// Issues #6–#9: independent app acceptance across SQLite reopen, forgetting and maintenance.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryDoc, MemoryRecall, rememberMemory } from "unit-memory";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

describe("independent persistent memory acceptance", () => {
	it("returns heap-ranked candidates in the same total order as an independent full sort", () => {
		const state = MemoryDoc.definition.initial!();
		const expected: { id: string; score: number; updatedAt: number }[] = [];
		for (let index = 0; index < 151; index++) {
			const updatedAt = (index % 7) * 1000;
			const importance = (index % 5) / 4;
			const id = rememberMemory(state, {
				writeKey: `rank-${index}`,
				content: "redis",
				now: updatedAt,
				importance,
				provenance: { origin: "user", conversationId: 1 as ConversationId, entryIds: [], derivation: "explicit" },
			});
			expected.push({
				id,
				updatedAt,
				score: (0.8 + 0.2 * importance) * (0.7 + 0.3 * Math.exp(-(10000 - updatedAt) / 3600000 / 72)),
			});
		}
		expected.sort(
			(a, b) => b.score - a.score || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		const recall = new MemoryRecall();
		for (const topK of [1, 5, 20])
			expect(recall.recall(state, "redis", { now: 10000, topK }).map((record) => record.id)).toEqual(
				expected.slice(0, topK).map((record) => record.id),
			);
		recall.clear();
	});
	it("keeps replay identities, excludes forgotten evidence, and drains sleeping maintenance", async () => {
		const directory = await mkdtemp("/tmp/unit-memory-acceptance-");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// Storage creation is asynchronous, so each owner is opened only after its predecessor closes.
		async function launch() {
			return Agent.open(
				{
					storage: await openNodeSqliteStorage(join(directory, "state.sqlite")),
					models,
					model: { provider: "faux", modelId: "faux-1" },
					cwd: directory,
					name: "bob",
				},
				context,
			);
		}
		let agent = await launch();
		try {
			const request = {
				operation: "remember" as const,
				content: "redis confidential preference",
				requestId: "original",
			};
			const result = await agent.memory(request, context);
			if (result.operation !== "remember") throw new Error("Expected remember result");
			// Cross the document checkpoint interval with independent committed mutations.
			for (let index = 0; index < 66; index++)
				await agent.memory(
					{ operation: "remember", content: `postgres record ${index}`, requestId: `seed-${index}` },
					context,
				);
			await agent.close(context);
			agent = await launch();
			expect(await agent.memory(request, context)).toEqual(result);
			const forget = {
				operation: "forget" as const,
				id: result.id,
				requestId: "delete-original",
				confirmed: true as const,
			};
			expect(await agent.memory(forget, context)).toEqual({ operation: "forget", removed: true });
			await agent.close(context);
			agent = await launch();
			expect(await agent.memory(forget, context)).toEqual({ operation: "forget", removed: true });
			expect(await agent.memory(request, context)).toEqual(result);
			expect(await agent.memory({ operation: "recall", query: "redis" }, context)).toEqual({
				operation: "recall",
				records: [],
			});
			let observed = "";
			faux.setResponses([
				(request) => {
					observed = JSON.stringify(request.messages);
					return fauxAssistantMessage("done");
				},
			]);
			await agent.ask("redis", context);
			await agent.idle(context);
			expect(observed).toContain("durable agent named bob");
			expect(observed).not.toContain("redis confidential preference");
			expect((await agent.status(context)).busy).toBe(false);
			expect(await agent.enterMaintenance("acceptance-update", 1000, context)).toMatchObject({ result: "drained" });
			await agent.close(context);
			agent = await launch();
			expect((await agent.status(context)).inhibited).toBe(true);
			await agent.releaseMaintenance("acceptance-update", context);
			expect(await agent.memory({ operation: "stats" }, context)).toMatchObject({ working: 66, tombstones: 1 });
		} finally {
			await agent.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
