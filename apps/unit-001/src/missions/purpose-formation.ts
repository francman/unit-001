// Proposes exact purpose terms and records them once a protected purpose receipt approves that exact digest.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import { type MissionLocation, readMissionAuthority, writeMissionAuthority } from "./authority.ts";
import type { MissionApproval, MissionAuthority, MissionRequest } from "./contract.ts";
import { MissionPurposeDoc, readMissionPurpose } from "./purpose.ts";
import { matchingPurposeApproval, purposeDigest, validatePurposeTerms } from "./purpose-authority.ts";
import { type LoopState, recordPurposeAgreement } from "./purpose-loop.ts";
import { MissionDoc } from "./state.ts";

type Propose = Extract<MissionRequest, { operation: "purpose-propose" }>;
type Approve = Extract<MissionRequest, { operation: "purpose-approve-local" }>;

/** Forms purpose agreements for continuous operation; approving a purpose opens nothing. */
export class PurposeFormation {
	readonly #harness: Harness;
	readonly #location: MissionLocation;
	readonly #now: () => number;

	constructor(harness: Harness, location: MissionLocation, now: () => number = Date.now) {
		this.#harness = harness;
		this.#location = location;
		this.#now = now;
	}

	/** Reconciles a purpose receipt issued before a crash; never creates a receipt. */
	async initialize(context: Context): Promise<void> {
		const authority = await readMissionAuthority(this.#location).catch(() => null);
		const receipt = authority?.purposeApprovals?.at(-1);
		const draft = (await readMissionPurpose(this.#harness, context).catch(() => undefined))?.loop.draft;
		if (!receipt || !draft || receipt.revision !== draft.revision || receipt.digest !== draft.digest) return;
		await this.reconcile(receipt.receiptId, context).catch(() => {});
	}

	/** Saves exact terms as the proposed revision; refused while operation is open, as an amendment would be. */
	async propose(request: Propose, context: Context): Promise<void> {
		const authority = await readMissionAuthority(this.#location);
		if (!authority) throw new Error("Configure the creator and purpose ceiling first.");
		const terms = validatePurposeTerms(request.terms, authority, this.#now());
		const formation = (await this.#harness.snapshot(MissionDoc, context))?.formation;
		const legacy = (await readMissionPurpose(this.#harness, context))?.purpose;
		await this.#harness.commit(async (tx) => {
			if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Service is held for maintenance.");
			const loop = (await tx.doc(MissionPurposeDoc)).loop;
			if (loop.draft?.requestId === request.requestId) return;
			refuseWhileOpen(loop);
			if (request.expectedRevision !== (loop.draft?.revision ?? loop.agreements.at(-1)?.revision ?? 0))
				throw new Error("Stale purpose revision; inspect the saved purpose again.");
			// One mission identity: the purpose continues the agreed one-shot mission when one exists.
			const missionId = loop.missionId ?? formation?.agreement?.missionId ?? legacy?.missionId ?? randomUUID();
			const revision = loop.nextRevision++;
			loop.missionId = missionId;
			loop.draft = {
				revision,
				terms,
				digest: purposeDigest(terms, missionId, revision, authority),
				requestId: request.requestId,
			};
		}, context);
	}

	/** Issues the developer's own receipt for the exact proposed digest, then records it. */
	async approveLocal(request: Approve, context: Context): Promise<void> {
		if (this.#location.kind !== "developer-local")
			throw new Error("Managed purpose approval requires the creator's own administrator command.");
		const authority = await readMissionAuthority(this.#location);
		const loop = (await readMissionPurpose(this.#harness, context))?.loop;
		if (!authority || !loop) throw new Error("Propose a purpose first.");
		const previous = authority.purposeApprovals?.find((item) => item.requestId === request.requestId);
		if (previous) {
			if (previous.revision !== request.revision || previous.digest !== request.digest)
				throw new Error("Conflicting approval request ID.");
			return this.reconcile(previous.receiptId, context);
		}
		refuseWhileOpen(loop);
		const draft = loop.draft;
		if (!draft || draft.revision !== request.revision || draft.digest !== request.digest)
			throw new Error("Stale purpose approval; inspect the exact proposal again.");
		const terms = validatePurposeTerms(draft.terms, authority, this.#now());
		if (purposeDigest(terms, loop.missionId!, draft.revision, authority) !== draft.digest)
			throw new Error("Creator authority changed; propose the purpose again.");
		const receipt: MissionApproval = {
			receiptId: randomUUID(),
			requestId: request.requestId,
			installationId: null,
			session: "default",
			missionId: loop.missionId!,
			revision: draft.revision,
			digest: draft.digest,
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: this.#now(),
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: process.getuid?.() ?? null },
		};
		await writeMissionAuthority(this.#location, withPurposeReceipt(authority, loop, receipt));
		await this.reconcile(receipt.receiptId, context);
	}

	/** Records the proposed purpose once the newest protected purpose receipt approves exactly it. */
	async reconcile(receiptId: string, context: Context): Promise<void> {
		const authority = await readMissionAuthority(this.#location);
		if (!authority) throw new Error("No authenticated mission authority is configured.");
		await this.#harness.commit(async (tx) => {
			if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Service is held for maintenance.");
			const loop = (await tx.doc(MissionPurposeDoc)).loop;
			const recorded = loop.agreements.find((item) => item.approval.receiptId === receiptId);
			if (recorded) return;
			refuseWhileOpen(loop);
			const draft = loop.draft;
			if (!draft) throw new Error("No exact proposed purpose awaits approval.");
			const terms = validatePurposeTerms(draft.terms, authority, this.#now());
			const receipt = matchingPurposeApproval(authority, receiptId, loop.missionId!, draft.revision, terms);
			if (!receipt || receipt.digest !== draft.digest)
				throw new Error("Purpose approval does not match this mission, revision, exact terms and creator.");
			recordPurposeAgreement(loop, {
				missionId: receipt.missionId,
				revision: receipt.revision,
				terms,
				digest: receipt.digest,
				approval: receipt,
			});
		}, context);
	}
}

/** The authority file with a new purpose receipt; the agreed one stays beside it until the new one is recorded. */
export function withPurposeReceipt(
	authority: MissionAuthority,
	loop: LoopState,
	receipt: MissionApproval,
): MissionAuthority {
	const agreed = loop.agreements.at(-1)?.approval.receiptId;
	const current = authority.purposeApprovals?.find((item) => item.receiptId === agreed);
	return { ...authority, purposeApprovals: current ? [current, receipt] : [receipt] };
}

// A purpose amendment changes what the open loop may admit; suspend or close first, as one-shot work is stopped first.
function refuseWhileOpen(loop: LoopState): void {
	if (loop.operation.state.status === "open")
		throw new Error("Suspend or close continuous operation before changing its purpose.");
}
