// Measures cold indexing, warm broad recall, and forget invalidation without provider calls.
import { strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type ConversationId, createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { forgetMemory, MemoryDoc, MemoryRecall, memoryEvidence, rememberMemory } from "unit-memory";
import { benchmark, reportEnvironment } from "./benchmark.ts";

reportEnvironment();
for (const [count, coldBudget, warmBudget, forgetBudget, commitBudget] of [
	[100, 4, 1, 2, 2],
	[1000, 20, 2, 20, 5],
	[10000, 300, 10, 200, 20],
]) {
	const state = MemoryDoc.definition.initial!();
	for (let index = 0; index < count; index++) {
		rememberMemory(state, {
			writeKey: `seed:${index}`,
			content: `redis deployment ${index}: ${"bounded evidence ".repeat(30)}`,
			now: index,
			provenance: { origin: "user", conversationId: 1 as ConversationId, entryIds: [], derivation: "explicit" },
		});
	}
	// Budgets are fixed from independent calibration; see docs/latency.md for workload and limits.
	await benchmark(`memory/${count}/cold-index-and-evidence`, coldBudget, async () => {
		const recall = new MemoryRecall();
		const start = performance.now();
		const block = memoryEvidence(recall.recall(state, "redis", { now: count }));
		const elapsed = performance.now() - start;
		strictEqual(block.includes("redis"), true);
		strictEqual(Array.from(block).length <= 3000, true);
		recall.clear();
		return elapsed;
	});
	const recall = new MemoryRecall();
	recall.recall(state, "redis", { now: count });
	await benchmark(`memory/${count}/warm-recall-and-evidence`, warmBudget, async () => {
		const start = performance.now();
		memoryEvidence(recall.recall(state, "redis", { now: count }));
		return performance.now() - start;
	});
	let sequence = 0;
	await benchmark(`memory/${count}/forget-reconcile`, forgetBudget, async () => {
		const id = `memory:seed:${sequence}`;
		const start = performance.now();
		forgetMemory(state, { writeKey: `forget:${sequence++}`, id });
		const results = recall.recall(state, "redis", { now: count, topK: 20 });
		const elapsed = performance.now() - start;
		strictEqual(
			results.some((record) => record.id === id),
			false,
		);
		return elapsed;
	});
	console.log(
		JSON.stringify({
			count,
			serializedStateBytes: Buffer.byteLength(JSON.stringify(state)),
			receipts: Object.keys(state.receipts).length,
		}),
	);
	recall.clear();
	const directory = await mkdtemp(join(tmpdir(), "unit-memory-commit-bench-"));
	const session = createSession(await openNodeSqliteStorage(join(directory, "state.sqlite")));
	try {
		await session.commit(async (tx) => Object.assign(await tx.doc(MemoryDoc), state), context);
		await benchmark(`memory/${count}/sqlite-commit`, commitBudget, async () => {
			const start = performance.now();
			await session.commit(async (tx) => {
				forgetMemory(await tx.doc(MemoryDoc), { writeKey: `commit:${sequence++}`, id: "absent" });
			}, context);
			return performance.now() - start;
		});
		const start = performance.now();
		await session.snapshot(MemoryDoc, context);
		console.log(JSON.stringify({ name: `memory/${count}/warm-snapshot`, elapsedMs: performance.now() - start }));
	} finally {
		await session.close(context);
		await rm(directory, { recursive: true, force: true });
	}
}
