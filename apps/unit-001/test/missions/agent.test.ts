// #14: The normal owner can form a mission without a provider and preserves existing unfinished conversation work.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import { MANAGED_MISSION_ACTIONS } from "../../src/missions/contract.ts";

let directory: string;
const opened: Agent[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-agent-"));
});
afterEach(async () => {
	for (const agent of opened.splice(0)) await agent.close(context);
	await rm(directory, { recursive: true, force: true });
});

async function launch(models = createModels(), model: { provider: string; modelId: string } | null = null) {
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
			models,
			model,
			cwd: directory,
			mission: { kind: "developer-local", directory, session: "default" },
		},
		context,
	);
	opened.push(agent);
	return agent;
}

it("keeps mission drafting, status and memory available without registering a fake model", async () => {
	const models = createModels();
	const agent = await launch(models);
	expect(models.getProviders()).toEqual([]);
	expect((await agent.status(context)).runtime).toMatchObject({
		configuration: "unconfigured",
		provider: null,
		modelId: null,
	});
	const saved = await agent.mission(
		{ operation: "draft", expectedRevision: 0, requestId: "first-goal", terms: { objective: "Monitor a fixture" } },
		context,
	);
	if (process.platform !== "win32") expect([...saved.tools].sort()).toEqual([...MANAGED_MISSION_ACTIONS].sort());
	expect(saved.stage).toBe("awaiting_creator");
	expect(saved.execution).toBe("not-implemented");
	await expect(agent.ask("Do not admit a request", context)).rejects.toThrow("No provider is configured");
	expect((await agent.status(context)).busy).toBe(false);
	await agent.memory({ operation: "remember", requestId: "local", content: "Local memory remains usable" }, context);
	expect(await agent.memory({ operation: "recall", query: "Local memory" }, context)).toMatchObject({
		operation: "recall",
		records: [{ content: "Local memory remains usable" }],
	});
	await agent.close(context);
	opened.splice(opened.indexOf(agent), 1);
	const reopened = await launch();
	expect((await reopened.mission({ operation: "status" }, context)).formation).toEqual(saved.formation);
});

it("preserves normal configured faux conversation and does not require mission agreement for ordinary work", async () => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("Ordinary work remains available")])]);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await launch(models, { provider: "faux", modelId: "faux-1" });
	expect(await agent.ask("An ordinary operator request", context)).toEqual({
		status: "answered",
		text: "Ordinary work remains available",
	});
	expect(faux.state.callCount).toBe(1);
	expect((await agent.mission({ operation: "status" }, context)).formation.agreement).toBeNull();
});
