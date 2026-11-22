// Stores the mission plan beside the purpose records: one pending draft, agreed revisions and saved review notes.
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { parseMissionApproval } from "./authority.ts";
import { type MissionApproval, missionObject } from "./contract.ts";
import { planDigest } from "./plan-authority.ts";
import type { ReviewNote } from "./plan-review.ts";
import { type PlanTerms, parsePlanTerms } from "./plan-terms.ts";
import { parseReviewNote } from "./plan-wire.ts";

/** One agreed plan revision; valid only as exactly what its embedded protected receipt approved. */
export type PlanAgreement = {
	missionId: string;
	revision: number;
	previousDigest: string | null;
	terms: PlanTerms;
	digest: string;
	approval: MissionApproval;
};

/** The one pending plan draft; `baseRevision` is the agreed head it was written against (0 before adoption). */
export type PlanDraft = {
	revision: number;
	baseRevision: number;
	status: "editing" | "proposed";
	terms: PlanTerms;
	digest: string | null;
	savedBy: "bob" | "owner";
	fromReview: string | null;
	requestId: string;
};

/**
 * One proposed revision exactly as it was frozen for review. Never edited: a later draft makes a new revision, and the
 * snapshot stays eligible for agreement until the head changes, so an edit never revokes a review already shown.
 */
export type PlanProposal = {
	revision: number;
	baseRevision: number;
	previousDigest: string | null;
	terms: PlanTerms;
	digest: string;
	requestId: string;
};

/** Plan records; additive, so a predecessor that does not know this document ignores it. */
export type PlanState = {
	missionId: string | null;
	nextRevision: number;
	draft: PlanDraft | null;
	/** Proposed snapshots on the current head, oldest first; cleared when a revision is recorded. */
	proposals: PlanProposal[];
	/** Snapshots a terminal prepared for publication, by its request ID. */
	prepared: { requestId: string; revision: number; digest: string }[];
	agreed: PlanAgreement[];
	reviews: ReviewNote[];
	/** Review trigger keys already used, newest last, so a key evicted from `reviews` never fires again. */
	reviewKeys: string[];
	/** Review-now request IDs and the note each produced, so a replay returns the same note. */
	reviewRequests: { requestId: string; reviewId: string }[];
};

/** Most agreed plan revisions kept; at the cap propose is refused (`plan-limit`), nothing is evicted. */
export const MAX_PLAN_REVISIONS = 32;

/** Most saved review notes; the oldest is dropped first. */
export const MAX_REVIEWS = 12;

/** Most proposed snapshots kept on one head; at the cap propose is refused (`plan-limit`) after pruning. */
export const MAX_PROPOSALS = 8;

const MAX_REVIEW_KEYS = 64;
const MAX_REVIEW_REQUESTS = 32;

/** The plan document: absent plans read as the empty state, which leaves the plan gate off. */
export const MissionPlanDoc = defineDoc<PlanState>({
	kind: "unit.mission.plan",
	version: 2,
	scope: "session",
	initial: () => ({
		missionId: null,
		nextRevision: 1,
		draft: null,
		proposals: [],
		prepared: [],
		agreed: [],
		reviews: [],
		reviewKeys: [],
		reviewRequests: [],
	}),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`Unsupported mission plan document version ${fromVersion}.`);
		// Version one had no review allowance; null means none and is left out of the digest, so agreements still verify.
		const plan = value as PlanState;
		const withAllowance = (terms: PlanTerms): PlanTerms => ({
			...terms,
			overall: { ...terms.overall, reviewAllowance: null },
		});
		return {
			...plan,
			draft: plan.draft && { ...plan.draft, terms: withAllowance(plan.draft.terms) },
			proposals: plan.proposals.map((proposal) => ({ ...proposal, terms: withAllowance(proposal.terms) })),
			agreed: plan.agreed.map((agreement) => ({ ...agreement, terms: withAllowance(agreement.terms) })),
		};
	},
	checkpointWhen: () => true,
});

/** Reads the stored plan after full validation; throws on a malformed or self-inconsistent document. */
export async function readMissionPlan(harness: Harness, context: Context): Promise<PlanState | undefined> {
	const saved = await harness.snapshot(MissionPlanDoc, context);
	if (saved !== undefined) checkPlanState(saved);
	return saved;
}

/**
 * The stored plan validated inside the caller's transaction; undefined when it cannot be read (for example a newer
 * document version) or fails validation. That closes the gate without failing the caller's commit, so a restrictive
 * change such as an acknowledgment still lands.
 */
export async function storedPlan(tx: Tx): Promise<PlanState | undefined> {
	try {
		return checkPlanState(await tx.doc(MissionPlanDoc));
	} catch {
		return undefined;
	}
}

/** Whether the owner has adopted the plan: some revision is agreed and recorded. */
export function planAdopted(plan: PlanState): boolean {
	return plan.agreed.length !== 0;
}

/** Records one more used review key, newest kept. */
export function rememberReviewKey(plan: PlanState, key: string): void {
	plan.reviewKeys.push(key);
	if (plan.reviewKeys.length <= MAX_REVIEW_KEYS) return;
	// Only keys that can never fire again are dropped: another revision's, or a cadence window already past. Within one
	// revision the live keys stay well under the bound (32 runs, 6 tacticals, runs-low, one cadence window).
	const head = plan.agreed.at(-1)?.revision;
	const windows = plan.reviewKeys.filter((item) => item.startsWith(`${head}:cadence:`));
	const latest = windows.at(-1);
	plan.reviewKeys = plan.reviewKeys.filter(
		(item) => item.startsWith(`${head}:`) && (!item.startsWith(`${head}:cadence:`) || item === latest),
	);
	if (plan.reviewKeys.length > MAX_REVIEW_KEYS) throw new Error("Review keys exceed their bound; nothing was stored.");
}

/** Saves a review note and its request, dropping the oldest beyond the bounds. */
export function saveReview(plan: PlanState, note: ReviewNote, requestId: string | null): void {
	plan.reviews.push(note);
	if (plan.reviews.length > MAX_REVIEWS) plan.reviews.shift();
	rememberReviewKey(plan, note.key);
	if (requestId === null) return;
	plan.reviewRequests.push({ requestId, reviewId: note.reviewId });
	if (plan.reviewRequests.length > MAX_REVIEW_REQUESTS) plan.reviewRequests.shift();
}

/**
 * Validates a stored plan. Durable returns same-version fields as stored, so each agreed revision must rebuild from
 * its receipt copy, chain to its predecessor's digest, and count up; the draft and notes must parse.
 */
export function checkPlanState(value: unknown): PlanState {
	const plan = missionObject(value) as PlanState;
	if (
		!Array.isArray(plan.agreed) ||
		!Array.isArray(plan.proposals) ||
		!Array.isArray(plan.prepared) ||
		plan.proposals.length > MAX_PROPOSALS ||
		plan.prepared.length > MAX_PROPOSALS ||
		!Array.isArray(plan.reviews) ||
		!Array.isArray(plan.reviewKeys) ||
		!Array.isArray(plan.reviewRequests) ||
		plan.agreed.length > MAX_PLAN_REVISIONS ||
		plan.reviews.length > MAX_REVIEWS ||
		plan.reviewKeys.length > MAX_REVIEW_KEYS ||
		plan.reviewRequests.length > MAX_REVIEW_REQUESTS ||
		!Number.isSafeInteger(plan.nextRevision)
	)
		throw new Error("Invalid stored mission plan.");
	let previous: PlanAgreement | null = null;
	for (const agreement of plan.agreed) {
		const exact = parseAgreement(agreement);
		if (
			exact.missionId !== plan.missionId ||
			exact.previousDigest !== (previous?.digest ?? null) ||
			(previous !== null && exact.revision <= previous.revision)
		)
			throw new Error("Invalid stored plan history.");
		previous = exact;
	}
	if (plan.draft !== null) checkDraft(plan.draft, plan.nextRevision);
	for (const proposal of plan.proposals) checkProposal(proposal, plan.nextRevision, previous?.digest ?? null);
	if (new Set(plan.proposals.map((proposal) => proposal.revision)).size !== plan.proposals.length)
		throw new Error("Invalid stored plan proposals.");
	for (const entry of plan.prepared) {
		const input = missionObject(entry);
		if (
			Object.keys(input).length !== 3 ||
			typeof entry.requestId !== "string" ||
			!plan.proposals.some((item) => item.revision === entry.revision && item.digest === entry.digest)
		)
			throw new Error("Invalid stored prepared plan.");
	}
	if ((previous?.revision ?? 0) >= plan.nextRevision) throw new Error("Invalid stored plan revision counter.");
	// Saved notes, keys and request IDs are shown and replayed: each must be exactly its closed, bounded shape.
	for (const note of plan.reviews)
		if (!isDeepStrictEqual(parseReviewNote(note), note)) throw new Error("Invalid stored review note.");
	if (plan.reviewKeys.some((key) => typeof key !== "string" || key.length > 400))
		throw new Error("Invalid stored review keys.");
	for (const entry of plan.reviewRequests) {
		const input = missionObject(entry);
		if (Object.keys(input).length !== 2 || typeof input.requestId !== "string" || typeof input.reviewId !== "string")
			throw new Error("Invalid stored review request.");
	}
	return plan;
}

// A snapshot is exactly its closed shape and was proposed on the recorded head.
function checkProposal(proposal: PlanProposal, nextRevision: number, headDigest: string | null): void {
	const input = missionObject(proposal);
	const fields = ["revision", "baseRevision", "previousDigest", "terms", "digest", "requestId"];
	if (
		Object.keys(input).length !== fields.length ||
		Object.keys(input).some((key) => !fields.includes(key)) ||
		!isDeepStrictEqual(parsePlanTerms(input.terms), input.terms) ||
		!Number.isSafeInteger(proposal.revision) ||
		proposal.revision < 1 ||
		proposal.revision >= nextRevision ||
		!Number.isSafeInteger(proposal.baseRevision) ||
		proposal.previousDigest !== headDigest ||
		typeof proposal.digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(proposal.digest) ||
		typeof proposal.requestId !== "string"
	)
		throw new Error("Invalid stored plan proposal.");
}

// The draft is exactly its closed shape: a proposed draft carries its digest, an editing one none.
function checkDraft(draft: PlanDraft, nextRevision: number): void {
	const input = missionObject(draft);
	const fields = ["revision", "baseRevision", "status", "terms", "digest", "savedBy", "fromReview", "requestId"];
	if (
		Object.keys(input).length !== fields.length ||
		Object.keys(input).some((key) => !fields.includes(key)) ||
		!isDeepStrictEqual(parsePlanTerms(input.terms), input.terms) ||
		!Number.isSafeInteger(draft.revision) ||
		draft.revision < 1 ||
		draft.revision >= nextRevision ||
		!Number.isSafeInteger(draft.baseRevision) ||
		draft.baseRevision < 0 ||
		(draft.status !== "editing" && draft.status !== "proposed") ||
		(draft.status === "proposed") !== (typeof draft.digest === "string" && /^[0-9a-f]{64}$/.test(draft.digest)) ||
		(draft.status === "editing" && draft.digest !== null) ||
		(draft.savedBy !== "bob" && draft.savedBy !== "owner") ||
		(draft.fromReview !== null && typeof draft.fromReview !== "string") ||
		typeof draft.requestId !== "string"
	)
		throw new Error("Invalid stored plan draft.");
}

function parseAgreement(value: unknown): PlanAgreement {
	const input = missionObject(value);
	const terms = parsePlanTerms(input.terms);
	const approval = parseMissionApproval(input.approval);
	const previousDigest = input.previousDigest === null ? null : String(input.previousDigest);
	if (approval.session !== "default") throw new Error("Invalid stored plan agreement.");
	const exact: PlanAgreement = {
		missionId: approval.missionId,
		revision: approval.revision,
		previousDigest,
		terms,
		digest: planDigest(terms, approval.missionId, approval.revision, previousDigest, {
			installationId: approval.installationId,
			session: approval.session,
			revision: approval.authorityRevision,
			creator: approval.creator,
		}),
		approval,
	};
	if (approval.digest !== exact.digest || !isDeepStrictEqual(value, exact))
		throw new Error("Invalid stored plan agreement.");
	return exact;
}
