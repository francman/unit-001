// Decides whether an adopted mission plan still permits the open purpose operation; it only ever restricts.
import type { MissionAuthority } from "./contract.ts";
import { matchingPlanDigest } from "./plan-authority.ts";
import type { PlanState } from "./plan-state.ts";
import { type LoopState, loopAgreement } from "./purpose-loop.ts";

/** Why the plan closes admission; `not-adopted` and `open` are the two states that do not. */
export type PlanGateReason = "receipt" | "binding" | "reopen-needed" | "head-missing";

/**
 * The plan's admission decision for the open operation, read with the caller's protected authority and loop. The gate
 * applies once any protected plan receipt exists or any revision is recorded, so an owner crash between publishing the
 * first receipt and recording it keeps legacy admission closed. While it applies, admission needs all of: the newest
 * protected plan receipt agrees the recorded head, the head's runnable tactical binds exactly the open purpose
 * revision, and the protected open intent was issued under exactly that head. Without a readable loop the binding
 * cannot be judged, so an otherwise valid head reads as `binding`; a broken head or history is still reported as such.
 */
export function planGate(
	authority: MissionAuthority,
	plan: PlanState | undefined,
	loop: LoopState | undefined,
): "not-adopted" | "open" | PlanGateReason {
	// A stored plan that fails validation cannot show that the plan permits anything.
	if (plan === undefined) return "head-missing";
	const head = plan.agreed.at(-1);
	// Any retained receipt or request record is evidence a plan was issued, even after a rotation cleared receipts.
	if (!head) return planIssued(authority) ? "head-missing" : "not-adopted";
	if (!planHeadValid(authority, plan)) return "receipt";
	if (loop === undefined) return "binding";
	const state = loop.operation.state;
	const binding = head.terms.tacticals.find((tactical) => tactical.mode === "runnable")?.binding;
	if (!binding || binding.missionId !== loop.missionId) return "binding";
	// Closed operation admits nothing anyway; status then shows whether an Open under this head could run.
	if (state.status === "closed")
		return loopAgreement(loop, binding.purposeRevision)?.digest === binding.purposeDigest ? "reopen-needed" : "binding";
	if (binding.purposeRevision !== state.purposeRevision || binding.purposeDigest !== state.purposeDigest)
		return "binding";
	// Recorded when the open was issued, never inferred: replaying an older open cannot arm a newer head.
	if (authority.operationIntent?.planDigest !== head.digest) return "reopen-needed";
	return "open";
}

/**
 * Whether every recorded plan revision, across all creator authority epochs, still has its exact protected request
 * binding. A dropped binding would let an issued request ID look new, so plan admission, preparation, recording and
 * agreement all require it.
 */
export function planHistoryBound(authority: MissionAuthority, plan: PlanState | undefined): boolean {
	const bindings = authority.planRequests ?? [];
	return (plan?.agreed ?? []).every(({ approval }) =>
		bindings.some(
			(binding) =>
				binding.receiptId === approval.receiptId &&
				binding.requestId === approval.requestId &&
				binding.missionId === approval.missionId &&
				binding.revision === approval.revision &&
				binding.digest === approval.digest &&
				binding.authorityRevision === approval.authorityRevision &&
				binding.issuedAt === approval.approvedAt,
		),
	);
}

/**
 * Whether the recorded head is the plan protected authority agrees now: every recorded revision keeps its exact
 * binding and the newest protected receipt agrees the head. Independent of the loop, so status can show it alone. The
 * plan is one `checkPlanState` accepted, which already hashed the head's terms to its stored digest.
 */
export function planHeadValid(authority: MissionAuthority, plan: PlanState): boolean {
	const head = plan.agreed.at(-1);
	return (
		head !== undefined &&
		planHistoryBound(authority, plan) &&
		matchingPlanDigest(
			authority,
			head.approval.receiptId,
			head.missionId,
			head.revision,
			head.previousDigest,
			head.digest,
		) !== undefined
	);
}

/** Whether protected authority shows any plan was ever issued: a retained receipt or request record. */
export function planIssued(authority: MissionAuthority): boolean {
	return (authority.planApprovals?.length ?? 0) !== 0 || (authority.planRequests?.length ?? 0) !== 0;
}
