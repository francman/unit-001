// #14: The normal owner can form a mission without a provider and preserves existing unfinished conversation work.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
	if (process.platform !== "win32")
		expect([...saved.tools].sort()).toEqual(
			// #72: unit_work_write is registered for purpose runs only; it is deferred and outside the one-shot catalog.
			[
				...MANAGED_MISSION_ACTIONS,
				"unit_channels",
				"unit_channel_request_setup",
				"unit_channel_setup",
				"unit_mission_draft",
				"unit_work_write",
			].sort(),
		);
	expect(saved.stage).toBe("awaiting_creator");
	expect(saved.execution).toBe("not-started");
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

// #72: a loop sleeping for its next observation is drained for update and backup, also on a model-null owner.
it("drains a parked purpose loop for maintenance without waking it", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("unit_work_write", { content: "alpha" }), { stopReason: "toolUse" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await launch(models, { provider: "faux", modelId: "faux-1" });
	await agent.mission(
		{
			operation: "configure-local",
			creator: { kind: "human", id: "creator", uid: process.getuid?.() ?? null },
			ceiling: {
				allowedTools: [],
				maxCycles: 1,
				maxRequests: 1,
				maxRetries: 0,
				maxConsecutiveNoProgress: 1,
				maxDurationMs: 3_600_000,
			},
			purposeCeiling: {
				capabilities: ["artifact-digest"],
				paths: ["reports/"],
				maxWorkItems: 2,
				maxCycles: 2,
				maxRequests: 2,
				maxRetries: 0,
				maxConsecutiveNoProgress: 1,
				maxDurationMs: 3_600_000,
			},
		},
		context,
	);
	const work = (path: string, text: string) => ({
		kind: "artifact-digest" as const,
		path,
		sha256: createHash("sha256").update(text).digest("hex"),
		instructions: "Write it.",
		maxCycles: 1,
		maxRequests: 1,
		maxRetries: 0,
		maxConsecutiveNoProgress: 1,
	});
	const proposed = await agent.mission(
		{
			operation: "purpose-propose",
			expectedRevision: 0,
			requestId: "propose",
			terms: {
				purpose: "Keep fixture reports",
				scope: "Fixture workspace",
				reviewEveryMs: 600_000,
				works: [work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")],
				lifetime: { maxWorkItems: 2, maxCycles: 2, maxRequests: 2, deadlineAt: Date.now() + 3_000_000 },
			},
		},
		context,
	);
	await agent.mission(
		{
			operation: "purpose-approve-local",
			revision: proposed.purpose!.proposed!.revision,
			digest: proposed.purpose!.proposed!.digest,
			requestId: "approve",
		},
		context,
	);
	await agent.mission(
		{ operation: "operate-local", action: "open", expectedOperationRevision: 0, requestId: "open" },
		context,
	);
	for (let i = 0; i < 400 && (await agent.mission({ operation: "status" }, context)).purpose?.activity !== "waiting"; i++)
		await setTimeout(5);
	expect((await agent.mission({ operation: "status" }, context)).purpose).toMatchObject({
		activity: "waiting",
		rollback: "live-loop",
		works: [{ result: "verified" }, { result: "pending" }],
	});
	expect(await agent.enterMaintenance("loop-parked", 1000, context)).toMatchObject({ result: "drained" });
	await agent.releaseMaintenance("loop-parked", context);
	await agent.close(context);
	opened.splice(opened.indexOf(agent), 1);
	// Without a provider the owner never schedules the loop; drain for backup still treats it as parked.
	const unconfigured = await launch();
	expect(await unconfigured.enterMaintenance("model-null", 1000, context)).toMatchObject({ result: "drained" });
	await unconfigured.releaseMaintenance("model-null", context);
	expect((await unconfigured.mission({ operation: "status" }, context)).purpose?.activity).toBe("waiting");
	expect(faux.state.callCount).toBe(1);
});
