// Measures the actual memory-enabled submit-to-faux-provider path and cold document replay.
import { strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryDoc, rememberMemory } from "unit-memory";
import { Agent } from "../src/agent.ts";
import { reportEnvironment, summarize } from "./benchmark.ts";

reportEnvironment();
for (const count of process.argv[2] === undefined ? [1000, 10000] : [Number(process.argv[2])]) {
	if (count !== 1000 && count !== 10000) throw new Error("Expected a fixture size of 1000 or 10000");
	const directory = await mkdtemp("/tmp/unit-memory-request-bench-");
	const file = join(directory, "state.sqlite");
	const seed = createSession(await openNodeSqliteStorage(file));
	await seed.commit(async (tx) => {
		const state = await tx.doc(MemoryDoc);
		for (let index = 0; index < count; index++)
			rememberMemory(state, {
				writeKey: `seed:${index}`,
				content: `redis deployment ${index}: ${"bounded evidence ".repeat(30)}`,
				now: Date.now(),
				provenance: { origin: "user", conversationId: 1 as ConversationId, entryIds: [], derivation: "explicit" },
			});
	}, context);
	await seed.close(context);
	const replaySamples: number[] = [];
	for (let index = 0; index < 30; index++) {
		const started = performance.now();
		const session = createSession(await openNodeSqliteStorage(file));
		strictEqual(Object.keys((await session.snapshot(MemoryDoc, context))!.records).length, count);
		if (index >= 5) replaySamples.push(performance.now() - started);
		await session.close(context);
	}
	report(`memory/${count}/storage-open-and-first-snapshot`, count === 1000 ? 20 : 100, replaySamples);
	global.gc?.();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(file),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
		},
		context,
	);
	try {
		const samples: number[] = [];
		let coldMs = 0;
		const rssBefore = process.memoryUsage().rss;
		for (let index = 0; index < 31; index++) {
			let elapsed = 0;
			faux.setResponses([
				(request) => {
					elapsed = performance.now() - started;
					strictEqual(JSON.stringify(request.messages).includes("Retrieved memory evidence"), true);
					return fauxAssistantMessage("done");
				},
			]);
			const started = performance.now();
			await agent.ask("redis", context);
			await agent.idle(context);
			if (index === 0) coldMs = elapsed;
			if (index >= 6) samples.push(elapsed);
		}
		const rssAfter = process.memoryUsage().rss;
		global.gc?.();
		report(`memory/${count}/actual-submit-to-provider`, count === 1000 ? 20 : 150, samples);
		console.log(
			JSON.stringify({
				name: `memory/${count}/process-observations`,
				firstRequestMs: coldMs,
				rssBefore,
				rssAfter,
				rssAfterGc: global.gc === undefined ? null : process.memoryUsage().rss,
			}),
		);
	} finally {
		await agent.close(context);
		await rm(directory, { recursive: true, force: true });
	}
}

function report(name: string, budgetMs: number, samples: number[]): void {
	const stats = summarize(samples);
	const passed = stats.p95Ms <= budgetMs;
	console.log(JSON.stringify({ name, budgetMs, ...stats, samples, passed }));
	if (!passed) process.exitCode = 1;
}
