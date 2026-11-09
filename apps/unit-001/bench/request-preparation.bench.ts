/**
 * Submit-to-provider latency through unit-001: scheduling, prompt assembly, default memory and one extra hook.
 * Consecutive requests include durable capture contention and SQLite checkpoint tails; no samples are removed.
 * Acceptance: cold and warm p95 <= 10 ms (measured baseline and headroom in docs/latency.md).
 * Run: node --conditions=source --experimental-strip-types bench/request-preparation.bench.ts
 */
import { strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../src/agent.ts";
import { benchmark, reportEnvironment } from "./benchmark.ts";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "unit-001-request-bench-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let hooks = 0;
	const instructions = "unit benchmark instructions\n".repeat(160);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
			extensions: [
				defineExtension({
					name: "unit.bench",
					sections: [section("benchmark-context", () => instructions)],
					hooks: [
						hook(GenerationTask, {
							beforeRequest: () => {
								hooks++;
							},
						}),
					],
				}),
			],
		},
		context,
	);
	return {
		async sample(): Promise<number> {
			let elapsed = 0;
			const previous = hooks;
			faux.setResponses([
				(request) => {
					elapsed = performance.now() - started;
					strictEqual(hooks, previous + 1);
					strictEqual(
						request.messages.some(
							(message) =>
								message.role === "system" &&
								Object.values(message.sections ?? {}).some((value) => value?.includes(instructions)),
						),
						true,
					);
					return fauxAssistantMessage([fauxText("done")]);
				},
			]);
			const started = performance.now();
			const reply = await agent.ask("Return done.", context);
			strictEqual(reply.status, "answered");
			return elapsed;
		},
		async close(): Promise<void> {
			await agent.close(context);
			await rm(directory, { recursive: true, force: true });
		},
	};
}

reportEnvironment();
await benchmark("request-preparation/sqlite/cold", 10, async () => {
	const fresh = await fixture();
	try {
		return await fresh.sample();
	} finally {
		await fresh.close();
	}
});
const warm = await fixture();
try {
	await benchmark("request-preparation/sqlite/warm", 10, () => warm.sample());
} finally {
	await warm.close();
}
