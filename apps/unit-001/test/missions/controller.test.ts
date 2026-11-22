// #15: Exercises autonomous bounded execution, exact receipts and restart safety on real SQLite.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	hook,
	type TaskId,
	type ToolExecutionApi,
	ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceDoc } from "../../src/maintenance.ts";
import { MissionAdmission } from "../../src/missions/admission.ts";
import * as authorityModule from "../../src/missions/authority.ts";
import { readMissionAuthority, writeMissionAuthority } from "../../src/missions/authority.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { missionController, startMissionExecution } from "../../src/missions/controller.ts";
import { type MissionExecution, MissionExecutionDoc } from "../../src/missions/execution-state.ts";
import { MissionOwner } from "../../src/missions/owner.ts";
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
	vi.restoreAllMocks();
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const criterion = (file: string, content: string) =>
	`sha256:${createHash("sha256").update(content).digest("hex")}:${file}`;
const write = (file: string, content: string) =>
	fauxAssistantMessage(fauxToolCall("write", { path: file, content }), { stopReason: "toolUse" });

async function launch(
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [],
	priced = false,
	retry: { enabled: false } | { enabled: true; maxRetries: number; baseDelayMs: number } = { enabled: false },
	stream: { deferred?: true } = {},
) {
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
			settings: { retry, stream: { maxRetries: 0, ...stream } },
			env: () => new NodeExecutionEnv({ cwd: directory }),
			onReport: (report) => reports.push(report),
		},
		context,
	);
	await admission.bind(harness, context);
	opened.push(harness);
	const control = new MissionControl(harness, location, ["write", "read", "bash"], () => now);
	const owner = new MissionOwner(harness, control, location, registry, admission, engine, model, directory);
	await owner.initialize(context, "permitted");
	return { harness, admission, engine, registry, faux, reports, control, location, owner };
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

type FixtureEffect = (
	args: { path: string; content: string },
	ctx: typeof context,
	api: ToolExecutionApi,
) => Promise<void>;

function fixtureTools(
	...tools: { name: "write" | "read"; replay?: "safe"; executionMode?: "sequential"; effect: FixtureEffect }[]
) {
	return defineExtension({
		name: "fixture-mission-tools",
		tools: tools.map(({ name, replay, executionMode, effect }) =>
			defineTool({
				name,
				description: "A mission fixture action.",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				...(replay === undefined ? {} : { replay }),
				...(executionMode === undefined ? {} : { executionMode }),
				execute: async (args, api, ctx) => {
					await effect(args, ctx, api);
					return { output: [] };
				},
			}),
		),
	});
}

const replaySafeWrite = (effect: FixtureEffect) => fixtureTools({ name: "write", replay: "safe", effect });

/** One storage effect, committed through the tool's own commit as memory tools commit theirs. */
const Effects = defineDoc<{ count: number }>({
	kind: "fixture.mission.effects",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => true,
});

const commitEffect: FixtureEffect = async (_args, ctx, api) => {
	await api.commit(async (tx) => {
		(await tx.doc(Effects)).count++;
	}, ctx);
};

const untilAborted = (ctx: typeof context) =>
	new Promise<never>((_resolve, reject) =>
		ctx.abortSignal!.addEventListener("abort", () => reject(new Error("Fixture interrupted")), { once: true }),
	);

function latch() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, opened };
}

async function reopen(host: Awaited<ReturnType<typeof launch>>, ...args: Parameters<typeof launch>) {
	await host.harness.close(context);
	opened.splice(opened.indexOf(host.harness), 1);
	const reopened = await launch(...args);
	reopened.registry.uninstall(CodingTools);
	return reopened;
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

	// #16: Durable reruns a replay-safe tool from its saved checkpoint without beforeTool; current authority must decide.
	it.each([true, false])(
		"reruns a recovered replay-safe mission action only under current authority: revoked=%s",
		async (revoked) => {
			let interrupted!: () => void;
			const started = new Promise<void>((resolve) => {
				interrupted = resolve;
			});
			const first = await launch([write("effect.txt", "proof")]);
			first.registry.uninstall(CodingTools);
			first.registry.install(
				replaySafeWrite(async (_args, ctx) => {
					interrupted();
					await new Promise((_resolve, reject) =>
						ctx.abortSignal!.addEventListener("abort", () => reject(new Error("Fixture interrupted")), {
							once: true,
						}),
					);
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
			expect((await first.harness.snapshot(MissionExecutionDoc, context))!.current!.pendingTools).toHaveLength(1);
			await first.harness.close(context);
			opened.splice(opened.indexOf(first.harness), 1);
			if (revoked) {
				const authority = (await readMissionAuthority(first.location))!;
				await writeMissionAuthority(first.location, { ...authority, revision: authority.revision + 1, approvals: [] });
			}
			const reruns: string[] = [];
			const reopened = await launch();
			reopened.registry.uninstall(CodingTools);
			reopened.registry.install(
				replaySafeWrite(async (args) => {
					reruns.push(args.path);
					await writeFile(join(directory, args.path), args.content);
				}),
			);
			const result = await finished(reopened, task);
			expect(reopened.faux.state.callCount).toBe(0);
			if (revoked) {
				expect(reruns).toEqual([]);
				await expect(readFile(join(directory, "effect.txt"))).rejects.toThrow("ENOENT");
				// The denied rerun proves nothing about the interrupted attempt, so its intent stays uncertain.
				expect(result.pendingTools).toHaveLength(1);
				expect(result.state).toEqual({ status: "blocked", reason: "authority" });
			} else {
				expect(reruns).toEqual(["effect.txt"]);
				expect(result.pendingTools).toEqual([]);
				expect(result.state).toEqual({ status: "completed", observedAt: 1_000 });
			}
		},
	);

	// #16: The admission decision and the effect are one transaction; a change landing after admission rolls it back.
	it.each([
		["fresh", "hold"],
		["fresh", "pause"],
		["fresh", "revoked"],
		["recovered", "hold"],
		["recovered", "pause"],
		["recovered", "revoked"],
	] as const)("commits no %s mission effect once a %s lands after its admission", async (origin, change) => {
		const parked = latch();
		const release = latch();
		const park: FixtureEffect = async (args, ctx, api) => {
			parked.open();
			await release.opened;
			await commitEffect(args, ctx, api);
		};
		const interrupted = latch();
		let host = await launch([write("effect.txt", "proof")]);
		host.registry.uninstall(CodingTools);
		host.registry.install(
			replaySafeWrite(
				origin === "fresh"
					? park
					: async (_args, ctx) => {
							interrupted.open();
							await untilAborted(ctx);
						},
			),
		);
		await agree(host, [criterion("effect.txt", "proof")]);
		const task = await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context);
		host.harness.resume();
		if (origin === "recovered") {
			await interrupted.opened;
			host = await reopen(host);
			host.registry.install(replaySafeWrite(park));
			host.harness.resume();
		}
		// The call passed admission and is about to commit its effect when the policy changes.
		await parked.opened;
		if (change === "hold")
			await host.harness.commit(async (tx) => {
				(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "update" };
			}, context);
		else if (change === "pause")
			await host.harness.commit(async (tx) => {
				const current = (await tx.doc(MissionExecutionDoc)).current!;
				current.state = { status: "paused" };
				current.policyRevision++;
				current.revision++;
			}, context);
		else {
			const authority = (await readMissionAuthority(host.location))!;
			await writeMissionAuthority(host.location, { ...authority, revision: authority.revision + 1, approvals: [] });
		}
		release.open();
		const result = await finished(host, task);
		expect((await host.harness.snapshot(Effects, context))?.count ?? 0).toBe(0);
		// The rolled-back commit proves nothing about work before it, so the intent stays uncertain.
		expect(result.pendingTools).toHaveLength(1);
		expect(result.state).toEqual(
			change === "hold"
				? { status: "blocked", reason: "unknown_tool_outcome" }
				: change === "pause"
					? { status: "paused" }
					: { status: "blocked", reason: "authority" },
		);
		expect(host.faux.state.callCount).toBe(origin === "fresh" ? 1 : 0);
	});

	// #16: A saved round's later action never runs while an earlier action's outcome is unknown, created fresh or rerun.
	it.each(["sequential", "parallel"] as const)(
		"runs no saved sibling action beside an interrupted action: %s round",
		async (mode) => {
			const interrupted = latch();
			const sibling = latch();
			const second = mode === "sequential" ? ("write" as const) : ("read" as const);
			const first = await launch([
				fauxAssistantMessage(
					[
						fauxToolCall("write", { path: "a.txt", content: "a" }),
						fauxToolCall(second, { path: "b.txt", content: "b" }),
					],
					{ stopReason: "toolUse" },
				),
			]);
			first.registry.uninstall(CodingTools);
			first.registry.install(
				fixtureTools(
					{
						name: "write",
						...(mode === "sequential" ? { executionMode: "sequential" as const } : {}),
						effect: async (_args, ctx) => {
							interrupted.open();
							await untilAborted(ctx);
						},
					},
					{
						name: "read",
						replay: "safe",
						effect: async (_args, ctx) => {
							sibling.open();
							await untilAborted(ctx);
						},
					},
				),
			);
			await agree(first, [criterion("b.txt", "b")], { allowedTools: ["write", "read"] });
			const task = await startMissionExecution(
				first.harness,
				first.engine,
				first.admission,
				first.registry,
				model,
				context,
			);
			first.harness.resume();
			await interrupted.opened;
			if (mode === "parallel") await sibling.opened;
			const reopened = await reopen(first);
			const runs: string[] = [];
			const record: FixtureEffect = async (args) => {
				runs.push(args.path);
				await writeFile(join(directory, args.path), args.content);
			};
			reopened.registry.install(
				fixtureTools(
					{ name: "write", ...(mode === "sequential" ? { executionMode: "sequential" as const } : {}), effect: record },
					{ name: "read", replay: "safe", effect: record },
				),
			);
			const result = await finished(reopened, task);
			expect(runs).toEqual([]);
			await expect(readFile(join(directory, "b.txt"))).rejects.toThrow("ENOENT");
			// Sequential: the sibling was refused before its intent; parallel: its saved intent stays uncertain too.
			expect(result.pendingTools).toHaveLength(mode === "sequential" ? 1 : 2);
			expect(result.state).toEqual({ status: "blocked", reason: "unknown_tool_outcome" });
			expect(reopened.faux.state.callCount).toBe(0);
		},
	);

	// #16: Durable polls a deferred handle without the provider session, so no mission attempt may leave one behind.
	it.each(["requested", "returned"] as const)("leaves no deferred mission poll: deferred %s", async (how) => {
		const asked: unknown[] = [];
		const host = await launch(
			[
				how === "requested"
					? (_input, options) => {
							asked.push(options?.deferred);
							return write("effect.txt", "proof");
						}
					: (_input, _options, _state, requested) =>
							fauxAssistantMessage([], {
								stopReason: "deferred",
								deferred: {
									provider: requested.provider,
									modelId: requested.id,
									api: requested.api,
									id: "fixture-deferred",
								},
							}),
			],
			false,
			{ enabled: false },
			how === "requested" ? { deferred: true } : {},
		);
		await agree(host, [criterion("effect.txt", "proof")], { maxRetries: 0 });
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(host.faux.state.deferredFetchCount).toBe(0);
		if (how === "requested") {
			expect(asked).toEqual([undefined]);
			expect(result.state).toEqual({ status: "completed", observedAt: 1_000 });
		} else {
			expect(host.faux.state.cancelledDeferred.map((handle) => handle.id)).toEqual(["fixture-deferred"]);
			// The provider accepted the work, so the attempt is an unpriced receipt, never a free one.
			expect(result).toMatchObject({ requests: 1, unknownRequests: 0, unpricedResponses: 1 });
			expect(result.state).toEqual({ status: "blocked", reason: "retry_limit" });
		}
	});

	it("reruns a recovered replay-safe action unchanged in ordinary chat beside a bound mission", async () => {
		const interrupted = latch();
		const first = await launch([write("chat.txt", "ordinary")]);
		first.registry.uninstall(CodingTools);
		first.registry.install(
			replaySafeWrite(async (_args, ctx) => {
				interrupted.open();
				await untilAborted(ctx);
			}),
		);
		await agree(first, [criterion("missing.txt", "proof")]);
		await startMissionExecution(first.harness, first.engine, first.admission, first.registry, model, context);
		// The mission's own decision now denies everything; ordinary chat must not consult it.
		const authority = (await readMissionAuthority(first.location))!;
		await writeMissionAuthority(first.location, { ...authority, revision: authority.revision + 1, approvals: [] });
		const root = await first.harness.root(context, { agent: { model } });
		await root.submit({ type: "input", content: "Write the chat file", requestId: "chat" }, context);
		first.harness.resume();
		await interrupted.opened;
		const reopened = await reopen(first);
		const reruns: string[] = [];
		reopened.registry.install(
			replaySafeWrite(async (args) => {
				reruns.push(args.path);
				await writeFile(join(directory, args.path), args.content);
			}),
		);
		reopened.harness.resume();
		await (await reopened.harness.root(context)).waitForIdle(context);
		const mission = (await reopened.harness.snapshot(MissionExecutionDoc, context))!.current!;
		await reopened.harness.waitForTask(mission.controller, context);
		expect((await reopened.harness.snapshot(MissionExecutionDoc, context))?.current?.state).toEqual({
			status: "blocked",
			reason: "authority",
		});
		expect(reruns).toEqual(["chat.txt"]);
		expect(await readFile(join(directory, "chat.txt"), "utf8")).toBe("ordinary");
	});

	// #16 (unit-mei.35): the "re-send after kill" was Durable's scheduled retry of a settled failure, a new admitted
	// attempt; an attempt still in flight at shutdown stays unknown and blocks every later attempt, retries included.
	it.each([false, true])(
		"distinguishes a scheduled provider retry from an unknown attempt across restart: in flight=%s",
		async (inFlight) => {
			const retry = { enabled: true, maxRetries: 3, baseDelayMs: 2_000 } as const;
			let requested!: () => void;
			const started = new Promise<void>((resolve) => {
				requested = resolve;
			});
			const host = await launch(
				[
					inFlight
						? (_input, options) =>
								new Promise((_resolve, reject) => {
									requested();
									options?.signal?.addEventListener("abort", () => reject(new Error("socket hang up")), {
										once: true,
									});
								})
						: () => {
								requested();
								return fauxAssistantMessage([], { stopReason: "error", errorMessage: "socket hang up" });
							},
				],
				false,
				retry,
			);
			await agree(host, [criterion("missing.txt", "proof")], { maxCycles: 1 });
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
			const generation = async () =>
				(await host.harness.inspect(context)).tasks.find((item) => item.record.kind === "pi.generation")?.record;
			if (!inFlight)
				for (let i = 0; i < 500 && (await generation())?.state.status !== "sleeping"; i++) await setImmediate();
			expect((await host.harness.snapshot(MissionExecutionDoc, context))!.current).toMatchObject({
				requests: 1,
				unknownRequests: inFlight ? 1 : 0,
				unpricedResponses: inFlight ? 0 : 1,
			});
			if (!inFlight) expect((await generation())?.state).toMatchObject({ status: "sleeping", until: 3_000 });
			await host.harness.close(context);
			opened.splice(opened.indexOf(host.harness), 1);
			now = 3_000;
			const reopened = await launch([fauxAssistantMessage("Still working")], false, retry);
			const result = await finished(reopened, task);
			if (inFlight) {
				expect(reopened.faux.state.callCount).toBe(0);
				expect(result).toMatchObject({ requests: 1, unknownRequests: 1 });
				expect(result.state).toEqual({ status: "blocked", reason: "unknown_request_outcome" });
			} else {
				// A new attempt, admitted against the current gates and counted; both receipts are unpriced on the free faux model.
				expect(reopened.faux.state.callCount).toBe(1);
				expect(result).toMatchObject({ requests: 2, unknownRequests: 0, unpricedResponses: 2 });
				expect(result.state).toEqual({ status: "blocked", reason: "cycle_limit" });
			}
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

	it("keeps a pending (partial) provider response unknown instead of counting it as a receipt", async () => {
		const host = await launch([]);
		const pending = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end(fauxAssistantMessage("partial", { stopReason: "pending" })));
			return stream;
		};
		vi.spyOn(host.faux.provider, "stream").mockImplementation(pending);
		vi.spyOn(host.faux.provider, "streamSimple").mockImplementation(pending);
		await agree(host, [criterion("missing.txt", "proof")]);
		const result = await finished(
			host,
			await startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		);
		expect(result).toMatchObject({ requests: 1, unknownRequests: 1, unpricedResponses: 0 });
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
	// #17: A managed migration or rewritten authority must never inherit host-engine admission.
	it("requires a managed exact intent receipt, including a migrated version-one ledger", async () => {
		const first = await launch();
		await agree(first, [criterion("missing.txt", "proof")]);
		await startMissionExecution(first.harness, first.engine, first.admission, first.registry, model, context);
		const saved = (await first.harness.snapshot(MissionExecutionDoc, context))!.current!;
		const { intent: _intent, ...legacyExecution } = saved;
		const legacy = defineDoc<{ current: Omit<MissionExecution, "intent"> | null }>({
			...MissionExecutionDoc.definition,
			version: 1,
			migrate: undefined,
			initial: () => ({ current: null }),
		});
		const migration = await Harness.open(
			await openNodeSqliteStorage(join(directory, "migration.sqlite")),
			{ models: createModels(), registry: first.registry },
			context,
		);
		opened.push(migration);
		await migration.commit(async (tx) => {
			(await tx.doc(legacy)).current = legacyExecution;
		}, context);
		await migration.close(context);
		opened.splice(opened.indexOf(migration), 1);
		const reopened = await Harness.open(
			await openNodeSqliteStorage(join(directory, "migration.sqlite")),
			{ models: createModels(), registry: first.registry },
			context,
		);
		opened.push(reopened);
		const migrated = (await reopened.snapshot(MissionExecutionDoc, context))!.current!;
		expect(migrated).toEqual({ ...legacyExecution, intent: null });
		const managed = new MissionAdmission(
			{ kind: "managed", installationId: "11111111-1111-4111-8111-111111111111", session: "default" },
			() => now,
		);
		const authority = (await readMissionAuthority(first.location))!;
		// Isolate intent admission from the protected-file/UID boundary covered by the Linux helper fixture.
		const read = vi.spyOn(authorityModule, "readMissionAuthority").mockResolvedValue(authority);
		expect(await managed.authorized(migrated)).toBe(false);
		const intent = {
			requestId: "start",
			sequence: 1,
			missionId: saved.agreement.missionId,
			agreementRevision: saved.agreement.revision,
			agreementDigest: saved.agreement.digest,
			authorityRevision: authority.revision,
			expectedPolicyRevision: 0,
			action: "start" as const,
			issuedAt: now,
		};
		read.mockResolvedValue({ ...authority, executionIntent: intent });
		expect(await managed.authorized(migrated)).toBe(false);
		const authenticated = { ...migrated, intent: { requestId: "start", sequence: 1 } };
		expect(await managed.authorized(authenticated)).toBe(true);
		for (const change of [
			{ requestId: "forged" },
			{ sequence: 2 },
			{ agreementDigest: "0".repeat(64) },
			{ authorityRevision: 2 },
			{ action: "pause" as const },
		]) {
			read.mockResolvedValue({ ...authority, executionIntent: { ...intent, ...change } });
			expect(await managed.authorized(authenticated)).toBe(false);
		}
		read.mockResolvedValue({ ...authority, approvals: [], executionIntent: intent });
		expect(await managed.authorized(authenticated)).toBe(false);
		now = saved.agreement.terms.policy.deadlineAt;
		read.mockResolvedValue({ ...authority, executionIntent: intent });
		expect(await managed.authorized(authenticated)).toBe(false);
	});

	// #17: Pause closes admission, aborts a live tool and crosses its background ownership boundary.
	it("drains an actual tool and its owned background task before acknowledging pause", async () => {
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let background: TaskId | undefined;
		let toolAborted = false;
		let backgroundAborted = false;
		const host = await launch([write("effect.txt", "proof")]);
		const Background = defineTask<null, { phase: "work" }, null>({
			name: "fixture.mission.background",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime) => {
					started();
					await new Promise((_resolve, reject) =>
						runtime.signal.addEventListener(
							"abort",
							() => {
								backgroundAborted = true;
								reject(new Error("drained"));
							},
							{ once: true },
						),
					);
				},
			},
			abort: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		host.registry.uninstall(CodingTools);
		host.registry.install(
			defineExtension({
				name: "fixture.mission.tool",
				tasks: [Background],
				tools: [
					defineTool({
						name: "write",
						description: "Hold a fixture tool and its background child.",
						parameters: Type.Object({ path: Type.String(), content: Type.String() }),
						execute: async (_args, api, ctx) => {
							background = await api.commit(async (tx) => {
								const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
								return tx.createTask(Background, null, {
									conversationId: child.id,
									ownership: { kind: "conversation" },
									background: true,
								});
							}, ctx);
							await new Promise((_resolve, reject) =>
								ctx.abortSignal!.addEventListener(
									"abort",
									() => {
										toolAborted = true;
										reject(new Error("drained"));
									},
									{ once: true },
								),
							);
							return { output: [] };
						},
					}),
				],
			}),
		);
		await agree(host, [criterion("effect.txt", "proof")]);
		await host.owner.handle(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		await running;
		const paused = await host.owner.handle(
			{ operation: "control-local", action: "pause", expectedPolicyRevision: 1, requestId: "pause" },
			context,
		);
		expect(paused.execution).toBe("paused");
		expect(toolAborted).toBe(true);
		expect(backgroundAborted).toBe(true);
		expect((await host.harness.getTask(background!, context))?.state.status).toBe("terminal");
		expect(paused.runtime?.uncertainTools).toBe(1);
		await expect(
			host.owner.handle(
				{ operation: "control-local", action: "resume", expectedPolicyRevision: 2, requestId: "resume" },
				context,
			),
		).rejects.toThrow("Uncertain mission effects");
	});

	// #17: New execution scopes retain every finite work/spend counter rather than starting a new budget.
	it("preserves all cumulative counters across pause, SQLite reopen and resume", async () => {
		const host = await launch([fauxAssistantMessage([], { stopReason: "error", errorMessage: "retry" })], true);
		await agree(host, [criterion("missing.txt", "proof")]);
		await host.owner.handle(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		for (let i = 0; i < 500 && (await host.owner.inspect(context)).execution !== "waiting"; i++) await setImmediate();
		await host.harness.commit(async (tx) => {
			const current = (await tx.doc(MissionExecutionDoc)).current!;
			current.estimatedCost = 0.12;
		}, context);
		const paused = await host.owner.handle(
			{ operation: "control-local", action: "pause", expectedPolicyRevision: 1, requestId: "pause" },
			context,
		);
		await host.harness.close(context);
		opened.splice(opened.indexOf(host.harness), 1);
		const reopened = await launch([], true);
		const before = (await reopened.owner.inspect(context)).runtime!;
		for (const key of [
			"cycles",
			"requests",
			"retries",
			"noProgress",
			"estimatedCost",
			"reservedCost",
			"unknownRequests",
			"unpricedResponses",
			"uncertainTools",
		] as const)
			expect(before[key]).toBe(paused.runtime![key]);
		expect(before).toMatchObject({
			requests: 1,
			retries: 1,
			noProgress: 1,
			estimatedCost: 0.12,
			reservedCost: 0.21,
			unpricedResponses: 1,
		});
		await writeFile(join(directory, "missing.txt"), "proof");
		await reopened.owner.handle(
			{ operation: "control-local", action: "resume", expectedPolicyRevision: 2, requestId: "resume" },
			context,
		);
		const controller = (await reopened.harness.snapshot(MissionExecutionDoc, context))!.current!.controller;
		await reopened.harness.waitForTask(controller, context);
		const after = (await reopened.owner.inspect(context)).runtime!;
		for (const key of [
			"cycles",
			"requests",
			"retries",
			"noProgress",
			"estimatedCost",
			"reservedCost",
			"unknownRequests",
			"unpricedResponses",
			"uncertainTools",
		] as const)
			expect(after[key]).toBe(before[key]);
		expect(after.status).toBe("completed");
		expect(reopened.faux.state.callCount).toBe(0);
	});
});
