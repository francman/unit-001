// Issues #6/#8: deterministic whole-token recall and stale-summary exclusion.

import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { memoryEvidence } from "../src/injection.ts";
import type { MemoryState } from "../src/memory.ts";
import { forgetMemory, rememberMemory } from "../src/operations.ts";
import { MemoryRecall, memoryTokens } from "../src/recall.ts";

function state(): MemoryState {
	return { revision: 0, records: {}, receipts: {}, captures: {}, consolidation: { state: "idle" } };
}
function add(memory: MemoryState, key: string, content: string) {
	return rememberMemory(memory, {
		writeKey: key,
		content,
		now: 0,
		provenance: { origin: "agent", conversationId: 1 as ConversationId, entryIds: [], derivation: "explicit" },
	});
}

describe("bounded lexical recall", () => {
	it("keeps flags exact, normalizes Unicode, and matches identifiers without substring fallback", () => {
		const memory = state();
		const recall = new MemoryRecall();
		add(memory, "redis", "redis --force db_name ＣＡＦÉ");
		add(memory, "other", "redistribution force -force");
		expect(recall.recall(memory, "redis", { now: 0 }).map((result) => result.id)).toEqual(["memory:redis"]);
		for (const query of ["--force", "db_name", "name", "café"])
			expect(recall.recall(memory, query, { now: 0 })[0]?.id).toBe("memory:redis");
		expect(recall.recall(memory, "force", { now: 0 })[0]?.id).toBe("memory:other");
		for (const query of ["the and", "unrelated", ""]) expect(recall.recall(memory, query, { now: 0 })).toEqual([]);
		expect(memoryTokens("--force").has("force")).toBe(false);
	});
	it("invalidates cached evidence on forget and when another owner has the same revision", () => {
		const memory = state();
		const recall = new MemoryRecall();
		const id = add(memory, "one", "redis");
		expect(recall.recall(memory, "redis", { now: 0 })).toHaveLength(1);
		forgetMemory(memory, { writeKey: "forget", id });
		expect(recall.recall(memory, "redis", { now: 0 })).toEqual([]);
		const other = state();
		add(other, "two", "postgres");
		expect(recall.recall(other, "postgres", { now: 0 })).toHaveLength(1);
		recall.clear();
		expect(recall.recall(other, "postgres", { now: 0 })).toHaveLength(1);
	});
	it("bounds request evidence and marks agent-authored statements untrusted", () => {
		const memory = state();
		add(memory, "long", `redis ${"界".repeat(1900)}`);
		const block = memoryEvidence(new MemoryRecall().recall(memory, "redis", { now: 0 }));
		expect(Array.from(block).length).toBeLessThanOrEqual(3000);
		expect(block).toContain("untrusted");
		expect(block).toContain('"origin":"agent"');
		expect(block).toContain("…");
	});
	it("uses the decided score, deterministic ties, bounds, and stale summary source versions", () => {
		const memory = state();
		const recall = new MemoryRecall();
		const id = add(memory, "b", "redis");
		add(memory, "a", "redis");
		const source = memory.records[id];
		if (source.state !== "live") throw new Error("source absent");
		memory.records.summary = {
			...source,
			id: "summary",
			content: "redis summary",
			tier: { kind: "episodic", summaryOf: [{ id, revision: 99 }] },
		};
		memory.revision++;
		const results = recall.recall(memory, "redis", { now: 0 });
		expect(results.map((result) => result.id)).toEqual(["memory:a", "memory:b"]);
		expect(results[0].score).toBeCloseTo(0.9);
		expect(recall.recall(memory, "redis", { now: 72 * 3600000 })[0].score).toBeCloseTo(0.9 * (0.7 + 0.3 / Math.E));
		expect(() => recall.recall(memory, "redis", { now: 0, topK: 21 })).toThrow("topK");
	});
	it("updates changed postings and bookkeeping without retaining prior owner content", () => {
		const memory = state();
		const recall = new MemoryRecall();
		const id = add(memory, "one", "redis");
		recall.recall(memory, "redis", { now: 0 });
		const previous = memory.records[id];
		if (previous.state !== "live") throw new Error("source absent");
		memory.records[id] = { ...previous, content: "postgres", revision: 2 };
		memory.revision++;
		expect(recall.recall(memory, "redis", { now: 0 })).toEqual([]);
		expect(recall.recall(memory, "postgres", { now: 0 })[0]?.revision).toBe(2);
		memory.records[id] = {
			...previous,
			content: "postgres",
			revision: 2,
			tier: { kind: "working", consolidation: { state: "done", summaryIds: [] } },
		};
		memory.revision++;
		expect(recall.recall(memory, "postgres", { now: 0 })[0]?.tier).toEqual({
			kind: "working",
			consolidation: { state: "done", summaryIds: [] },
		});
	});
});
