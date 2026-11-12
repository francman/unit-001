// Defines bounded mission formation data without granting execution authority.
import type { MissionPolicy } from "./state.ts";

// The managed Linux host approves only this application's shipped actions, independently of owner-provided text.
export const MANAGED_MISSION_ACTIONS = [
	"read",
	"write",
	"edit",
	"bash",
	"unit_status",
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
};

export type MissionRequest =
	| { operation: "status" }
	| { operation: "draft"; expectedRevision: number; requestId: string; terms: MissionDraftTerms }
	| { operation: "propose"; expectedRevision: number; requestId: string }
	| { operation: "reconcile"; receiptId: string }
	| { operation: "configure-local"; creator: MissionCreator; ceiling: MissionCeiling }
	| { operation: "approve-local"; expectedRevision: number; digest: string; requestId: string };

export type MissionView = {
	stage: "awaiting_creator" | "drafting" | "awaiting_approval" | "agreed";
	formation: MissionFormation;
	creator: MissionCreator | null;
	authority: "managed-administrator" | "developer-local" | "unconfigured" | "invalid";
	authorityError: string | null;
	agreementValid: boolean;
	missing: string[];
	execution: "not-implemented";
	tools: string[];
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
	if (input.approvalBoundary !== undefined)
		result.approvalBoundary = missionTextList(input.approvalBoundary, 32, 2000);
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
		if (policy.allowedTools !== undefined)
			result.policy.allowedTools = missionTextList(policy.allowedTools, 128, 100);
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
