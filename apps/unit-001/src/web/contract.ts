// Restricts browser requests to an explicit subset of the existing operator protocol.
import type { MissionDraftTerms, MissionRequest } from "../missions/contract.ts";
import type { PlanTerms } from "../missions/plan-terms.ts";
import { parseMissionRequest } from "../missions/wire.ts";
import type { ServiceRequest } from "../service.ts";

export type WebOperation =
	| { type: "status" | "cancel" }
	| { type: "send"; prompt: string }
	| { type: "chat-history"; before: number | null }
	| {
			type: "mission";
			request:
				| { operation: "status" }
				| { operation: "draft"; expectedRevision: number; terms: MissionDraftTerms }
				| { operation: "propose"; expectedRevision: number }
				| { operation: "plan-draft"; expectedRevision: number; terms: PlanTerms }
				| { operation: "plan-propose"; expectedRevision: number }
				| { operation: "plan-agree"; revision: number; digest: string; confirmed: true }
				| { operation: "review-now" }
				| { operation: "review-dismiss"; reviewId: string }
				| { operation: "agree"; revision: number; digest: string; confirmed: true };
	  }
	| { type: "channels"; request: { operation: "status" } }
	| {
			type: "memory";
			request:
				| { operation: "stats" | "graph" }
				| { operation: "recall"; query: string }
				| { operation: "forget"; id: string; confirmed: true };
	  };

export type WebRequest = { requestId: string; operation: WebOperation };

export type WebSession = { csrfToken: string };

/** Validates browser input and reconstructs owner requests without accepting authority claims. */
export function parseWebRequest(value: unknown): { requestId: string; operation: ServiceRequest } {
	const envelope = object(value, ["requestId", "operation"]);
	const requestId = text(envelope.requestId, 200);
	const input = object(envelope.operation, ["type", "request", "prompt", "before"]);
	if (input.type === "status" || input.type === "cancel") {
		object(input, ["type"]);
		return { requestId, operation: { type: input.type } };
	}
	if (input.type === "chat-history") {
		object(input, ["type", "before"]);
		const before = input.before;
		if (before !== null && (typeof before !== "number" || !Number.isSafeInteger(before) || before < 1))
			throw new Error("Invalid chat history cursor.");
		return { requestId, operation: { type: "chat-history", before } };
	}
	if (input.type === "send") {
		object(input, ["type", "prompt"]);
		return { requestId, operation: { type: "send", prompt: text(input.prompt, 32_768), requestId } };
	}
	object(input, ["type", "request"]);
	if (input.type === "mission")
		return { requestId, operation: { type: "mission", request: missionRequest(input.request, requestId) } };
	if (input.type === "channels") {
		const request = object(input.request, ["operation"]);
		if (request.operation !== "status") throw new Error("Only status is available on this surface.");
		return { requestId, operation: { type: input.type, request: { operation: "status" } } };
	}
	if (input.type === "memory") {
		const request = object(input.request, ["operation", "query", "id", "confirmed"]);
		if (request.operation === "stats" || request.operation === "graph") {
			object(request, ["operation"]);
			return { requestId, operation: { type: "memory", request: { operation: request.operation } } };
		}
		if (request.operation === "recall") {
			object(request, ["operation", "query"]);
			return {
				requestId,
				operation: { type: "memory", request: { operation: "recall", query: text(request.query, 2000) } },
			};
		}
		object(request, ["operation", "id", "confirmed"]);
		if (request.operation !== "forget" || request.confirmed !== true)
			throw new Error("Forgetting memory requires explicit confirmation.");
		return {
			requestId,
			operation: {
				type: "memory",
				request: { operation: "forget", id: text(request.id, 1000), confirmed: true, requestId },
			},
		};
	}
	throw new Error("Operation is unavailable on the browser surface.");
}

const MISSION_MUTATIONS: ReadonlySet<string> = new Set([
	"draft",
	"propose",
	"agree",
	"plan-draft",
	"plan-propose",
	"plan-agree",
	"review-now",
	"review-dismiss",
]);

/** True for an operation that changes owner state: a send, a cancel, a mission change or forgetting a memory. */
export function isMutation(operation: ServiceRequest): boolean {
	switch (operation.type) {
		case "send":
		case "cancel":
			return true;
		case "mission":
			return MISSION_MUTATIONS.has(operation.request.operation);
		case "memory":
			return operation.request.operation === "forget";
		default:
			return false;
	}
}

// Mission definition: status, draft and propose as the operator CLI has them, and one agreement that names the exact
// proposed revision and digest the owner reviewed. The envelope's request ID makes each change idempotent.
function missionRequest(value: unknown, requestId: string): MissionRequest {
	const request = object(value, [
		"operation",
		"expectedRevision",
		"terms",
		"revision",
		"digest",
		"confirmed",
		"reviewId",
	]);
	if (request.operation === "status") {
		object(request, ["operation"]);
		return { operation: "status" };
	}
	if (request.operation === "draft" || request.operation === "plan-draft") {
		object(request, ["operation", "expectedRevision", "terms"]);
		return parseMissionRequest({ ...request, requestId });
	}
	if (request.operation === "propose" || request.operation === "plan-propose") {
		object(request, ["operation", "expectedRevision"]);
		return parseMissionRequest({ ...request, requestId });
	}
	if (request.operation === "review-now") {
		object(request, ["operation"]);
		return parseMissionRequest({ ...request, requestId });
	}
	if (request.operation === "review-dismiss") {
		object(request, ["operation", "reviewId"]);
		return parseMissionRequest({ ...request, requestId });
	}
	if (request.operation !== "agree" && request.operation !== "plan-agree")
		throw new Error("Operation is unavailable on the browser surface.");
	object(request, ["operation", "revision", "digest", "confirmed"]);
	if (request.confirmed !== true) throw new Error("Agreeing to a mission requires explicit confirmation.");
	return parseMissionRequest({ operation: request.operation, revision: request.revision, digest: request.digest, requestId });
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
	// HTTP JSON is an untrusted boundary, including fields that resemble creator credentials.
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object.");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((field) => !fields.includes(field))) throw new Error("Unknown request field.");
	return input;
}

function text(value: unknown, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum)
		throw new Error(`Text must contain 1 to ${maximum} bytes.`);
	return value;
}
