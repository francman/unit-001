// #15: Exercises autonomous bounded execution, exact receipts and restart safety on real SQLite.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	hook,
	type TaskId,
	ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaintenanceDoc } from "../../src/maintenance.ts";
import { MissionAdmission } from "../../src/missions/admission.ts";
import { readMissionAuthority, writeMissionAuthority } from "../../src/missions/authority.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { missionController, startMissionExecution } from "../../src/missions/controller.ts";
import { MissionExecutionDoc } from "../../src/missions/execution-state.ts";
import { MissionFoundation } from "../../src/missions/state.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];
const model = { provider: "faux", modelId: "faux-1" };
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-controller-"));
	now = 1_000;
});
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const criterion = (file: string, content: string) =>
	`sha256:${createHash("sha256").update(content).digest("hex")}:${file}`;
const write = (file: string, content: string) =>
	fauxAssistantMessage(fauxToolCall("write", { path: file, content }), { stopReason: "toolUse" });

async function launch(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [], priced = false) {
	const location = { kind: "developer-local" as const, directory, session: "default" };
	const admission = new MissionAdmission(location, () => now);
	const engine = missionController(admission, directory);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(MissionFoundation);
	registry.install(engine.extension);
	const faux = fauxProvider(
		priced
			? {
					models: [
						{
							id: "faux-1",
							contextWindow: 100_000,
							maxTokens: 10_000,
							cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
						},
					],
				}
			: undefined,
	);
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const reports: unknown[] = [];
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{
			models: admission.models(models),
			registry,
			now: () => now,
			setTimer: () => () => {},
			settings: { retry: { enabled: false }, stream: { maxRetries: 0 } },
			env: () => new NodeExecutionEnv({ cwd: directory }),
			onReport: (report) => reports.push(report),
		},
		context,
	);
	await admission.bind(harness, context);
	opened.push(harness);
	const control = new MissionControl(harness, location, ["write", "read", "bash"], () => now);
	return { harness, admission, engine, registry, faux, reports, control, location };
}

async function agree(host: Awaited<ReturnType<typeof launch>>, criteria: string[], policy = {}) {
	await host.control.handle(
		{
			operation: "configure-local",
			creator: { kind: "human", id: "creator", uid: process.getuid?.() ?? null },
			ceiling: {
				allowedTools: ["write", "read", "bash"],
				maxCycles: 10,
				maxRequests: 20,
				maxRetries: 2,
				maxConsecutiveNoProgress: 10,
				maxDurationMs: 30_000,
			},
		},
		context,
	);
	const draft = await host.control.handle(
		{
			operation: "draft",
			expectedRevision: 0,
			requestId: "draft",
			terms: {
				objective: "Create verified files",
				scope: "The isolated fixture workspace",
				successCriteria: criteria,
				approvalBoundary: [],
				reviewEveryMs: 100,
				policy: {
					allowedTools: ["write"],
					maxCycles: 4,
					maxRequests: 8,
					maxRetries: 1,
					maxConsecutiveNoProgress: 3,
					deadlineAt: 20_000,
					...policy,
				},
			},
		},
		context,
	);
	const proposed = await host.control.handle(
		{ operation: "propose", expectedRevision: draft.formation.draft!.revision, requestId: "propose" },
		context,
	);
	await host.control.handle(
		{
			operation: "approve-local",
			expectedRevision: proposed.formation.draft!.revision,
			digest: proposed.formation.draft!.digest!,
			requestId: "approval",
		},
		context,
	);
}

async function finished(host: Awaited<ReturnType<typeof launch>>, task: TaskId<null>) {
	host.harness.resume();
	await host.harness.waitForTask(task, context);
	return (await host.harness.snapshot(MissionExecutionDoc, context))!.current!;
}

describe("checkpointed mission controller", () => {
	it("continues from one assignment through multiple verified steps without another human prompt", async () => {
		const host = await launch([write("a.txt", "first"), write("b.txt", "second")]);
		await agree(host, [criterion("a.txt", "first"), criterion("b.txt", "second")]);
		const id = await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context);
		const result = await finished(host, id);
		expect(result.state.status).toBe("completed");
		expect(result.cycles).toBe(2);
		expect(result.requests).toBe(2);
		expect(result.evidence.every((item) => item.accepted)).toBe(true);
		expect(result.pendingTools).toEqual([]);
		expect(result.unknownRequests).toBe(0);
		expect(await readFile(join(directory, "b.txt"), "utf8")).toBe("second");
		expect(host.reports).toEqual([]);
	});

	it("never treats an assistant saying done as completion and stops at the finite cycle limit", async () => {
		const host = await launch([fauxAssistantMessage("Done"), fauxAssistantMessage("Done")]);
		await agree(host, [criterion("missing.txt", "proof")], { maxCycles: 2 });
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result.state).toEqual({ status: "blocked", reason: "cycle_limit" });
		expect(host.faux.state.callCount).toBe(2);
		expect(result.evidence[0].accepted).toBe(false);
	});

	it("blocks unsupported verification before any model request", async () => {
		const host = await launch();
		await agree(host, ["Make the world better"]);
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result.state).toEqual({ status: "blocked", reason: "unsupported_verification" });
		expect(host.faux.state.callCount).toBe(0);
	});

	it("rechecks a revoked creator receipt before restored task execution", async () => {
		const host = await launch();
		await agree(host, [criterion("missing.txt", "proof")]);
		const task = await startMissionExecution(
			host.harness,
			host.engine,
			host.admission,
			host.registry,
			model,
			context,
		);
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, { ...authority, revision: authority.revision + 1, approvals: [] });
		const result = await finished(host, task);
		expect(result.state).toEqual({ status: "blocked", reason: "authority" });
		expect(host.faux.state.callCount).toBe(0);
	});

	it("holds maintenance with a persisted sleep and performs no model polling", async () => {
		const host = await launch();
		await agree(host, [criterion("missing.txt", "proof")]);
		const task = await startMissionExecution(
			host.harness,
			host.engine,
			host.admission,
			host.registry,
			model,
			context,
		);
		await host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "update" };
		}, context);
		host.harness.resume();
		for (let i = 0; i < 100 && (await host.harness.getTask(task, context))?.state.status !== "sleeping"; i++)
			await setImmediate();
		expect((await host.harness.getTask(task, context))?.state).toMatchObject({ status: "sleeping", until: 1_100 });
		expect(host.faux.state.callCount).toBe(0);
		await host.harness.close(context);
		opened.splice(opened.indexOf(host.harness), 1);
		const reopened = await launch();
		expect((await reopened.harness.getTask(task, context))?.state).toMatchObject({
			status: "sleeping",
			until: 1_100,
		});
		reopened.harness.resume();
		await setImmediate();
		expect(reopened.faux.state.callCount).toBe(0);
	});

	it("uses the remaining request allowance even when many cycles are permitted", async () => {
		const host = await launch([fauxAssistantMessage("Still working"), fauxAssistantMessage("Must not be requested")]);
		await agree(host, [criterion("missing.txt", "proof")], { maxRequests: 1 });
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result.state).toEqual({ status: "blocked", reason: "request_limit" });
		expect(result.requests).toBe(1);
		expect(host.faux.state.callCount).toBe(1);
	});

	it("does not reissue an interrupted request after SQLite reopen", async () => {
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const host = await launch([
			(_input, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("Fixture request interrupted")), {
						once: true,
					});
				}),
		]);
		await agree(host, [criterion("missing.txt", "proof")]);
		const task = await startMissionExecution(
			host.harness,
			host.engine,
			host.admission,
			host.registry,
			model,
			context,
		);
		host.harness.resume();
		await started;
		expect((await host.harness.snapshot(MissionExecutionDoc, context))?.current).toMatchObject({
			requests: 1,
			unknownRequests: 1,
		});
		await host.harness.close(context);
		opened.splice(opened.indexOf(host.harness), 1);
		const reopened = await launch([fauxAssistantMessage("This request must not execute")]);
		const result = await finished(reopened, task);
		expect(result.state).toEqual({ status: "blocked", reason: "unknown_request_outcome" });
		expect(result.requests).toBe(1);
		expect(result.unknownRequests).toBe(1);
		expect(reopened.faux.state.callCount).toBe(0);
	});

	it("closes tool admission when pause is committed during an already dispatched request", async () => {
		let requested!: () => void;
		let finish!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const host = await launch([
			() =>
				new Promise((resolve) => {
					finish = resolve;
					requested();
				}),
		]);
		await agree(host, [criterion("forbidden.txt", "proof")]);
		const task = await startMissionExecution(
			host.harness,
			host.engine,
			host.admission,
			host.registry,
			model,
			context,
		);
		host.harness.resume();
		await started;
		await host.harness.commit(async (tx) => {
			const current = (await tx.doc(MissionExecutionDoc)).current!;
			current.state = { status: "paused" };
			current.policyRevision++;
			current.revision++;
		}, context);
		finish(write("forbidden.txt", "proof"));
		const result = await finished(host, task);
		expect(result.state).toEqual({ status: "paused" });
		await expect(readFile(join(directory, "forbidden.txt"))).rejects.toThrow("ENOENT");
		expect(host.faux.state.callCount).toBe(1);
	});

	it("rejects racing activation so only one controller and execution conversation exist", async () => {
		const host = await launch();
		await agree(host, [criterion("missing.txt", "proof")]);
		const results = await Promise.allSettled(
			[1, 2].map(() =>
				startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(
			(await host.harness.inspect(context)).tasks.filter((task) => task.record.kind === "unit.mission.controller"),
		).toHaveLength(1);
	});

	it("finishes preexisting verified evidence without spending a request", async () => {
		const host = await launch();
		await agree(host, [criterion("exists.txt", "proof")]);
		await writeFile(join(directory, "exists.txt"), "proof");
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result.state.status).toBe("completed");
		expect(result.cycles).toBe(0);
		expect(host.faux.state.callCount).toBe(0);
	});

	it("charges a settled provider failure and persists its bounded retry deadline", async () => {
		const host = await launch([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "Fixture rejected request" }),
		]);
		await agree(host, [criterion("missing.txt", "proof")]);
		const task = await startMissionExecution(
			host.harness,
			host.engine,
			host.admission,
			host.registry,
			model,
			context,
		);
		host.harness.resume();
		for (let i = 0; i < 500 && (await host.harness.getTask(task, context))?.state.status !== "sleeping"; i++)
			await setImmediate();
		expect((await host.harness.getTask(task, context))?.state).toMatchObject({ status: "sleeping", until: 1_100 });
		expect((await host.harness.snapshot(MissionExecutionDoc, context))?.current).toMatchObject({
			requests: 1,
			retries: 1,
			unknownRequests: 0,
			unpricedResponses: 1,
		});
		now = 20_000;
		const result = await finished(host, task);
		expect(result.state).toEqual({ status: "blocked", reason: "authority" });
		expect(host.faux.state.callCount).toBe(1);
	});

	it("closes execution intent when the owning controller is explicitly aborted", async () => {
		const host = await launch();
		await agree(host, [criterion("missing.txt", "proof")]);
		const task = await startMissionExecution(
			host.harness,
			host.engine,
			host.admission,
			host.registry,
			model,
			context,
		);
		await host.harness.abortTask(task, context);
		await host.harness.waitForTask(task, context);
		expect((await host.harness.snapshot(MissionExecutionDoc, context))?.current?.state).toEqual({
			status: "stopped",
		});
		expect(host.faux.state.callCount).toBe(0);
	});

	it("settles a later hook's pre-dispatch rejection without inventing an uncertain tool effect", async () => {
		const host = await launch([write("denied.txt", "proof")]);
		host.registry.install(
			defineExtension({
				name: "fixture-rejection",
				hooks: [hook(ToolTask, { beforeTool: () => ({ block: "Fixture policy rejection" }) })],
			}),
		);
		await agree(host, [criterion("denied.txt", "proof")], { maxCycles: 1 });
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result.pendingTools).toEqual([]);
		expect(result.state).toEqual({ status: "blocked", reason: "cycle_limit" });
		await expect(readFile(join(directory, "denied.txt"))).rejects.toThrow("ENOENT");
	});

	it.each([false, true])(
		"reconciles an interrupted tool only through actual verifier evidence: completed=%s",
		async (complete) => {
			let writing!: () => void;
			const started = new Promise<void>((resolve) => {
				writing = resolve;
			});
			const first = await launch([write("effect.txt", "proof")]);
			first.registry.uninstall(CodingTools);
			first.registry.install(
				defineExtension({
					name: "fixture-interrupted-write",
					tools: [
						defineTool({
							name: "write",
							description: "Write before an interrupted fixture receipt.",
							parameters: Type.Object({ path: Type.String(), content: Type.String() }),
							execute: async (args, _api, ctx) => {
								await writeFile(join(directory, args.path), complete ? args.content : "partial");
								writing();
								await new Promise((_resolve, reject) =>
									ctx.abortSignal!.addEventListener("abort", () => reject(new Error("Fixture interrupted")), {
										once: true,
									}),
								);
								return { output: [] };
							},
						}),
					],
				}),
			);
			await agree(first, [criterion("effect.txt", "proof")]);
			const task = await startMissionExecution(
				first.harness,
				first.engine,
				first.admission,
				first.registry,
				model,
				context,
			);
			first.harness.resume();
			await started;
			await first.harness.close(context);
			opened.splice(opened.indexOf(first.harness), 1);
			const reopened = await launch([write("effect.txt", "must not repeat")]);
			const result = await finished(reopened, task);
			expect(result.state).toEqual(
				complete
					? { status: "completed", observedAt: 1_000 }
					: { status: "blocked", reason: "unknown_tool_outcome" },
			);
			expect(reopened.faux.state.callCount).toBe(0);
		},
	);

	it("rejects an unpriced capped request before dispatch", async () => {
		const host = await launch();
		await agree(host, [criterion("missing.txt", "proof")], { maxEstimatedCost: 1 });
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result.state).toEqual({ status: "blocked", reason: "estimated_spend_limit" });
		expect(host.faux.state.callCount).toBe(0);
	});

	it("retains a paid-model reservation when a response omits usage pricing", async () => {
		const host = await launch([fauxAssistantMessage("Still working")], true);
		await agree(host, [criterion("missing.txt", "proof")], { maxEstimatedCost: 0.3 });
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result.state).toEqual({ status: "blocked", reason: "estimated_spend_limit" });
		expect(result.unpricedResponses).toBe(1);
		expect(result.reservedCost).toBeCloseTo(0.21);
		expect(host.faux.state.callCount).toBe(1);
	});
});
