// The size limits of the mission plan projection, in one dependency-free file the owner wire and the browser page both import.

/** Most review turns the owner retains and status lists; an unresolved turn is never dropped. */
export const MAX_REVIEW_TURNS = 16;

/** Most due review triggers status lists; the producer keeps the most urgent ones, so a valid status always parses. */
export const MAX_DUE_TRIGGERS = 16;

/** Limits of the plan projection that status carries, beyond the review turn and trigger counts above. */
export const PLAN_PROJECTION_LIMITS = {
	/** Agreed revisions the status history lists, newest first. */
	history: 32,
	/** Recorded review notes status lists. */
	reviews: 12,
	/** The plan's lifetime run count and its cap; the owner's purpose-work cap. */
	runs: 32,
	/** Entries of a draft's missing-terms list, and the length of each. */
	missing: 64,
	missingText: 200,
	/** A review note: items, uncertainty lines, and the run ids and block reasons of one item. */
	noteItems: 16,
	uncertainty: 64,
	uncertaintyText: 400,
	itemRunIds: 32,
	itemBlockReasons: 32,
	blockReasonText: 200,
	/** The text of a trigger key, a run id and a plan item id inside a review note. */
	keyText: 400,
	itemIdText: 64,
} as const;

/** Limits of authored plan terms, as the owner enforces them when it parses a draft. */
export const PLAN_TERMS_LIMITS = {
	strategics: 3,
	tacticals: 6,
	/** Most model requests one review turn may make. */
	requestsPerReview: 4,
	purposeText: 4096,
	scopeText: 4096,
	askFirst: 32,
	askFirstText: 2000,
	titleText: 200,
	intentText: 2048,
	signals: 16,
	signalText: 1000,
	objectiveText: 2048,
	successCriteria: 16,
	criterionText: 1000,
	/** UTF-8 bytes of the whole terms document. */
	termsBytes: 65536,
} as const;
