// Applies protected open, suspend, close and acknowledgment of continuous operation, and drains its loop.
import type { Context } from "@earendil-works/chord/context";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import type { ModelChoice } from "../provider.ts";
import { type MissionLocation, readMissionAuthority, writeMissionAuthority } from "./authority.ts";
import type { MissionAuthority, MissionRequest, OperationAcknowledgment, OperationIntent } from "./contract.ts";
import { MissionExecutionDoc } from "./execution-state.ts";
import { abandonRuns, type missionLoop, operationDenial } from "./loop.ts";
import { MissionPurposeDoc, readMissionPurpose, storedLoop, validPurposeLoop } from "./purpose.ts";
import { type LoopState, loopAgreement, rememberAcknowledgment } from "./purpose-loop.ts";

type Operate = Extract<MissionRequest, { operation: "operate-local" }>;
type Scheduling = "inhibited" | "permitted";
type LoopTask = ReturnType<typeof missionLoop>;

const AMBIGUOUS_REQUEST = "This request ID names both an operation intent and an acknowledgment.";

/** Owns continuous operation through the sole storage owner; only protected intents change it. */
export class PurposeOperation {
	readonly #harness: Harness;
	readonly #location: MissionLocation;
	readonly #loop: LoopTask;
	readonly #model: ModelChoice | null;
	readonly #now: () => number;

	constructor(
		harness: Harness,
		location: MissionLocation,
		loop: LoopTask,
		model: ModelChoice | null,
		now: () => number = Date.now,
	) {
		this.#harness = harness;
		this.#location = location;
		this.#loop = loop;
		this.#model = model;
		this.#now = now;
	}

	/** Replays the latest protected intent, then pending acknowledgments; restrictive ones apply even when inhibited. */
	async initialize(context: Context, scheduling: Scheduling): Promise<void> {
		const authority = await readMissionAuthority(this.#location).catch(() => null);
		if (authority?.operationIntent)
			await this.reconcile(authority.operationIntent.requestId, context, scheduling).catch(() => {});
		for (const acknowledgment of authority?.operationAcknowledgments ?? [])
			await this.reconcile(acknowledgment.requestId, context, scheduling).catch(() => {});
		const loop = (await readMissionPurpose(this.#harness, context).catch(() => undefined))?.loop;
		if (loop?.operation.drain) await this.#drain(context, scheduling).catch(() => {});
	}

	/** Writes a developer-local protected intent or acknowledgment; managed ones come from the administrator command. */
	async issueLocal(request: Operate, context: Context): Promise<void> {
		if (this.#location.kind !== "developer-local")
			throw new Error("Managed operation changes require the administrator command.");
		const authority = await readMissionAuthority(this.#location);
		const loop = (await readMissionPurpose(this.#harness, context))?.loop;
		if (!authority || !loop) throw new Error("Approve a purpose before operating it.");
		await writeMissionAuthority(this.#location, nextOperationAuthority(authority, loop, request, this.#now()));
	}

	/**
	 * Applies the protected record with this request ID: an operation intent or an acknowledgment. The authority file
	 * is read inside the one serialized commit that applies it, so a revocation published while that commit was queued
	 * is seen; a value read before the commit could open or rearm under a grant already withdrawn.
	 */
	async reconcile(requestId: string, context: Context, scheduling: Scheduling): Promise<void> {
		let ambiguous = false;
		const applied = await this.#harness.commit(async (tx) => {
			const authority = await readMissionAuthority(this.#location);
			if (!authority) throw new Error("No authenticated mission authority is configured.");
			const loop = await storedLoop(tx);
			if (!loop) throw new Error("Stored purpose records are invalid; continuous operation stays closed.");
			const acknowledgment = authority.operationAcknowledgments?.find((item) => item.requestId === requestId);
			const intent = authority.operationIntent;
			// One request ID names one record. Reused across an acknowledgment and an intent, it could report one command's
			// result as the other's, so the call fails; a restrictive intent still applies first, since nothing blocks one.
			ambiguous = acknowledgment !== undefined && intent?.requestId === requestId;
			if (ambiguous && intent!.action === "open") throw new Error(AMBIGUOUS_REQUEST);
			if (acknowledgment && !ambiguous) return this.#acknowledge(tx, loop, authority, acknowledgment, scheduling);
			if (!intent || intent.requestId !== requestId)
				throw new Error("No protected operation intent has this request ID.");
			if (loop.operation.applied?.sequence === intent.sequence && loop.operation.applied.requestId === requestId)
				return "applied";
			if (loop.operation.applied && loop.operation.applied.sequence >= intent.sequence)
				throw new Error("Stale operation intent.");
			if (loop.operation.revision !== intent.expectedOperationRevision)
				throw new Error("Stale operation revision.");
			const agreement = loopAgreement(loop, intent.purposeRevision);
			if (
				!agreement ||
				intent.missionId !== agreement.missionId ||
				intent.purposeDigest !== agreement.digest ||
				intent.authorityRevision !== authority.revision
			)
				throw new Error("Operation intent does not match its current protected purpose agreement.");
			if (intent.action !== "open") return restrict(loop, intent);
			await this.#open(tx, loop, authority, intent, scheduling);
			return "armed";
		}, context);
		if (applied === "armed") this.#harness.resume();
		else if (applied !== "recorded") await this.#drain(context, scheduling);
		if (ambiguous) throw new Error(AMBIGUOUS_REQUEST);
	}

	// Throwing rolls back every change of the commit, so the state is set first and the full admission decision then
	// judges exactly what would be stored: receipt, exact intent, authority revision and deadline.
	async #open(
		tx: Tx,
		loop: LoopState,
		authority: MissionAuthority,
		intent: OperationIntent,
		scheduling: Scheduling,
	): Promise<void> {
		if (scheduling === "inhibited") throw new Error("Mission scheduling is inhibited.");
		if (this.#model === null) throw new Error("Configure a provider before opening operation.");
		if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Maintenance holds operation.");
		if (loop.operation.drain) throw new Error("The previous loop has not drained.");
		const status = (await tx.doc(MissionExecutionDoc)).current?.state.status;
		if (status === "ready" || status === "running" || status === "waiting" || status === "paused")
			throw new Error("Stop the one-shot mission execution before opening continuous operation.");
		loop.operation.state = {
			status: "open",
			purposeRevision: intent.purposeRevision,
			purposeDigest: intent.purposeDigest,
			sequence: intent.sequence,
		};
		loop.operation.revision++;
		loop.operation.applied = { requestId: intent.requestId, sequence: intent.sequence };
		const denial = operationDenial(authority, loop, intent.sequence, this.#now());
		if (denial === "deadline") throw new Error("The purpose lifetime deadline has passed.");
		if (denial !== undefined)
			throw new Error("Operation intent does not match its current protected purpose agreement.");
		await this.#arm(tx, loop, intent.missionId);
	}

	// One commit creates the loop and names it, so a crash never leaves an unnamed live loop or a named missing one.
	async #arm(tx: Tx, loop: LoopState, missionId: string): Promise<void> {
		const state = loop.operation.state;
		if (state.status !== "open" || this.#model === null) throw new Error("Operation is not open.");
		const control = await tx.createConversation({ ownership: { kind: "ownerless" } });
		loop.operation.loop = await tx.createTask(
			this.#loop,
			{ missionId, purposeRevision: state.purposeRevision, sequence: state.sequence, model: this.#model },
			{ conversationId: control.id, ownership: { kind: "conversation" }, background: true },
		);
		loop.operation.activity = { kind: "observing" };
	}

	// The disposition is recorded even when inhibited; only the rearm needs permission and current consent.
	async #acknowledge(
		tx: Tx,
		loop: LoopState,
		authority: MissionAuthority,
		acknowledgment: OperationAcknowledgment,
		scheduling: Scheduling,
	): Promise<"armed" | "recorded"> {
		const run = loop.runs.find((item) => item.runId === acknowledgment.runId);
		const settlement = run?.settlement;
		// A replay is this ID already bound to this run. The remembered IDs alone cannot tell: the protected file keeps
		// only eight acknowledgments, so an evicted ID reissued for another unsettled run would report success unapplied.
		const replay = typeof settlement === "object" && settlement?.acknowledged === acknowledgment.requestId;
		if (!replay) {
			if (loop.operation.acknowledged.includes(acknowledgment.requestId))
				throw new Error("Conflicting acknowledgment request ID.");
			if (acknowledgment.missionId !== loop.missionId || acknowledgment.authorityRevision !== authority.revision)
				throw new Error("Acknowledgment does not match the current protected authority.");
			if (!run || run.settlement !== "unsettled" || run.state.status === "running")
				throw new Error("Only a finished run with unsettled effects can be acknowledged.");
			const live = loop.operation.loop && (await tx.task(loop.operation.loop))?.state.status !== "terminal";
			if (live) throw new Error("The loop that ran this work has not ended.");
			// Charges stay: acknowledgment accepts uncertainty, it refunds nothing and proves no work.
			run.settlement = { acknowledged: acknowledgment.requestId };
			rememberAcknowledgment(loop, acknowledgment.requestId);
		}
		return (await this.#rearm(tx, loop, authority, scheduling)) ? "armed" : "recorded";
	}

	// Rearms a loop blocked only by now-settled effects: needs scheduling permission, no hold, no drain, no live loop,
	// no other unsettled run, and the current grant plus the exact applied open intent, read in this commit.
	async #rearm(tx: Tx, loop: LoopState, authority: MissionAuthority, scheduling: Scheduling): Promise<boolean> {
		const state = loop.operation.state;
		if (scheduling === "inhibited" || state.status !== "open" || loop.operation.drain) return false;
		if (loop.operation.activity?.kind !== "blocked" || loop.operation.activity.reason !== "unsettled_effects")
			return false;
		if (loop.runs.some((run) => run.settlement === "unsettled")) return false;
		if (loop.operation.loop && (await tx.task(loop.operation.loop))?.state.status !== "terminal") return false;
		if ((await tx.doc(MaintenanceDoc)).current.state === "held") return false;
		if (operationDenial(authority, loop, state.sequence, this.#now()) !== undefined) return false;
		await this.#arm(tx, loop, loop.missionId!);
		return true;
	}

	// Abort-marks the persisted drain target; only a permitted owner also aborts run work and waits for the end.
	async #drain(context: Context, scheduling: Scheduling): Promise<void> {
		const loop = validPurposeLoop(await this.#harness.snapshot(MissionPurposeDoc, context));
		const drain = loop?.operation.drain;
		if (!drain) return;
		await this.#harness.abortTask(drain.loop, context);
		if (scheduling === "inhibited") return;
		for (const id of drain.conversations)
			await (await this.#harness.conversation(id, context))?.abort(context, { background: true });
		await this.#harness.waitForTask(drain.loop, context);
		await this.#harness.commit(async (tx) => {
			const saved = await storedLoop(tx);
			if (!saved || saved.operation.drain?.loop !== drain.loop) return;
			if ((await tx.task(drain.loop))?.state.status !== "terminal") return;
			// The run's disposition is final before the target is forgotten: a phase that saw the restrictive commit
			// before the abort mark ended the loop normally and left its run running, possibly with an uncertain effect.
			abandonRuns(saved);
			saved.operation.drain = null;
			if (saved.operation.loop === drain.loop) saved.operation.loop = null;
		}, context);
	}
}

/** Builds the authority file carrying one new protected operation intent or acknowledgment, idempotent by request ID. */
export function nextOperationAuthority(
	authority: MissionAuthority,
	loop: LoopState,
	request: Operate,
	now: number,
): MissionAuthority {
	// A request ID names one command: reused across kinds, reconciliation could not tell which one it applies.
	const otherKind =
		request.action === "acknowledge"
			? authority.operationIntent?.requestId === request.requestId
			: authority.operationAcknowledgments?.some((item) => item.requestId === request.requestId);
	if (otherKind) throw new Error("Conflicting operation request ID.");
	if (request.action === "acknowledge") {
		const previous = authority.operationAcknowledgments?.find((item) => item.requestId === request.requestId);
		if (previous) {
			if (previous.runId !== request.runId) throw new Error("Conflicting acknowledgment request ID.");
			return authority;
		}
		// The owner refuses an ID it remembers but this file evicted; refusing here keeps that record out of the file.
		if (loop.operation.acknowledged.includes(request.requestId))
			throw new Error("Conflicting acknowledgment request ID.");
		const run = loop.runs.find((item) => item.runId === request.runId);
		if (!run || run.settlement !== "unsettled")
			throw new Error("Only a run with unsettled effects can be acknowledged.");
		const acknowledgment: OperationAcknowledgment = {
			requestId: request.requestId,
			missionId: loop.missionId!,
			runId: run.runId,
			authorityRevision: authority.revision,
			issuedAt: now,
		};
		return {
			...authority,
			operationAcknowledgments: [...(authority.operationAcknowledgments ?? []), acknowledgment].slice(-8),
		};
	}
	const previous = authority.operationIntent;
	if (previous?.requestId === request.requestId) {
		if (previous.action !== request.action || previous.expectedOperationRevision !== request.expectedOperationRevision)
			throw new Error("Conflicting operation request ID.");
		return authority;
	}
	if (loop.operation.revision !== request.expectedOperationRevision) throw new Error("Stale operation revision.");
	const state = loop.operation.state;
	const agreement = request.action === "open" ? loop.agreements.at(-1) : state.status === "closed" ? undefined : loopAgreement(loop, state.purposeRevision);
	if (!agreement)
		throw new Error(request.action === "open" ? "Approve a purpose before opening operation." : "Operation is not open.");
	if (request.action === "open" && state.status === "open") throw new Error("Operation is already open.");
	if (request.action === "open" && loop.operation.drain) throw new Error("The previous loop has not drained.");
	if (request.action === "suspend" && state.status !== "open") throw new Error("Only open operation can be suspended.");
	return {
		...authority,
		operationIntent: {
			requestId: request.requestId,
			sequence: Math.max(previous?.sequence ?? 0, loop.operation.applied?.sequence ?? 0) + 1,
			missionId: agreement.missionId,
			purposeRevision: agreement.revision,
			purposeDigest: agreement.digest,
			authorityRevision: authority.revision,
			expectedOperationRevision: request.expectedOperationRevision,
			action: request.action,
			issuedAt: now,
		},
	};
}

// Admission closes in this commit, before any abort; the loop identity stays as the drain target until it is terminal.
function restrict(loop: LoopState, intent: OperationIntent): "restricted" {
	loop.operation.state =
		intent.action === "close"
			? { status: "closed" }
			: {
					status: "suspended",
					purposeRevision: intent.purposeRevision,
					purposeDigest: intent.purposeDigest,
					sequence: intent.sequence,
				};
	loop.operation.revision++;
	loop.operation.applied = { requestId: intent.requestId, sequence: intent.sequence };
	if (loop.operation.loop)
		loop.operation.drain = {
			loop: loop.operation.loop,
			conversations: loop.runs.filter((run) => run.state.status === "running").map((run) => run.conversation),
		};
	for (const proposal of loop.proposals) if (proposal.status === "recorded") proposal.status = "stale";
	loop.operation.activity = null;
	return "restricted";
}
