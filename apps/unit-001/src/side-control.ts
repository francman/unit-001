// Parses and presents the bounded owner-only side conversation surface.
import { UsageError } from "./errors.ts";
import { sanitizeTerminalText } from "./render.ts";

export const SIDE_LIMIT = 16;

export type SideRequest =
	| { readonly operation: "list" }
	| { readonly operation: "start"; readonly from: number; readonly title: string; readonly requestId: string };

export type SideChatState = "idle" | "busy" | "queued";

export type SideSummary = {
	readonly conversationId: number;
	readonly parent: { readonly conversationId: number; readonly at: number };
	readonly title: string;
	readonly createdAt: number;
	readonly state: SideChatState;
};

export type SideResult =
	| {
			readonly operation: "list";
			readonly main: { readonly conversationId: number; readonly state: SideChatState };
			readonly sides: readonly SideSummary[];
	  }
	| { readonly operation: "start"; readonly conversationId: number };

/** Rejects undeclared fields and normalizes a concrete main-reply start operation. */
export function parseSideRequest(value: unknown): SideRequest {
	const input = object(value);
	if (input.operation === "list") {
		keys(input, ["operation"]);
		return { operation: "list" };
	}
	if (input.operation !== "start") throw new UsageError("Invalid side operation.");
	keys(input, ["operation", "from", "title", "requestId"]);
	if (!positiveId(input.from)) throw new UsageError("Side source must be a positive safe entry ID.");
	if (typeof input.requestId !== "string" || input.requestId.length < 1 || input.requestId.length > 200)
		throw new UsageError("Side start requires a request ID (1 to 200 characters).");
	const title = input.title === undefined ? `Side chat from message ${input.from}` : normalizedTitle(input.title);
	const request: SideRequest = { operation: "start", from: input.from, title, requestId: input.requestId };
	if (Buffer.byteLength(JSON.stringify(request), "utf8") > 65536) throw new UsageError("Side request is too large.");
	return request;
}

/** Canonically identifies the normalized operation; request identity is stored separately. */
export function sideFingerprint(request: Extract<SideRequest, { operation: "start" }>): string {
	return JSON.stringify(["start", request.from, request.title]);
}

/** Validates an owner result before exposing its bounded metadata to a client. */
export function parseSideResult(value: unknown): SideResult {
	const input = object(value);
	if (input.operation === "start" && positiveId(input.conversationId)) {
		keys(input, ["operation", "conversationId"]);
		return { operation: "start", conversationId: input.conversationId };
	}
	if (input.operation !== "list" || !Array.isArray(input.sides) || input.sides.length > SIDE_LIMIT)
		throw new UsageError("Invalid side result.");
	keys(input, ["operation", "main", "sides"]);
	const main = object(input.main);
	keys(main, ["conversationId", "state"]);
	if (!positiveId(main.conversationId)) throw new UsageError("Invalid main conversation ID.");
	const mainId = main.conversationId;
	const ids = new Set([mainId]);
	const sides = (input.sides as unknown[]).map((value): SideSummary => {
		const side = object(value);
		keys(side, ["conversationId", "parent", "title", "createdAt", "state"]);
		const parent = object(side.parent);
		keys(parent, ["conversationId", "at"]);
		if (
			!positiveId(side.conversationId) || ids.has(side.conversationId) ||
			parent.conversationId !== main.conversationId || !positiveId(parent.at) ||
			typeof side.createdAt !== "number" || !Number.isSafeInteger(side.createdAt) || side.createdAt < 0 ||
			normalizedTitle(side.title) !== side.title
		) throw new UsageError("Invalid side summary.");
		ids.add(side.conversationId);
		return {
			conversationId: side.conversationId,
			parent: { conversationId: mainId, at: parent.at },
			title: side.title,
			createdAt: side.createdAt,
			state: chatState(side.state),
		};
	});
	return { operation: "list", main: { conversationId: main.conversationId, state: chatState(main.state) }, sides };
}

/** Renders metadata only; titles cannot emit terminal control sequences. */
export function describeSides(result: SideResult): string {
	if (result.operation === "start") return `Created side chat ${result.conversationId}.`;
	return [
		`Main chat ${result.main.conversationId}: ${result.main.state}.`,
		...result.sides.map((side) => `${side.conversationId}: ${sanitizeTerminalText(side.title)} (${side.state}; from message ${side.parent.at}).`),
	].join("\n");
}

/** Checks untrusted numeric addresses without accepting coercions or unsafe integers. */
export function positiveId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizedTitle(value: unknown): string {
	// Cf covers bidi controls (U+202A-202E, U+2066-2069) and zero-width characters that reorder or hide list text.
	if (typeof value !== "string" || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw new UsageError("Invalid side title.");
	const title = value.trim();
	if (Array.from(title).length < 1 || Array.from(title).length > 80 || Buffer.byteLength(title, "utf8") > 320)
		throw new UsageError("Side title must contain 1 to 80 code points and at most 320 UTF-8 bytes.");
	return title;
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UsageError("Invalid side message.");
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) throw new UsageError("Unknown side field.");
}

function chatState(value: unknown): SideChatState {
	if (value === "idle" || value === "busy" || value === "queued") return value;
	throw new UsageError("Invalid side chat state.");
}
