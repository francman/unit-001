// Verifies mission ownership and deadline persistence without enabling autonomous execution.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineDoc,
	defineTask,
	Harness,
	type HarnessOptions,
	type Task,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activateMission,
	type MissionActivation,
	MissionDoc,
	MissionFoundation,
	type MissionRecord,
	type MissionState,
	requireMissionIdentity,
} from "../../src/missions/state.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-mission-"));
	now = 1_000;
});

afterEach(async () => {
	try {
		await Promise.all(opened.splice(0).map((harness) => harness.close(context)));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function closeHarness(harness: Harness): Promise<void> {
	await harness.close(context);
	opened.splice(opened.indexOf(harness), 1);
}

function activation(): MissionActivation {
	return {
		missionId: "inspect-repository",
		objective: "Inspect a repository and report cited evidence.",
		successCriteria: ["The report cites the inspected files."],
		policy: {
			allowedTools: ["read"],
			maxCycles: 3,
			maxRequests: 5,
			maxRetries: 1,
			maxConsecutiveNoProgress: 2,
			deadlineAt: 2_000,
		},
	};
}

async function launch(name = "session", options: Pick<HarnessOptions, "conversationCreated"> = {}) {
	const registry = createRegistry();
	registry.install(MissionFoundation);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, `${name}.sqlite`)),
		{ models, registry, now: () => now, setTimer: () => () => {}, ...options },
		context,
	);
	opened.push(harness);
	return { harness, faux };
}

async function waitForTaskState(harness: Harness, id: TaskId, status: "sleeping" | "terminal"): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await harness.getTask(id, context))?.state.status === status) return;
		await setImmediate();
	}
	throw new Error(`Mission holder did not reach ${status}.`);
}

describe("nonexecuting mission foundation", () => {
	it.each(["paused", "stopped"] as const)(
		"#14 migrates a version-one %s holder without changing identity or granting agreement",
		async (status) => {
			const first = await launch();
			const legacy = defineDoc<{ current: MissionRecord | null }>({
				kind: "unit.mission",
				version: 1,
				scope: "session",
				initial: () => ({ current: null }),
				checkpointWhen: () => true,
			});
			const before = await first.harness.commit(async (tx) => {
				const control = await tx.createConversation({ ownership: { kind: "ownerless" } });
				// The registered version-one holder has a null result; retain its exported branded identity in the fixture.
				const holder = MissionFoundation.tasks![0] as Task<
					{ missionId: string; policyRevision: number },
					{ phase: "hold" } | { phase: "deadline" },
					null,
					object
				>;
				const controllerTaskId = await tx.createTask(
					holder,
					{ missionId: "legacy-mission", policyRevision: 3 },
					{ conversationId: control.id, ownership: { kind: "conversation" }, background: true },
				);
				const execution = await tx.createConversation({ ownership: { kind: "task", taskId: controllerTaskId } });
				const record: MissionRecord = {
					...activation(),
					missionId: "legacy-mission",
					revision: 7,
					policyRevision: 3,
					controllerTaskId,
					controlConversationId: control.id,
					executionConversationId: execution.id,
					state: { status },
				};
				(await tx.doc(legacy)).current = record;
				return record;
			}, context);
			const task = await first.harness.getTask(before.controllerTaskId, context);
			await closeHarness(first.harness);
			const second = await launch();
			await second.harness.commit((tx) => tx.doc(MissionDoc), context);
			const migrated = (await second.harness.snapshot(MissionDoc, context))!;
			expect(migrated.current).toEqual(before);
			expect(await second.harness.getTask(before.controllerTaskId, context)).toEqual(task);
			expect(migrated.formation.agreement).toBeNull();
			expect(migrated.formation.draft).toMatchObject({
				missionId: before.missionId,
				status: "editing",
				terms: { objective: before.objective, policy: before.policy },
			});
			await expect(second.harness.snapshot(legacy, context)).rejects.toThrow("newer version");
			expect(second.faux.state.callCount).toBe(0);
		},
	);
	it("atomically stores mission ownership without admitting requests, tools, or submissions", async () => {
		// #15: activating the state foundation must not imply permission to execute a mission.
		const { harness, faux } = await launch();
		const identity = await activateMission(harness, activation(), context);
		harness.resume();
		await waitForTaskState(harness, identity.controllerTaskId, "sleeping");
		const current = (await harness.snapshot(MissionDoc, context))!.current!;
		expect(current.state).toEqual({ status: "waiting", reason: "execution_support" });
		expect(current.policyRevision).toBe(1);
		expect(current.revision).toBe(1);
		const task = await harness.getTask(identity.controllerTaskId, context);
		expect(task?.conversationId).toBe(current.controlConversationId);
		expect(task?.background).toBe(true);
		expect(task?.kind).toBe("unit.mission.hold");
		const execution = await harness.commit((tx) => tx.conversation(current.executionConversationId), context);
		expect(execution?.owner).toEqual({
			conversationId: current.controlConversationId,
			taskId: identity.controllerTaskId,
		});
		expect((await harness.inspect(context)).submissions).toEqual([]);
		expect(await harness.usage(context)).toEqual({ models: {}, tools: {} });
		expect(faux.state.callCount).toBe(0);
		for (const conversationId of [current.controlConversationId, current.executionConversationId]) {
			expect((await harness.commit((tx) => tx.scanEntries({ conversationId }, 100), context)).items).toEqual([]);
		}
	});

	it("rolls back document, task, and conversations when activation fails halfway", async () => {
		let conversations = 0;
		const { harness } = await launch("rollback", {
			conversationCreated: () => {
				if (++conversations === 2) throw new Error("creation interrupted");
			},
		});
		await expect(activateMission(harness, activation(), context)).rejects.toThrow("creation interrupted");
		expect(await harness.snapshot(MissionDoc, context)).toBeUndefined();
		expect((await harness.commit((tx) => tx.scanConversations({}, 100), context)).items).toEqual([]);
		expect((await harness.inspect(context)).tasks).toEqual([]);
	});

	it("serializes competing activations to one mission and one controller", async () => {
		const { harness } = await launch();
		const results = await Promise.allSettled([
			activateMission(harness, activation(), context),
			activateMission(harness, { ...activation(), missionId: "another" }, context),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await harness.inspect(context)).tasks).toHaveLength(1);
		expect((await harness.commit((tx) => tx.scanConversations({}, 100), context)).items).toHaveLength(2);
	});

	it("rejects stale policy or controller identity before committing a state mutation", async () => {
		const { harness } = await launch();
		const identity = await activateMission(harness, activation(), context);
		const otherController = defineTask<null, { phase: "done" }, null>({
			name: "unit.test.other-controller",
			version: 1,
			initial: () => ({ phase: "done" }),
			phases: {
				done: (_task, runtime, ctx) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
			},
			abort: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const current = (await harness.snapshot(MissionDoc, context))!.current!;
		const otherId = await harness.commit(
			(tx) =>
				tx.createTask(otherController, null, {
					conversationId: current.controlConversationId,
					ownership: { kind: "conversation" },
				}),
			context,
		);
		await expect(
			harness.commit((tx) => requireMissionIdentity(tx, { ...identity, controllerTaskId: otherId }), context),
		).rejects.toThrow("Stale mission");
		await harness.commit(async (tx) => {
			await requireMissionIdentity(tx, identity);
			const current = (await tx.doc(MissionDoc)).current!;
			current.policyRevision++;
			current.revision++;
			current.state = { status: "paused" };
		}, context);
		await expect(
			harness.commit(async (tx) => {
				(await tx.doc(MissionDoc)).current!.objective = "stale overwrite";
				await requireMissionIdentity(tx, identity);
			}, context),
		).rejects.toThrow("Stale mission");
		expect((await harness.snapshot(MissionDoc, context))!.current!.objective).toBe(activation().objective);
		await expect(
			harness.commit((tx) => requireMissionIdentity(tx, { ...identity, missionId: "replacement" }), context),
		).rejects.toThrow("Stale mission");
	});

	it("reopens the same identity and persisted sleep, then blocks at its deadline", async () => {
		const first = await launch();
		const identity = await activateMission(first.harness, activation(), context);
		first.harness.resume();
		await waitForTaskState(first.harness, identity.controllerTaskId, "sleeping");
		await closeHarness(first.harness);
		const second = await launch();
		expect((await second.harness.snapshot(MissionDoc, context))?.current?.controllerTaskId).toBe(
			identity.controllerTaskId,
		);
		expect((await second.harness.getTask(identity.controllerTaskId, context))?.state).toMatchObject({
			status: "sleeping",
			until: 2_000,
		});
		now = 2_000;
		second.harness.resume();
		await waitForTaskState(second.harness, identity.controllerTaskId, "terminal");
		expect((await second.harness.snapshot(MissionDoc, context))?.current?.state).toEqual({
			status: "blocked",
			reason: "deadline",
		});
		expect(second.faux.state.callCount).toBe(0);
	});

	it.each(["paused", "stopped", "policy", "replacement"] as const)(
		"deadline cannot overwrite %s state",
		async (change) => {
			const { harness } = await launch();
			const identity = await activateMission(harness, activation(), context);
			harness.resume();
			await waitForTaskState(harness, identity.controllerTaskId, "sleeping");
			await harness.commit(async (tx) => {
				const current = (await tx.doc(MissionDoc)).current!;
				if (change === "policy") current.policyRevision++;
				else if (change === "replacement") current.missionId = "replacement";
				else current.state = { status: change };
			}, context);
			const before = await harness.snapshot(MissionDoc, context);
			now = 2_000;
			harness.resume();
			await waitForTaskState(harness, identity.controllerTaskId, "terminal");
			expect(await harness.snapshot(MissionDoc, context)).toEqual(before);
		},
	);

	it("shares Session state with forks but isolates another SQLite Session", async () => {
		const { harness } = await launch();
		await activateMission(harness, activation(), context);
		const root = await harness.root(context);
		const entry = await root.commit((tx) => tx.appendEntry(root.id, { kind: "unit.test", data: null }), context);
		const fork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		expect(await fork.commit(async (tx) => (await tx.doc(MissionDoc)).current?.missionId, context)).toBe(
			activation().missionId,
		);
		const other = await launch("other");
		expect(await other.harness.snapshot(MissionDoc, context)).toBeUndefined();
	});

	it("refuses a newer persisted document version without discarding it", async () => {
		const first = await launch();
		const newer = defineDoc<MissionState>({ ...MissionDoc.definition, version: 3 });
		await first.harness.commit((tx) => tx.doc(newer), context);
		await closeHarness(first.harness);
		const second = await launch();
		await expect(second.harness.snapshot(MissionDoc, context)).rejects.toThrow("newer version");
	});

	it("requires an explicit persisted migration before a future schema can read version two", async () => {
		const first = await launch();
		await activateMission(first.harness, activation(), context);
		const before = await first.harness.snapshot(MissionDoc, context);
		await closeHarness(first.harness);
		const second = await launch();
		const noMigration = defineDoc<MissionState>({ ...MissionDoc.definition, version: 3, migrate: undefined });
		await expect(second.harness.snapshot(noMigration, context)).rejects.toThrow("requires migration");
		const future = defineDoc<MissionState & { migratedFrom: number }>({
			...MissionDoc.definition,
			version: 3,
			initial: () => ({
				current: null,
				formation: { nextRevision: 1, draft: null, agreement: null, lastOperation: null },
				migratedFrom: 3,
			}),
			migrate: (value, fromVersion) => ({
				// The fixture was written with the known version-two MissionDoc shape above.
				current: value.current as MissionRecord | null,
				formation: value.formation as MissionState["formation"],
				migratedFrom: fromVersion,
			}),
		});
		await second.harness.commit((tx) => tx.doc(future), context);
		await closeHarness(second.harness);
		const third = await launch();
		expect(await third.harness.snapshot(future, context)).toEqual({ ...before, migratedFrom: 2 });
		await expect(third.harness.snapshot(MissionDoc, context)).rejects.toThrow("newer version");
	});

	it.each([NaN, Infinity, 0, -1, 1.5])(
		"rejects invalid finite work limit %s before creating state",
		async (maxRequests) => {
			const { harness } = await launch();
			const input = activation();
			input.policy.maxRequests = maxRequests;
			await expect(activateMission(harness, input, context)).rejects.toThrow("positive integers");
			expect(await harness.snapshot(MissionDoc, context)).toBeUndefined();
			expect((await harness.inspect(context)).tasks).toEqual([]);
		},
	);

	it.each(["objective", "criteria", "retry", "deadline", "cost", "tools"] as const)(
		"rejects invalid %s policy input without state",
		async (invalid) => {
			const { harness } = await launch();
			const input = activation();
			if (invalid === "objective") input.objective = " ";
			else if (invalid === "criteria") input.successCriteria = [];
			else if (invalid === "retry") input.policy.maxRetries = -1;
			else if (invalid === "deadline") input.policy.deadlineAt = Infinity;
			else if (invalid === "cost") input.policy.maxEstimatedCost = NaN;
			else input.policy.allowedTools = [""];
			await expect(activateMission(harness, input, context)).rejects.toThrow();
			expect(await harness.snapshot(MissionDoc, context)).toBeUndefined();
		},
	);
});
