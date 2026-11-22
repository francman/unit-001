// Closed browser projection for Missions v2; no protected authority records or write requests.

type Priority = "high" | "normal" | "low";

/** Model review caps; null in the terms keeps reviews deterministic. */
export interface ReviewAllowance {
	maxRequests: number;
	maxRequestsPerReview: number;
	maxEstimatedCost: number | null;
}

/** Current review caps and lifetime usage across plan revisions. */
export interface ReviewAllowanceView extends ReviewAllowance {
	requests: number;
	estimatedCost: number;
	reservedCost: number;
}

/** The complete three-level plan terms, independent of approval and admission. */
export interface PlanTerms {
	overall: {
		purpose: string;
		scope: string;
		askFirst: readonly string[];
		reviewEveryMs: number;
		reviewAllowance: ReviewAllowance | null;
	};
	strategics: readonly { id: string; title: string; intent: string; signals: readonly string[]; priority: Priority }[];
	tacticals: readonly ({
		id: string;
		strategic: string;
		objective: string;
		successCriteria: readonly string[];
		priority: Priority;
		deadlineAt: number | null;
	} & (
		| { mode: "runnable"; binding: { missionId: string; purposeRevision: number; purposeDigest: string } }
		| { mode: "parked" | "planned"; binding: null }
	))[];
}

/** A recorded agreement, with exact terms and the receipt that recorded it. */
export interface PlanRevisionView {
	revision: number;
	digest: string;
	previousDigest: string | null;
	terms: PlanTerms;
	agreedAt: number;
	receiptId: string;
}

/** A computed cause for reviewing the plan; its key identifies the deduplication window. */
export interface ReviewTrigger {
	kind: "cadence" | "completed" | "blocked" | "runs-low" | "deadline-near" | "owner";
	key: string;
	subject: string | null;
}

/** Public review turn evidence, without provider or conversation identifiers. */
export type ReviewTurnView = {
	key: string;
	planRevision: number;
	trigger: ReviewTrigger;
	reviewId: string | null;
	requests: number;
	at: number;
} & (
	| { state: "running"; reason: null; draftRevision: null }
	| { state: "done"; reason: null; draftRevision: number | null }
	| { state: "skipped"; reason: "budget" | "hold" | "unsettled"; draftRevision: null }
	| { state: "blocked"; reason: "unknown_request_outcome" | "turn_failed" | "authority"; draftRevision: null }
);

/** A deterministic review snapshot, either computed and unsaved or recorded by the owner. */
export interface ReviewNote {
	reviewId: string;
	key: string;
	trigger: ReviewTrigger;
	planRevision: number;
	planDigest: string;
	window: { from: number; to: number };
	createdAt: number;
	outcome: "no-change" | "attention";
	items: readonly {
		id: string;
		level: "strategic" | "tactical" | "legacy";
		status: "on-track" | "at-risk" | "blocked" | "done" | "planned" | "parked";
		verifiedWorks: number;
		listedWorks: number;
		runIds: readonly string[];
		blockReasons: readonly string[];
		unsettled: number;
		deadlineAt: number | null;
	}[];
	facts: {
		runsUsed: number;
		runsLimit: number;
		cycles: number;
		maxCycles: number;
		requests: number;
		maxRequests: number;
		estimatedCost: number;
		maxEstimatedCost: number | null;
	};
	uncertainty: readonly string[];
	disposition: { kind: "dismissed" | "drafted"; at: number; draftRevision: number | null } | null;
}

/** Recorded plan, receipt validity, admission gate, and reviews as separate facts. */
export interface PlanView {
	missionId: string | null;
	adopted: boolean;
	head: PlanRevisionView | null;
	headValid: boolean;
	previous: PlanRevisionView | null;
	history: readonly Pick<PlanRevisionView, "revision" | "digest" | "agreedAt">[];
	draft: {
		revision: number;
		baseRevision: number;
		status: "editing" | "proposed";
		terms: PlanTerms;
		digest: string | null;
		savedBy: "bob" | "owner";
		fromReview: string | null;
		missing: readonly string[];
	} | null;
	gate: { state: "not-adopted" | "open" | "closed"; reason: "receipt" | "binding" | "reopen-needed" | "head-missing" | null };
	runs: { used: number; limit: 32 };
	allowance: ReviewAllowanceView | null;
	turns: readonly ReviewTurnView[];
	blocker: ReviewTurnView | null;
	due: readonly ReviewTrigger[];
	preview: ReviewNote | null;
	reviews: readonly ReviewNote[];
}
