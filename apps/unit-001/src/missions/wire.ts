// Validates mission commands and bounded projections at local IPC boundaries.
import { parseCompleteMissionTerms, parseMissionApproval, parseMissionCeiling } from "./authority.ts";
import {
	type MissionAgreement,
	type MissionDraft,
	type MissionRequest,
	type MissionView,
	missionNumber,
	missionObject,
	missionText,
	missionTextList,
	parseMissionCreator,
	parseMissionDraftTerms,
} from "./contract.ts";
import { parseMissionExecutionView } from "./execution-view.ts";

/** Validates owner commands without accepting caller-supplied managed approval or authenticated principal claims. */
export function parseMissionRequest(value: unknown): MissionRequest {
	const input = missionObject(value);
	if (input.operation === "reconcile-execution") {
		if (Object.keys(input).some((key) => key !== "operation" && key !== "requestId"))
			throw new Error("Unknown mission command field.");
		const requestId = missionText(input.requestId);
		if (!requestId.trim()) throw new Error("Mission changes need a request ID.");
		return { operation: "reconcile-execution", requestId };
	}
	if (input.operation === "control-local") {
		if (
			Object.keys(input).some((key) => !["operation", "action", "expectedPolicyRevision", "requestId"].includes(key))
		)
			throw new Error("Unknown mission command field.");
		if (input.action !== "start" && input.action !== "pause" && input.action !== "resume" && input.action !== "stop")
			throw new Error("Unknown mission lifecycle action.");
		const requestId = missionText(input.requestId);
		if (!requestId.trim()) throw new Error("Mission changes need a request ID.");
		return {
			operation: "control-local",
			action: input.action,
			expectedPolicyRevision: revision(input.expectedPolicyRevision, 0),
			requestId,
		};
	}
	const fields =
		input.operation === "status"
			? ["operation"]
			: input.operation === "reconcile"
				? ["operation", "receiptId"]
				: input.operation === "configure-local"
					? ["operation", "creator", "ceiling"]
					: input.operation === "draft"
						? ["operation", "expectedRevision", "requestId", "terms"]
						: input.operation === "approve-local"
							? ["operation", "expectedRevision", "requestId", "digest"]
							: ["operation", "expectedRevision", "requestId"];
	if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unknown mission command field.");
	if (input.operation === "status") return { operation: "status" };
	if (input.operation === "reconcile") return { operation: "reconcile", receiptId: missionText(input.receiptId) };
	if (input.operation === "configure-local")
		return {
			operation: "configure-local",
			creator: parseMissionCreator(input.creator),
			ceiling: parseMissionCeiling(input.ceiling),
		};
	if (input.operation !== "draft" && input.operation !== "propose" && input.operation !== "approve-local")
		throw new Error("Unknown mission operation.");
	const expectedRevision = revision(input.expectedRevision, 0);
	const requestId = missionText(input.requestId);
	if (!requestId.trim()) throw new Error("Mission changes need a request ID.");
	if (input.operation === "draft")
		return { operation: "draft", expectedRevision, requestId, terms: parseMissionDraftTerms(input.terms) };
	if (input.operation === "approve-local")
		return { operation: "approve-local", expectedRevision, digest: digest(input.digest), requestId };
	return { operation: "propose", expectedRevision, requestId };
}

/** Validates presentation data before a terminal or privileged approval client reads it. */
export function parseMissionView(value: unknown): MissionView {
	const input = missionObject(value);
	if (
		input.stage !== "awaiting_creator" &&
		input.stage !== "drafting" &&
		input.stage !== "awaiting_approval" &&
		input.stage !== "agreed"
	)
		throw new Error("Invalid mission stage.");
	if (
		input.authority !== "managed-administrator" &&
		input.authority !== "developer-local" &&
		input.authority !== "unconfigured" &&
		input.authority !== "invalid"
	)
		throw new Error("Invalid mission authority projection.");
	if (
		(input.execution !== "not-implemented" &&
			input.execution !== "not-started" &&
			input.execution !== "ready" &&
			input.execution !== "running" &&
			input.execution !== "waiting" &&
			input.execution !== "paused" &&
			input.execution !== "blocked" &&
			input.execution !== "completed" &&
			input.execution !== "stopped") ||
		typeof input.agreementValid !== "boolean"
	)
		throw new Error("Invalid mission execution projection.");
	const runtime =
		input.runtime === undefined || input.runtime === null ? null : parseMissionExecutionView(input.runtime);
	if (
		(runtime !== null && runtime.status !== input.execution) ||
		(runtime === null && input.execution !== "not-implemented" && input.execution !== "not-started")
	)
		throw new Error("Mission runtime does not match its execution projection.");
	const formation = missionObject(input.formation);
	const draft = formation.draft === null ? null : parseDraft(formation.draft);
	const agreement = formation.agreement === null ? null : parseAgreement(formation.agreement);
	const operation = formation.lastOperation === null ? null : missionObject(formation.lastOperation);
	return {
		stage: input.stage,
		formation: {
			nextRevision: revision(formation.nextRevision, 1),
			draft,
			agreement,
			lastOperation:
				operation === null
					? null
					: {
							requestId: missionText(operation.requestId),
							digest: digest(operation.digest),
							revision: revision(operation.revision, 1),
						},
		},
		creator: input.creator === null ? null : parseMissionCreator(input.creator),
		authorityError: input.authorityError === null ? null : missionText(input.authorityError, 1000),
		authority: input.authority,
		agreementValid: input.agreementValid,
		missing: missionTextList(input.missing, 32, 200),
		execution: input.execution,
		...(input.runtime === undefined ? {} : { runtime }),
		...(input.policyRevision === undefined ? {} : { policyRevision: revision(input.policyRevision, 0) }),
		tools: missionTextList(input.tools, 128, 100),
	};
}

function parseDraft(value: unknown): MissionDraft {
	const input = missionObject(value);
	if (input.status !== "editing" && input.status !== "proposed") throw new Error("Invalid mission draft state.");
	return {
		missionId: missionText(input.missionId),
		revision: revision(input.revision, 1),
		status: input.status,
		terms: parseMissionDraftTerms(input.terms),
		digest: input.digest === null ? null : digest(input.digest),
	};
}

function parseAgreement(value: unknown): MissionAgreement {
	const input = missionObject(value);
	if (input.execution !== "not-implemented") throw new Error("Invalid mission agreement execution state.");
	return {
		missionId: missionText(input.missionId),
		revision: revision(input.revision, 1),
		terms: parseCompleteMissionTerms(input.terms),
		digest: digest(input.digest),
		approval: parseMissionApproval(input.approval),
		execution: "not-implemented",
	};
}

function revision(value: unknown, minimum: number): number {
	const result = missionNumber(value);
	if (!Number.isSafeInteger(result) || result < minimum) throw new Error("Invalid mission revision.");
	return result;
}

function digest(value: unknown): string {
	const result = missionText(value, 64);
	if (!/^[0-9a-f]{64}$/.test(result)) throw new Error("Invalid mission digest.");
	return result;
}
