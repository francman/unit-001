import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { sendDigest } from "../src/send-receipt.ts";
import { SideDoc } from "../src/side.ts";

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
		expect(requestText).toContain("You are bob, the agent of this unit-001 installation");
		expect(requestText).toContain("configured model is faux/faux-1");
		expect(requestText).toContain("persist in this session across restarts");
		expect(requestText).toContain("An agreement alone does not start a mission");
		expect(requestText).toContain("unit_status");
	});

	it("states the installation name, version, durable memory and agreed purpose in the identity section", async () => {
		let requestText = "";
		const faux = fauxProvider();
		faux.setResponses([
			(request) => {
				requestText = JSON.stringify(request.messages);
				return reply("I am ada.");
			},
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = await Agent.open(
			{ storage: await openNodeSqliteStorage(file), models, model, cwd: directory, name: "ada", version: "9.8.7" },
			context,
		);
		open.push(agent);
		await agent.ask("who are you?", context);
		expect(requestText).toContain("You are ada, the agent of this unit-001 installation (unit-001 9.8.7)");
		expect(requestText).toContain("transport requirement, not your identity. Introduce yourself as ada.");
		expect(requestText).not.toContain("terminal is where the owner approves");
		expect(requestText).toContain("carries across conversations and restarts");
		expect(requestText).not.toContain("session-scoped");
		expect(requestText).toContain("Having no agreed purpose yet is a normal state");
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

	it("wires side creation, held listing and receipt replay across reopen, validating before scheduling", async () => {
		const first = await launch([reply("Paris.")]);
		const settled = await (await first.agent.submit("Capital of France?", context)).wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error("Expected a completed input.");
		await first.agent.idle(context);
		const request = { operation: "start" as const, from: settled.answer, title: "  Research  ", requestId: "side-1" };
		expect(await first.agent.side({ operation: "list" }, context)).toMatchObject({ sides: [] });
		const created = await first.agent.side(request, context);
		if (created.operation !== "start") throw new Error("Expected a side start.");
		const listed = await first.agent.side({ operation: "list" }, context);
		expect(listed).toMatchObject({
			operation: "list",
			main: { state: "idle" },
			sides: [{ conversationId: created.conversationId, title: "Research", parent: { at: settled.answer }, state: "idle" }],
		});
		expect(first.faux.state.callCount).toBe(1);
		await first.agent.enterMaintenance("side-reopen", 1000, context);
		await expect(first.agent.side(request, context)).rejects.toThrow("maintenance");
		await first.agent.close(context);
		open.splice(open.indexOf(first.agent), 1);

		const second = await launch([]);
		expect(await second.agent.side({ operation: "list" }, context)).toEqual(listed);
		await expect(second.agent.side(request, context)).rejects.toThrow("inhibited");
		await second.agent.releaseMaintenance("side-reopen", context);
		expect(await second.agent.side({ ...request, title: "Research" }, context)).toEqual(created);
		expect(await second.agent.side({ operation: "list" }, context)).toEqual(listed);
		expect(second.faux.state.callCount).toBe(0);
		await second.agent.close(context);
		open.splice(open.indexOf(second.agent), 1);

		const models = createModels();
		models.setProvider(second.faux.provider);
		const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: createRegistry() }, context);
		try {
			const root = await harness.root(context);
			await root.commit(async (tx) => {
				// An incomplete restore must fail Agent.open before its pending input can reach the provider.
				(await tx.doc(SideDoc)).sides[0]!.conversationId = root.id;
				await root.submit(tx, { type: "input", content: "Pending main input" });
			}, context);
		} finally {
			await harness.close(context);
		}
		await expect(Agent.open({ storage: await openNodeSqliteStorage(file), models, model, cwd: directory }, context))
			.rejects.toThrow("Side registry is inconsistent");
		expect(second.faux.state.callCount).toBe(0);
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

	it("preserves providerless work through idle and maintenance release, and cancels only the chat", async () => {
		const requested = Promise.withResolvers<void>();
		const first = await launch([
			(_request, options) => {
				const pending = Promise.withResolvers<never>();
				options?.signal?.addEventListener("abort", () => pending.reject(new Error("closed")), { once: true });
				requested.resolve();
				return pending.promise;
			},
		]);
		await first.agent.submit("Interrupted input", context, { requestId: "interrupted" });
		await requested.promise;
		await first.agent.submit("Queued input", context, { requestId: "queued" });
		await first.agent.close(context);
		open.splice(open.indexOf(first.agent), 1);

		const pending = defineTask<null, { phase: "finish" }, null>({
			name: "test.agent.pending",
			version: 1,
			initial: () => ({ phase: "finish" }),
			phases: {
				finish: async (_task, runtime, ctx) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
			},
			abort: async (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const extension = defineExtension({ name: "test.agent.scheduling", tasks: [pending] });
		const models = createModels();
		const faux = fauxProvider();
		faux.setResponses([reply("Should not run")]);
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(extension);
		const seed = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
		const ids = await seed
			.root(context)
			.then(async (root) => {
				const run = (await seed.snapshot(LiveDoc, root.id, context))?.run;
				if (!run) throw new Error("Expected the interrupted run.");
				return root.commit(async (tx) => {
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: run.taskId } });
					const other = await tx.createConversation({ ownership: { kind: "ownerless" } });
					const nested = await tx.createTask(pending, null, {
						conversationId: child.id,
						ownership: { kind: "conversation" },
					});
					const unrelated = await tx.createTask(pending, null, {
						conversationId: other.id,
						ownership: { kind: "conversation" },
					});
					const background = await tx.createTask(pending, null, {
						ownership: { kind: "conversation" },
						background: true,
					});
					return { run: run.taskId, nested, unrelated, background };
				}, context);
			})
			.finally(() => seed.close(context));

		const agent = await Agent.open(
			{ storage: await openNodeSqliteStorage(file), models, model: null, cwd: directory, extensions: [extension] },
			context,
		);
		open.push(agent);
		expect(await agent.status(context)).toMatchObject({
			busy: true,
			inhibited: false,
			runtime: { configuration: "unconfigured" },
		});
		await expect(agent.idle(context)).rejects.toThrow("Pending work is preserved");
		expect(await agent.admission("queued", undefined, context)).toMatchObject({ outcome: "queued" });
		expect(await agent.enterMaintenance("providerless", 0, context)).toMatchObject({ result: "deferred" });
		await agent.releaseMaintenance("providerless", context);
		await agent.abort(context);
		expect(await agent.admission("queued", undefined, context)).toMatchObject({
			outcome: "unanswered",
			reason: "aborted",
		});
		expect(await agent.admission("interrupted", undefined, context)).toMatchObject({ outcome: "placed" });
		expect((await agent.inspect({ scope: "tasks" }, context)).data).toMatchObject({ scheduling: "paused" });
		expect(faux.state.callCount).toBe(0);
		await agent.close(context);
		open.splice(open.indexOf(agent), 1);

		const reopened = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
		try {
			for (const id of [ids.run, ids.nested])
				expect(await reopened.getTask(id, context)).toMatchObject({ abortRequested: true });
			for (const id of [ids.unrelated, ids.background]) {
				expect(await reopened.getTask(id, context)).toMatchObject({
					abortRequested: false,
					state: { status: "pending" },
				});
			}
		} finally {
			await reopened.close(context);
		}
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

	it("clears the stored model when reopened without one and keeps the history", async () => {
		const first = await launch([reply("Paris.")]);
		await first.agent.ask("Capital of France?", context);
		await first.agent.close(context);
		open.splice(open.indexOf(first.agent), 1);

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = await Agent.open(
			{ storage: await openNodeSqliteStorage(file), models, model: null, cwd: directory },
			context,
		);
		open.push(agent);
		expect(await agent.status(context)).toMatchObject({ runtime: { configuration: "unconfigured" } });
		expect((await agent.chatHistory(null, context)).entries.map((entry) => entry.text)).toContain("Paris.");
		await agent.close(context);
		open.splice(open.indexOf(agent), 1);

		const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: createRegistry() }, context);
		try {
			expect((await (await harness.root(context)).agent(context)).model).toBeUndefined();
		} finally {
			await harness.close(context);
		}
		expect(faux.state.callCount).toBe(0);
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

// #26: a client that lost its connection after submit settles the send from durable state instead of sending again.
describe("send admission", () => {
	// Equal in the first 2,000 code points, so only a full-prompt binding can tell them apart.
	const prompt = `${"x".repeat(2100)} first`;
	const other = `${"x".repeat(2100)} second`;

	it("binds a request ID to the full prompt and refuses a replay with different text", async () => {
		const { agent, faux } = await launch([reply("Paris.")]);
		expect(await agent.ask(prompt, context, { requestId: "r1" })).toEqual({ status: "answered", text: "Paris." });
		await expect(agent.ask(other, context, { requestId: "r1" })).rejects.toThrow("different prompt");
		expect(await agent.ask(prompt, context, { requestId: "r1" })).toEqual({ status: "answered", text: "Paris." });
		expect(faux.state.callCount).toBe(1);
	});

	// #26 review, blocker 3: before the fix, the prefix-only memory check let this replay return the original answer.
	it("refuses a replay whose receipt 256 later sends evicted, across a reopen, without calling the model", async () => {
		const first = await launch([reply("Paris."), ...Array.from({ length: 256 }, () => reply("ok"))]);
		expect(await first.agent.ask(prompt, context, { requestId: "r1" })).toEqual({ status: "answered", text: "Paris." });
		for (let index = 0; index < 256; index++)
			await first.agent.submit(`later ${index}`, context, { requestId: `later-${index}` });
		await first.agent.idle(context);
		await first.agent.close(context);
		open.splice(open.indexOf(first.agent), 1);

		const { agent, faux } = await launch([reply("Wrong.")]);
		await expect(agent.ask(other, context, { requestId: "r1" })).rejects.toThrow("can no longer be compared");
		await expect(agent.ask(prompt, context, { requestId: "r1" })).rejects.toThrow("can no longer be compared");
		expect(await agent.admission("r1", sendDigest(other), context)).toMatchObject({
			status: "admitted",
			binding: "unverified",
		});
		expect(faux.state.callCount).toBe(0);
	});

	it("answers admitted, rejected and not found from committed state, across a restart", async () => {
		const first = await launch([reply("Paris.")]);
		await first.agent.ask(prompt, context, { requestId: "r1" });
		await first.agent.close(context);
		open.splice(open.indexOf(first.agent), 1);

		const { agent, faux } = await launch([]);
		expect(await agent.admission("r1", sendDigest(prompt), context)).toEqual({
			status: "admitted",
			source: "model",
			binding: "exact",
			outcome: "answered",
		});
		expect(await agent.admission("r1", undefined, context)).toMatchObject({ status: "admitted", binding: "recorded" });
		expect(await agent.admission("r1", sendDigest(other), context)).toEqual({
			status: "rejected",
			reason: "different-prompt",
		});
		expect(await agent.admission("never-sent", sendDigest(prompt), context)).toEqual({ status: "not-found" });
		expect(faux.state.callCount).toBe(0);
	});

	it("binds a host-fact send by the input its entry recorded", async () => {
		const { agent, faux } = await launch([]);
		const question = "What operating system are you running?";
		expect(await agent.ask(question, context, { requestId: "os-1" })).toMatchObject({ status: "answered" });
		expect(await agent.admission("os-1", sendDigest(question), context)).toEqual({
			status: "admitted",
			source: "host",
			binding: "exact",
			outcome: "answered",
		});
		expect(await agent.admission("os-1", sendDigest("something else"), context)).toMatchObject({ status: "rejected" });
		expect(faux.state.callCount).toBe(0);
	});

	it("reports a pre-receipt send as unverified while inhibited, without resuming it", async () => {
		const faux = fauxProvider();
		faux.setResponses([reply("Paris.")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: createRegistry() }, context);
		try {
			const root = await harness.root(context);
			await root.commit((tx) => root.submit(tx, { type: "input", content: prompt, requestId: "legacy" }), context);
		} finally {
			await harness.close(context);
		}
		const agent = await Agent.open(
			{ storage: await openNodeSqliteStorage(file), models, model, cwd: directory, startup: { kind: "inhibited" } },
			context,
		);
		open.push(agent);
		expect(await agent.admission("legacy", sendDigest(prompt), context)).toEqual({
			status: "admitted",
			source: "model",
			binding: "unverified",
			outcome: "placed",
		});
		await setTimeout(50);
		expect(await agent.admission("legacy", undefined, context)).toMatchObject({ outcome: "placed" });
		expect(faux.state.callCount).toBe(0);
	});
});
