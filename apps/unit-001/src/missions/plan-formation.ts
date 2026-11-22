// Drafts and proposes exact mission plan revisions and records them once a protected plan receipt agrees one.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { type Harness, ProviderDoc, type Tx } from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import { type MissionLocation, readMissionAuthority, writeMissionAuthority } from "./authority.ts";
import type { MissionApproval, MissionAuthority, MissionRequest, PlanRequestBinding } from "./contract.ts";
import { matchingPlanApproval, planDigest, planReceiptsRecorded } from "./plan-authority.ts";
import { planHeadValid, planHistoryBound } from "./plan-gate.ts";
import { dismissReview, storeReview } from "./plan-review.ts";
import {
	MAX_PLAN_REVISIONS,
	MAX_PROPOSALS,
	type PlanProposal,
	type PlanState,
	readMissionPlan,
	storedPlan,
} from "./plan-state.ts";
import { missingPlanTerms, parsePlanTerms, planTermsDenial, reviewAllowanceDenial } from "./plan-terms.ts";
import type { LoopState } from "./purpose-loop.ts";
import { readMissionPurpose, storedLoop } from "./purpose.ts";
import { MissionRefusal } from "./refusal.ts";
import { purposeUnsettled, REVIEW_PROVIDER_PREFIX, storedReviewState, unresolvedTurn } from "./review-turn-state.ts";
import { MissionDoc } from "./state.ts";

/**
 * A plan receipt is known to be published but the owner has not recorded it yet. Never a refusal: the agreement
 * exists, and a retry with the same request ID only records it. A write that fails before publication is known is
 * not this error; its outcome stays unknown.
 */
export class MissionPlanIssued extends Error {
	readonly receiptId: string;

	constructor(receiptId: string, message: string) {
		super(message);
		this.name = "MissionPlanIssued";
		this.receiptId = receiptId;
	}
}

type Draft = Extract<MissionRequest, { operation: "plan-draft" }>;
type Propose = Extract<MissionRequest, { operation: "plan-propose" }>;
type Agree = Extract<MissionRequest, { operation: "plan-agree" }>;
type Prepare = Extract<MissionRequest, { operation: "prepare-plan" }>;

/**
 * The plan document's only writer: drafts, proposals, agreements and saved reviews. Agreeing a plan opens nothing.
 * Each proposal is an immutable snapshot that stays eligible until the head changes, so a later edit never revokes a
 * revision a creator is already reviewing; the protected head compare-and-swap decides which one is recorded.
 */
export class PlanFormation {
	readonly #harness: Harness;
	readonly #location: MissionLocation;
	readonly #now: () => number;

	constructor(harness: Harness, location: MissionLocation, now: () => number = Date.now) {
		this.#harness = harness;
		this.#location = location;
		this.#now = now;
	}

	/** Records a plan receipt issued before a crash; never creates a receipt. */
	async initialize(context: Context): Promise<void> {
		const authority = await readMissionAuthority(this.#location).catch(() => null);
		const receipt = authority?.planApprovals?.at(-1);
		const plan = await readMissionPlan(this.#harness, context).catch(() => undefined);
		if (!receipt || !plan || !proposalFor(plan, receipt.revision, receipt.digest)) return;
		await this.reconcile(receipt.receiptId, context).catch(() => {});
	}

	/** Saves complete plan terms as the next draft revision; the draft is replaced, never merged, and grants nothing. */
	async draft(request: Draft, context: Context): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const plan = await writablePlan(tx);
			if (request.reviewConversation !== null)
				// Read inside this commit: a revocation published while it was queued still closes the draft.
				await refuseOutsideReviewTurn(tx, plan, () => readMissionAuthority(this.#location).catch(() => null), request);
			if (plan.draft?.requestId === request.requestId) {
				if (!isDeepStrictEqual(plan.draft.terms, request.terms))
					throw new MissionRefusal("conflicting-request", "That request ID already saved other plan terms.");
				return;
			}
			if (request.expectedRevision !== (plan.draft?.revision ?? plan.agreed.at(-1)?.revision ?? 0))
				throw new MissionRefusal("stale-revision", "The plan changed since it was read; inspect it again.");
			if (request.savedBy === "bob" && plan.draft?.savedBy === "owner")
				throw new MissionRefusal("owner-draft", "The owner has a pending plan draft; Bob cannot replace it.");
			const review = request.fromReview === null ? null : plan.reviews.find((note) => note.reviewId === request.fromReview);
			if (review === undefined) throw new MissionRefusal("stale-revision", "That review note is no longer stored.");
			// A review answers one agreed head; a draft from an older one would silently rebase its findings.
			const head = plan.agreed.at(-1);
			if (review && (review.planRevision !== head?.revision || review.planDigest !== head.digest))
				throw new MissionRefusal("stale-revision", "That review covered an older plan revision; review again.");
			plan.missionId ??= await missionIdentity(tx);
			const revision = plan.nextRevision++;
			plan.draft = {
				revision,
				baseRevision: head?.revision ?? 0,
				status: "editing",
				terms: request.terms,
				digest: null,
				savedBy: request.savedBy,
				fromReview: request.fromReview,
				requestId: request.requestId,
			};
			if (review && review.disposition === null)
				review.disposition = { kind: "drafted", at: this.#now(), draftRevision: revision };
		}, context);
	}

	/**
	 * Freezes the draft as the exact proposed revision, bound to the current creator authority and agreed head, and keeps
	 * an immutable snapshot of it. Snapshots no receipt can ever agree (an older authority epoch) make room first.
	 */
	async propose(request: Propose, context: Context): Promise<void> {
		const authority = await readMissionAuthority(this.#location);
		if (!authority) throw new MissionRefusal("outside-authority", "Configure the mission creator first.");
		await this.#harness.commit(async (tx) => {
			const plan = await writablePlan(tx);
			const draft = plan.draft;
			if (!draft || draft.revision !== request.expectedRevision)
				throw new MissionRefusal("stale-revision", "The plan draft changed since it was read; inspect it again.");
			// No silent rebase: a draft written against an older head is saved again on the current one first.
			if (draft.baseRevision !== (plan.agreed.at(-1)?.revision ?? 0))
				throw new MissionRefusal("stale-revision", "The draft was written against an older agreed plan; save it again first.");
			const missing = missingPlanTerms(draft.terms);
			if (missing.length !== 0)
				throw new MissionRefusal("incomplete", `The plan draft still needs: ${missing.join(", ")}.`);
			if (plan.agreed.length >= MAX_PLAN_REVISIONS)
				throw new MissionRefusal("plan-limit", "The mission plan has reached its limit of agreed revisions.");
			const denial = planTermsDenial(draft.terms, await storedLoop(tx)) ?? reviewAllowanceDenial(draft.terms, authority);
			if (denial) throw new MissionRefusal("outside-authority", denial);
			const digest = planDigest(draft.terms, plan.missionId!, draft.revision, headDigest(plan), authority);
			draft.status = "proposed";
			draft.digest = digest;
			if (proposalFor(plan, draft.revision, digest)) return;
			pruneUnissuable(plan, authority);
			if (plan.proposals.length >= MAX_PROPOSALS)
				throw new MissionRefusal("plan-limit", "Too many proposed plan revisions await review; agree one first.");
			plan.proposals.push({
				revision: draft.revision,
				baseRevision: draft.baseRevision,
				previousDigest: headDigest(plan),
				// A fresh copy: the snapshot never shares structure with the draft that later edits replace.
				terms: parsePlanTerms(draft.terms),
				digest,
				requestId: request.requestId,
			});
		}, context);
	}

	/**
	 * Prepares one exact proposed snapshot for a protected publisher (the managed terminal), durably and idempotently by
	 * request ID, and returns it: the publisher validates exactly this snapshot before it writes any receipt. It is a
	 * private owner operation and never on the browser allowlist.
	 */
	async prepare(request: Prepare, context: Context): Promise<PlanProposal> {
		const authority = await readMissionAuthority(this.#location);
		if (!authority) throw new MissionRefusal("outside-authority", "Configure the mission creator first.");
		return this.#harness.commit(async (tx) => {
			const plan = await writablePlan(tx);
			const prior = plan.prepared.find((entry) => entry.requestId === request.requestId);
			if (prior && (prior.revision !== request.revision || prior.digest !== request.digest))
				throw new MissionRefusal("conflicting-request", "That request ID already prepared another plan revision.");
			if (!planHistoryBound(authority, plan))
				throw new MissionRefusal("unavailable", "Protected plan request history is unavailable; nothing was prepared.");
			const loop = await storedLoop(tx);
			const proposal = eligibleProposal(plan, authority, loop, request.revision, request.digest);
			if (!prior && plan.prepared.length >= MAX_PROPOSALS)
				throw new MissionRefusal("plan-limit", "Too many plan publications are prepared on this head; agree one first.");
			if (!prior) plan.prepared.push({ requestId: request.requestId, revision: request.revision, digest: request.digest });
			// A plain copy: stored values are only valid inside their commit.
			return { ...proposal, terms: parsePlanTerms(proposal.terms) };
		}, context);
	}

	/**
	 * Issues the developer's own receipt for an exact proposed snapshot, then records it. Every refusal comes before the
	 * receipt is published; afterwards a failure means issued and pending, and a retry with the same ID only records it.
	 */
	async agreeLocal(request: Agree, context: Context): Promise<void> {
		// The owner shares the service UID with the agent's tools, so on a managed host it never mints a receipt itself.
		if (this.#location.kind !== "developer-local")
			throw new MissionRefusal(
				"managed-requires-gateway",
				`Managed plan agreement uses the administrator command: sudo unit-001 mission plan approve --revision ${request.revision} --digest ${request.digest}`,
			);
		const authority = await readMissionAuthority(this.#location);
		if (!authority) throw new MissionRefusal("outside-authority", "Configure the mission creator first.");
		const plan = await readMissionPlan(this.#harness, context);
		// Every recorded revision and the retained receipts must still have their exact protected bindings before a
		// replay or a mint: a dropped binding would make an issued request ID look new.
		if (!planReceiptsRecorded(authority) || !planHistoryBound(authority, plan))
			throw new MissionRefusal("unavailable", "Protected plan request history is unavailable; nothing was agreed.");
		// The protected bindings, never owner history, decide whether a request ID was already issued.
		const previous = authority.planRequests?.find((binding) => binding.requestId === request.requestId);
		if (previous) {
			if (previous.revision !== request.revision || previous.digest !== request.digest)
				throw new MissionRefusal("conflicting-request", "That request ID already agreed another plan revision.");
			// Issued under an earlier creator authority: it can never be recorded now, and it is never reissued.
			if (previous.authorityRevision !== authority.revision)
				throw new Error("That plan agreement was issued under an earlier creator authority and cannot be recorded.");
			return this.#recordIssued(previous.receiptId, context);
		}
		if ((authority.planRequests?.length ?? 0) >= MAX_PLAN_REVISIONS)
			throw new MissionRefusal("plan-limit", "The mission plan has reached its limit of agreed revisions.");
		if ((await this.#harness.snapshot(MaintenanceDoc, context))?.current.state === "held")
			throw new MissionRefusal("held", "The service is held for maintenance.");
		if (!plan) throw new MissionRefusal("stale-revision", "No proposed plan has that revision; inspect the plan again.");
		// Compare-and-swap: the newest protected plan receipt must still be the recorded head's.
		const newest = authority.planApprovals?.at(-1);
		if ((newest?.receiptId ?? null) !== currentHeadReceipt(plan, authority))
			throw new MissionRefusal("stale-digest", "The protected plan changed; inspect the plan again.");
		const loop = (await readMissionPurpose(this.#harness, context))?.loop;
		const proposal = eligibleProposal(plan, authority, loop, request.revision, request.digest);
		const receipt: MissionApproval = {
			receiptId: randomUUID(),
			requestId: request.requestId,
			installationId: null,
			session: "default",
			missionId: plan.missionId!,
			revision: proposal.revision,
			digest: proposal.digest,
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: this.#now(),
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: process.getuid?.() ?? null },
		};
		await writeMissionAuthority(this.#location, withPlanReceipt(authority, newest, receipt));
		return this.#recordIssued(receipt.receiptId, context);
	}

	/**
	 * Records the snapshot the newest protected plan receipt agrees, by exact revision, digest and predecessor, whatever
	 * the current draft is; idempotent by receipt. A newer draft stays an editing draft on the old base, never rebased.
	 */
	async reconcile(receiptId: string, context: Context): Promise<void> {
		const authority = await readMissionAuthority(this.#location);
		if (!authority) throw new Error("No authenticated mission authority is configured.");
		await this.#harness.commit(async (tx) => {
			const plan = await writablePlan(tx);
			// Checked before the idempotent answer: a replay never reports success over a broken history.
			if (!planHistoryBound(authority, plan))
				throw new Error("Protected plan request history is unavailable; the receipt stays unrecorded.");
			if (plan.agreed.some((agreement) => agreement.approval.receiptId === receiptId)) return;
			// A receipt issued while open already closes admission through the gate; recording waits for suspend or close.
			if ((await storedLoop(tx))?.operation.state.status === "open")
				throw new Error("Suspend or close operation, then reconcile the plan.");
			const newest = authority.planApprovals?.at(-1);
			const proposal = newest && proposalFor(plan, newest.revision, newest.digest);
			const receipt =
				proposal &&
				matchingPlanApproval(
					authority,
					receiptId,
					plan.missionId!,
					proposal.revision,
					proposal.previousDigest,
					proposal.terms,
				);
			if (!proposal || !receipt || receipt.digest !== proposal.digest || proposal.previousDigest !== headDigest(plan))
				throw new Error("Plan receipt does not match a retained proposal, its predecessor, exact terms and creator.");
			plan.agreed.push({
				missionId: receipt.missionId,
				revision: receipt.revision,
				previousDigest: proposal.previousDigest,
				terms: proposal.terms,
				digest: receipt.digest,
				approval: receipt,
			});
			// Every other snapshot was proposed on the old head and can never be agreed now.
			plan.proposals = [];
			plan.prepared = [];
			if (plan.draft?.revision === proposal.revision) plan.draft = null;
			else if (plan.draft?.status === "proposed") {
				plan.draft.status = "editing";
				plan.draft.digest = null;
			}
		}, context);
	}

	/** Stores the review an explicit request asks for; built from stored facts, it makes no model request. */
	async review(requestId: string, context: Context): Promise<void> {
		await this.#harness.commit(async (tx) => {
			storeReview(await writablePlan(tx), await storedLoop(tx), requestId, this.#now());
		}, context);
	}

	/** Records the owner's dismissal of a stored review note; terms do not change. */
	async dismiss(reviewId: string, context: Context): Promise<void> {
		await this.#harness.commit(async (tx) => dismissReview(await writablePlan(tx), reviewId, this.#now()), context);
	}

	// Called only once publication is known: after this owner wrote the receipt, or on a durable replay.
	async #recordIssued(receiptId: string, context: Context): Promise<void> {
		try {
			await this.reconcile(receiptId, context);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new MissionPlanIssued(
				receiptId,
				`The plan agreement was issued but is not recorded yet (${reason}); retry with the same request ID.`,
			);
		}
	}
}

/**
 * The authority file with a new plan receipt and its request binding, written together; the current head's receipt
 * stays beside it until the new one is recorded.
 */
export function withPlanReceipt(
	authority: MissionAuthority,
	current: MissionApproval | undefined,
	receipt: MissionApproval,
): MissionAuthority {
	const binding: PlanRequestBinding = {
		requestId: receipt.requestId,
		receiptId: receipt.receiptId,
		missionId: receipt.missionId,
		revision: receipt.revision,
		digest: receipt.digest,
		authorityRevision: receipt.authorityRevision,
		issuedAt: receipt.approvedAt,
	};
	return {
		...authority,
		planApprovals: current ? [current, receipt] : [receipt],
		planRequests: [...(authority.planRequests ?? []), binding],
	};
}

// Plan changes read a validated document; a corrupted one changes nothing and the plan gate stays closed.
async function writablePlan(tx: Tx): Promise<PlanState> {
	if ((await tx.doc(MaintenanceDoc)).current.state === "held")
		throw new MissionRefusal("held", "The service is held for maintenance.");
	const plan = await storedPlan(tx);
	if (!plan) throw new Error("Stored mission plan records are invalid; the plan gate stays closed.");
	return plan;
}

function proposalFor(plan: PlanState, revision: number, digest: string): PlanProposal | undefined {
	return plan.proposals.find((proposal) => proposal.revision === revision && proposal.digest === digest);
}

// A draft saved from a review conversation is that turn's effect. The conversation is recognised by its stored provider
// session, not by the turn list, so a turn record that is missing or evicted fails closed instead of passing as an
// ordinary draft. The draft lands only while the turn runs under the current agreed head with a valid protected
// receipt, nothing of unknown outcome is open, the per-review, lifetime and spend allowances are not exceeded (spending
// exactly the cap is allowed: the last charged request may still draft), and only as an answer to that turn's note.
async function refuseOutsideReviewTurn(
	tx: Tx,
	plan: PlanState,
	readAuthority: () => Promise<MissionAuthority | null>,
	request: Draft,
): Promise<void> {
	const conversation = request.reviewConversation!;
	// The hold is already read in this same commit by `writablePlan`, which every plan write calls first.
	const refuse = () => new MissionRefusal("stale-revision", "This review turn can no longer save a draft.");
	// An unreadable provider record cannot show the conversation is not a review turn, so it fails closed.
	const provider = await tx.doc(ProviderDoc, conversation).catch(() => null);
	if (!provider) throw refuse();
	const session = provider.sessionId;
	if (!session?.startsWith(REVIEW_PROVIDER_PREFIX)) return;
	const reviews = await storedReviewState(tx);
	const turn = reviews?.turns.find((item) => item.conversation === conversation && item.providerSession === session);
	const head = plan.agreed.at(-1);
	const allowance = head?.terms.overall.reviewAllowance;
	const loop = await storedLoop(tx);
	const authority = await readAuthority();
	if (
		!reviews ||
		!turn ||
		turn.state.status !== "running" ||
		!head ||
		!allowance ||
		turn.planRevision !== head.revision ||
		!authority ||
		!planHeadValid(authority, plan) ||
		!loop ||
		purposeUnsettled(loop) ||
		reviews.turns.some(unresolvedTurn) ||
		request.fromReview !== turn.reviewId
	)
		throw refuse();
	const ledger = reviews.ledger;
	if (
		turn.attempts.length > allowance.maxRequestsPerReview ||
		ledger.requests > allowance.maxRequests ||
		(allowance.maxEstimatedCost !== null && ledger.estimatedCost + ledger.reservedCost > allowance.maxEstimatedCost)
	)
		throw refuse();
}

// The snapshot a receipt may agree now: retained, proposed on the current head, still bound to current authority,
// valid against the stored loop, and operation not open. Each refusal names why before anything is written.
function eligibleProposal(
	plan: PlanState,
	authority: MissionAuthority,
	loop: LoopState | undefined,
	revision: number,
	digest: string,
): PlanProposal {
	const proposal = proposalFor(plan, revision, digest);
	if (!proposal) throw new MissionRefusal("stale-revision", "No proposed plan has that revision and digest.");
	if (
		proposal.previousDigest !== headDigest(plan) ||
		planDigest(proposal.terms, plan.missionId!, revision, proposal.previousDigest, authority) !== digest
	)
		throw new MissionRefusal("stale-digest", "The plan head or creator authority changed; inspect the plan again.");
	if (loop?.operation.state.status === "open")
		throw new MissionRefusal("execution-active", "Suspend or close operation before agreeing a plan revision.");
	const denial = planTermsDenial(proposal.terms, loop) ?? reviewAllowanceDenial(proposal.terms, authority);
	if (denial) throw new MissionRefusal("outside-authority", denial);
	return proposal;
}

// After a creator authority rotation, snapshots bound to the old epoch can never be agreed: their digest no longer
// recomputes. They are dropped to recover capacity, except any a current-epoch receipt or binding names, so a pending
// issued receipt keeps the snapshot it agreed. Older-epoch bindings stay in the protected ledger, so no issued request
// record is discarded and its ID still resolves; its receipt can never be recorded under the new authority anyway.
function pruneUnissuable(plan: PlanState, authority: MissionAuthority): void {
	const named = (proposal: PlanProposal) =>
		[...(authority.planApprovals ?? []), ...(authority.planRequests ?? [])].some(
			(item) =>
				item.authorityRevision === authority.revision &&
				item.revision === proposal.revision &&
				item.digest === proposal.digest,
		);
	plan.proposals = plan.proposals.filter(
		(proposal) =>
			named(proposal) ||
			planDigest(proposal.terms, plan.missionId!, proposal.revision, proposal.previousDigest, authority) ===
				proposal.digest,
	);
	plan.prepared = plan.prepared.filter((entry) => proposalFor(plan, entry.revision, entry.digest));
}

// The head's receipt is the expected newest protected receipt only within its own authority epoch; after a rotation
// the current epoch holds no receipt yet, so a new revision on the old head can be agreed.
function currentHeadReceipt(plan: PlanState, authority: MissionAuthority): string | null {
	const head = plan.agreed.at(-1);
	return head && head.approval.authorityRevision === authority.revision ? head.approval.receiptId : null;
}

function headDigest(plan: PlanState): string | null {
	return plan.agreed.at(-1)?.digest ?? null;
}

// One mission identity: the plan continues the purpose or one-shot mission when one exists.
async function missionIdentity(tx: Tx): Promise<string> {
	const loop = await storedLoop(tx);
	return loop?.missionId ?? (await tx.doc(MissionDoc)).formation.agreement?.missionId ?? randomUUID();
}
