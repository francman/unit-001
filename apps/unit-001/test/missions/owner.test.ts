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
import { readMissionAuthority, writeMissionAuthority } from "../../src/missions/authority.ts";
import { parseMissionCommand } from "../../src/missions/command.ts";
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
	startup: "active" | "inhibited" = "active",
) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
			models,
			model: configuration === "configured" ? { provider: "faux", modelId: "faux-1" } : null,
			cwd: directory,
			startup: { kind: startup },
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
	it("allows stop after creator revocation and drains the dispatched request", async () => {
		let requested!: () => void;
		let aborted = false;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const { agent } = await launch([
			(_input, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("revoked"));
						},
						{ once: true },
					);
				}),
		]);
		await agree(agent);
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await started;
		const location = { kind: "developer-local" as const, directory, session: "default" };
		const prior = (await readMissionAuthority(location))!;
		await agent.mission(
			{ operation: "configure-local", creator: { ...prior.creator, id: "replacement" }, ceiling: prior.ceiling },
			context,
		);
		const stopped = await agent.mission(
			{ operation: "control-local", action: "stop", expectedPolicyRevision: 1, requestId: "revoked-stop" },
			context,
		);
		expect(stopped.execution).toBe("stopped");
		expect(stopped.agreementValid).toBe(false);
		expect(aborted).toBe(true);
		expect((await readMissionAuthority(location))!.executionIntent?.sequence).toBe(2);
	});

	it("rejects an amendment while the old execution is paused", async () => {
		const { agent } = await launch([fauxAssistantMessage([], { stopReason: "error", errorMessage: "retry" })]);
		await agree(agent);
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await waitFor(agent, "waiting");
		await agent.mission(
			{ operation: "control-local", action: "pause", expectedPolicyRevision: 1, requestId: "pause" },
			context,
		);
		const original = (await agent.mission({ operation: "status" }, context)).formation.agreement!;
		await agent.mission(
			{
				operation: "draft",
				expectedRevision: 1,
				requestId: "amend",
				terms: { ...original.terms, objective: "New objective" },
			},
			context,
		);
		const proposed = await agent.mission(
			{ operation: "propose", expectedRevision: 2, requestId: "propose-amend" },
			context,
		);
		await expect(
			agent.mission(
				{
					operation: "approve-local",
					expectedRevision: 2,
					requestId: "approve-amend",
					digest: proposed.formation.draft!.digest!,
				},
				context,
			),
		).rejects.toThrow("Stop the existing");
		expect((await agent.mission({ operation: "status" }, context)).formation.agreement).toEqual(original);
	});

	it("rejects superseded resume IDs with their captured revision and requires it on CLI retries", async () => {
		const response = fauxAssistantMessage([], { stopReason: "error", errorMessage: "retry" });
		const { agent } = await launch([response, response]);
		await agree(agent);
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await waitFor(agent, "waiting");
		await agent.mission(
			{ operation: "control-local", action: "pause", expectedPolicyRevision: 1, requestId: "P1" },
			context,
		);
		await agent.mission(
			{ operation: "control-local", action: "resume", expectedPolicyRevision: 2, requestId: "R1" },
			context,
		);
		await waitFor(agent, "waiting");
		const paused = await agent.mission(
			{ operation: "control-local", action: "pause", expectedPolicyRevision: 3, requestId: "P2" },
			context,
		);
		await expect(
			agent.mission(
				{ operation: "control-local", action: "resume", expectedPolicyRevision: 2, requestId: "R1" },
				context,
			),
		).rejects.toThrow("Stale mission policy");
		expect((await agent.mission({ operation: "status" }, context)).runtime).toEqual(
			expect.objectContaining({ policyRevision: paused.runtime!.policyRevision, status: "paused" }),
		);
		expect(() => parseMissionCommand(["resume", "--request-id", "R1"])).toThrow("requires --policy-revision");
		expect(parseMissionCommand(["resume", "--request-id", "R1", "--policy-revision", "2"]).command).toMatchObject({
			policyRevision: 2,
			requestId: "R1",
		});
	});

	it.each(["active", "inhibited"] as const)(
		"replays restrictive gates without resuming unfinished ordinary work: startup=%s",
		async (startup) => {
			const response = fauxAssistantMessage([], { stopReason: "error", errorMessage: "retry" });
			let requested!: () => void;
			const started = new Promise<void>((resolve) => {
				requested = resolve;
			});
			const first = await launch([
				response,
				(_input, options) =>
					new Promise((_resolve, reject) => {
						requested();
						options?.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true });
					}),
			]);
			await agree(first.agent);
			await first.agent.mission(
				{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
				context,
			);
			await waitFor(first.agent, "waiting");
			await first.agent.mission(
				{ operation: "control-local", action: "pause", expectedPolicyRevision: 1, requestId: "pause" },
				context,
			);
			await first.agent.submit("unfinished ordinary request", context);
			await started;
			await close(first.agent);
			const location = { kind: "developer-local" as const, directory, session: "default" };
			const prior = (await readMissionAuthority(location))!;
			await writeMissionAuthority(location, {
				...prior,
				executionIntent: {
					...prior.executionIntent!,
					requestId: "pending-stop",
					sequence: 3,
					expectedPolicyRevision: 2,
					action: "stop",
				},
			});
			const next = await launch([write], "unconfigured", startup);
			expect((await next.agent.mission({ operation: "status" }, context)).runtime).toMatchObject({
				status: "stopped",
				policyRevision: 3,
			});
			await setTimeout(30);
			expect(next.faux.state.callCount).toBe(0);
			await expect(readFile(join(directory, "proof.txt"))).rejects.toThrow("ENOENT");
		},
	);

	it("reconciles a pending stop while held before maintenance release enables scheduling", async () => {
		const first = await launch([fauxAssistantMessage([], { stopReason: "error", errorMessage: "retry" })]);
		await agree(first.agent);
		await first.agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await waitFor(first.agent, "waiting");
		await first.agent.enterMaintenance("update", 0, context);
		await close(first.agent);
		const location = { kind: "developer-local" as const, directory, session: "default" };
		const authority = (await readMissionAuthority(location))!;
		await writeMissionAuthority(location, {
			...authority,
			executionIntent: {
				...authority.executionIntent!,
				requestId: "held-stop",
				action: "stop",
				sequence: 2,
				expectedPolicyRevision: 1,
			},
		});
		const next = await launch([write]);
		expect((await next.agent.mission({ operation: "status" }, context)).execution).toBe("stopped");
		expect(next.faux.state.callCount).toBe(0);
		await next.agent.releaseMaintenance("update", context);
		expect((await next.agent.mission({ operation: "status" }, context)).execution).toBe("stopped");
		expect(next.faux.state.callCount).toBe(0);
	});
	it("applies a protected stop on maintenance release without reopening the live owner", async () => {
		const { agent, faux } = await launch([fauxAssistantMessage([], { stopReason: "error", errorMessage: "retry" })]);
		await agree(agent);
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await waitFor(agent, "waiting");
		await agent.enterMaintenance("live-update", 0, context);
		const location = { kind: "developer-local" as const, directory, session: "default" };
		const authority = (await readMissionAuthority(location))!;
		await writeMissionAuthority(location, {
			...authority,
			executionIntent: {
				...authority.executionIntent!,
				requestId: "live-stop",
				action: "stop",
				sequence: 2,
				expectedPolicyRevision: 1,
			},
		});
		await agent.releaseMaintenance("live-update", context);
		expect((await agent.mission({ operation: "status" }, context)).execution).toBe("stopped");
		expect(faux.state.callCount).toBe(1);
	});

	it("preserves verified completion when stop drains the terminal scope", async () => {
		const { agent } = await launch([write]);
		await agree(agent);
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		const completed = await waitFor(agent, "completed");
		const stopped = await agent.mission(
			{ operation: "control-local", action: "stop", expectedPolicyRevision: 1, requestId: "stop-completed" },
			context,
		);
		expect(stopped.execution).toBe("completed");
		expect(stopped.runtime!.evidence).toEqual(completed.runtime!.evidence);
	});
});
