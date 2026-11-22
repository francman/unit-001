// Projects the mission plan for status: head and predecessor, draft, gate, review preview and saved reviews.
import type { MissionAuthority } from "./contract.ts";
import { planGate, planHeadValid, planIssued } from "./plan-gate.ts";
import { dueTriggers, reviewNote } from "./plan-review.ts";
import { type PlanAgreement, type PlanProposal, type PlanState, planAdopted } from "./plan-state.ts";
import { missingPlanTerms, planTermsDenial } from "./plan-terms.ts";
import type { PlanRevisionView, PlanView } from "./plan-wire.ts";
import { MAX_PURPOSE_WORKS } from "./purpose-authority.ts";
import type { LoopState } from "./purpose-loop.ts";

/** Builds the plan view from validated records and protected authority; reading it stores nothing. */
export function missionPlanView(
	plan: PlanState,
	loop: LoopState | undefined,
	authority: MissionAuthority | null,
	now: number,
): PlanView {
	const head = plan.agreed.at(-1);
	const adopting = head !== undefined || (authority !== null && planIssued(authority));
	const headValid = authority !== null && planHeadValid(authority, plan);
	// Without a readable loop the binding cannot be judged, but a broken head or history is still reported as such.
	const gate = !adopting
		? "not-adopted"
		: !authority
			? "receipt"
			: loop
				? planGate(authority, plan, loop)
				: !head
					? "head-missing"
					: headValid
						? "binding"
						: "receipt";
	const due = dueTriggers(plan, loop, now);
	const draft = plan.draft;
	return {
		missionId: plan.missionId,
		adopted: planAdopted(plan),
		head: head ? revisionView(head) : null,
		headValid,
		previous: plan.agreed.length > 1 ? revisionView(plan.agreed.at(-2)!) : null,
		history: plan.agreed
			.map((item) => ({ revision: item.revision, digest: item.digest, agreedAt: item.approval.approvedAt }))
			.reverse(),
		draft: draft && {
			revision: draft.revision,
			baseRevision: draft.baseRevision,
			status: draft.status,
			terms: draft.terms,
			digest: draft.digest,
			savedBy: draft.savedBy,
			fromReview: draft.fromReview,
			missing: draftMissing(draft, loop),
		},
		gate:
			gate === "not-adopted" || gate === "open"
				? { state: gate, reason: null }
				: { state: "closed", reason: gate },
		runs: { used: loop?.runs.length ?? 0, limit: MAX_PURPOSE_WORKS },
		due,
		preview: head && due[0] ? reviewNote(plan, head, loop, due[0], now) : null,
		reviews: [...plan.reviews].reverse(),
	};
}

// A proposed draft also lists why it can no longer be agreed against the current loop, for example a runnable binding
// to a purpose revision that is no longer agreed, so a writer reading status sees current validity.
function draftMissing(draft: NonNullable<PlanState["draft"]>, loop: LoopState | undefined): string[] {
	const missing = missingPlanTerms(draft.terms);
	const denial = draft.status === "proposed" ? planTermsDenial(draft.terms, loop) : undefined;
	return denial === undefined ? missing : [...missing, denial];
}

/** Projects one exact proposed snapshot as a proposed draft, for the private prepare answer. */
export function proposalDraftView(proposal: PlanProposal): NonNullable<PlanView["draft"]> {
	return {
		revision: proposal.revision,
		baseRevision: proposal.baseRevision,
		status: "proposed",
		terms: proposal.terms,
		digest: proposal.digest,
		// Proposing is an owner action, so a proposed snapshot is the owner's whoever saved its draft.
		savedBy: "owner",
		fromReview: null,
		missing: missingPlanTerms(proposal.terms),
	};
}

function revisionView(agreement: PlanAgreement): PlanRevisionView {
	return {
		revision: agreement.revision,
		digest: agreement.digest,
		previousDigest: agreement.previousDigest,
		terms: agreement.terms,
		agreedAt: agreement.approval.approvedAt,
		receiptId: agreement.approval.receiptId,
	};
}
