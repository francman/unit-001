// Changes saved mission drafts through the sole owner and reconciles exact protected approval receipts.
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import {
	type MissionLocation,
	matchingApproval,
	missionDigest,
	readMissionAuthority,
	validateMissionTerms,
	writeMissionAuthority,
} from "./authority.ts";
import {
	initialFormation,
	type MissionApproval,
	type MissionAuthority,
	type MissionDraft,
	type MissionDraftTerms,
	type MissionRequest,
	type MissionTerms,
	type MissionView,
	missingMissionTerms,
	parseMissionDraftTerms,
} from "./contract.ts";
import { MissionExecutionDoc } from "./execution-state.ts";
import { importLegacyAgreements, readMissionPurpose, recordLegacyAgreement } from "./purpose.ts";
import { MissionRefusal } from "./refusal.ts";
import { MissionDoc } from "./state.ts";

/** Owns one session's mission formation; it contains no controller, model request or execution admission. */
export class MissionControl {
	readonly #harness: Harness;
	readonly #location: MissionLocation;
	readonly #tools: readonly string[];
	readonly #now: () => number;

	constructor(harness: Harness, location: MissionLocation, tools: readonly string[], now: () => number = Date.now) {
		this.#harness = harness;
		this.#location = location;
		this.#tools = tools;
		this.#now = now;
	}

	/** Imports saved agreements as purpose and work, then reconciles an issued approval; never creates authority itself. */
	async initialize(context: Context): Promise<void> {
		if (this.#location.session !== "default") return;
		try {
			await importLegacyAgreements(this.#harness, context);
		} catch {
			// Purpose records grant nothing yet; an unreadable or conflicting record must not block ordinary owner startup.
		}
		let authority: MissionAuthority | null;
		try {
			authority = await readMissionAuthority(this.#location);
		} catch {
			return;
		}
		const draft = (await this.#harness.snapshot(MissionDoc, context))?.formation.draft;
		if (
			authority &&
			draft?.status === "proposed" &&
			missingMissionTerms(draft.terms).length === 0 &&
			(draft.terms.policy?.deadlineAt ?? 0) > this.#now()
		) {
			// A changed ceiling or expired draft must not make ordinary owner startup fail.
			const receipt = authority.approvals.at(-1);
			if (
				receipt &&
				receipt.missionId === draft.missionId &&
				receipt.revision === draft.revision &&
				receipt.authorityRevision === authority.revision &&
				receipt.digest === draft.digest
			)
				try {
					await this.handle({ operation: "reconcile", receiptId: receipt.receiptId }, context);
				} catch {
					// A changed tool registry or authority file leaves approval pending; ordinary owner startup stays available.
				}
		}
	}

	/** Projects saved formation and fresh authority without changing the mission or making provider requests. */
	async inspect(context: Context): Promise<MissionView> {
		let authority: MissionAuthority | null = null;
		let authorityError: string | null = null;
		try {
			authority = await readMissionAuthority(this.#location);
		} catch (error) {
			authorityError = error instanceof Error ? error.message : String(error);
		}
		const formation = (await this.#harness.snapshot(MissionDoc, context))?.formation ?? initialFormation();
		const agreement = formation.agreement;
		const agreementValid =
			agreement !== null &&
			authority !== null &&
			agreement.terms.policy.deadlineAt > this.#now() &&
			matchingApproval(
				authority,
				agreement.approval.receiptId,
				agreement.missionId,
				agreement.revision,
				agreement.terms,
			) !== undefined;
		return {
			stage:
				authority === null
					? "awaiting_creator"
					: formation.draft?.status === "proposed"
						? "awaiting_approval"
						: formation.draft !== null
							? "drafting"
							: agreementValid
								? "agreed"
								: "drafting",
			formation,
			creator: authority?.creator ?? null,
			authority:
				authorityError !== null
					? "invalid"
					: authority === null
						? "unconfigured"
						: this.#location.kind === "managed"
							? "managed-administrator"
							: "developer-local",
			agreementValid,
			authorityError,
			missing: missingMissionTerms(formation.draft?.terms ?? {}),
			execution: "not-implemented",
			tools: [...this.#tools],
		};
	}

	/** Commits one revision-checked draft operation or an approval already issued by its authenticated authority. */
	async handle(request: MissionRequest, context: Context): Promise<MissionView> {
		if (
			request.operation === "control-local" ||
			request.operation === "reconcile-execution" ||
			request.operation === "purpose-propose" ||
			request.operation === "purpose-approve-local" ||
			request.operation === "reconcile-purpose" ||
			request.operation === "operate-local" ||
			request.operation === "reconcile-operation"
		)
			throw new Error("Mission execution and purpose changes belong to its runtime owner.");
		if (this.#location.session !== "default")
			throw new Error("Mission formation belongs to the default owner session.");
		if (request.operation === "status") return this.inspect(context);
		if (request.operation === "agree") {
			// The owner shares the service UID with the agent's tools, so on a managed host it never mints a receipt itself.
			if (this.#location.kind !== "developer-local")
				throw new MissionRefusal(
					"managed-requires-gateway",
					"Managed agreement is issued by the creator's own gateway or administrator command.",
				);
			const { revision, digest, requestId } = request;
			return this.handle({ operation: "approve-local", expectedRevision: revision, digest, requestId }, context);
		}
		if (request.operation === "configure-local") {
			if (this.#location.kind !== "developer-local")
				throw new Error("Managed creator and authority changes require the administrator command.");
			if (request.creator.uid !== (process.getuid?.() ?? null))
				throw new Error("Developer-local authority belongs to this instance's OS user.");
			if (request.ceiling.allowedTools.some((tool) => !this.#tools.includes(tool)))
				throw new Error("Unknown registered tool action.");
			const prior = await readMissionAuthority(this.#location);
			await writeMissionAuthority(this.#location, {
				schemaVersion: 1,
				installationId: null,
				session: "default",
				revision: (prior?.revision ?? 0) + 1,
				creator: request.creator,
				ceiling: request.ceiling,
				approvals: [],
				...(prior?.executionIntent ? { executionIntent: prior.executionIntent } : {}),
				// The revision bump closes purpose receipts and the open intent; restrictive history stays for replay.
				...(request.purposeCeiling ? { purposeCeiling: request.purposeCeiling } : {}),
				...(prior?.operationIntent ? { operationIntent: prior.operationIntent } : {}),
				...(prior?.operationAcknowledgments ? { operationAcknowledgments: prior.operationAcknowledgments } : {}),
			});
			return this.inspect(context);
		}
		const authority = await readMissionAuthority(this.#location);
		if (request.operation === "approve-local") return this.#approveLocal(request, authority, context);
		if (request.operation === "reconcile") {
			const agreement = (await this.#harness.snapshot(MissionDoc, context))?.formation.agreement;
			if (agreement?.approval.receiptId !== request.receiptId) await this.#requireStopped(context);
		}
		// A proposal is what the managed administrator command approves, so the purpose check also precedes its receipt.
		if (request.operation === "propose") await this.#requirePurpose(context);
		// An issued receipt reaches formation even when this release cannot record the purpose: the purpose document
		// stays as stored, a newer one included, and the next compatible owner start imports the agreement from formation.
		const recordPurpose =
			request.operation === "reconcile" &&
			(await readMissionPurpose(this.#harness, context).then(
				() => true,
				() => false,
			));
		const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		await this.#harness.commit(async (tx) => {
			if ((await tx.doc(MaintenanceDoc)).current.state === "held")
				throw new MissionRefusal("held", "Service is held for maintenance.");
			const state = await tx.doc(MissionDoc);
			const formation = state.formation;
			if (request.operation === "reconcile") {
				if (authority === null) throw new Error("No authenticated mission authority is configured.");
				if (
					formation.agreement?.approval.receiptId === request.receiptId &&
					matchingApproval(
						authority,
						request.receiptId,
						formation.agreement.missionId,
						formation.agreement.revision,
						formation.agreement.terms,
					)
				)
					return;
				const draft = formation.draft;
				if (!draft || draft.status !== "proposed") throw new Error("No exact proposed mission awaits approval.");
				const terms = validateMissionTerms(draft.terms, authority, this.#tools, this.#now());
				const receipt = matchingApproval(authority, request.receiptId, draft.missionId, draft.revision, terms);
				if (!receipt || receipt.digest !== draft.digest)
					throw new Error("Approval does not match this mission, revision and exact terms.");
				const agreement = {
					missionId: draft.missionId,
					revision: draft.revision,
					terms,
					digest: receipt.digest,
					approval: receipt,
					execution: "not-implemented" as const,
				};
				formation.agreement = agreement;
				formation.draft = null;
				// The same commit records the agreed purpose and its one bounded work item.
				if (recordPurpose) await recordLegacyAgreement(tx, agreement);
				return;
			}
			if (formation.lastOperation?.requestId === request.requestId) {
				if (formation.lastOperation.digest !== fingerprint)
					throw new MissionRefusal("conflicting-request", "Conflicting mission request ID.");
				return;
			}
			const expected = formation.draft?.revision ?? formation.agreement?.revision ?? 0;
			if (request.expectedRevision !== expected)
				throw new MissionRefusal("stale-revision", "Stale mission revision; inspect the saved draft again.");
			if (request.operation === "draft") {
				const draft: MissionDraft = {
					missionId:
						formation.draft?.missionId ??
						formation.agreement?.missionId ??
						state.current?.missionId ??
						randomUUID(),
					revision: formation.nextRevision++,
					status: "editing",
					terms: parseMissionDraftTerms(request.terms),
					digest: null,
				};
				formation.draft = draft;
			} else {
				if (!formation.draft)
					throw new MissionRefusal("incomplete", "Save a draft and configure its creator authority first.");
				if (authority === null)
					throw new MissionRefusal("outside-authority", "Save a draft and configure its creator authority first.");
				const terms = agreeableTerms(formation.draft.terms, authority, this.#tools, this.#now());
				formation.draft.digest = missionDigest(
					terms,
					formation.draft.missionId,
					formation.draft.revision,
					authority,
				);
				formation.draft.status = "proposed";
			}
			formation.lastOperation = {
				requestId: request.requestId,
				digest: fingerprint,
				revision: formation.draft!.revision,
			};
		}, context);
		return this.inspect(context);
	}

	// Every refusal comes before the receipt is published; once it is, a failure is reported as pending, never a refusal.
	async #approveLocal(
		request: Extract<MissionRequest, { operation: "approve-local" }>,
		authority: MissionAuthority | null,
		context: Context,
	): Promise<MissionView> {
		if (this.#location.kind !== "developer-local" || authority === null)
			throw new Error("Managed approval requires an exact administrator receipt.");
		const formation = (await this.#harness.snapshot(MissionDoc, context))?.formation;
		if (formation?.agreement?.approval.requestId === request.requestId) {
			if (formation.agreement.revision !== request.expectedRevision || formation.agreement.digest !== request.digest)
				throw new MissionRefusal("conflicting-request", "Conflicting approval request ID.");
			return this.inspect(context);
		}
		const issued = authority.approvals.find((item) => item.requestId === request.requestId);
		if (issued) {
			if (issued.revision !== request.expectedRevision || issued.digest !== request.digest)
				throw new MissionRefusal("conflicting-request", "Conflicting approval request ID.");
			return this.#reconcileIssued(issued.receiptId, context);
		}
		await this.#requireStopped(context);
		if ((await this.#harness.snapshot(MaintenanceDoc, context))?.current.state === "held")
			throw new MissionRefusal("held", "Service is held for maintenance.");
		const draft = formation?.draft;
		if (!draft || draft.status !== "proposed" || draft.revision !== request.expectedRevision)
			throw new MissionRefusal("stale-revision", "Stale mission approval; inspect the exact proposal again.");
		if (draft.digest !== request.digest)
			throw new MissionRefusal("stale-digest", "Stale mission approval; inspect the exact proposal again.");
		const terms = agreeableTerms(draft.terms, authority, this.#tools, this.#now());
		const digest = missionDigest(terms, draft.missionId, draft.revision, authority);
		if (digest !== request.digest)
			throw new MissionRefusal("stale-digest", "Mission authority changed; propose the draft again.");
		await this.#requirePurpose(context);
		const receipt: MissionApproval = {
			receiptId: randomUUID(),
			requestId: request.requestId,
			installationId: null,
			session: "default",
			missionId: draft.missionId,
			revision: draft.revision,
			digest,
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: this.#now(),
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: process.getuid?.() ?? null },
		};
		const currentReceipt = authority.approvals.find((item) => item.receiptId === formation?.agreement?.approval.receiptId);
		await writeMissionAuthority(this.#location, {
			...authority,
			approvals: currentReceipt ? [currentReceipt, receipt] : [receipt],
		});
		return this.#reconcileIssued(receipt.receiptId, context);
	}

	// A hold or failure here leaves a published receipt unrecorded: a plain error (pending), which a retry of the same
	// request ID or the next owner start reconciles. It must never surface as a refusal, which would claim nothing changed.
	async #reconcileIssued(receiptId: string, context: Context): Promise<MissionView> {
		try {
			return await this.handle({ operation: "reconcile", receiptId }, context);
		} catch (error) {
			throw new Error(
				`Mission agreement ${receiptId} is issued but not yet recorded; a retry of the same request or the next owner start records it while it is current. ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #requireStopped(context: Context): Promise<void> {
		const current = (await this.#harness.snapshot(MissionExecutionDoc, context))?.current;
		if (current && current.state.status !== "stopped" && current.state.status !== "completed")
			throw new MissionRefusal("execution-active", "Stop the existing mission execution before approving an amendment.");
	}

	// A new receipt closes the agreed revision at once, so it is issued only when this release can also record its purpose.
	async #requirePurpose(context: Context): Promise<void> {
		try {
			await readMissionPurpose(this.#harness, context);
		} catch (error) {
			throw new Error(
				`Mission purpose records are unreadable by this release; the agreed revision stays in force. ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

// Terms the creator cannot agree yet are a refusal: missing fields are incomplete, anything else exceeds creator authority.
function agreeableTerms(
	draft: MissionDraftTerms,
	authority: MissionAuthority,
	tools: readonly string[],
	now: number,
): MissionTerms {
	try {
		return validateMissionTerms(draft, authority, tools, now);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new MissionRefusal(missingMissionTerms(draft).length > 0 ? "incomplete" : "outside-authority", message);
	}
}
