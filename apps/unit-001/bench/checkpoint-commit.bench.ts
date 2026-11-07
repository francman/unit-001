/**
 * Real task checkpoint commit on SQLite, including serialization, persistence, and publication.
 * Acceptance: cold and warm p95 <= 2 ms (measured baseline and headroom in docs/latency.md).
 * Run: node --conditions=source --experimental-strip-types bench/checkpoint-commit.bench.ts
 */
import { strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { benchmark, reportEnvironment } from "./benchmark.ts";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "unit-001-checkpoint-bench-"));
	let elapsed = 0;
	const payload = "x".repeat(4096);
	const checkpoint = defineTask<null, { phase: "checkpoint" } | { phase: "finish"; payload: string }, null>({
		name: "unit.bench.checkpoint",
		version: 1,
		initial: () => ({ phase: "checkpoint" }),
		phases: {
			checkpoint: async (_task, runtime, ctx) => {
				const started = performance.now();
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish", payload } }), ctx);
				elapsed = performance.now() - started;
			},
			finish: async (task, runtime, ctx) => {
				strictEqual(task.state.checkpoint.payload, payload);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: async (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "unit.bench", tasks: [checkpoint] }));
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models: createModels(), registry },
		context,
	);
	const root = await harness.root(context);
	harness.resume();
	return {
		async sample(): Promise<number> {
			const id = await root.commit(
				(tx) => tx.createTask(checkpoint, null, { ownership: { kind: "conversation" } }),
				context,
			);
			const settled = await harness.waitForTask(id, context);
			strictEqual(settled.state.outcome.status, "completed");
			return elapsed;
		},
		async close(): Promise<void> {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		},
	};
}

reportEnvironment();
await benchmark("checkpoint/sqlite/cold", 2, async () => {
	const fresh = await fixture();
	try {
		return await fresh.sample();
	} finally {
		await fresh.close();
	}
});
const warm = await fixture();
try {
	await benchmark("checkpoint/sqlite/warm", 2, () => warm.sample());
} finally {
	await warm.close();
}
