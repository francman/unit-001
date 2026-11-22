// Issue #5: Session memory persistence, atomicity, visibility, and version policy.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LiveMemory, MemoryDoc, type MemoryState } from "../src/memory.ts";
import { type SqliteFixture, sqliteFixture } from "./sqlite-fixture.ts";

const context = BACKGROUND_CONTEXT;
let fixture: SqliteFixture;

beforeEach(async () => {
	fixture = await sqliteFixture();
});
afterEach(async () => {
	await fixture.close();
});

describe("session memory document", () => {
	it("leaves absent memory absent and initializes each Session independently", async () => {
		expect(await fixture.session.snapshot(MemoryDoc, context)).toBeUndefined();
		await fixture.session.commit(async (tx) => {
			(await tx.doc(MemoryDoc)).revision = 1;
		}, context);
		const other = await sqliteFixture();
		try {
			await other.session.commit(async (tx) => {
				await tx.doc(MemoryDoc);
			}, context);
			expect(await other.session.snapshot(MemoryDoc, context)).toEqual({
				revision: 0,
				records: {},
				receipts: {},
				captures: {},
				consolidation: { state: "idle" },
			});
			expect((await fixture.session.snapshot(MemoryDoc, context))?.revision).toBe(1);
		} finally {
			await other.close();
		}
	});

	it("commits memory, receipts, and transcript bookkeeping atomically across reopen", async () => {
		const conversation = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		await expect(
			fixture.session.commit(async (tx) => {
				const memory = await tx.doc(MemoryDoc);
				memory.revision = 1;
				memory.receipts.write = { kind: "remember", memoryId: "lost" };
				await tx.appendEntry(conversation.id, { kind: "unit.memory.changed", data: { id: "lost" } });
				throw new Error("interrupted before commit");
			}, context),
		).rejects.toThrow("interrupted before commit");
		expect(await fixture.session.snapshot(MemoryDoc, context)).toBeUndefined();
		const empty = await fixture.session.commit(
			(tx) => tx.scanEntries({ conversationId: conversation.id }, 10),
			context,
		);
		expect(empty.items).toHaveLength(0);

		await fixture.session.commit(async (tx) => {
			const source = await tx.appendEntry(conversation.id, { kind: "unit.input", data: { origin: "human" } });
			const memory = await tx.doc(MemoryDoc);
			const record: LiveMemory = {
				state: "live",
				id: "preference-1",
				revision: 1,
				content: "I prefer SQLite.",
				kind: "preference",
				importance: 0.5,
				createdAt: 1_000,
				updatedAt: 1_000,
				provenance: {
					origin: "user",
					conversationId: conversation.id,
					entryIds: [source.id],
					derivation: "capture",
				},
				tier: { kind: "working", consolidation: { state: "pending" } },
			};
			memory.records[record.id] = record;
			memory.receipts.write = { kind: "remember", memoryId: record.id };
			memory.revision = 1;
			await tx.appendEntry(conversation.id, { kind: "unit.memory.changed", data: { id: record.id } });
		}, context);
		const expected = await fixture.session.snapshot(MemoryDoc, context);
		await fixture.reopen();
		expect(await fixture.session.snapshot(MemoryDoc, context)).toEqual(expected);
		const entries = await fixture.session.commit(
			(tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 10),
			context,
		);
		expect(entries.items.map((entry) => entry.kind)).toEqual(["unit.input", "unit.memory.changed"]);
	});

	it("shares current memory across conversations and forks without copying a historical value", async () => {
		const first = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const at = await fixture.session.commit(async (tx) => {
			(await tx.doc(MemoryDoc)).revision = 1;
			return tx.appendEntry(first.id, { kind: "marker" });
		}, context);
		const second = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		await fixture.session.commit(async (tx) => {
			(await tx.doc(MemoryDoc)).revision = 2;
			await tx.appendEntry(second.id, { kind: "marker" });
		}, context);
		const fork = await fixture.session.commit(
			(tx) => tx.forkConversation(first.id, at.id, { ownership: { kind: "ownerless" } }),
			context,
		);
		await fixture.session.commit(async (tx) => {
			const memory = await tx.doc(MemoryDoc);
			expect(memory.revision).toBe(2);
			memory.revision = 3;
			await tx.appendEntry(fork.id, { kind: "unit.memory.changed" });
		}, context);
		await fixture.reopen();
		expect((await fixture.session.snapshot(MemoryDoc, context))?.revision).toBe(3);
		const sessionDocs = await fixture.storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current" },
			10,
			undefined,
			context,
		);
		expect(sessionDocs.items.filter((doc) => doc.kind === MemoryDoc.definition.kind)).toHaveLength(1);
		for (const conversation of [first, second, fork]) {
			const docs = await fixture.storage.scanDocuments(
				{ scope: { kind: "conversation", conversationId: conversation.id }, at: "current" },
				10,
				undefined,
				context,
			);
			expect(docs.items.some((doc) => doc.kind === MemoryDoc.definition.kind)).toBe(false);
		}
	});

	it("persists content-free tombstones and scheduled task receipts with their task", async () => {
		const capture = defineTask<null, { phase: "capture" }, null>({
			name: "test.capture",
			version: 1,
			initial: () => ({ phase: "capture" }),
			phases: {
				capture: async (_task, runtime, ctx) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const conversation = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const taskId = await fixture.session.commit(async (tx) => {
			const id = await tx.createTask(capture, null, {
				ownership: { kind: "conversation" },
				conversationId: conversation.id,
				background: true,
			});
			const memory = await tx.doc(MemoryDoc);
			memory.records.old = { state: "forgotten", id: "old", revision: 2 };
			memory.receipts.forget = { kind: "forget", removed: true };
			memory.captures.run = { taskId: id, outcome: { state: "pending" } };
			memory.consolidation = { state: "scheduled", taskId: id };
			memory.revision = 1;
			return id;
		}, context);
		await fixture.reopen();
		const memory = await fixture.session.snapshot(MemoryDoc, context);
		expect(memory?.records.old).toEqual({ state: "forgotten", id: "old", revision: 2 });
		expect(memory?.captures.run).toEqual({ taskId, outcome: { state: "pending" } });
		expect((await fixture.storage.task(taskId, context))?.background).toBe(true);
	});

	it("bounds replay depth with a full base after 64 document changes", async () => {
		await fixture.session.commit(async (tx) => {
			await tx.doc(MemoryDoc);
		}, context);
		for (let revision = 1; revision <= 63; revision++) {
			await fixture.session.commit(async (tx) => {
				(await tx.doc(MemoryDoc)).revision = revision;
			}, context);
		}
		const address = await fixture.storage.findDocument(
			{ kind: MemoryDoc.definition.kind, scope: { kind: "session" } },
			"current",
			context,
		);
		expect(address).toBeDefined();
		expect((await fixture.storage.document(address!.id, "current", context))?.deltasSinceBase).toBe(63);
		await fixture.session.commit(async (tx) => {
			(await tx.doc(MemoryDoc)).revision = 64;
		}, context);
		await fixture.reopen();
		expect((await fixture.storage.document(address!.id, "current", context))?.deltasSinceBase).toBe(0);
		expect((await fixture.session.snapshot(MemoryDoc, context))?.revision).toBe(64);
	});

	it("stores session memory immediately even when progress deferral is requested", async () => {
		await fixture.session.commit(
			async (tx) => {
				(await tx.doc(MemoryDoc)).revision = 1;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: Number.POSITIVE_INFINITY } },
		);
		const record = await fixture.storage.findDocument(
			{ kind: MemoryDoc.definition.kind, scope: { kind: "session" } },
			"current",
			context,
		);
		expect(record).toBeDefined();
		expect((await fixture.storage.document(record!.id, "current", context))?.value.revision).toBe(1);
	});

	it("requires an explicit future migration and rejects a newer persisted version", async () => {
		await fixture.session.commit(async (tx) => {
			const memory = await tx.doc(MemoryDoc);
			memory.revision = 7;
			memory.records.old = { state: "forgotten", id: "old", revision: 2 };
		}, context);
		await fixture.reopen();
		const incompatible = defineDoc<MemoryState>({ ...MemoryDoc.definition, version: 2 });
		await expect(fixture.session.snapshot(incompatible, context)).rejects.toThrow(
			"requires migration from version 1",
		);
		const nextVersion = defineDoc<MemoryState>({
			...MemoryDoc.definition,
			version: 2,
			migrate: (value, fromVersion) => {
				expect(fromVersion).toBe(1);
				// The persisted fixture was written with the complete version-1 MemoryDoc above.
				return value as MemoryState;
			},
		});
		await fixture.session.commit(async (tx) => {
			const migrated = await tx.doc(nextVersion);
			expect(migrated.revision).toBe(7);
			migrated.revision = 8;
		}, context);
		await fixture.reopen();
		expect((await fixture.session.snapshot(nextVersion, context))?.records.old).toEqual({
			state: "forgotten",
			id: "old",
			revision: 2,
		});
		await expect(fixture.session.snapshot(MemoryDoc, context)).rejects.toThrow("newer version 2 than 1");
	});
});
