// Issues #6/#8: deterministic whole-token recall and stale-summary exclusion.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { memoryEvidence } from "../src/injection.ts";
import { MemoryDoc, type MemoryState } from "../src/memory.ts";
import { forgetMemory, rememberMemory } from "../src/operations.ts";
import { MemoryRecall, memoryTokens } from "../src/recall.ts";
import { sqliteFixture } from "./sqlite-fixture.ts";

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
	it("prepares the owner index and reuses structurally shared records after a SQLite receipt-only commit", async () => {
		// #6: bookkeeping must not move bank-wide scanning or tokenization onto the next request.
		const fixture = await sqliteFixture();
		const recall = new MemoryRecall();
		const normalization = vi.spyOn(String.prototype, "normalize");
		try {
			await fixture.session.commit(async (tx) => add(await tx.doc(MemoryDoc), "one", "violet approval"), context);
			const first = await fixture.session.snapshot(MemoryDoc, context);
			if (first === undefined) throw new Error("Memory is missing");
			let recordReads = 0;
			const records = new Proxy(first.records, {
				ownKeys(target) {
					recordReads++;
					return Reflect.ownKeys(target);
				},
				get(target, key) {
					recordReads++;
					return typeof key === "string" ? target[key] : undefined;
				},
			});
			recall.prepare({ ...first, records });
			expect(recordReads).toBeGreaterThan(0);
			expect(normalization).toHaveBeenCalledTimes(1);
			await fixture.session.commit(
				async (tx) => forgetMemory(await tx.doc(MemoryDoc), { writeKey: "missing", id: "absent" }),
				context,
			);
			const second = await fixture.session.snapshot(MemoryDoc, context);
			if (second === undefined) throw new Error("Memory is missing");
			expect(second).not.toBe(first);
			expect(second?.records).toBe(first?.records);
			normalization.mockClear();
			recordReads = 0;
			const shared = { ...second, records };
			recall.prepare(shared);
			expect(recordReads).toBe(0);
			expect(normalization).not.toHaveBeenCalled();
			expect(recall.recall(shared, "violet", { now: 0 })[0]?.id).toBe("memory:one");
			expect(recordReads).toBe(0);
			expect(normalization).toHaveBeenCalledTimes(1);
			recall.prepare(undefined);
			normalization.mockClear();
			recall.prepare(shared);
			expect(recordReads).toBeGreaterThan(0);
			expect(normalization).toHaveBeenCalledTimes(1);
		} finally {
			normalization.mockRestore();
			recall.clear();
			await fixture.close();
		}
	});
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
