// Issue #6: request evidence comes from current placed inputs and never persists in context.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, GenerationTask, Harness, hook, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { memoryBeforeRequest } from "../src/injection.ts";
import { MemoryInputEntry, MemoryInputsDoc, recordMemoryInput } from "../src/inputs.ts";
import { MemoryDoc } from "../src/memory.ts";
import { rememberMemory } from "../src/operations.ts";
import { MemoryRecall } from "../src/recall.ts";

const context = BACKGROUND_CONTEXT;

describe("placed input recall injection", () => {
	it("ignores newer queued metadata, preserves messages, and supports synthetic mission queries", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const recall = new MemoryRecall();
		const extension = {
			name: "memory-test",
			hooks: [hook(GenerationTask, { beforeRequest: memoryBeforeRequest(recall, () => 0) })],
		};
		registry.install(extension);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [extension] },
			});
			await root.commit(async (tx) => {
				const memory = await tx.doc(MemoryDoc);
				for (const word of ["redis", "postgres"])
					rememberMemory(memory, {
						writeKey: word,
						content: `prefer ${word}`,
						now: 0,
						provenance: { origin: "user", conversationId: root.id, entryIds: [], derivation: "explicit" },
					});
			}, context);
			const observed: string[] = [];
			faux.setResponses([
				(request) => {
					observed.push(JSON.stringify(request.messages));
					return fauxAssistantMessage("done");
				},
				(request) => {
					observed.push(JSON.stringify(request.messages));
					return fauxAssistantMessage("done again");
				},
			]);
			await root.commit(async (tx) => {
				const id = await root.submit(tx, {
					type: "input",
					content: "redis question",
					entry: { kind: MemoryInputEntry.kind, data: { origin: "human" } },
				});
				await recordMemoryInput(tx, root.id, id, "human", "redis");
				(await tx.doc(MemoryInputsDoc, root.id)).inputs.queued = { origin: "human", query: "postgres" };
			}, context);
			await harness.waitForIdle(context);
			expect(observed[0]).toContain("prefer redis");
			expect(observed[0]).not.toContain("prefer postgres");
			expect(JSON.stringify((await root.context(context)).messages)).not.toContain("Retrieved memory evidence");
			await root.commit(async (tx) => {
				const id = await root.submit(tx, {
					type: "input",
					content: "perform mission",
					entry: { kind: MemoryInputEntry.kind, data: { origin: "mission" } },
				});
				await recordMemoryInput(tx, root.id, id, "mission", "postgres");
			}, context);
			await harness.waitForIdle(context);
			expect(observed[1]).toContain("prefer postgres");
		} finally {
			recall.clear();
			await harness.close(context);
		}
	});
});
