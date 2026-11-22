// Issue #8: all memory tools run locally and retain model authorship regardless of input origin.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createMemoryExtension } from "../src/extension.ts";
import { MemoryDoc } from "../src/memory.ts";
import { MemoryRelationsDoc } from "../src/relations-doc.ts";

const context = BACKGROUND_CONTEXT;

describe("in-process memory tools", () => {
	it("stores model claims as agent evidence, returns recall/stats, and forgets by ID", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const service = createMemoryExtension({ now: () => 0 });
		const registry = createRegistry();
		registry.install(service.extension);
		const harness = await Harness.open(new MemoryStorage(), { models, registry, now: () => 0 }, context);
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [service.extension] },
			});
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("remember", { content: "I am Claude Code", source: "human" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("saved"),
			]);
			await (await root.submit({ type: "input", content: "Who are you?" }, context)).wait(context);
			let memory = await harness.snapshot(MemoryDoc, context);
			const record = Object.values(memory?.records ?? {}).find((item) => item.state === "live");
			expect(record).toMatchObject({
				state: "live",
				content: "I am Claude Code",
				source: "human",
				provenance: { origin: "agent", derivation: "explicit" },
			});
			if (record?.state !== "live") throw new Error("memory was not stored");
			expect(record.provenance.entryIds).toHaveLength(1);
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("recall", { query: "Claude" }), fauxToolCall("stats", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("inspected"),
				fauxAssistantMessage(fauxToolCall("forget", { id: record.id }), { stopReason: "toolUse" }),
				fauxAssistantMessage("forgot"),
			]);
			await (await root.submit({ type: "input", content: "inspect memory" }, context)).wait(context);
			expect(JSON.stringify((await root.context(context)).messages)).toContain("working");
			await (await root.submit({ type: "input", content: "forget the claim" }, context)).wait(context);
			memory = await harness.snapshot(MemoryDoc, context);
			expect(memory?.records[record.id]).toMatchObject({ state: "forgotten" });
		} finally {
			await harness.close(context);
			service.close();
		}
	});

	it("stores relations the agent names to existing memories and rejects a dead target", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const service = createMemoryExtension({ now: () => 0 });
		const registry = createRegistry();
		registry.install(service.extension);
		const harness = await Harness.open(new MemoryStorage(), { models, registry, now: () => 0 }, context);
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [service.extension] },
			});
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("remember", { content: "Budget is ten thousand" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("saved"),
			]);
			await (await root.submit({ type: "input", content: "note the budget" }, context)).wait(context);
			const target = Object.keys((await harness.snapshot(MemoryDoc, context))?.records ?? {})[0]!;
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("remember", {
						content: "Finance cut the budget",
						relations: [{ id: target, kind: "updates" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("remember", {
						content: "Points nowhere",
						relations: [{ id: "memory:missing", kind: "relates" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await (await root.submit({ type: "input", content: "update it" }, context)).wait(context);
			const memory = (await harness.snapshot(MemoryDoc, context))!;
			const contents = Object.values(memory.records).map((record) =>
				record.state === "live" ? record.content : "",
			);
			expect(contents).toEqual(["Budget is ten thousand", "Finance cut the budget"]);
			expect(Object.values((await harness.snapshot(MemoryRelationsDoc, context))!.relations)).toEqual([
				expect.objectContaining({
					kind: "updates",
					to: { id: target, revision: 1 },
					provenance: expect.objectContaining({ derivation: "explicit", origin: "agent" }),
				}),
			]);
			expect(JSON.stringify((await root.context(context)).messages)).toContain("is not live");
		} finally {
			await harness.close(context);
			service.close();
		}
	});
});
