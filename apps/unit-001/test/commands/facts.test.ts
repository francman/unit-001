// Verifies authoritative host answers without model calls, invented usage or lost retry identity.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import { isOperatingSystemQuestion } from "../../src/commands/facts.ts";
import { serviceView } from "../../src/service-view.ts";

const context = BACKGROUND_CONTEXT;
let directory: string;
const opened: Agent[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-host-facts-"));
});
afterEach(async () => {
	await Promise.all(opened.splice(0).map((agent) => agent.close(context).catch(() => {})));
	await rm(directory, { recursive: true, force: true });
});

async function launch(configured = false) {
	const models = createModels();
	const faux = fauxProvider();
	let calls = 0;
	faux.setResponses([
		() => {
			calls++;
			return fauxAssistantMessage(fauxText("Model answer."));
		},
	]);
	if (configured) models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "state.sqlite")),
			models,
			model: configured ? { provider: "faux", modelId: "faux-1" } : null,
			cwd: directory,
		},
		context,
	);
	opened.push(agent);
	return { agent, models, faux, calls: () => calls };
}

describe("deterministic host facts", () => {
	it("recognizes known questions without swallowing ordinary discussion (#57, #59)", () => {
		expect(isOperatingSystemQuestion("What operating system are you running?")).toBe(true);
		expect(isOperatingSystemQuestion("inspect os")).toBe(true);
		expect(isOperatingSystemQuestion("Explain how operating systems work")).toBe(false);
	});

	it("answers without a provider and persists explicit host provenance across retry/restart (#57)", async () => {
		const first = await launch();
		const answer = await first.agent.ask("What OS are you running?", context, { requestId: "os-query" });
		expect(answer).toMatchObject({
			status: "answered",
			text: expect.stringContaining(`Platform: ${process.platform}`),
		});
		const watch = await first.agent.watchConversation(context);
		const view = serviceView(watch.value, { pid: process.pid, version: "test", name: "agent", installationId: null });
		expect(view.entries).toHaveLength(2);
		expect(view.entries.every((entry) => entry.source === "host")).toBe(true);
		expect(view.usage).toBeNull();
		expect(view.model).toBeNull();
		await watch.stop();
		await first.agent.close(context);
		const second = await launch();
		expect(await second.agent.ask("What OS are you running?", context, { requestId: "os-query" })).toEqual(answer);
		expect(second.calls()).toBe(0);
	});

	it("does not call a configured model for an OS question (#59)", async () => {
		const { agent, calls } = await launch(true);
		await agent.ask("What is your operating system?", context);
		expect(calls()).toBe(0);
	});

	it("keeps existing ordinary request receipts authoritative on retry (#59)", async () => {
		const { agent, calls } = await launch(true);
		// Simulate a question already admitted by a release without deterministic routing.
		await (await agent.submit("What OS are you running?", context, { requestId: "existing" })).wait(context);
		expect(await agent.ask("What OS are you running?", context, { requestId: "existing" })).toEqual({
			status: "answered",
			text: "Model answer.",
		});
		expect(calls()).toBe(1);
	});

	it("rejects changed input for an existing host receipt", async () => {
		const { agent } = await launch();
		await agent.ask("What OS are you running?", context, { requestId: "bound" });
		await expect(agent.ask("A different question", context, { requestId: "bound" })).rejects.toThrow("conflicts");
	});

	it("preserves maintenance admission protection", async () => {
		const { agent } = await launch();
		await agent.enterMaintenance("update", 0, context);
		await expect(agent.ask("What OS are you running?", context)).rejects.toThrow("maintenance");
	});

	it("drains auxiliary interpretation before reporting maintenance ready (#59)", async () => {
		const { agent, models, calls } = await launch(true);
		let entered = () => {};
		const checking = new Promise<void>((resolve) => {
			entered = resolve;
		});
		models.checkAuth = async (_provider, options) => {
			entered();
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			return undefined;
		};
		const pending = agent.resolveCommand("xyzzy", "cli", context, new AbortController().signal);
		await checking;
		expect(await agent.enterMaintenance("update", 1000, context)).toMatchObject({ result: "drained" });
		expect((await pending).stage).toBe("unavailable");
		expect(calls()).toBe(0);
	});

	it("installs the shared OS inspection tool for normal model work (#57)", async () => {
		const { agent, faux } = await launch(true);
		let observed = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("unit_inspect_os", {}), { stopReason: "toolUse" }),
			(request) => {
				observed = JSON.stringify(request.messages);
				return fauxAssistantMessage(fauxText("Inspected."));
			},
		]);
		await agent.ask("Inspect the environment using your tools", context);
		expect(observed).toContain('\\"scope\\":\\"current-process-namespace\\"');
		expect(observed).toContain('\\"platform\\":');
	});
});
