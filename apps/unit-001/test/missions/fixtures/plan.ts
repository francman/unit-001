// Builds mission plan fixtures: terms, a loop with one agreed purpose, and protected authority agreeing a plan head.
import type { MissionApproval, MissionAuthority } from "../../../src/missions/contract.ts";
import { planDigest } from "../../../src/missions/plan-authority.ts";
import type { PlanAgreement, PlanState } from "../../../src/missions/plan-state.ts";
import type { PlanTactical, PlanTerms } from "../../../src/missions/plan-terms.ts";
import { initialLoop, type LoopState, type PurposeReceiptAgreement } from "../../../src/missions/purpose-loop.ts";

export const MISSION = "mission-1";
export const PURPOSE_DIGEST = "a".repeat(64);

/** A complete plan: one strategic, one runnable tactical bound to purpose revision 1, one planned tactical. */
export function planTerms(overrides: Partial<PlanTerms> = {}): PlanTerms {
	return {
		overall: { purpose: "Keep the reports current", scope: "The workspace", askFirst: [], reviewEveryMs: 10_000, reviewAllowance: null },
		strategics: [{ id: "reports", title: "Reports", intent: "Fresh reports", signals: ["Owner reads them"], priority: "high" }],
		tacticals: [runnable(), planned()],
		...overrides,
	};
}

export function runnable(overrides: Partial<PlanTactical> = {}): PlanTactical {
	return {
		id: "weekly",
		strategic: "reports",
		objective: "Write the weekly report",
		successCriteria: ["reports/a.txt matches"],
		priority: "normal",
		deadlineAt: null,
		mode: "runnable",
		binding: { missionId: MISSION, purposeRevision: 1, purposeDigest: PURPOSE_DIGEST },
		...overrides,
	};
}

export function planned(overrides: Partial<PlanTactical> = {}): PlanTactical {
	return {
		id: "readme",
		strategic: "reports",
		objective: "Improve the README",
		successCriteria: ["The owner finds it clearer"],
		priority: "low",
		deadlineAt: null,
		mode: "planned",
		binding: null,
		...overrides,
	};
}

/** A loop holding one agreed purpose revision with the given work digests (only the fields plan code reads). */
export function loopWithPurpose(works: string[] = ["w1"]): LoopState {
	const loop = initialLoop();
	loop.missionId = MISSION;
	loop.agreements.push({
		missionId: MISSION,
		revision: 1,
		digest: PURPOSE_DIGEST,
		terms: {
			purpose: "p",
			scope: "s",
			reviewEveryMs: 1_000,
			works: works.map((path) => ({
				kind: "artifact-digest",
				path: `reports/${path}.txt`,
				sha256: "b".repeat(64),
				instructions: "",
				maxCycles: 2,
				maxRequests: 2,
				maxRetries: 0,
				maxConsecutiveNoProgress: 2,
			})),
			lifetime: { maxWorkItems: 4, maxCycles: 6, maxRequests: 6, deadlineAt: 100_000 },
		},
		// Plan code reads only the revision, mission and digest of the receipt copy.
	} as unknown as PurposeReceiptAgreement);
	return loop;
}

/** Developer-local authority with one creator; plan fields are added by `agreePlan`. */
export function authority(): MissionAuthority {
	return {
		schemaVersion: 1,
		installationId: null,
		session: "default",
		revision: 1,
		creator: { kind: "human", id: "creator", uid: 501 },
		ceiling: {
			allowedTools: [],
			maxCycles: 1,
			maxRequests: 1,
			maxRetries: 0,
			maxConsecutiveNoProgress: 1,
			maxDurationMs: 1,
		},
		approvals: [],
	};
}

/** Agrees `terms` as the next plan revision: a receipt and binding in authority, the agreement in the plan. */
export function agreePlan(auth: MissionAuthority, plan: PlanState, terms: PlanTerms, approvedAt = 1_000): PlanAgreement {
	const revision = plan.nextRevision++;
	const previousDigest = plan.agreed.at(-1)?.digest ?? null;
	const digest = planDigest(terms, MISSION, revision, previousDigest, auth);
	const receipt: MissionApproval = {
		receiptId: `receipt-${revision}`,
		requestId: `agree-${revision}`,
		installationId: null,
		session: "default",
		missionId: MISSION,
		revision,
		digest,
		creator: auth.creator,
		authorityRevision: auth.revision,
		approvedAt,
		provenance: "developer-local",
		approvedBy: { kind: "developer-local", uid: auth.creator.uid },
	};
	auth.planApprovals = [...(auth.planApprovals ?? []).slice(-1), receipt];
	auth.planRequests = [
		...(auth.planRequests ?? []),
		{ requestId: receipt.requestId, receiptId: receipt.receiptId, missionId: MISSION, revision, digest, authorityRevision: 1, issuedAt: approvedAt },
	];
	const agreement: PlanAgreement = { missionId: MISSION, revision, previousDigest, terms, digest, approval: receipt };
	plan.missionId = MISSION;
	plan.agreed.push(agreement);
	return agreement;
}

export function emptyPlan(): PlanState {
	return {
		missionId: null,
		nextRevision: 1,
		draft: null,
		proposals: [],
		prepared: [],
		agreed: [],
		reviews: [],
		reviewKeys: [],
		reviewRequests: [],
	};
}
