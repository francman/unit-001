// Checks the untrusted memory control boundary and explicit forget confirmation.
import { describe, expect, it } from "vitest";
import { describeMemory, memoryCommand, parseMemoryRequest, parseMemoryResult } from "../src/memory-control.ts";

describe("memory control", () => {
	it("#8 separates an operator forget proposal from a confirmed wire mutation", () => {
		expect(memoryCommand("forget", "memory:a", "retry")).toEqual({
			operation: "confirm-forget",
			id: "memory:a",
			requestId: "retry",
		});
		expect(() => parseMemoryRequest({ operation: "forget", id: "memory:a", requestId: "retry" })).toThrow(
			"confirmation",
		);
		expect(
			parseMemoryRequest({ operation: "forget", id: "memory:a", requestId: "retry", confirmed: true }),
		).toMatchObject({ confirmed: true });
	});

	it("#8 rejects malformed or oversized arguments and bounded result frames", () => {
		for (const value of [
			null,
			{},
			{ operation: "recall", query: "" },
			{ operation: "recall", query: "x".repeat(2001) },
			{ operation: "remember", content: "x", requestId: 4 },
		])
			expect(() => parseMemoryRequest(value)).toThrow();
		for (const value of [
			null,
			{},
			{ operation: "stats", working: -1 },
			{
				operation: "recall",
				records: [{ id: "memory:a", content: "a", origin: "user", tier: "working", score: Infinity }],
			},
			{ operation: "recall", records: Array(6).fill({}) },
		])
			expect(() => parseMemoryResult(value)).toThrow();
		expect(() => memoryCommand("stats", "extra")).toThrow();
	});

	it("#8 sanitizes terminal memory content and reports transcript retention on forget", () => {
		expect(describeMemory({ operation: "remember", id: "memory:a\u001b]52;c;bad\u0007" })).toBe(
			"Remembered memory:a.",
		);
		expect(
			describeMemory({
				operation: "recall",
				records: [
					{ id: "memory:a", content: "violet\u001b]52;c;bad\u0007", origin: "user", tier: "working", score: 1 },
				],
			}),
		).toBe("memory:a [user/working]\nviolet");
		expect(describeMemory({ operation: "forget", removed: true })).toContain(
			"Immutable conversation history remains",
		);
	});

	it("accepts the read-only graph request without arguments and validates graph result frames", () => {
		expect(parseMemoryRequest({ operation: "graph" })).toEqual({ operation: "graph" });
		expect(parseMemoryRequest({ operation: "graph", requestId: "ignored" })).toEqual({ operation: "graph" });
		expect(() => memoryCommand("graph", "extra")).toThrow();
		const node = {
			id: "memory:a",
			content: "a",
			truncated: false,
			kind: "fact",
			tier: "working",
			origin: "user",
			importance: 0.5,
			createdAt: 1,
			conversation: "0123456789ab",
		};
		const valid = {
			operation: "graph",
			nodes: [node, { ...node, id: "memory:s", tier: "episodic" }],
			edges: [
				{ from: "memory:s", to: "memory:a", kind: "summary" },
				{ from: "memory:a", to: "memory:s", kind: "contradicts", derivation: "explicit" },
				{ from: "memory:s", to: "memory:a", kind: "relates", derivation: "consolidation" },
			],
			total: 3,
			limited: true,
		};
		expect(parseMemoryResult({ ...valid, extra: "dropped" })).toEqual(valid);
		expect(describeMemory(parseMemoryResult(valid))).toBe(
			"Memory graph: 2 of 3 live memories, 1 summary links, 2 relations (newest only).",
		);
		for (const patch of [
			{ nodes: Array(301).fill(node), total: 301, limited: false },
			{ edges: Array(1001).fill(valid.edges[0]) },
			{ nodes: [{ ...node, content: "x".repeat(281) }], edges: [] },
			{ nodes: [{ ...node, conversation: "1" }], edges: [] },
			{ nodes: [{ ...node, kind: "secret" }], edges: [] },
			{ nodes: [{ ...node, importance: 2 }], edges: [] },
			{ nodes: [node, node], edges: [] },
			{ edges: [{ from: "memory:s", to: "memory:gone", kind: "summary" }] },
			{ edges: [{ from: "memory:s", to: "memory:a", kind: "causes", derivation: "explicit" }] },
			{ edges: [{ from: "memory:s", to: "memory:a", kind: "supports" }] },
			{ edges: [{ from: "memory:s", to: "memory:a", kind: "supports", derivation: "guessed" }] },
			{ edges: [{ from: "memory:a", to: "memory:a", kind: "relates", derivation: "explicit" }] },
			{ edges: [{ from: "memory:a", to: "memory:gone", kind: "updates", derivation: "explicit" }] },
			{ total: 1 },
			{ limited: false },
		])
			expect(() => parseMemoryResult({ ...valid, ...patch })).toThrow();
	});
});
