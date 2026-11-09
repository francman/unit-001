// Validates and renders bounded owner-only memory operations without opening storage.
import { randomUUID } from "node:crypto";
import { UsageError } from "./errors.ts";
import { sanitizeTerminalText } from "./render.ts";

export type MemoryRequest =
	| { readonly operation: "stats" | "sleep" }
	| { readonly operation: "recall"; readonly query: string }
	| { readonly operation: "remember"; readonly content: string; readonly requestId: string }
	| { readonly operation: "forget"; readonly id: string; readonly requestId: string; readonly confirmed: true };

export type MemoryResult =
	| {
			readonly operation: "stats";
			readonly working: number;
			readonly episodic: number;
			readonly tombstones: number;
			readonly pendingCaptures: number;
			readonly failedCaptures: number;
			readonly consolidation: "idle" | "scheduled";
	  }
	| {
			readonly operation: "recall";
			readonly records: readonly {
				readonly id: string;
				readonly content: string;
				readonly origin: "user" | "agent" | "tool";
				readonly tier: "working" | "episodic";
				readonly score: number;
			}[];
	  }
	| { readonly operation: "remember"; readonly id: string }
	| { readonly operation: "forget"; readonly removed: boolean }
	| { readonly operation: "sleep"; readonly taskId: number };

/** Rejects malformed local wire requests before they reach the storage owner. */
export function parseMemoryRequest(value: unknown): MemoryRequest {
	if (typeof value !== "object" || value === null || !("operation" in value))
		throw new UsageError("Invalid memory request.");
	if (value.operation === "stats" || value.operation === "sleep") return { operation: value.operation };
	if (value.operation === "recall" && "query" in value && bounded(value.query, 2000))
		return { operation: "recall", query: value.query };
	if (!("requestId" in value) || !bounded(value.requestId, 200))
		throw new UsageError("Memory mutation requires a request ID (1 to 200 characters).");
	if (value.operation === "remember" && "content" in value && bounded(value.content, 2000))
		return { operation: "remember", content: value.content, requestId: value.requestId };
	if (
		value.operation === "forget" &&
		"id" in value &&
		bounded(value.id, 1000) &&
		"confirmed" in value &&
		value.confirmed === true
	)
		return { operation: "forget", id: value.id, requestId: value.requestId, confirmed: true };
	throw new UsageError("Invalid memory operation or arguments; forget requires confirmation.");
}

/** Validates bounded result frames from the local owner before rendering or script output. */
export function parseMemoryResult(value: unknown): MemoryResult {
	if (typeof value !== "object" || value === null || !("operation" in value))
		throw new Error("Invalid memory result.");
	if (
		value.operation === "stats" &&
		"working" in value &&
		count(value.working) &&
		"episodic" in value &&
		count(value.episodic) &&
		"tombstones" in value &&
		count(value.tombstones) &&
		"pendingCaptures" in value &&
		count(value.pendingCaptures) &&
		"failedCaptures" in value &&
		count(value.failedCaptures) &&
		"consolidation" in value &&
		(value.consolidation === "idle" || value.consolidation === "scheduled")
	)
		return {
			operation: "stats",
			working: value.working,
			episodic: value.episodic,
			tombstones: value.tombstones,
			pendingCaptures: value.pendingCaptures,
			failedCaptures: value.failedCaptures,
			consolidation: value.consolidation,
		};
	if (value.operation === "remember" && "id" in value && bounded(value.id, 1000))
		return { operation: "remember", id: value.id };
	if (value.operation === "forget" && "removed" in value && typeof value.removed === "boolean")
		return { operation: "forget", removed: value.removed };
	if (value.operation === "sleep" && "taskId" in value && count(value.taskId))
		return { operation: "sleep", taskId: value.taskId };
	if (
		value.operation === "recall" &&
		"records" in value &&
		Array.isArray(value.records) &&
		value.records.length <= 5
	) {
		const records: Extract<MemoryResult, { operation: "recall" }>["records"][number][] = [];
		// Array.isArray establishes only the container; every wire record is still unknown.
		for (const record of value.records as readonly unknown[]) {
			if (
				typeof record !== "object" ||
				record === null ||
				!("id" in record) ||
				!bounded(record.id, 1000) ||
				!("content" in record) ||
				!bounded(record.content, 2000) ||
				!("origin" in record) ||
				(record.origin !== "user" && record.origin !== "agent" && record.origin !== "tool") ||
				!("tier" in record) ||
				(record.tier !== "working" && record.tier !== "episodic") ||
				!("score" in record) ||
				typeof record.score !== "number" ||
				!Number.isFinite(record.score) ||
				record.score < 0 ||
				record.score > 1
			)
				throw new Error("Invalid recalled memory.");
			records.push({
				id: record.id,
				content: record.content,
				origin: record.origin,
				tier: record.tier,
				score: record.score,
			});
		}
		return { operation: "recall", records };
	}
	throw new Error("Invalid memory result.");
}

/** Parses shared slash/CLI operands; forgetting is deliberately a separate confirmed step. */
export function memoryCommand(
	operation: string = "stats",
	argument: string = "",
	requestId: string = randomUUID(),
): MemoryRequest | { readonly operation: "confirm-forget"; readonly id: string; readonly requestId: string } {
	if ((operation === "stats" || operation === "sleep") && argument.trim() !== "")
		throw new UsageError(`Memory ${operation} takes no argument.`);
	if (operation === "forget") {
		if (!bounded(argument, 1000)) throw new UsageError("Usage: memory forget <id>");
		return { operation: "confirm-forget", id: argument, requestId };
	}
	return parseMemoryRequest({
		operation,
		...(operation === "recall"
			? { query: argument }
			: operation === "remember"
				? { content: argument, requestId }
				: {}),
	});
}

/** Renders only memory operation output, never provider credentials or host configuration. */
export function describeMemory(result: MemoryResult): string {
	if (result.operation === "stats")
		return `Session memory: ${result.working} working, ${result.episodic} episodic, ${result.tombstones} forgotten; captures ${result.pendingCaptures} pending, ${result.failedCaptures} failed; consolidation ${result.consolidation}.`;
	if (result.operation === "remember") return `Remembered ${sanitizeTerminalText(result.id)}.`;
	if (result.operation === "forget")
		return result.removed
			? "Forgotten; dependent summaries are invalidated. Immutable conversation history remains."
			: "No live memory matched that ID.";
	if (result.operation === "sleep") return `Memory consolidation scheduled as task ${result.taskId}.`;
	return result.records.length === 0
		? "No matching session memories."
		: result.records
				.map(
					(record) =>
						`${sanitizeTerminalText(record.id)} [${record.origin}/${record.tier}]\n${sanitizeTerminalText(record.content)}`,
				)
				.join("\n\n");
}

function bounded(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= limit;
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
