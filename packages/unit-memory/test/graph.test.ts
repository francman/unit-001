// Bounded read-only memory graph: caps, ordering, forgotten exclusion and edge filtering.
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
	MEMORY_GRAPH_CONTENT_LIMIT,
	MEMORY_GRAPH_EDGE_LIMIT,
	MEMORY_GRAPH_NODE_LIMIT,
	memoryGraph,
} from "../src/graph.ts";
import type { LiveMemory, MemoryState } from "../src/memory.ts";
import { forgetMemory } from "../src/operations.ts";
import type { MemoryRelation } from "../src/relations-doc.ts";

function state(): MemoryState {
	return { revision: 0, records: {}, receipts: {}, captures: {}, consolidation: { state: "idle" } };
}

function live(id: string, updatedAt: number, overrides: Partial<LiveMemory> = {}): LiveMemory {
	return {
		state: "live",
		id,
		revision: 1,
		content: `memory ${id}`,
		kind: "fact",
		importance: 0.5,
		createdAt: updatedAt,
		updatedAt,
		provenance: { origin: "user", conversationId: 1 as ConversationId, entryIds: [], derivation: "explicit" },
		tier: { kind: "working", consolidation: { state: "pending" } },
		...overrides,
	};
}

function summary(id: string, updatedAt: number, sources: string[]): LiveMemory {
	return live(id, updatedAt, {
		tier: { kind: "episodic", summaryOf: sources.map((source) => ({ id: source, revision: 1 })) },
		provenance: { origin: "agent", conversationId: 2 as ConversationId, entryIds: [], derivation: "summary" },
	});
}

function put(memory: MemoryState, ...records: LiveMemory[]): MemoryState {
	for (const record of records) memory.records[record.id] = record;
	return memory;
}

describe("memory graph read", () => {
	it("returns an empty graph for absent memory", () => {
		expect(memoryGraph(undefined, undefined)).toEqual({ nodes: [], edges: [], total: 0, limited: false });
	});

	it("orders nodes newest first by update time with id as tie-break and projects display fields only", () => {
		const memory = put(
			state(),
			live("b", 5),
			live("a", 5),
			live("old", 1, { kind: "preference", importance: 0.9, createdAt: 0, source: "private-source" }),
		);
		const graph = memoryGraph(memory, undefined);
		expect(graph.nodes.map((node) => node.id)).toEqual(["a", "b", "old"]);
		expect(graph.nodes[2]).toEqual({
			id: "old",
			content: "memory old",
			truncated: false,
			kind: "preference",
			tier: "working",
			origin: "user",
			importance: 0.9,
			createdAt: 0,
			conversation: expect.stringMatching(/^[a-f0-9]{12}$/),
		});
		expect(graph).toMatchObject({ total: 3, limited: false, edges: [] });
		expect(JSON.stringify(graph)).not.toContain("private-source");
	});

	it("caps nodes at the newest limit and reports the live total", () => {
		const memory = state();
		for (let index = 0; index < MEMORY_GRAPH_NODE_LIMIT + 5; index++) put(memory, live(`m${index}`, index));
		const graph = memoryGraph(memory, undefined);
		expect(graph.nodes).toHaveLength(MEMORY_GRAPH_NODE_LIMIT);
		expect(graph.nodes[0]?.id).toBe(`m${MEMORY_GRAPH_NODE_LIMIT + 4}`);
		expect(graph.nodes.some((node) => node.id === "m4")).toBe(false);
		expect(graph).toMatchObject({ total: MEMORY_GRAPH_NODE_LIMIT + 5, limited: true });
	});

	it("truncates content by code points and marks it", () => {
		const long = `${"語".repeat(MEMORY_GRAPH_CONTENT_LIMIT - 1)}😀😀`;
		const exact = "x".repeat(MEMORY_GRAPH_CONTENT_LIMIT);
		const [first, second] = memoryGraph(
			put(state(), live("long", 2, { content: long }), live("exact", 1, { content: exact })),
			undefined,
		).nodes;
		expect(first).toMatchObject({ id: "long", truncated: true });
		expect(Array.from(first?.content ?? "")).toHaveLength(MEMORY_GRAPH_CONTENT_LIMIT);
		expect(first?.content.endsWith("😀")).toBe(true);
		expect(second).toMatchObject({ content: exact, truncated: false });
	});

	it("never returns forgotten records or their invalidated summaries", () => {
		const memory = put(state(), live("source", 1), live("other", 2), summary("digest", 3, ["source", "other"]));
		forgetMemory(memory, { writeKey: "forget", id: "source" }, { relations: {} });
		const graph = memoryGraph(memory, undefined);
		expect(graph.nodes.map((node) => node.id)).toEqual(["other"]);
		expect(graph).toMatchObject({ edges: [], total: 1, limited: false });
	});

	it("keeps summary edges only between returned nodes", () => {
		const memory = state();
		put(memory, live("dropped", 0));
		for (let index = 1; index < MEMORY_GRAPH_NODE_LIMIT; index++) put(memory, live(`m${index}`, index));
		put(memory, summary("digest", MEMORY_GRAPH_NODE_LIMIT, ["m1", "dropped", "missing", "m2"]));
		const graph = memoryGraph(memory, undefined);
		expect(graph.nodes.some((node) => node.id === "dropped")).toBe(false);
		expect(graph.edges).toEqual([
			{ from: "digest", to: "m1", kind: "summary" },
			{ from: "digest", to: "m2", kind: "summary" },
		]);
	});

	it("bounds edges even for abnormal summary state", () => {
		const memory = state();
		const sources = Array.from({ length: 50 }, (_, index) => `s${index}`);
		for (const id of sources) put(memory, live(id, 0));
		for (let index = 0; index < 30; index++) put(memory, summary(`digest${index}`, 1 + index, sources));
		expect(memoryGraph(memory, undefined).edges).toHaveLength(MEMORY_GRAPH_EDGE_LIMIT);
	});

	it("replaces conversation ids with stable opaque keys", () => {
		const graph = memoryGraph(
			put(
				state(),
				live("a", 3),
				live("b", 2),
				live("c", 1, {
					provenance: { origin: "tool", conversationId: 7 as ConversationId, entryIds: [], derivation: "capture" },
				}),
			),
			undefined,
		);
		const [a, b, c] = graph.nodes;
		expect(a?.conversation).toBe(b?.conversation);
		expect(a?.conversation).not.toBe(c?.conversation);
		expect(c?.conversation).not.toBe("7");
		expect(memoryGraph(put(state(), live("a", 3)), undefined).nodes[0]?.conversation).toBe(a?.conversation);
	});

	it("adds live relation edges between returned nodes after summary edges, newest first", () => {
		const relation = (id: string, from: string, to: string, createdAt: number, revision = 1): MemoryRelation => ({
			id,
			kind: id === "r-new" ? "supports" : "relates",
			from: { id: from, revision: 1 },
			to: { id: to, revision },
			createdAt,
			provenance:
				id === "r-new"
					? { derivation: "explicit", origin: "agent", conversationId: 1 as ConversationId, entryIds: [] }
					: { derivation: "consolidation", taskId: 1 as TaskId },
		});
		const memory = put(state(), live("a", 3), live("b", 2), summary("digest", 4, ["a"]));
		const relations = {
			"r-old": relation("r-old", "a", "b", 1),
			"r-new": relation("r-new", "b", "a", 2),
			"r-stale": relation("r-stale", "a", "b", 3, 2),
			"r-absent": relation("r-absent", "a", "gone", 4),
		};
		expect(memoryGraph(memory, { relations }).edges).toEqual([
			{ from: "digest", to: "a", kind: "summary" },
			{ from: "b", to: "a", kind: "supports", derivation: "explicit" },
			{ from: "a", to: "b", kind: "relates", derivation: "consolidation" },
		]);
	});
});
