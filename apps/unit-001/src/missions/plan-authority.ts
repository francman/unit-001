// Binds mission plan revisions to protected receipts; owner documents never grant a plan.
import { createHash } from "node:crypto";
import type { MissionApproval, MissionAuthority } from "./contract.ts";
import type { PlanTerms } from "./plan-terms.ts";

/** Hashes exact plan terms bound to mission, revision, predecessor, installation, session, authority revision and creator. */
export function planDigest(
	terms: PlanTerms,
	missionId: string,
	revision: number,
	previousDigest: string | null,
	authority: Pick<MissionAuthority, "installationId" | "session" | "revision" | "creator">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: 1,
				kind: "unit.mission.plan",
				installationId: authority.installationId,
				session: authority.session,
				missionId,
				revision,
				previousDigest,
				authorityRevision: authority.revision,
				creator: { kind: authority.creator.kind, id: authority.creator.id, uid: authority.creator.uid },
				terms: canonicalPlan(terms),
			}),
		)
		.digest("hex");
}

/**
 * Finds the current plan receipt that agreed exactly these terms. Only the newest receipt counts, so issuing a new
 * revision closes the previous one at once; a managed receipt also needs the creator's own assent.
 */
export function matchingPlanApproval(
	authority: MissionAuthority,
	receiptId: string,
	missionId: string,
	revision: number,
	previousDigest: string | null,
	terms: PlanTerms,
): MissionApproval | undefined {
	const receipt = authority.planApprovals?.at(-1);
	if (!receipt || receipt.receiptId !== receiptId || !planReceiptsRecorded(authority)) return undefined;
	const managed = authority.installationId !== null;
	if (
		receipt.installationId !== authority.installationId ||
		receipt.session !== authority.session ||
		receipt.missionId !== missionId ||
		receipt.revision !== revision ||
		previousDigest !== (authority.planRequests?.at(-2)?.digest ?? null) ||
		receipt.authorityRevision !== authority.revision ||
		receipt.digest !== planDigest(terms, missionId, revision, previousDigest, authority) ||
		receipt.provenance !== (managed ? "managed-administrator" : "developer-local") ||
		receipt.approvedBy.kind !== (managed ? "local-creator" : "developer-local") ||
		receipt.approvedBy.uid !== authority.creator.uid ||
		(managed && (authority.creator.uid === null || authority.creator.uid === 0)) ||
		receipt.creator.kind !== authority.creator.kind ||
		receipt.creator.id !== authority.creator.id ||
		receipt.creator.uid !== authority.creator.uid
	)
		return undefined;
	return receipt;
}

/** Checks the retained receipts against the current creator epoch in the protected request ledger. */
export function planReceiptsRecorded(authority: MissionAuthority): boolean {
	const receipts = authority.planApprovals ?? [];
	const requests = (authority.planRequests ?? []).filter((binding) => binding.authorityRevision === authority.revision);
	if (receipts.length !== Math.min(2, requests.length)) return false;
	return receipts.every((receipt, index) => {
		const binding = requests[requests.length - receipts.length + index];
		return (
			receipt.receiptId === binding.receiptId &&
			receipt.requestId === binding.requestId &&
			receipt.missionId === binding.missionId &&
			receipt.revision === binding.revision &&
			receipt.digest === binding.digest &&
			receipt.authorityRevision === binding.authorityRevision &&
			receipt.approvedAt === binding.issuedAt
		);
	});
}

// Fixed key order, so the digest depends on the terms and never on how a client ordered its JSON.
function canonicalPlan(terms: PlanTerms): PlanTerms {
	return {
		overall: {
			purpose: terms.overall.purpose,
			scope: terms.overall.scope,
			askFirst: terms.overall.askFirst,
			reviewEveryMs: terms.overall.reviewEveryMs,
		},
		strategics: terms.strategics.map((item) => ({
			id: item.id,
			title: item.title,
			intent: item.intent,
			signals: item.signals,
			priority: item.priority,
		})),
		tacticals: terms.tacticals.map((item) => ({
			id: item.id,
			strategic: item.strategic,
			objective: item.objective,
			successCriteria: item.successCriteria,
			priority: item.priority,
			deadlineAt: item.deadlineAt,
			mode: item.mode,
			binding:
				item.binding === null
					? null
					: {
							missionId: item.binding.missionId,
							purposeRevision: item.binding.purposeRevision,
							purposeDigest: item.binding.purposeDigest,
						},
		})),
	};
}
