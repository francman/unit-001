// Validates and renders bounded owner-only memory operations without opening storage.
import { randomUUID } from "node:crypto";
import {
	MEMORY_GRAPH_CONTENT_LIMIT,
	MEMORY_GRAPH_EDGE_LIMIT,
	MEMORY_GRAPH_NODE_LIMIT,
	MEMORY_RELATION_KINDS,
	MEMORY_RELATIONS_PER_REMEMBER,
	type MemoryGraph,
	type MemoryGraphNode,
	type MemoryRelationRequest,
} from "unit-memory";
import { UsageError } from "./errors.ts";
import { sanitizeTerminalText } from "./render.ts";

export type MemoryRequest =
	| { readonly operation: "stats" | "sleep" | "graph" }
	| { readonly operation: "recall"; readonly query: string }
	| {
			readonly operation: "remember";
			readonly content: string;
			readonly requestId: string;
			readonly relations?: readonly MemoryRelationRequest[];
	  }
	| { readonly operation: "forget"; readonly id: string; readonly requestId: string; readonly confirmed: true };

export type MemoryResult =
	| {
			readonly operation: "stats";
			readonly working: number;
			readonly episodic: number;
			readonly tombstones: number;
			readonly relations: number;
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
	| ({ readonly operation: "graph" } & MemoryGraph)
	| { readonly operation: "remember"; readonly id: string }
	| { readonly operation: "forget"; readonly removed: boolean }
	| { readonly operation: "sleep"; readonly taskId: number };

/** Rejects malformed local wire requests before they reach the storage owner. */
export function parseMemoryRequest(value: unknown): MemoryRequest {
	if (typeof value !== "object" || value === null || !("operation" in value))
		throw new UsageError("Invalid memory request.");
	if (value.operation === "stats" || value.operation === "sleep" || value.operation === "graph")
		return { operation: value.operation };
	if (value.operation === "recall" && "query" in value && bounded(value.query, 2000))
		return { operation: "recall", query: value.query };
	if (!("requestId" in value) || !bounded(value.requestId, 200))
		throw new UsageError("Memory mutation requires a request ID (1 to 200 characters).");
	if (value.operation === "remember" && "content" in value && bounded(value.content, 2000))
		return {
			operation: "remember",
			content: value.content,
			requestId: value.requestId,
			...("relations" in value ? { relations: parseRelationRequests(value.relations) } : {}),
		};
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
		"relations" in value &&
		count(value.relations) &&
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
			relations: value.relations,
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
	if (value.operation === "graph") return parseMemoryGraph(value);
	throw new Error("Invalid memory result.");
}

const KINDS = ["fact", "preference", "decision", "observation"] as const;
const TIERS = ["working", "episodic"] as const;
const ORIGINS = ["user", "agent", "tool"] as const;
const DERIVATIONS = ["explicit", "consolidation"] as const;

// Owner frames are untrusted at the socket; every node and edge is rebuilt from checked fields only.
function parseMemoryGraph(value: object): Extract<MemoryResult, { operation: "graph" }> {
	if (
		!("nodes" in value) ||
		!Array.isArray(value.nodes) ||
		value.nodes.length > MEMORY_GRAPH_NODE_LIMIT ||
		!("edges" in value) ||
		!Array.isArray(value.edges) ||
		value.edges.length > MEMORY_GRAPH_EDGE_LIMIT ||
		!("total" in value) ||
		!count(value.total) ||
		value.total < value.nodes.length ||
		!("limited" in value) ||
		value.limited !== value.nodes.length < value.total
	)
		throw new Error("Invalid memory graph.");
	const nodes: MemoryGraphNode[] = [];
	const ids = new Set<string>();
	for (const node of value.nodes as readonly unknown[]) {
		if (
			typeof node !== "object" ||
			node === null ||
			!("id" in node) ||
			!bounded(node.id, 1000) ||
			ids.has(node.id) ||
			!("content" in node) ||
			typeof node.content !== "string" ||
			node.content.length === 0 ||
			Array.from(node.content).length > MEMORY_GRAPH_CONTENT_LIMIT ||
			!("truncated" in node) ||
			typeof node.truncated !== "boolean" ||
			!("kind" in node) ||
			!member(node.kind, KINDS) ||
			!("tier" in node) ||
			!member(node.tier, TIERS) ||
			!("origin" in node) ||
			!member(node.origin, ORIGINS) ||
			!("importance" in node) ||
			typeof node.importance !== "number" ||
			!(node.importance >= 0 && node.importance <= 1) ||
			!("createdAt" in node) ||
			typeof node.createdAt !== "number" ||
			!Number.isFinite(node.createdAt) ||
			!("conversation" in node) ||
			typeof node.conversation !== "string" ||
			!/^[a-f0-9]{12}$/.test(node.conversation)
		)
			throw new Error("Invalid memory graph node.");
		ids.add(node.id);
		nodes.push({
			id: node.id,
			content: node.content,
			truncated: node.truncated,
			kind: node.kind,
			tier: node.tier,
			origin: node.origin,
			importance: node.importance,
			createdAt: node.createdAt,
			conversation: node.conversation,
		});
	}
	const edges: MemoryGraph["edges"] = [];
	for (const edge of value.edges as readonly unknown[]) {
		if (
			typeof edge !== "object" ||
			edge === null ||
			!("from" in edge) ||
			typeof edge.from !== "string" ||
			!ids.has(edge.from) ||
			!("to" in edge) ||
			typeof edge.to !== "string" ||
			!ids.has(edge.to) ||
			!("kind" in edge)
		)
			throw new Error("Invalid memory graph edge.");
		if (edge.kind === "summary") {
			edges.push({ from: edge.from, to: edge.to, kind: "summary" });
			continue;
		}
		if (
			!member(edge.kind, MEMORY_RELATION_KINDS) ||
			edge.from === edge.to ||
			!("derivation" in edge) ||
			!member(edge.derivation, DERIVATIONS)
		)
			throw new Error("Invalid memory graph edge.");
		edges.push({ from: edge.from, to: edge.to, kind: edge.kind, derivation: edge.derivation });
	}
	return { operation: "graph", nodes, edges, total: value.total, limited: value.limited };
}

function member<const T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && allowed.some((item) => item === value);
}

// Local wire input is untrusted; storage validates target liveness and capacity inside its transaction.
function parseRelationRequests(value: unknown): MemoryRelationRequest[] {
	if (!Array.isArray(value) || value.length > MEMORY_RELATIONS_PER_REMEMBER)
		throw new UsageError(`Memory remember accepts at most ${MEMORY_RELATIONS_PER_REMEMBER} relations.`);
	const relations: MemoryRelationRequest[] = [];
	const targets = new Set<string>();
	for (const relation of value as readonly unknown[]) {
		if (
			typeof relation !== "object" ||
			relation === null ||
			!("id" in relation) ||
			!bounded(relation.id, 1000) ||
			!("kind" in relation) ||
			!member(relation.kind, MEMORY_RELATION_KINDS) ||
			Object.keys(relation).some((key) => key !== "id" && key !== "kind")
		)
			throw new UsageError("Memory relation requires an ID and kind: relates, supports, contradicts or updates.");
		if (targets.has(relation.id)) throw new UsageError("Memory relation targets must be distinct.");
		targets.add(relation.id);
		relations.push({ id: relation.id, kind: relation.kind });
	}
	return relations;
}

/** Parses shared slash/CLI operands; forgetting is deliberately a separate confirmed step. */
export function memoryCommand(
	operation: string = "stats",
	argument: string = "",
	requestId: string = randomUUID(),
	relations?: readonly MemoryRelationRequest[],
): MemoryRequest | { readonly operation: "confirm-forget"; readonly id: string; readonly requestId: string } {
	if (relations !== undefined && operation !== "remember")
		throw new UsageError("--relation applies only to memory remember.");
	if ((operation === "stats" || operation === "sleep" || operation === "graph") && argument.trim() !== "")
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
				? { content: argument, requestId, ...(relations === undefined ? {} : { relations }) }
				: {}),
	});
}

/** Renders only memory operation output, never provider credentials or host configuration. */
export function describeMemory(result: MemoryResult): string {
	if (result.operation === "stats")
		return `Session memory: ${result.working} working, ${result.episodic} episodic, ${result.tombstones} forgotten, ${result.relations} relations; captures ${result.pendingCaptures} pending, ${result.failedCaptures} failed; consolidation ${result.consolidation}.`;
	if (result.operation === "remember") return `Remembered ${sanitizeTerminalText(result.id)}.`;
	if (result.operation === "forget")
		return result.removed
			? "Forgotten; dependent summaries are invalidated. Immutable conversation history remains."
			: "No live memory matched that ID.";
	if (result.operation === "sleep") return `Memory consolidation scheduled as task ${result.taskId}.`;
	if (result.operation === "graph") {
		const summaries = result.edges.filter((edge) => edge.kind === "summary").length;
		return `Memory graph: ${result.nodes.length} of ${result.total} live memories, ${summaries} summary links, ${result.edges.length - summaries} relations${result.limited ? " (newest only)" : ""}.`;
	}
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
