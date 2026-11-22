// Exercises bounded side operation parsing without opening a service or socket.
import { describe, expect, it } from "vitest";
import { describeSides, parseSideRequest, parseSideResult, sideFingerprint } from "../src/side-control.ts";

describe("side control", () => {
	it("normalizes titles and supplies the concrete source title without changing request identity", () => {
		expect(parseSideRequest({ operation: "list" })).toEqual({ operation: "list" });
		expect(parseSideRequest({ operation: "start", from: 42, requestId: "r" })).toEqual({
			operation: "start", from: 42, title: "Side chat from message 42", requestId: "r",
		});
		const request = parseSideRequest({ operation: "start", from: 42, title: "  Research  ", requestId: "r" });
		if (request.operation !== "start") throw new Error("Expected start.");
		expect(request.title).toBe("Research");
		expect(sideFingerprint(request)).toBe(sideFingerprint({ ...request, requestId: "another" }));
		expect(sideFingerprint(request)).not.toBe(sideFingerprint({ ...request, from: 43 }));
		expect(sideFingerprint(request)).not.toBe(sideFingerprint({ ...request, title: "research" }));
	});

	it("accepts 80 Unicode code points including four-byte characters", () => {
		expect(parseSideRequest({ operation: "start", from: 1, title: "𐐀".repeat(80), requestId: "r" })).toMatchObject({
			title: "𐐀".repeat(80),
		});
	});

	it.each(["", " ", "x".repeat(81), "𐐀".repeat(81), "line\nline", "tab\t", "\u007f", "\u0085", "a\u202Eb", "a\u2066b", "a\u2069b", "a\u200Bb", "a\u2028b", "a\u2029b"])(
		"rejects invalid title %j", (title) => {
			expect(() => parseSideRequest({ operation: "start", from: 1, title, requestId: "r" })).toThrow();
		},
	);

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "42", null])("rejects invalid source %j", (from) => {
		expect(() => parseSideRequest({ operation: "start", from, requestId: "r" })).toThrow();
	});

	it("rejects missing request identity and undeclared authority or lifecycle fields", () => {
		for (const requestId of [undefined, "", "x".repeat(201), 1])
			expect(() => parseSideRequest({ operation: "start", from: 1, requestId })).toThrow();
		for (const field of ["owner", "model", "tools", "cwd", "credentials", "parent", "archive", "conversation"])
			expect(() => parseSideRequest({ operation: "start", from: 1, requestId: "r", [field]: 1 })).toThrow();
		expect(() => parseSideRequest({ operation: "list", title: "Extra" })).toThrow();
	});

	it("round-trips bounded metadata and renders titles as terminal-safe text", () => {
		const result = parseSideResult({
			operation: "list", main: { conversationId: 1, state: "busy" },
			sides: [{ conversationId: 5, parent: { conversationId: 1, at: 3 }, title: "Research", createdAt: 10, state: "queued" }],
		});
		expect(describeSides(result)).toContain("5: Research (queued; from message 3).");
		expect(parseSideResult({ operation: "start", conversationId: 5 })).toEqual({ operation: "start", conversationId: 5 });
	});

	it("rejects oversized lists, duplicate addresses, inconsistent parents and invented states", () => {
		const side = { conversationId: 5, parent: { conversationId: 1, at: 3 }, title: "Research", createdAt: 10, state: "idle" };
		const list = { operation: "list", main: { conversationId: 1, state: "idle" }, sides: [side] };
		for (const sides of [Array(17).fill(side), [side, side], [{ ...side, conversationId: 1 }],
			[{ ...side, parent: { conversationId: 2, at: 3 } }], [{ ...side, state: "needs-input" }],
			[{ ...side, title: " space " }], [{ ...side, createdAt: -1 }]])
			expect(() => parseSideResult({ ...list, sides })).toThrow();
	});
});
