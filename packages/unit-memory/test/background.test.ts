// Issues #7/#9: real SQLite tasks survive paused maintenance and reopen without extra writes.
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import {
	createMemoryBackground,
	isMemoryBackgroundTask,
	MemoryCapture,
	MemoryCaptureDispatcher,
	MemoryConsolidation,
	reconcileMemoryTasks,
	scheduleMemoryConsolidation,
} from "../src/background.ts";
import { MemoryDoc } from "../src/memory.ts";
import { forgetMemory, rememberMemory } from "../src/operations.ts";

const context = BACKGROUND_CONTEXT;

describe("durable background memory", () => {
	it("recovers a committed page after SIGKILL without losing its cursor or replay receipts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-memory-crash-"));
		const file = join(directory, "memory.sqlite");
		const script = join(directory, "capture-crash.mjs");
		await writeFile(
			script,
			`
import { BACKGROUND_CONTEXT as context } from ${JSON.stringify(new URL("../../chord/src/context/index.ts", import.meta.url).href)};
import { createModels } from ${JSON.stringify(new URL("../../ai/src/models.ts", import.meta.url).href)};
import { createRegistry, defineExtension, defineTask, Harness } from ${JSON.stringify(new URL("../../durable/src/index.ts", import.meta.url).href)};
import { openNodeSqliteStorage } from ${JSON.stringify(new URL("../../durable/src/storage/sqlite/node.ts", import.meta.url).href)};
import { MemoryCapture } from ${JSON.stringify(new URL("../src/capture.ts", import.meta.url).href)};
import { MemoryConsolidation } from ${JSON.stringify(new URL("../src/consolidation.ts", import.meta.url).href)};
import { MemoryDoc } from ${JSON.stringify(new URL("../src/memory.ts", import.meta.url).href)};
const registry = createRegistry();
const capture = defineTask({ ...MemoryCapture.definition, phases: { capture: async (task, runtime, ctx) => {
  await MemoryCapture.definition.phases.capture(task, runtime, ctx);
  process.send({ taskId: task.id });
  await new Promise(() => {});
} } });
registry.install(defineExtension({ name: "crash-capture", tasks: [capture, MemoryConsolidation] }));
const harness = await Harness.open(await openNodeSqliteStorage(process.argv[2]), { models: createModels(), registry }, context);
const root = await harness.root(context);
await root.commit(async (tx) => {
  const first = await tx.appendEntry(root.id, { kind: "unit.input", data: { origin: "human" }, model: [{ role: "user", content: "remember before crash", timestamp: 1 }] });
  for (let i = 0; i < 100; i++) await tx.appendEntry(root.id, { kind: "noise" });
  const last = await tx.appendEntry(root.id, { kind: "unit.input", data: { origin: "human" }, model: [{ role: "user", content: "remember after crash", timestamp: 2 }] });
  const id = await tx.createTask(MemoryCapture, { first: first.id, answer: last.id, last: last.id, generationTaskId: 1002, conversationId: root.id }, { ownership: { kind: "conversation" }, background: true });
  (await tx.doc(MemoryDoc)).captures[1002] = { taskId: id, outcome: { state: "pending" } };
}, context);
harness.resume();
setInterval(() => {}, 1000);
`,
		);
		const child = fork(script, [file], {
			execArgv: ["--conditions=source", "--experimental-strip-types"],
			silent: true,
		});
		let errors = "";
		child.stderr?.on("data", (data: Buffer) => {
			errors += data.toString();
		});
		let harness: Harness | undefined;
		try {
			const id = await new Promise<TaskId>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", (code, signal) =>
					reject(new Error(`Capture child exited before checkpoint: ${code}/${signal}: ${errors}`)),
				);
				child.once("message", (message) => {
					// Process IPC is a trust boundary; the crash marker carries only the branded numeric task identity.
					if (
						typeof message !== "object" ||
						message === null ||
						!("taskId" in message) ||
						typeof message.taskId !== "number"
					)
						reject(new Error("Invalid child checkpoint marker"));
					else resolve(message.taskId as TaskId);
				});
			});
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			expect((await exited)[1]).toBe("SIGKILL");
			const registry = createRegistry();
			registry.install(defineExtension({ name: "recovered-capture", tasks: createMemoryBackground().tasks }));
			harness = await Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry }, context);
			const pending = (await harness.snapshot(MemoryDoc, context))!;
			expect(Object.keys(pending.records)).toHaveLength(1);
			expect(Object.keys(pending.receipts)).toHaveLength(1);
			const record = await (await harness.root(context)).commit((tx) => tx.task(id), context);
			expect(record?.state).toMatchObject({
				status: "pending",
				checkpoint: { phase: "capture", cursor: expect.any(Object) },
			});
			await harness.waitForTask(id, context);
			const completed = (await harness.snapshot(MemoryDoc, context))!;
			expect(Object.keys(completed.records)).toHaveLength(2);
			expect(Object.keys(completed.receipts)).toHaveLength(2);
			expect(completed.captures[1002]!.outcome.state).toBe("completed");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);

	it("resumes a published page checkpoint after close without duplicate memories", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-memory-page-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("Foreground answer while capture remains blocked.")]);
		let published!: () => void;
		const firstPage = new Promise<void>((resolve) => {
			published = resolve;
		});
		let interrupt = true;
		const capture = defineTask({
			...MemoryCapture.definition,
			phases: {
				capture: async (task, runtime, ctx) => {
					await MemoryCapture.definition.phases.capture(task, runtime, ctx);
					if (interrupt) {
						interrupt = false;
						published();
						await new Promise<void>((resolve) => {
							runtime.signal.addEventListener("abort", () => resolve(), { once: true });
						});
					}
				},
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test-page", tasks: [capture, MemoryConsolidation] }));
		const open = async () =>
			Harness.open(await openNodeSqliteStorage(join(directory, "memory.sqlite")), { models, registry }, context);
		let harness = await open();
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const id = await root.commit(async (tx) => {
				const first = await tx.appendEntry(root.id, {
					kind: "unit.input",
					data: { origin: "human" },
					model: [{ role: "user", content: "remember first page", timestamp: 1 }],
				});
				for (let i = 0; i < 100; i++) await tx.appendEntry(root.id, { kind: "noise" });
				const last = await tx.appendEntry(root.id, {
					kind: "unit.input",
					data: { origin: "human" },
					model: [{ role: "user", content: "remember final page", timestamp: 2 }],
				});
				const generationTaskId = 1001 as Parameters<typeof tx.task>[0];
				const id = await tx.createTask(
					MemoryCapture,
					{ first: first.id, answer: last.id, last: last.id, generationTaskId, conversationId: root.id },
					{ ownership: { kind: "conversation" }, background: true },
				);
				(await tx.doc(MemoryDoc)).captures[generationTaskId] = { taskId: id, outcome: { state: "pending" } };
				return id;
			}, context);
			harness.resume();
			await firstPage;
			expect(Object.keys((await harness.snapshot(MemoryDoc, context))!.records)).toHaveLength(1);
			// The task remains blocked until close, while ordinary input still gets its response.
			await (await root.submit({ type: "input", content: "What is your status?" }, context)).wait(context);
			expect(faux.getPendingResponseCount()).toBe(0);
			await harness.close(context);
			harness = await open();
			expect(Object.keys((await harness.snapshot(MemoryDoc, context))!.records)).toHaveLength(1);
			await harness.waitForTask(id, context);
			const state = (await harness.snapshot(MemoryDoc, context))!;
			expect(Object.keys(state.records)).toHaveLength(2);
			expect(Object.values(state.receipts)).toHaveLength(2);
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("preserves pending capture through closed and inhibited candidates before resuming", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-memory-pending-"));
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test-pending", tasks: createMemoryBackground().tasks }));
		const open = async () =>
			Harness.open(
				await openNodeSqliteStorage(join(directory, "memory.sqlite")),
				{ models: createModels(), registry },
				context,
			);
		let harness = await open();
		try {
			const root = await harness.root(context);
			const id = await root.commit(async (tx) => {
				const entry = await tx.appendEntry(root.id, {
					kind: "unit.input",
					data: { origin: "human" },
					model: [
						{
							role: "user",
							content:
								"````typescript\n```\nremember code after short close\n```` trailing\nI prefer code after invalid close.\n~~~~\nremember code after wrong delimiter\n````\nremember preserved pending capture",
							timestamp: 1,
						},
					],
				});
				const generationTaskId = 1000 as Parameters<typeof tx.task>[0];
				const id = await tx.createTask(
					MemoryCapture,
					{ first: entry.id, answer: entry.id, last: entry.id, generationTaskId, conversationId: root.id },
					{ ownership: { kind: "conversation" }, background: true },
				);
				const memory = await tx.doc(MemoryDoc);
				memory.captures[generationTaskId] = { taskId: id, outcome: { state: "pending" } };
				memory.revision++;
				return id;
			}, context);
			const before = await harness.snapshot(MemoryDoc, context);
			await harness.close(context);
			harness = await open();
			expect(await harness.snapshot(MemoryDoc, context)).toEqual(before);
			await harness.close(context);
			harness = await open();
			expect(await harness.snapshot(MemoryDoc, context)).toEqual(before);
			await harness.waitForTask(id, context);
			expect(Object.values((await harness.snapshot(MemoryDoc, context))!.records)).toHaveLength(1);
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("publishes aged statements without altering source revisions or timestamps", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-memory-publish-"));
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test-publish", tasks: createMemoryBackground().tasks }));
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "memory.sqlite")),
			{ models: createModels(), registry },
			context,
		);
		try {
			const root = await harness.root(context);
			const now = Date.now() - 13 * 60 * 60 * 1000;
			const id = await root.commit(async (tx) => {
				const state = await tx.doc(MemoryDoc);
				for (let index = 0; index < 2; index++)
					rememberMemory(state, {
						writeKey: `aged-${index}`,
						content: `statement ${index}`,
						now,
						provenance: { origin: "user", conversationId: root.id, entryIds: [], derivation: "explicit" },
					});
				return (await scheduleMemoryConsolidation(tx, root.id, Date.now()))!;
			}, context);
			await harness.waitForTask(id, context);
			const state = (await harness.snapshot(MemoryDoc, context))!;
			const records = Object.values(state.records).filter((record) => record.state === "live");
			expect(records.filter((record) => record.tier.kind === "episodic")).toHaveLength(1);
			for (const record of records.filter((record) => record.tier.kind === "working")) {
				expect(record.revision).toBe(1);
				expect(record.updatedAt).toBe(now);
				expect(record.tier).toMatchObject({ consolidation: { state: "done" } });
			}
			expect(state.consolidation).toEqual({ state: "idle" });
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects stale publication after forget and never resurrects its selected source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-memory-race-"));
		let selected!: () => void;
		let release!: () => void;
		const reachedPublish = new Promise<void>((resolve) => {
			selected = resolve;
		});
		const canPublish = new Promise<void>((resolve) => {
			release = resolve;
		});
		const task = defineTask({
			...MemoryConsolidation.definition,
			phases: {
				...MemoryConsolidation.definition.phases,
				publish: async (current, runtime, ctx) => {
					selected();
					await canPublish;
					await MemoryConsolidation.definition.phases.publish(current, runtime, ctx);
				},
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test-race", tasks: [task] }));
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "memory.sqlite")),
			{ models: createModels(), registry },
			context,
		);
		try {
			const root = await harness.root(context);
			const { id, sourceId } = await root.commit(async (tx) => {
				const state = await tx.doc(MemoryDoc);
				const sourceId = rememberMemory(state, {
					writeKey: "race",
					content: "private original",
					now: Date.now() - 13 * 60 * 60 * 1000,
					provenance: { origin: "user", conversationId: root.id, entryIds: [], derivation: "explicit" },
				});
				return { id: (await scheduleMemoryConsolidation(tx, root.id, Date.now()))!, sourceId };
			}, context);
			const completed = harness.waitForTask(id, context);
			await reachedPublish;
			const checkpoint = await root.commit((tx) => tx.task(id), context);
			expect(JSON.stringify(checkpoint)).not.toContain("private original");
			await root.commit(async (tx) => {
				forgetMemory(await tx.doc(MemoryDoc), { writeKey: "forget-race", id: sourceId });
			}, context);
			release();
			await completed;
			const state = (await harness.snapshot(MemoryDoc, context))!;
			expect(state.records[sourceId]!.state).toBe("forgotten");
			expect(Object.values(state.records).filter((record) => record.state === "live")).toEqual([]);
			expect(state.consolidation).toEqual({ state: "idle" });
		} finally {
			release();
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("dispatches once, pages human history, preserves pending tasks while inhibited, and reopens sleeping work", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-memory-background-"));
		const file = join(directory, "memory.sqlite");
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test-memory", tasks: createMemoryBackground().tasks }));
		const open = async () =>
			Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry }, context);
		let harness = await open();
		try {
			const root = await harness.root(context);
			const dispatched = await root.commit(async (tx) => {
				const first = await tx.appendEntry(root.id, {
					kind: "unit.input",
					data: { origin: "human" },
					model: [{ role: "user", content: "remember that SQLite survives restart", timestamp: 1 }],
				});
				for (let index = 0; index < 105; index++) await tx.appendEntry(root.id, { kind: "noise" });
				const last = await tx.appendEntry(root.id, {
					kind: "unit.input",
					data: { origin: "human" },
					model: [{ role: "user", content: "I prefer dark terminals.", timestamp: 2 }],
				});
				const generationTaskId = 999 as Parameters<typeof tx.task>[0];
				const input = {
					first: first.id,
					answer: last.id,
					last: last.id,
					conversationId: root.id,
					generationTaskId,
				};
				const id = await tx.createTask(MemoryCaptureDispatcher, input, { ownership: { kind: "conversation" } });
				return { id, input };
			}, context);
			await harness.close(context);
			harness = await open();
			// Opening an inhibited update candidate never starts pending capture work.
			expect(await harness.snapshot(MemoryDoc, context)).toBeUndefined();
			await harness.close(context);
			harness = await open();
			await harness.waitForTask(dispatched.id, context);
			const capture = (await harness.snapshot(MemoryDoc, context))!.captures[dispatched.input.generationTaskId]!;
			await harness.waitForTask(capture.taskId, context);
			const state = (await harness.snapshot(MemoryDoc, context))!;
			expect(state.captures[dispatched.input.generationTaskId]!.outcome.state).toBe("completed");
			expect(
				Object.values(state.records)
					.filter((record) => record.state === "live")
					.map((record) => record.content),
			).toEqual(["SQLite survives restart", "I prefer dark terminals."]);
			expect(state.consolidation.state).toBe("scheduled");
			const duplicate = await (await harness.root(context)).commit(
				(tx) => tx.createTask(MemoryCaptureDispatcher, dispatched.input, { ownership: { kind: "conversation" } }),
				context,
			);
			await harness.waitForTask(duplicate, context);
			expect((await harness.snapshot(MemoryDoc, context))!.captures[dispatched.input.generationTaskId]!.taskId).toBe(
				capture.taskId,
			);
			await harness.close(context);
			harness = await open();
			expect((await harness.snapshot(MemoryDoc, context))!.records).toEqual(state.records);
			const next = await (await harness.root(context)).commit(
				(tx) => reconcileMemoryTasks(tx, root.id, Date.now()),
				context,
			);
			expect(next).toBe(state.consolidation.state === "scheduled" ? state.consolidation.taskId : undefined);
			const record = await (await harness.root(context)).commit((tx) => tx.task(next!), context);
			expect(record && isMemoryBackgroundTask(record)).toBe(true);
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
