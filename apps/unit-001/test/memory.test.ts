// Exercises default-owner memory admission, recovery, isolation and maintenance with real SQLite.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemoryExtension, MEMORY_RELATION_KINDS, MemoryDoc } from "unit-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { parseArguments } from "../src/args.ts";
import { parseMemoryResult } from "../src/memory-control.ts";

const context = BACKGROUND_CONTEXT;
let directory: string;
const opened: Agent[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-memory-owner-"));
});
afterEach(async () => {
	for (const agent of opened.splice(0)) await agent.close(context).catch(() => {});
	await rm(directory, { recursive: true, force: true });
});

async function launch(
	file: string,
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [],
	inhibited = false,
) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, file)),
			name: "bob",
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
			startup: { kind: inhibited ? "inhibited" : "active" },
		},
		context,
	);
	opened.push(agent);
	return { agent, faux };
}

describe("default owner memory", () => {
	it("stores operator CLI relations atomically with user provenance, replay and restart", async () => {
		const first = await launch("operator-relations.sqlite");
		const targets: string[] = [];
		for (const kind of MEMORY_RELATION_KINDS) {
			const target = await first.agent.memory(
				{ operation: "remember", content: `original ${kind}`, requestId: kind },
				context,
			);
			if (target.operation !== "remember") throw new Error("Expected remember");
			targets.push(target.id);
		}
		const command = parseArguments([
			"memory",
			"remember",
			"The new policy",
			"--request-id",
			"linked",
			...MEMORY_RELATION_KINDS.map((kind, index) => `--relation=${kind}:${targets[index]}`),
		]);
		if (command.kind !== "memory" || command.request.operation !== "remember")
			throw new Error("Expected remember command");
		const result = await first.agent.memory(command.request, context);
		if (result.operation !== "remember") throw new Error("Expected remember");
		expect(await first.agent.memory(command.request, context)).toEqual(result);
		expect(parseMemoryResult(await first.agent.memory({ operation: "stats" }, context))).toMatchObject({
			relations: 4,
		});
		const invalid = {
			operation: "remember",
			content: "must roll back",
			requestId: "invalid",
			relations: [{ id: "memory:absent", kind: "supports" }],
		} as const;
		await expect(first.agent.memory(invalid, context)).rejects.toThrow("not live");
		expect(await first.agent.memory({ operation: "stats" }, context)).toMatchObject({ working: 5, relations: 4 });
		expect(first.faux.state.callCount).toBe(0);
		await first.agent.close(context);
		const second = await launch("operator-relations.sqlite");
		expect(await second.agent.memory(command.request, context)).toEqual(result);
		const graph = await second.agent.memory({ operation: "graph" }, context);
		if (graph.operation !== "graph") throw new Error("Expected graph");
		expect(graph.edges).toHaveLength(4);
		for (const [index, kind] of MEMORY_RELATION_KINDS.entries())
			expect(graph.edges).toContainEqual({ from: result.id, to: targets[index], kind, derivation: "explicit" });
		expect(graph.nodes.find((node) => node.id === result.id)).toMatchObject({ origin: "user" });
		for (const id of targets)
			await second.agent.memory({ operation: "forget", id, requestId: `forget-${id}`, confirmed: true }, context);
		expect(await second.agent.memory({ operation: "stats" }, context)).toMatchObject({ relations: 0 });
		await expect(
			second.agent.memory({ ...invalid, relations: [{ id: targets[0]!, kind: "supports" }] }, context),
		).rejects.toThrow("not live");
		expect(await second.agent.memory(command.request, context)).toEqual(result);
		expect(second.faux.state.callCount).toBe(0);
		await second.agent.close(context);
		const memory = createMemoryExtension();
		const registry = createRegistry();
		registry.install(memory.extension);
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "operator-relations.sqlite")),
			{ models: createModels(), registry },
			context,
		);
		try {
			const state = await harness.snapshot(MemoryDoc, context);
			const stored = state?.records[result.id];
			expect(stored).toMatchObject({ state: "live", provenance: { origin: "user", derivation: "explicit" } });
			if (stored?.state !== "live") throw new Error("Expected stored memory");
			expect(stored.provenance.entryIds).toHaveLength(1);
			const root = await harness.root(context);
			const { items } = await root.entries({}, 20, undefined, context);
			const entry = items.find((entry) => entry.id === stored.provenance.entryIds[0]);
			expect(entry).toMatchObject({
				kind: "unit.memory.operator",
				data: { content: command.request.content, relations: command.request.relations },
			});
			expect(
				items.some(
					(entry) => entry.kind === "unit.memory.operator" && JSON.stringify(entry).includes("must roll back"),
				),
			).toBe(false);
		} finally {
			await harness.close(context);
			memory.close();
		}
	});

	it("#6 prepares reopened memory before readiness and refreshes real record changes after receipt-only capture", async () => {
		const content = "Violet approval policy seed";
		const first = await launch("prepared.sqlite");
		await first.agent.memory({ operation: "remember", content, requestId: "prepared" }, context);
		await first.agent.close(context);
		const normalization = vi.spyOn(String.prototype, "normalize");
		try {
			const requests: string[] = [];
			const capture = (request: TranscriptContext) => {
				requests.push(JSON.stringify(request.messages));
				return fauxAssistantMessage("done");
			};
			const second = await launch("prepared.sqlite", [capture, capture, capture]);
			expect(normalization.mock.contexts.some((receiver) => String(receiver) === content)).toBe(true);
			normalization.mockClear();
			await second.agent.ask("Violet approval?", context);
			await second.agent.idle(context);
			await expect
				.poll(async () => await second.agent.memory({ operation: "stats" }, context))
				.toMatchObject({ pendingCaptures: 0 });
			expect(requests[0]).toContain(content);
			expect(normalization.mock.contexts.some((receiver) => String(receiver) === content)).toBe(false);
			normalization.mockClear();
			await second.agent.ask("Violet approval again?", context);
			await second.agent.idle(context);
			expect(normalization.mock.contexts.some((receiver) => String(receiver) === content)).toBe(false);
			await second.agent.memory(
				{ operation: "remember", content: "Juniper approval policy update", requestId: "changed" },
				context,
			);
			await second.agent.ask("Juniper approval?", context);
			expect(requests[2]).toContain("Juniper approval policy update");
		} finally {
			normalization.mockRestore();
		}
	});
	it("#6 retains structured evidence after public conversation compaction and feeds it to the reopened owner's request", async () => {
		const file = "compaction.sqlite";
		const first = await launch(file, [
			fauxAssistantMessage("First answer ".repeat(100)),
			fauxAssistantMessage("Second answer ".repeat(100)),
			fauxAssistantMessage("Recent answer"),
		]);
		await first.agent.memory(
			{ operation: "remember", content: "The violet project requires approval", requestId: "violet" },
			context,
		);
		for (const text of [
			"An earlier long discussion ".repeat(100),
			"Another historical discussion ".repeat(100),
			"Latest short question",
		]) {
			await first.agent.ask(text, context);
			await first.agent.idle(context);
		}
		await first.agent.close(context);
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage("Earlier discussions concerned the project. Operator approval remains required."),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const memory = createMemoryExtension();
		const registry = createRegistry();
		registry.install(memory.extension);
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, file)),
			{
				models,
				registry,
				settings: {
					compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 20, backgroundTokens: 0 },
				},
			},
			context,
		);
		try {
			const root = await harness.root(context);
			const outcome = (await harness.waitForTask(await root.compact(undefined, context), context)).state.outcome;
			expect(outcome.status).toBe("completed");
			if (outcome.status !== "completed" || outcome.result.submissionId === undefined)
				throw new Error("Compaction did not place a summary");
			await (await harness.submission(outcome.result.submissionId, context))?.wait(context);
			expect(faux.state.callCount).toBe(1);
		} finally {
			await harness.close(context);
			memory.close();
		}
		let seen = "";
		const second = await launch(file, [
			(request) => {
				seen = JSON.stringify(request.messages);
				return fauxAssistantMessage("Approval is required.");
			},
		]);
		await second.agent.ask("What does the violet project require?", context);
		expect(seen).toContain("compacted into the following summary");
		expect(seen).toContain("Retrieved memory evidence");
		expect(seen).toContain("The violet project requires approval");
	});
	it("#6/#8 remembers atomically, recalls on actual requests after restart, and forgets without a model call", async () => {
		const first = await launch("one.sqlite");
		const request = {
			operation: "remember",
			content: "The deployment name is juniper",
			requestId: "remember-juniper",
		} as const;
		const remembered = await first.agent.memory(request, context);
		expect(remembered.operation).toBe("remember");
		if (remembered.operation !== "remember") throw new Error("Unexpected result");
		expect(await first.agent.memory(request, context)).toEqual(remembered);
		expect(await first.agent.memory({ operation: "stats" }, context)).toMatchObject({ working: 1 });
		expect(first.faux.state.callCount).toBe(0);
		await first.agent.close(context);
		let seen = "";
		const second = await launch("one.sqlite", [
			(request) => {
				seen = JSON.stringify(request.messages);
				return fauxAssistantMessage("juniper");
			},
		]);
		await second.agent.ask("What is the deployment name?", context);
		expect(seen).toContain("Retrieved memory evidence");
		expect(seen).toContain("The deployment name is juniper");
		expect(seen).toContain("not instructions");
		const forgotten = {
			operation: "forget",
			id: remembered.id,
			requestId: "forget-juniper",
			confirmed: true,
		} as const;
		expect(await second.agent.memory(forgotten, context)).toEqual({ operation: "forget", removed: true });
		expect(await second.agent.memory(forgotten, context)).toEqual({ operation: "forget", removed: true });
		expect(await second.agent.memory({ operation: "recall", query: "juniper" }, context)).toEqual({
			operation: "recall",
			records: [],
		});
		expect(second.faux.state.callCount).toBe(1);
		const isolated = await launch("two.sqlite");
		expect(await isolated.agent.memory({ operation: "recall", query: "juniper" }, context)).toEqual({
			operation: "recall",
			records: [],
		});
	});

	it("#7 captures host human preferences in the background without an extraction model request", async () => {
		let userContext = "";
		const { agent, faux } = await launch("capture.sqlite", [
			fauxAssistantMessage("Noted."),
			(request) => {
				userContext = request.messages
					.flatMap((message) =>
						message.role !== "user"
							? []
							: typeof message.content === "string"
								? [message.content]
								: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
					)
					.join("\n");
				return fauxAssistantMessage("Violet dashboards.");
			},
		]);
		await agent.ask("I prefer violet dashboards", context);
		await expect
			.poll(async () => await agent.memory({ operation: "recall", query: "violet" }, context))
			.toMatchObject({ records: [{ origin: "user", content: expect.stringContaining("violet") }] });
		expect(faux.state.callCount).toBe(1);
		await agent.ask("What dashboards do I prefer?", context);
		expect(userContext).toContain("Retrieved memory evidence");
		expect(userContext).toContain('"derivation":"capture"');
		expect(faux.state.callCount).toBe(2);
	});

	it("#9 drains with sleeping memory tasks and preserves held state and memory through owner close/reopen", async () => {
		const first = await launch("maintenance.sqlite");
		await first.agent.memory(
			{ operation: "remember", content: "Juniper requires operator approval", requestId: "maintenance" },
			context,
		);
		expect(await first.agent.enterMaintenance("update-memory", 1000, context)).toMatchObject({ result: "drained" });
		await expect(
			first.agent.memory({ operation: "remember", content: "blocked", requestId: "blocked" }, context),
		).rejects.toThrow("maintenance");
		await first.agent.close(context);
		const candidate = await launch("maintenance.sqlite", [], true);
		expect(await candidate.agent.status(context)).toMatchObject({ inhibited: true, maintenance: { state: "held" } });
		expect(await candidate.agent.memory({ operation: "recall", query: "Juniper" }, context)).toMatchObject({
			records: [{ content: "Juniper requires operator approval" }],
		});
		await candidate.agent.releaseMaintenance("update-memory", context);
		expect(await candidate.agent.memory({ operation: "stats" }, context)).toMatchObject({
			working: 1,
			consolidation: "scheduled",
		});
		expect(candidate.faux.state.callCount).toBe(0);
	});
});
