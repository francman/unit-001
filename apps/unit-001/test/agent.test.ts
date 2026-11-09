import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

let directory: string;
let file: string;
const open: Agent[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-agent-"));
	file = join(directory, "session.sqlite");
});
afterEach(async () => {
	await Promise.all(open.splice(0).map((agent) => agent.close(context).catch(() => {})));
	await rm(directory, { recursive: true, force: true });
});

async function launch(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], name?: string) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(file),
			models,
			model,
			cwd: directory,
			...(name === undefined ? {} : { name }),
		},
		context,
	);
	open.push(agent);
	return { agent, faux };
}

const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

describe("Agent", () => {
	it("orients the named host separately from its model and describes durable capabilities truthfully", async () => {
		let requestText = "";
		const { agent } = await launch(
			[
				(request) => {
					requestText = JSON.stringify(request.messages);
					return reply("I am bob, running in unit-001.");
				},
			],
			"bob",
		);
		await agent.ask("Who are you and do you remember prior conversations?", context);
		expect(requestText).toContain("unit-001, the durable agent named bob");
		expect(requestText).toContain("configured model is faux/faux-1");
		expect(requestText).toContain("persist in this session across restarts");
		expect(requestText).toContain("Autonomous mission scheduling is not implemented");
		expect(requestText).toContain("unit_status");
	});

	it("reads authoritative owner process runtime through a local tool", async () => {
		let toolResult = "";
		const before = Date.now();
		const first = await launch(
			[
				fauxAssistantMessage(fauxToolCall("unit_status", {}), { stopReason: "toolUse" }),
				(request) => {
					toolResult = JSON.stringify(request.messages);
					return reply("Owner status read.");
				},
			],
			"bob",
		);
		await first.agent.ask("How long have you been running?", context);
		const status = await first.agent.status(context);
		expect(status.runtime).toMatchObject({
			application: "unit-001",
			name: "bob",
			provider: "faux",
			modelId: "faux-1",
			pid: process.pid,
		});
		expect(status.runtime.startedAt).toBeLessThanOrEqual(before);
		expect(status.runtime.startedAt).toBe(Math.floor(performance.timeOrigin));
		expect(status.runtime.uptimeMs).toBeGreaterThanOrEqual(0);
		expect(toolResult).toContain('\\"application\\":\\"unit-001\\"');
		expect(toolResult).toContain('\\"startedAt\\":');
		expect(toolResult).toContain('\\"observedAt\\":');
		expect(status.runtime.observedAt).toBeGreaterThanOrEqual(before);
		await first.agent.close(context);
		const second = await launch([], "bob");
		expect((await second.agent.status(context)).runtime.startedAt).toBe(status.runtime.startedAt);
	});

	it("answers a prompt", async () => {
		const { agent } = await launch([reply("Paris.")]);
		expect(await agent.ask("Capital of France?", context)).toEqual({ status: "answered", text: "Paris." });
		expect(agent.interrupted).toBe(false);
	});

	it("keeps the conversation across a restart", async () => {
		const first = await launch([reply("Paris.")]);
		await first.agent.ask("Capital of France?", context);
		await first.agent.idle(context);
		await first.agent.close(context);

		// The model of the restarted agent receives the first exchange as context, not just the new question.
		let seen = "";
		const second = await launch([
			(request) => {
				seen = JSON.stringify(request.messages);
				return reply("Berlin.");
			},
		]);
		expect(second.agent.interrupted).toBe(false);
		expect(await second.agent.idle(context)).toBe("Paris.");
		expect(await second.agent.ask("And of Germany?", context)).toEqual({ status: "answered", text: "Berlin." });
		expect(seen).toContain("Capital of France?");
		expect(seen).toContain("Paris.");
		expect(seen).toContain("And of Germany?");
	});

	it("resumes a run that was unfinished when the agent stopped", async () => {
		// The first process is inside a model request that never completes, so the run is unfinished when it closes.
		let started!: () => void;
		const requested = new Promise<void>((resolve) => {
			started = resolve;
		});
		const first = await launch([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					started();
					options?.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true });
				}),
		]);
		await first.agent.submit("Capital of France?", context, { requestId: "q1" });
		await requested;
		await first.agent.close(context);

		const second = await launch([reply("Paris.")]);
		expect(second.agent.interrupted).toBe(true);
		expect(await second.agent.idle(context)).toBe("Paris.");
	});

	it("does not submit twice for one request id", async () => {
		const { agent } = await launch([reply("Paris.")]);
		const one = await agent.submit("Capital of France?", context, { requestId: "same" });
		const two = await agent.submit("Capital of France?", context, { requestId: "same" });
		expect(two.id).toBe(one.id);
		await one.wait(context);
	});

	it("switches to the model of the current launch", async () => {
		const first = await launch([reply("Paris.")]);
		await first.agent.ask("Capital of France?", context);
		await first.agent.close(context);

		const faux = fauxProvider({ models: [{ id: "faux-2" }] });
		faux.setResponses([reply("Berlin.")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(file),
				models,
				model: { provider: "faux", modelId: "faux-2" },
				cwd: directory,
			},
			context,
		);
		open.push(agent);
		expect(await agent.ask("And of Germany?", context)).toEqual({ status: "answered", text: "Berlin." });
	});

	it("streams committed live state to a watcher", async () => {
		const { agent } = await launch([reply("Paris.")]);
		const states: unknown[] = [];
		const stop = await agent.watch((live) => states.push(live), context);
		await agent.ask("Capital of France?", context);
		await stop();
		expect(states.length).toBeGreaterThan(0);
	});
});
