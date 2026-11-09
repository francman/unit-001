// Exercises default-owner memory admission, recovery, isolation and maintenance with real SQLite.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemoryExtension } from "unit-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

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
		const { agent, faux } = await launch("capture.sqlite", [fauxAssistantMessage("Noted.")]);
		await agent.ask("I prefer violet dashboards", context);
		await expect
			.poll(async () => await agent.memory({ operation: "recall", query: "violet" }, context))
			.toMatchObject({ records: [{ origin: "user", content: expect.stringContaining("violet") }] });
		expect(faux.state.callCount).toBe(1);
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
