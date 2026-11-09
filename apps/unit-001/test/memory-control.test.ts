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
});
