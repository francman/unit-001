// #17: Operator lifecycle intent reaches the real owner, survives reopen and never grants itself managed authority.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import type { MissionView } from "../../src/missions/contract.ts";
import { parseMissionView } from "../../src/missions/wire.ts";

let directory: string;
const opened: Agent[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-owner-"));
});
afterEach(async () => {
	for (const agent of opened.splice(0)) await agent.close(context);
	await rm(directory, { recursive: true, force: true });
});
const criterion = `sha256:${createHash("sha256").update("proof").digest("hex")}:proof.txt`;
const write = fauxAssistantMessage(fauxToolCall("write", { path: "proof.txt", content: "proof" }), {
	stopReason: "toolUse",
});

async function launch(
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [],
	configuration: "configured" | "unconfigured" = "configured",
) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	if (configuration === "configured") models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
			models,
			model: configuration === "configured" ? { provider: "faux", modelId: "faux-1" } : null,
			cwd: directory,
			mission: { kind: "developer-local", directory, session: "default" },
		},
		context,
	);
	opened.push(agent);
	return { agent, faux };
}

async function agree(agent: Agent) {
	await agent.mission(
		{
			operation: "configure-local",
			creator: { kind: "human", id: "creator", uid: process.getuid?.() ?? null },
			ceiling: {
				allowedTools: ["write"],
				maxCycles: 5,
				maxRequests: 8,
				maxRetries: 2,
				maxConsecutiveNoProgress: 4,
				maxDurationMs: 60_000,
			},
		},
		context,
	);
	await agent.mission(
		{
			operation: "draft",
			expectedRevision: 0,
			requestId: "draft",
			terms: {
				objective: "Write the agreed fixture file",
				scope: "Isolated test workspace",
				successCriteria: [criterion],
				approvalBoundary: [],
				reviewEveryMs: 5_000,
				policy: {
					allowedTools: ["write"],
					maxCycles: 5,
					maxRequests: 8,
					maxRetries: 2,
					maxConsecutiveNoProgress: 4,
					deadlineAt: Date.now() + 60_000,
				},
			},
		},
		context,
	);
	const proposed = await agent.mission({ operation: "propose", expectedRevision: 1, requestId: "proposal" }, context);
	await agent.mission(
		{
			operation: "approve-local",
			expectedRevision: 1,
			requestId: "approval",
			digest: proposed.formation.draft!.digest!,
		},
		context,
	);
}

async function waitFor(agent: Agent, status: NonNullable<MissionView["runtime"]>["status"]): Promise<MissionView> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const view = await agent.mission({ operation: "status" }, context);
		if (view.execution === status) return view;
		await setTimeout(5);
	}
	throw new Error(`Mission did not reach ${status}.`);
}

async function close(agent: Agent) {
	await agent.close(context);
	opened.splice(opened.indexOf(agent), 1);
}

describe("mission owner lifecycle", () => {
	it("starts an exact agreement, reports verified execution and replays the same start without resetting counters", async () => {
		const { agent, faux } = await launch([write]);
		await agree(agent);
		expect((await agent.mission({ operation: "status" }, context)).execution).toBe("not-started");
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		const view = await waitFor(agent, "completed");
		expect(parseMissionView(view)).toEqual(view);
		expect(view.runtime).toMatchObject({ cycles: 1, requests: 1, policyRevision: 1, evidence: [{ accepted: true }] });
		const again = await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		expect(again.runtime?.requests).toBe(1);
		expect(faux.state.callCount).toBe(1);
	});

	it("pauses an in-flight request, drains it, then resumes with the same finite budget", async () => {
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const { agent, faux } = await launch([
			(_input, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("Paused fixture")), { once: true });
				}),
			write,
		]);
		await agree(agent);
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await started;
		const paused = await agent.mission(
			{ operation: "control-local", action: "pause", expectedPolicyRevision: 1, requestId: "pause" },
			context,
		);
		expect(paused.execution).toBe("paused");
		expect(paused.runtime?.policyRevision).toBe(2);
		await expect(readFile(join(directory, "proof.txt"))).rejects.toThrow("ENOENT");
		await agent.mission(
			{ operation: "control-local", action: "resume", expectedPolicyRevision: 2, requestId: "resume" },
			context,
		);
		const completed = await waitFor(agent, "completed");
		expect(completed.runtime).toMatchObject({ requests: 2, cycles: 2, policyRevision: 3 });
		expect(faux.state.callCount).toBe(2);
	});

	it("stops a persisted retry and preserves terminal intent through owner restart", async () => {
		const first = await launch([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "Fixture rejected request" }),
		]);
		await agree(first.agent);
		await first.agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await waitFor(first.agent, "waiting");
		const stopped = await first.agent.mission(
			{ operation: "control-local", action: "stop", expectedPolicyRevision: 1, requestId: "stop" },
			context,
		);
		expect(stopped.execution).toBe("stopped");
		await close(first.agent);
		const second = await launch([write]);
		expect((await second.agent.mission({ operation: "status" }, context)).runtime).toMatchObject({
			status: "stopped",
			requests: stopped.runtime?.requests,
		});
		await expect(
			second.agent.mission(
				{ operation: "control-local", action: "pause", expectedPolicyRevision: 2, requestId: "revive" },
				context,
			),
		).rejects.toThrow("terminal mission");
		await expect(
			second.agent.mission(
				{ operation: "control-local", action: "resume", expectedPolicyRevision: 2, requestId: "revive-resume" },
				context,
			),
		).rejects.toThrow("paused mission");
		expect(second.faux.state.callCount).toBe(0);
	});

	it("rejects stale policy controls and forged protected intent IDs", async () => {
		const { agent } = await launch([write]);
		await agree(agent);
		await expect(
			agent.mission(
				{ operation: "control-local", action: "start", expectedPolicyRevision: 3, requestId: "stale" },
				context,
			),
		).rejects.toThrow("Stale mission policy");
		await expect(agent.mission({ operation: "reconcile-execution", requestId: "forged" }, context)).rejects.toThrow(
			"protected agreement",
		);
	});

	it("cancels pending activation without a provider so later configuration cannot resurrect it", async () => {
		const first = await launch([], "unconfigured");
		await agree(first.agent);
		await expect(
			first.agent.mission(
				{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
				context,
			),
		).rejects.toThrow("Configure a provider");
		await first.agent.mission(
			{ operation: "control-local", action: "stop", expectedPolicyRevision: 0, requestId: "cancel-pending" },
			context,
		);
		await close(first.agent);
		const second = await launch([write]);
		expect((await second.agent.mission({ operation: "status" }, context)).execution).toBe("not-started");
		expect(second.faux.state.callCount).toBe(0);
	});
});
