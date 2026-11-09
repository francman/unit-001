// Issue #7: the empty-run shortcut must retain long-run extraction and invalid-input diagnostics.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createMemoryExtension } from "../src/extension.ts";
import { MemoryDoc } from "../src/memory.ts";

describe("run-end shortcut boundaries", () => {
	it("keeps durable extraction for a tool run exceeding the three-entry page", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const service = createMemoryExtension();
		const registry = createRegistry();
		registry.install(service.extension);
		registry.install(
			defineExtension({
				name: "boundary-tool",
				tools: [
					defineTool({
						name: "noop",
						description: "Return a local fixture tool response",
						parameters: Type.Object({}),
						execute: async () => ({ output: [{ type: "text", text: "remember tool output is not human" }] }),
					}),
				],
			}),
		);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await (
				await root.submit(
					{
						type: "input",
						content: "Ordinary question",
						entry: { kind: "unit.input", data: { origin: "human" } },
					},
					context,
				)
			).wait(context);
			await root.waitForIdle(context);
			const state = await harness.snapshot(MemoryDoc, context);
			const captures = Object.values(state?.captures ?? {});
			expect(captures).toHaveLength(1);
			const settled = await harness.waitForTask(captures[0].taskId, context);
			expect(settled.state.outcome).toMatchObject({ status: "completed", result: { memoryIds: [], skipped: 0 } });
			expect(Object.values((await harness.snapshot(MemoryDoc, context))!.records)).toEqual([]);
		} finally {
			await harness.close(context);
			service.close();
		}
	});

	it("preserves oversized-candidate diagnostics and finds valid statements beyond truncated recall metadata", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const service = createMemoryExtension();
		const registry = createRegistry();
		registry.install(service.extension);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			for (const content of [`remember ${"x".repeat(2001)}`, `${"x".repeat(2001)}\nremember late statement`]) {
				faux.setResponses([fauxAssistantMessage("done")]);
				await (
					await root.submit(
						{ type: "input", content, entry: { kind: "unit.input", data: { origin: "human" } } },
						context,
					)
				).wait(context);
				await root.waitForIdle(context);
				for (const capture of Object.values((await harness.snapshot(MemoryDoc, context))!.captures))
					await harness.waitForTask(capture.taskId, context);
			}
			const state = (await harness.snapshot(MemoryDoc, context))!;
			const captures = Object.values(state.captures);
			expect(captures).toHaveLength(2);
			const first = await harness.waitForTask(captures[0].taskId, context);
			expect(first.state.outcome).toMatchObject({ status: "completed", result: { memoryIds: [], skipped: 1 } });
			expect(
				Object.values(state.records)
					.filter((record) => record.state === "live")
					.map((record) => record.content),
			).toEqual(["late statement"]);
			faux.setResponses([fauxAssistantMessage("done")]);
			await (
				await root.submit(
					{
						type: "input",
						content: "Another ordinary question",
						entry: { kind: "unit.input", data: { origin: "human" } },
					},
					context,
				)
			).wait(context);
			await root.waitForIdle(context);
			expect(Object.keys((await harness.snapshot(MemoryDoc, context))!.captures)).toHaveLength(2);
		} finally {
			await harness.close(context);
			service.close();
		}
	});
});
