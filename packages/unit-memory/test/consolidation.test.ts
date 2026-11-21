// Issue #9: summaries preserve source text, provenance and stable identities.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import {
	MEMORY_RELATIONS_PER_CONSOLIDATED,
	MemoryConsolidation,
	pendingMemories,
	relatedMemories,
	scheduleMemoryConsolidation,
	summarizeMemories,
} from "../src/consolidation.ts";
import { type LiveMemory, MemoryDoc } from "../src/memory.ts";
import { forgetMemory, rememberMemory } from "../src/operations.ts";

const context = BACKGROUND_CONTEXT;

async function openMemory(file: string, consolidation = MemoryConsolidation) {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "consolidation-checkpoints", tasks: [consolidation] }));
	return Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry }, context);
}

describe("extractive consolidation", () => {
	it("groups provenance and kinds, deduplicates exact text and bounds chunks", () => {
		const state = MemoryDoc.definition.initial!();
		for (let index = 0; index < 5; index++)
			rememberMemory(state, {
				writeKey: `${index}`,
				content: index < 2 ? "same" : "a".repeat(1800),
				now: index,
				kind: index === 4 ? "preference" : "fact",
				provenance: {
					origin: "user",
					conversationId: 1 as LiveMemory["provenance"]["conversationId"],
					entryIds: [],
					derivation: "explicit",
				},
			});
		const records = pendingMemories(state);
		const summaries = summarizeMemories(records);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]!.sources).toHaveLength(4);
		expect(summaries[0]!.content.match(/same/gu)).toHaveLength(1);
		for (const summary of summaries) expect(Array.from(summary.content).length).toBeLessThanOrEqual(3000);
		expect(summarizeMemories(records)).toEqual(summaries);
	});
});

describe("cross-conversation relation candidates", () => {
	function note(
		state: ReturnType<typeof MemoryDoc.definition.initial>,
		key: string,
		conversation: number,
		content: string,
	) {
		return rememberMemory(state, {
			writeKey: key,
			content,
			now: 0,
			provenance: {
				origin: "user",
				conversationId: conversation as LiveMemory["provenance"]["conversationId"],
				entryIds: [],
				derivation: "explicit",
			},
		});
	}

	it("pairs lexically related memories of other conversations only, best first and bounded", () => {
		const state = MemoryDoc.definition.initial();
		const deploy = note(state, "deploy", 1, "Deploy the web app to fly.io from main");
		const sameConversation = note(state, "same", 1, "deploy web app fly.io nightly");
		// Related but displaced by the closer copies below.
		note(state, "other", 2, "The web app deploys to fly.io");
		const weak = note(state, "weak", 3, "The web looks nice");
		const unrelated = note(state, "unrelated", 4, "I prefer tabs over spaces");
		for (let index = 0; index < MEMORY_RELATIONS_PER_CONSOLIDATED + 1; index++)
			note(state, `copy-${index}`, 10 + index, `Deploy the web app to fly.io from main ${index}`);
		const pairs = relatedMemories(state, [state.records[deploy] as LiveMemory]);
		expect(pairs).toHaveLength(MEMORY_RELATIONS_PER_CONSOLIDATED);
		for (const pair of pairs) {
			expect(pair.from).toEqual({ id: deploy, revision: 1 });
			expect([sameConversation, weak, unrelated]).not.toContain(pair.to.id);
		}
		expect(pairs.map((pair) => pair.to.id)).toEqual(["memory:copy-0", "memory:copy-1", "memory:copy-2"]);
		const only = MemoryDoc.definition.initial();
		const a = note(only, "a", 1, "Deploy the web app to fly.io from main");
		const b = note(only, "b", 2, "The web app deploys to fly.io");
		const both = relatedMemories(only, pendingMemories(only));
		expect(both).toEqual([{ from: { id: a, revision: 1 }, to: { id: b, revision: 1 } }]);
		expect(relatedMemories(only, pendingMemories(only))).toEqual(both);
	});
});

describe("durable consolidation checkpoints", () => {
	it("publishes a new batch in three phases without a validation-only checkpoint", async () => {
		// #50: count persisted task work as well as the phase calls; less code must not hide extra commits.
		const directory = await mkdtemp(join(tmpdir(), "unit-consolidation-phases-"));
		const phases: string[] = [];
		const original = MemoryConsolidation.definition.phases;
		const observed = defineTask({
			...MemoryConsolidation.definition,
			phases: {
				select: async (...args) => {
					phases.push("select");
					await original.select(...args);
				},
				summarize: async (...args) => {
					phases.push("summarize");
					await original.summarize(...args);
				},
				publish: async (...args) => {
					phases.push("publish");
					await original.publish(...args);
				},
			},
		});
		const harness = await openMemory(join(directory, "memory.sqlite"), observed);
		try {
			const root = await harness.root(context);
			const now = Date.now() - 13 * 60 * 60 * 1000;
			const taskId = await root.commit(async (tx) => {
				rememberMemory(await tx.doc(MemoryDoc), {
					writeKey: "phase-count",
					content: "one aged statement",
					now,
					provenance: { origin: "user", conversationId: root.id, entryIds: [], derivation: "explicit" },
				});
				return (await scheduleMemoryConsolidation(tx, root.id, Date.now()))!;
			}, context);
			let taskCommits = 0;
			const commits = harness.observeCommits({
				advance(publication) {
					for (const change of publication.changes)
						if (change.type === "task" && change.value.id === taskId) taskCommits++;
				},
				end() {},
			});
			try {
				expect((await harness.waitForTask(taskId, context)).state.outcome.status).toBe("completed");
			} finally {
				commits.detach();
			}
			expect({ phases, taskCommits }).toEqual({ phases: ["select", "publish", "select"], taskCommits: 4 });
			const memory = (await harness.snapshot(MemoryDoc, context))!;
			expect(memory.consolidation).toEqual({ state: "idle" });
			const source = memory.records["memory:phase-count"]!;
			expect(source).toMatchObject({ state: "live", revision: 1, createdAt: now, updatedAt: now });
			const summaries = Object.values(memory.records).filter(
				(record) => record.state === "live" && record.tier.kind === "episodic",
			);
			expect(summaries).toHaveLength(1);
			expect(summaries[0]).toMatchObject({ content: "[memory:phase-count] one aged statement" });
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("resumes the directly selected publish checkpoint after the owner closes", async () => {
		// #50: graceful shutdown must retain new work at the same released publish checkpoint shape.
		const directory = await mkdtemp(join(tmpdir(), "unit-consolidation-close-"));
		const file = join(directory, "memory.sqlite");
		const publishing = Promise.withResolvers<void>();
		const paused = defineTask({
			...MemoryConsolidation.definition,
			phases: {
				...MemoryConsolidation.definition.phases,
				publish: async (_task, runtime) => {
					publishing.resolve();
					await new Promise<void>((resolve) =>
						runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
					runtime.signal.throwIfAborted();
				},
			},
		});
		let harness = await openMemory(file, paused);
		try {
			const root = await harness.root(context);
			const id = await root.commit(async (tx) => {
				rememberMemory(await tx.doc(MemoryDoc), {
					writeKey: "close-resume",
					content: "pending publication",
					now: Date.now() - 13 * 60 * 60 * 1000,
					provenance: { origin: "user", conversationId: root.id, entryIds: [], derivation: "explicit" },
				});
				return (await scheduleMemoryConsolidation(tx, root.id, Date.now()))!;
			}, context);
			harness.resume();
			await publishing.promise;
			await harness.close(context);
			harness = await openMemory(file);
			expect((await harness.getTask(id, context))?.state).toMatchObject({
				status: "pending",
				checkpoint: { phase: "publish", sources: [{ id: "memory:close-resume", revision: 1 }] },
			});
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
			const memory = (await harness.snapshot(MemoryDoc, context))!;
			expect(Object.values(memory.records).filter((record) => record.state === "live")).toHaveLength(2);
			expect(memory.consolidation).toEqual({ state: "idle" });
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["summarize", "publish"] as const)("reopens a persisted %s checkpoint", async (phase) => {
		// #50: keep released version-one task states readable even though new batches skip summarize.
		const directory = await mkdtemp(join(tmpdir(), "unit-consolidation-legacy-"));
		const file = join(directory, "memory.sqlite");
		const sourceId = "memory:legacy";
		const seeded = defineTask({
			...MemoryConsolidation.definition,
			initial: (): ReturnType<typeof MemoryConsolidation.definition.initial> => ({
				phase,
				sources: [{ id: sourceId, revision: 1 }],
			}),
		});
		let harness = await openMemory(file, seeded);
		try {
			const root = await harness.root(context);
			const id = await root.commit(async (tx) => {
				const memory = await tx.doc(MemoryDoc);
				rememberMemory(memory, {
					writeKey: "legacy",
					content: "persisted source",
					now: Date.now() - 13 * 60 * 60 * 1000,
					provenance: { origin: "user", conversationId: root.id, entryIds: [], derivation: "explicit" },
				});
				const taskId = await tx.createTask(seeded, null, {
					conversationId: root.id,
					ownership: { kind: "conversation" },
					background: true,
				});
				memory.consolidation = { state: "scheduled", taskId };
				return taskId;
			}, context);
			await harness.close(context);
			harness = await openMemory(file);
			expect((await harness.getTask(id, context))?.state).toMatchObject({
				status: "pending",
				checkpoint: { phase, sources: [{ id: sourceId, revision: 1 }] },
			});
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
			const memory = (await harness.snapshot(MemoryDoc, context))!;
			expect(Object.values(memory.records).filter((record) => record.state === "live")).toHaveLength(2);
			expect(memory.consolidation).toEqual({ state: "idle" });
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["forget", "change"] as const)(
		"rechecks a source that changes after the publication snapshot: %s",
		async (mutation) => {
			// #50: removing the earlier phase must not replace the atomic source validation with a stale snapshot.
			const directory = await mkdtemp(join(tmpdir(), "unit-consolidation-atomic-"));
			const sourceId = "memory:atomic-race";
			let interleaved = false;
			let harness: Harness;
			const observed = defineTask({
				...MemoryConsolidation.definition,
				phases: {
					...MemoryConsolidation.definition.phases,
					publish: async (task, runtime, ctx) => {
						const commit: typeof runtime.commit = async (...args) => {
							if (!interleaved) {
								interleaved = true;
								await harness.commit(async (tx) => {
									const memory = await tx.doc(MemoryDoc);
									if (mutation === "forget") forgetMemory(memory, { writeKey: "atomic-forget", id: sourceId });
									else {
										const source = memory.records[sourceId]!;
										if (source.state !== "live") throw new Error("Expected a live race fixture.");
										source.content = "changed before publication";
										source.revision++;
										memory.revision++;
									}
								}, context);
							}
							return runtime.commit(...args);
						};
						const boundary = new Proxy(runtime, {
							get(target, key) {
								if (key === "commit") return commit;
								const value: unknown = Reflect.get(target, key, target);
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
						await MemoryConsolidation.definition.phases.publish(task, boundary, ctx);
					},
				},
			});
			harness = await openMemory(join(directory, "memory.sqlite"), observed);
			try {
				const root = await harness.root(context);
				const id = await root.commit(async (tx) => {
					rememberMemory(await tx.doc(MemoryDoc), {
						writeKey: "atomic-race",
						content: "original statement",
						now: Date.now() - 13 * 60 * 60 * 1000,
						provenance: { origin: "user", conversationId: root.id, entryIds: [], derivation: "explicit" },
					});
					return (await scheduleMemoryConsolidation(tx, root.id, Date.now()))!;
				}, context);
				expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
				expect(interleaved).toBe(true);
				const memory = (await harness.snapshot(MemoryDoc, context))!;
				const summaries = Object.values(memory.records).filter(
					(record) => record.state === "live" && record.tier.kind === "episodic",
				);
				if (mutation === "forget") {
					expect(memory.records[sourceId]!.state).toBe("forgotten");
					expect(summaries).toEqual([]);
				} else {
					expect(summaries).toHaveLength(1);
					expect(summaries[0]).toMatchObject({
						content: `[${sourceId}] changed before publication`,
						tier: { summaryOf: [{ id: sourceId, revision: 2 }] },
					});
				}
				expect(memory.consolidation).toEqual({ state: "idle" });
			} finally {
				await harness.close(context);
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("relates memories across conversations while each summary keeps one conversation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-consolidation-relations-"));
		const harness = await openMemory(join(directory, "memory.sqlite"));
		try {
			const root = await harness.root(context);
			const now = Date.now() - 13 * 60 * 60 * 1000;
			const taskId = await root.commit(async (tx) => {
				const second = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const memory = await tx.doc(MemoryDoc);
				for (const [key, conversationId, content] of [
					["first", root.id, "The staging database runs Postgres 17"],
					["second", second.id, "Postgres 17 staging database needs a vacuum"],
				] as const)
					rememberMemory(memory, {
						writeKey: key,
						content,
						now,
						provenance: { origin: "user", conversationId, entryIds: [], derivation: "explicit" },
					});
				return (await scheduleMemoryConsolidation(tx, root.id, Date.now()))!;
			}, context);
			harness.resume();
			expect((await harness.waitForTask(taskId, context)).state.outcome.status).toBe("completed");
			const memory = (await harness.snapshot(MemoryDoc, context))!;
			const summaries = Object.values(memory.records).filter(
				(record): record is LiveMemory => record.state === "live" && record.tier.kind === "episodic",
			);
			expect(summaries).toHaveLength(2);
			for (const summary of summaries) expect(summary.tier).toMatchObject({ summaryOf: [expect.anything()] });
			expect(Object.values(memory.relations)).toEqual([
				expect.objectContaining({
					kind: "relates",
					from: { id: "memory:first", revision: 1 },
					to: { id: "memory:second", revision: 1 },
					provenance: { derivation: "consolidation", taskId },
				}),
			]);
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
