// Applies protected lifecycle intent through the existing storage owner and drains mission-owned work.
import type { Context } from "@earendil-works/chord/context";
import type { Harness, Registry } from "@earendil-works/pi-durable";
import type { ModelChoice } from "../provider.ts";
import type { MissionAdmission } from "./admission.ts";
import { type MissionLocation, matchingApproval, readMissionAuthority, writeMissionAuthority } from "./authority.ts";
import type { MissionRequest, MissionView } from "./contract.ts";
import type { MissionControl } from "./control.ts";
import { type missionController, resumeMissionExecution, startMissionExecution } from "./controller.ts";
import { type MissionExecution, MissionExecutionDoc } from "./execution-state.ts";
import { missionExecutionView } from "./execution-view.ts";
import { loopRollbackBlocker } from "./loop-drain.ts";
import { PurposeOperation } from "./operation.ts";
import { readMissionPurpose } from "./purpose.ts";
import { PurposeFormation } from "./purpose-formation.ts";
import type { LoopState } from "./purpose-loop.ts";
import { missionPurposeView } from "./purpose-view.ts";
import { MissionDoc } from "./state.ts";
import { verifyMissionFiles } from "./verification.ts";

/** Serializes mission lifecycle changes; creator receipts and root intent remain independent of owner-wire access. */
export class MissionOwner {
	readonly #harness: Harness;
	readonly #formation: MissionControl;
	readonly #location: MissionLocation;
	readonly #registry: Registry;
	readonly #admission: MissionAdmission;
	readonly #engine: ReturnType<typeof missionController>;
	readonly #model: ModelChoice | null;
	readonly #cwd: string;
	readonly #purpose: PurposeFormation;
	readonly #operation: PurposeOperation;
	#tail: Promise<unknown> = Promise.resolve();
	#scheduling: "inhibited" | "permitted" = "inhibited";

	constructor(
		harness: Harness,
		formation: MissionControl,
		location: MissionLocation,
		registry: Registry,
		admission: MissionAdmission,
		engine: ReturnType<typeof missionController>,
		model: ModelChoice | null,
		cwd: string,
		now: () => number = Date.now,
	) {
		this.#harness = harness;
		this.#formation = formation;
		this.#location = location;
		this.#registry = registry;
		this.#admission = admission;
		this.#engine = engine;
		this.#model = model;
		this.#cwd = cwd;
		this.#purpose = new PurposeFormation(harness, location, now);
		this.#operation = new PurposeOperation(harness, location, engine.loop, model, now);
	}

	/** Replays only the latest protected intent after restart; agreement alone never starts execution. */
	async initialize(context: Context, scheduling: "inhibited" | "permitted" = "inhibited"): Promise<void> {
		this.#scheduling = scheduling;
		await this.#formation.initialize(context);
		if (this.#location.session !== "default") return;
		await this.#purpose.initialize(context);
		// Restrictive operation intents apply before scheduling; open and acknowledgment wait for permission.
		await this.#operation.initialize(context, scheduling);
		const authority = await readMissionAuthority(this.#location).catch(() => null);
		if (authority?.executionIntent) {
			try {
				await this.reconcile(authority.executionIntent.requestId, context, scheduling);
			} catch {
				/* Invalid, expired or unresolved intent keeps its admission gates closed; owner inspection remains available. */
			}
		}
	}

	/** Returns current execution evidence independently of the controller task's terminal outcome. */
	async inspect(context: Context): Promise<MissionView> {
		const view = await this.#formation.inspect(context);
		const current = (await this.#harness.snapshot(MissionExecutionDoc, context))?.current;
		const intent = (await readMissionAuthority(this.#location).catch(() => null))?.executionIntent;
		return {
			...view,
			execution: current?.state.status ?? "not-started",
			runtime: current ? missionExecutionView(current, Date.now()) : null,
			policyRevision:
				current?.policyRevision ?? (intent?.expectedPolicyRevision ?? 0) + (intent?.action === "stop" ? 1 : 0),
			...(await this.#purposeView(context)),
		};
	}

	// Status validates exactly what execution validates (`readMissionPurpose`, `validPurposeLoop`), and reports a
	// failure as such, not as "no purpose". The rollback answer comes from live task inspection, never from the
	// document alone: invalid records project no purpose, yet a parked loop task can still be live.
	async #purposeView(context: Context): Promise<Pick<MissionView, "purpose" | "purposeError" | "loopRollback">> {
		const loopRollback = loopRollbackBlocker(await this.#harness.inspect(context)) ?? "no-live-loop";
		let loop: LoopState | undefined;
		try {
			loop = (await readMissionPurpose(this.#harness, context))?.loop;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { purpose: null, purposeError: reason.slice(0, 500), loopRollback };
		}
		if (!loop) return { purpose: null, purposeError: null, loopRollback };
		let live = loopRollback === "live-loop";
		for (const id of [loop.operation.loop, loop.operation.drain?.loop])
			if (id && (await this.#harness.getTask(id, context))?.state.status !== "terminal") live = true;
		return { purpose: missionPurposeView(loop, live), purposeError: null, loopRollback };
	}

	/** Routes formation normally and serializes exact protected lifecycle requests through the same owner. */
	async handle(request: MissionRequest, context: Context): Promise<MissionView> {
		if (request.operation === "status") return this.inspect(context);
		const work = this.#tail.then(async () => {
			if (request.operation === "control-local" || request.operation === "reconcile-execution") {
				if (request.operation === "control-local") await this.issueLocal(request, context);
				await this.reconcile(request.requestId, context, this.#scheduling);
			} else if (request.operation === "purpose-propose") await this.#purpose.propose(request, context);
			else if (request.operation === "purpose-approve-local") await this.#purpose.approveLocal(request, context);
			else if (request.operation === "reconcile-purpose") await this.#purpose.reconcile(request.receiptId, context);
			else if (request.operation === "operate-local" || request.operation === "reconcile-operation") {
				if (request.operation === "operate-local") await this.#operation.issueLocal(request, context);
				await this.#operation.reconcile(request.requestId, context, this.#scheduling);
			} else await this.#formation.handle(request, context);
			return this.inspect(context);
		});
		this.#tail = work.catch(() => {});
		return work;
	}

	private async issueLocal(
		request: Extract<MissionRequest, { operation: "control-local" }>,
		context: Context,
	): Promise<void> {
		if (this.#location.kind !== "developer-local")
			throw new Error("Managed mission lifecycle changes require the administrator command.");
		const authority = await readMissionAuthority(this.#location);
		const current = (await this.#harness.snapshot(MissionExecutionDoc, context))?.current;
		const agreement =
			(request.action === "pause" || request.action === "stop") && current
				? current.agreement
				: (await this.#harness.snapshot(MissionDoc, context))?.formation.agreement;
		if (!authority || !agreement) throw new Error("Configure and approve the mission before changing its execution.");
		const previous = authority.executionIntent;
		if (previous?.requestId === request.requestId) {
			if (previous.action !== request.action || previous.expectedPolicyRevision !== request.expectedPolicyRevision)
				throw new Error("Conflicting mission lifecycle request ID.");
			return;
		}
		if (
			(current?.policyRevision ??
				(previous?.expectedPolicyRevision ?? 0) + (previous?.action === "stop" ? 1 : 0)) !==
			request.expectedPolicyRevision
		)
			throw new Error("Stale mission policy revision.");
		if (request.action === "start" ? current != null : current == null && request.action !== "stop")
			throw new Error(
				request.action === "start" ? "A mission execution already exists." : "No mission execution exists.",
			);
		if (request.action === "pause" && (current?.state.status === "stopped" || current?.state.status === "completed"))
			throw new Error("A terminal mission cannot be paused or restarted.");
		if (request.action === "resume" && current?.state.status !== "paused")
			throw new Error("Only a paused mission can resume.");
		await writeMissionAuthority(this.#location, {
			...authority,
			executionIntent: {
				requestId: request.requestId,
				sequence: Math.max(previous?.sequence ?? 0, current?.intent?.sequence ?? 0) + 1,
				missionId: agreement.missionId,
				agreementRevision: agreement.revision,
				agreementDigest: agreement.digest,
				authorityRevision: authority.revision,
				expectedPolicyRevision: request.expectedPolicyRevision,
				action: request.action,
				issuedAt: Date.now(),
			},
		});
	}

	private async reconcile(requestId: string, context: Context, scheduling: "inhibited" | "permitted"): Promise<void> {
		const authority = await readMissionAuthority(this.#location);
		const intent = authority?.executionIntent;
		const current = (await this.#harness.snapshot(MissionExecutionDoc, context))?.current;
		const restrictive = intent?.action === "pause" || intent?.action === "stop";
		const agreement =
			restrictive && current
				? current.agreement
				: (await this.#harness.snapshot(MissionDoc, context))?.formation.agreement;
		if (
			!authority ||
			!intent ||
			intent.requestId !== requestId ||
			!agreement ||
			intent.missionId !== agreement.missionId ||
			intent.agreementRevision !== agreement.revision ||
			intent.agreementDigest !== agreement.digest ||
			intent.authorityRevision !== authority.revision ||
			(!restrictive &&
				!matchingApproval(
					authority,
					agreement.approval.receiptId,
					agreement.missionId,
					agreement.revision,
					agreement.terms,
				))
		)
			throw new Error("Mission lifecycle intent does not match its current protected agreement.");
		// Startup may close admission before scheduling is permitted; opening intent remains pending.
		if (!restrictive && scheduling === "inhibited") throw new Error("Mission scheduling is inhibited.");
		if (current?.intent?.sequence === intent.sequence && current.intent.requestId === requestId) {
			if (current.state.status === "paused" || current.state.status === "stopped")
				await this.drain(current, context, scheduling);
			return;
		}
		if (current?.intent && current.intent.sequence >= intent.sequence)
			throw new Error("Stale mission lifecycle intent.");
		// With no execution, protected intent is the durable compare-and-set receipt; stop consumes its revision.
		if (intent.action === "stop" && !current) return;
		if (current && current.policyRevision !== intent.expectedPolicyRevision)
			throw new Error("Stale mission policy revision.");
		if (intent.action === "start") {
			if (this.#model === null) throw new Error("Configure a provider before starting mission execution.");
			await startMissionExecution(
				this.#harness,
				this.#engine,
				this.#admission,
				this.#registry,
				this.#model,
				context,
				intent,
			);
			this.#harness.resume();
			return;
		}
		if (!current || current.agreement.digest !== agreement.digest)
			throw new Error("No matching mission execution exists.");
		if (intent.action === "pause" && (current.state.status === "stopped" || current.state.status === "completed"))
			throw new Error("A terminal mission cannot be paused or restarted.");
		if (intent.action === "pause" || intent.action === "stop") {
			await this.#harness.commit(async (tx) => {
				const saved = (await tx.doc(MissionExecutionDoc)).current!;
				if (saved.policyRevision !== intent.expectedPolicyRevision)
					throw new Error("Stale mission policy revision.");
				if (saved.state.status !== "completed")
					saved.state = { status: intent.action === "pause" ? "paused" : "stopped" };
				saved.policyRevision++;
				saved.revision++;
				saved.intent = { requestId, sequence: intent.sequence };
			}, context);
			await this.drain(current, context, scheduling);
			return;
		}
		if (current.state.status !== "paused") throw new Error("Only a paused mission can resume.");
		await this.drain(current, context, scheduling);
		const settled = (await this.#harness.snapshot(MissionExecutionDoc, context))!.current!;
		if (!(await this.#admission.authorized({ ...settled, intent: { requestId, sequence: intent.sequence } })))
			throw new Error("Mission approval is invalid or expired.");
		if (settled.pendingTools.length !== 0 || settled.unknownRequests !== 0) {
			const evidence = await verifyMissionFiles(agreement.terms.successCriteria, this.#cwd, Date.now());
			if (!evidence.every((item) => item.accepted))
				throw new Error("Uncertain mission effects need verified reconciliation before resume.");
			await this.#harness.commit(async (tx) => {
				const saved = (await tx.doc(MissionExecutionDoc)).current!;
				if (saved.policyRevision !== intent.expectedPolicyRevision)
					throw new Error("Stale mission policy revision.");
				saved.evidence = evidence;
				saved.state = { status: "completed", observedAt: Date.now() };
				saved.policyRevision++;
				saved.revision++;
				saved.intent = { requestId, sequence: intent.sequence };
			}, context);
			return;
		}
		if (this.#model === null) throw new Error("Configure a provider before resuming mission execution.");
		await resumeMissionExecution(this.#harness, this.#engine, this.#admission, this.#model, intent, context);
		this.#harness.resume();
	}

	private async drain(
		current: MissionExecution,
		context: Context,
		scheduling: "inhibited" | "permitted",
	): Promise<void> {
		await this.#harness.abortTask(current.controller, context);
		if (scheduling === "inhibited") return;
		const conversation = await this.#harness.conversation(current.conversation, context);
		if (!conversation) throw new Error("Mission execution conversation is unavailable.");
		await conversation.abort(context, { background: true });
		await this.#harness.waitForTask(current.controller, context);
	}
}
