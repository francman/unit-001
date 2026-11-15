// Restricts browser requests to an explicit subset of the existing operator protocol.
import type { ServiceRequest, ServiceResponse } from "../service.ts";

export type WebOperation =
	| { type: "status" | "cancel" }
	| { type: "send"; prompt: string }
	| { type: "mission"; request: { operation: "status" } }
	| { type: "channels"; request: { operation: "status" } }
	| {
			type: "memory";
			request:
				| { operation: "stats" }
				| { operation: "recall"; query: string }
				| { operation: "forget"; id: string; confirmed: true };
	  };

export type WebRequest = { requestId: string; operation: WebOperation };

export type WebResult =
	| { requestId: string; state: "completed"; response: ServiceResponse }
	| { requestId: string; state: "unknown"; message: string };

export type WebSession =
	| { authenticated: false }
	| { authenticated: true; csrfToken: string; expiresAt: number };

/** Validates browser input and reconstructs owner requests without accepting authority claims. */
export function parseWebRequest(value: unknown): { requestId: string; operation: ServiceRequest } {
	const envelope = object(value, ["requestId", "operation"]);
	const requestId = text(envelope.requestId, 200);
	const input = object(envelope.operation, ["type", "request", "prompt"]);
	if (input.type === "status" || input.type === "cancel") {
		object(input, ["type"]);
		return { requestId, operation: { type: input.type } };
	}
	if (input.type === "send") {
		object(input, ["type", "prompt"]);
		return { requestId, operation: { type: "send", prompt: text(input.prompt, 32_768), requestId } };
	}
	object(input, ["type", "request"]);
	if (input.type === "mission" || input.type === "channels") {
		const request = object(input.request, ["operation"]);
		if (request.operation !== "status") throw new Error("Only status is available on this surface.");
		return { requestId, operation: { type: input.type, request: { operation: "status" } } };
	}
	if (input.type === "memory") {
		const request = object(input.request, ["operation", "query", "id", "confirmed"]);
		if (request.operation === "stats") {
			object(request, ["operation"]);
			return { requestId, operation: { type: "memory", request: { operation: "stats" } } };
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

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
	// HTTP JSON is an untrusted boundary, including fields that resemble creator credentials.
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected an object.");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((field) => !fields.includes(field))) throw new Error("Unknown request field.");
	return input;
}

function text(value: unknown, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum)
		throw new Error(`Text must contain 1 to ${maximum} bytes.`);
	return value;
}
