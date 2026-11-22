// Defines bounded mission formation data without granting execution authority.

import type { MissionExecutionView } from "./execution-view.ts";
import type { MissionPurposeView } from "./purpose-view.ts";
import type { MissionPolicy } from "./state.ts";

// The managed Linux host approves only this application's shipped actions, independently of owner-provided text.
export const MANAGED_MISSION_ACTIONS = [
	"read",
	"write",
	"edit",
	"bash",
	"unit_status",
	"unit_inspect_os",
	"unit_inspect",
	"remember",
	"recall",
	"forget",
	"stats",
	"unit_mission_status",
] as const;

export type MissionCreator = {
	kind: "human" | "elder" | "organization";
	id: string;
	uid: number | null;
};

export type MissionTerms = {
	objective: string;
	scope: string;
	successCriteria: string[];
	policy: MissionPolicy;
	approvalBoundary: string[];
	reviewEveryMs: number;
};

export type MissionDraftTerms = Omit<Partial<MissionTerms>, "policy"> & { policy?: Partial<MissionPolicy> };

export type MissionDraft = {
	missionId: string;
	revision: number;
	status: "editing" | "proposed";
	terms: MissionDraftTerms;
	digest: string | null;
};

export type MissionApproval = {
	receiptId: string;
	requestId: string;
	installationId: string | null;
	session: string;
	missionId: string;
	revision: number;
	digest: string;
	creator: MissionCreator;
	authorityRevision: number;
	approvedAt: number;
	provenance: "managed-administrator" | "developer-local";
	approvedBy: { kind: "local-creator" | "host-administrator" | "developer-local"; uid: number | null };
};

export type MissionAgreement = {
	missionId: string;
	revision: number;
	terms: MissionTerms;
	digest: string;
	approval: MissionApproval;
	execution: "not-implemented";
};

export type MissionFormation = {
	nextRevision: number;
	draft: MissionDraft | null;
	agreement: MissionAgreement | null;
	lastOperation: { requestId: string; digest: string; revision: number } | null;
};

export type MissionCeiling = {
	allowedTools: string[];
	maxCycles: number;
	maxRequests: number;
	maxRetries: number;
	maxConsecutiveNoProgress: number;
	maxDurationMs: number;
	maxEstimatedCost?: number;
};

export type MissionAuthority = {
	schemaVersion: 1;
	installationId: string | null;
	session: "default";
	revision: number;
	creator: MissionCreator;
	ceiling: MissionCeiling;
	approvals: MissionApproval[];
	executionIntent?: MissionExecutionIntent;
	purposeCeiling?: PurposeCeiling;
	purposeApprovals?: MissionApproval[];
	operationIntent?: OperationIntent;
	operationAcknowledgments?: OperationAcknowledgment[];
	browserAgreement?: BrowserAgreementGrant;
};

/**
 * The administrator's opt-in for the creator to agree from the browser through the root helper. It holds only for the
 * creator UID and authority revision it names, so any creator or ceiling change closes it.
 */
export type BrowserAgreementGrant = {
	enabled: boolean;
	creatorUid: number;
	/** The installation's service UID, which runs Bob's tools: never the creator, never an agreeing actor. */
	serviceUid: number;
	authorityRevision: number;
	/** Changes on every enable and reinstall and is never reused, so a gateway armed under an older grant stays closed. */
	generation: number;
	/**
	 * Receipts the helper issued, oldest first. Never evicted: at capacity the helper refuses new request IDs, so a
	 * request ID stays bound to its exact click for the life of the grant.
	 */
	issued: IssuedAgreement[];
};

/** One receipt the browser agreement helper published, with the exact identity its request ID is bound to. */
export type IssuedAgreement = {
	requestId: string;
	receiptId: string;
	missionId: string;
	revision: number;
	digest: string;
	authorityRevision: number;
	previousReceipt: string | null;
	issuedAt: number;
};

/** The only work kind a purpose can list: write one declared workspace file whose SHA-256 the creator fixed. */
export type WorkTerms = {
	kind: "artifact-digest";
	path: string;
	sha256: string;
	instructions: string;
	maxCycles: number;
	maxRequests: number;
	maxRetries: number;
	maxConsecutiveNoProgress: number;
};

/** Lifetime limits of one purpose: absolute totals per mission, never renewed by restart, completion or reopen. */
export type PurposeLifetime = {
	maxWorkItems: number;
	maxCycles: number;
	maxRequests: number;
	maxEstimatedCost?: number;
	deadlineAt: number;
};

/** What a creator approves for continuous operation: an ordered list of bounded work and one lifetime allowance. */
export type PurposeTerms = {
	purpose: string;
	scope: string;
	reviewEveryMs: number;
	works: WorkTerms[];
	lifetime: PurposeLifetime;
};

/** The protected, purpose-only grant: the `artifact-digest` capability under these path prefixes and caps. */
export type PurposeCeiling = {
	capabilities: ["artifact-digest"];
	paths: string[];
	maxWorkItems: number;
	maxCycles: number;
	maxRequests: number;
	maxRetries: number;
	maxConsecutiveNoProgress: number;
	maxDurationMs: number;
	maxEstimatedCost?: number;
};

/** The latest protected open, suspend or close of continuous operation for one exact purpose revision. */
export type OperationIntent = {
	requestId: string;
	sequence: number;
	missionId: string;
	purposeRevision: number;
	purposeDigest: string;
	authorityRevision: number;
	expectedOperationRevision: number;
	action: "open" | "suspend" | "close";
	issuedAt: number;
};

/** A protected decision that one unsettled run's uncertain effects are accepted; it refunds nothing. */
export type OperationAcknowledgment = {
	requestId: string;
	missionId: string;
	runId: string;
	authorityRevision: number;
	issuedAt: number;
};

export type MissionExecutionIntent = {
	requestId: string;
	sequence: number;
	missionId: string;
	agreementRevision: number;
	agreementDigest: string;
	authorityRevision: number;
	expectedPolicyRevision: number;
	action: "start" | "pause" | "resume" | "stop";
	issuedAt: number;
};

export type MissionRequest =
	| { operation: "status" }
	| { operation: "draft"; expectedRevision: number; requestId: string; terms: MissionDraftTerms }
	| { operation: "propose"; expectedRevision: number; requestId: string }
	| { operation: "reconcile"; receiptId: string }
	| { operation: "reconcile-execution"; requestId: string }
	| {
			operation: "control-local";
			action: MissionExecutionIntent["action"];
			expectedPolicyRevision: number;
			requestId: string;
	  }
	| { operation: "configure-local"; creator: MissionCreator; ceiling: MissionCeiling; purposeCeiling?: PurposeCeiling }
	| { operation: "approve-local"; expectedRevision: number; digest: string; requestId: string }
	/** The creator's one explicit browser agreement to an exact proposed revision; the owner mints it only on developer-local. */
	| { operation: "agree"; revision: number; digest: string; requestId: string }
	| { operation: "purpose-propose"; expectedRevision: number; requestId: string; terms: PurposeTerms }
	| { operation: "purpose-approve-local"; revision: number; digest: string; requestId: string }
	| { operation: "reconcile-purpose"; receiptId: string }
	| {
			operation: "operate-local";
			action: OperationIntent["action"] | "acknowledge";
			expectedOperationRevision: number;
			requestId: string;
			runId?: string;
	  }
	| { operation: "reconcile-operation"; requestId: string };

export type MissionView = {
	stage: "awaiting_creator" | "drafting" | "awaiting_approval" | "agreed";
	formation: MissionFormation;
	creator: MissionCreator | null;
	authority: "managed-administrator" | "developer-local" | "unconfigured" | "invalid";
	authorityError: string | null;
	agreementValid: boolean;
	missing: string[];
	execution: "not-implemented" | "not-started" | MissionExecutionView["status"];
	runtime?: MissionExecutionView | null;
	policyRevision?: number;
	tools: string[];
	purpose?: MissionPurposeView | null;
	/** Why the stored purpose records failed validation; continuous operation then runs and admits nothing. */
	purposeError?: string | null;
	/** From live task inspection, not the purpose records: whether a loop task is live; rollback needs "no-live-loop". */
	loopRollback?: "no-live-loop" | "live-loop";
};

/** Creates an unapproved formation; it never allocates a controller or execution conversation. */
export function initialFormation(): MissionFormation {
	return { nextRevision: 1, draft: null, agreement: null, lastOperation: null };
}

/** Lists incomplete or invalid terms without inventing limits or interpreting prose as authority. */
export function missingMissionTerms(terms: MissionDraftTerms): string[] {
	const missing: string[] = [];
	if (!terms.objective?.trim()) missing.push("objective");
	if (!terms.scope?.trim()) missing.push("scope");
	if (!terms.successCriteria?.length || terms.successCriteria.some((value) => !value.trim()))
		missing.push("success criteria");
	if (terms.approvalBoundary === undefined || terms.approvalBoundary.some((value) => !value.trim()))
		missing.push("approval boundary");
	if (!Number.isSafeInteger(terms.reviewEveryMs) || (terms.reviewEveryMs ?? 0) <= 0) missing.push("review cadence");
	const policy = terms.policy;
	if (policy?.allowedTools === undefined || policy.allowedTools.some((value) => !value.trim()))
		missing.push("allowed tool actions");
	for (const field of ["maxCycles", "maxRequests", "maxConsecutiveNoProgress"] as const) {
		if (!Number.isSafeInteger(policy?.[field]) || (policy?.[field] ?? 0) < 1) missing.push(field);
	}
	if (!Number.isSafeInteger(policy?.maxRetries) || (policy?.maxRetries ?? -1) < 0) missing.push("maxRetries");
	if (
		!Number.isSafeInteger(policy?.deadlineAt) ||
		(policy?.deadlineAt ?? -1) < 0 ||
		(policy?.deadlineAt ?? 0) > 8_640_000_000_000_000
	)
		missing.push("deadline");
	if (
		policy?.maxEstimatedCost !== undefined &&
		(!Number.isFinite(policy.maxEstimatedCost) || policy.maxEstimatedCost <= 0)
	)
		missing.push("estimated spend limit");
	return missing;
}

/** Validates the bounded owner-wire terms; partial drafts carry no authority. */
export function parseMissionDraftTerms(value: unknown): MissionDraftTerms {
	const input = missionObject(value);
	if (Buffer.byteLength(JSON.stringify(input)) > 32768) throw new Error("Mission terms exceed 32 KiB.");
	const fields = ["objective", "scope", "successCriteria", "policy", "approvalBoundary", "reviewEveryMs"];
	if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unknown mission term.");
	const result: MissionDraftTerms = {};
	if (input.objective !== undefined) result.objective = missionText(input.objective, 4096);
	if (input.scope !== undefined) result.scope = missionText(input.scope, 4096);
	if (input.successCriteria !== undefined) result.successCriteria = missionTextList(input.successCriteria, 32, 2000);
	if (input.approvalBoundary !== undefined) result.approvalBoundary = missionTextList(input.approvalBoundary, 32, 2000);
	if (input.reviewEveryMs !== undefined) result.reviewEveryMs = missionNumber(input.reviewEveryMs);
	if (input.policy !== undefined) {
		const policy = missionObject(input.policy);
		const numeric = [
			"maxCycles",
			"maxRequests",
			"maxRetries",
			"maxConsecutiveNoProgress",
			"deadlineAt",
			"maxEstimatedCost",
		] as const;
		if (Object.keys(policy).some((key) => key !== "allowedTools" && !numeric.some((field) => field === key)))
			throw new Error("Unknown mission limit.");
		result.policy = {};
		if (policy.allowedTools !== undefined) result.policy.allowedTools = missionTextList(policy.allowedTools, 128, 100);
		for (const key of numeric) if (policy[key] !== undefined) result.policy[key] = missionNumber(policy[key]);
	}
	return result;
}

/** Reads one bounded protocol object without accepting arrays or null. */
export function missionObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected a mission object.");
	return value as Record<string, unknown>;
}

/** Reads bounded text at the mission wire and protected-file boundaries. */
export function missionText(value: unknown, maximum = 200): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > maximum)
		throw new Error(`Mission text must fit ${maximum} bytes.`);
	return value;
}

/** Reads finite numeric wire values; semantic limits are checked before proposing or approving. */
export function missionNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Mission numbers must be finite.");
	return value;
}

/** Reads bounded arrays of bounded strings at an untrusted boundary. */
export function missionTextList(value: unknown, maximum: number, textMaximum: number): string[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`Mission list must fit ${maximum} items.`);
	return value.map((item) => missionText(item, textMaximum));
}

/** Validates a provisioned local creator; its label alone is never authentication. */
export function parseMissionCreator(value: unknown): MissionCreator {
	const input = missionObject(value);
	if (input.kind !== "human" && input.kind !== "elder" && input.kind !== "organization")
		throw new Error("Unknown creator kind.");
	const id = missionText(input.id);
	const uid = input.uid === null ? null : missionNumber(input.uid);
	if (!id.trim() || (uid !== null && (!Number.isSafeInteger(uid) || uid < 0)))
		throw new Error("A creator needs an identity and local UID.");
	return { kind: input.kind, id, uid };
}
