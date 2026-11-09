// Issue #7: empty learning does not create durable capture work between requests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { createMemoryExtension } from "../src/extension.ts";
import { MemoryDoc } from "../src/memory.ts";

it("skips complete empty runs, then durably captures eligible input after restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-memory-run-end-"));
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const service = createMemoryExtension();
	const registry = createRegistry();
	registry.install(service.extension);
	const open = () =>
		openNodeSqliteStorage(join(directory, "session.sqlite")).then((storage) =>
			Harness.open(storage, { models, registry }, context),
		);
	let harness = await open();
	try {
		let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		for (const text of ["", "Who are you?", '> remember quoted\n"remember quoted"\n~~~\nI prefer code\n~~~']) {
			faux.setResponses([fauxAssistantMessage("done")]);
			await (
				await root.submit(
					{ type: "input", content: text, entry: { kind: "unit.input", data: { origin: "human" } } },
					context,
				)
			).wait(context);
			await root.waitForIdle(context);
			expect(await harness.snapshot(MemoryDoc, context)).toBeUndefined();
		}
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		faux.setResponses([fauxAssistantMessage("done")]);
		await (
			await root.submit(
				{
					type: "input",
					content: "remember durable fact\nI prefer dark terminals.",
					requestId: "eligible",
					entry: { kind: "unit.input", data: { origin: "human" } },
				},
				context,
			)
		).wait(context);
		await root.waitForIdle(context);
		const state = await harness.snapshot(MemoryDoc, context);
		const capture = Object.values(state!.captures)[0]!;
		await harness.waitForTask(capture.taskId, context);
		const captured = await harness.snapshot(MemoryDoc, context);
		expect(
			Object.values(captured!.records)
				.filter((record) => record.state === "live")
				.map((record) => record.content),
		).toEqual(["durable fact", "I prefer dark terminals."]);
		await (
			await root.submit(
				{
					type: "input",
					content: "remember durable fact\nI prefer dark terminals.",
					requestId: "eligible",
					entry: { kind: "unit.input", data: { origin: "human" } },
				},
				context,
			)
		).wait(context);
		expect(Object.keys((await harness.snapshot(MemoryDoc, context))!.captures)).toHaveLength(1);
	} finally {
		await harness.close(context);
		service.close();
		await rm(directory, { recursive: true, force: true });
	}
});
