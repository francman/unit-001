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
	type MissionAuthority,
	type MissionDraft,
	type MissionRequest,
	type MissionView,
	missingMissionTerms,
	parseMissionDraftTerms,
} from "./contract.ts";
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

	/** Reconciles an already-issued exact approval after interruption; never creates authority itself. */
	async initialize(context: Context): Promise<void> {
		if (this.#location.session !== "default") return;
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
		if (this.#location.session !== "default")
			throw new Error("Mission formation belongs to the default owner session.");
		if (request.operation === "status") return this.inspect(context);
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
			});
			return this.inspect(context);
		}
		const authority = await readMissionAuthority(this.#location);
		if (request.operation === "approve-local") {
			if (this.#location.kind !== "developer-local" || authority === null)
				throw new Error("Managed approval requires an exact administrator receipt.");
			const formation = (await this.#harness.snapshot(MissionDoc, context))?.formation;
			if (formation?.agreement?.approval.requestId === request.requestId) {
				if (
					formation.agreement.revision !== request.expectedRevision ||
					formation.agreement.digest !== request.digest
				)
					throw new Error("Conflicting approval request ID.");
				return this.inspect(context);
			}
			const draft = formation?.draft;
			if (
				!draft ||
				draft.status !== "proposed" ||
				draft.revision !== request.expectedRevision ||
				draft.digest !== request.digest
			)
				throw new Error("Stale mission approval; inspect the exact proposal again.");
			const terms = validateMissionTerms(draft.terms, authority, this.#tools, this.#now());
			const digest = missionDigest(terms, draft.missionId, draft.revision, authority);
			if (digest !== request.digest) throw new Error("Mission authority changed; propose the draft again.");
			const previous = authority.approvals.find((item) => item.requestId === request.requestId);
			if (previous && previous.digest !== digest) throw new Error("Conflicting approval request ID.");
			const receipt = previous ?? {
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
				provenance: "developer-local" as const,
				approvedBy: { kind: "developer-local" as const, uid: process.getuid?.() ?? null },
			};
			const currentReceipt = authority.approvals.find(
				(item) => item.receiptId === formation.agreement?.approval.receiptId,
			);
			await writeMissionAuthority(this.#location, {
				...authority,
				approvals:
					currentReceipt && currentReceipt.receiptId !== receipt.receiptId ? [currentReceipt, receipt] : [receipt],
			});
			return this.handle({ operation: "reconcile", receiptId: receipt.receiptId }, context);
		}
		const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		await this.#harness.commit(async (tx) => {
			if ((await tx.doc(MaintenanceDoc)).current.state === "held")
				throw new Error("Service is held for maintenance.");
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
				formation.agreement = {
					missionId: draft.missionId,
					revision: draft.revision,
					terms,
					digest: receipt.digest,
					approval: receipt,
					execution: "not-implemented",
				};
				formation.draft = null;
				return;
			}
			if (formation.lastOperation?.requestId === request.requestId) {
				if (formation.lastOperation.digest !== fingerprint) throw new Error("Conflicting mission request ID.");
				return;
			}
			const expected = formation.draft?.revision ?? formation.agreement?.revision ?? 0;
			if (request.expectedRevision !== expected)
				throw new Error("Stale mission revision; inspect the saved draft again.");
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
				if (!formation.draft || authority === null)
					throw new Error("Save a draft and configure its creator authority first.");
				const terms = validateMissionTerms(formation.draft.terms, authority, this.#tools, this.#now());
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
}
