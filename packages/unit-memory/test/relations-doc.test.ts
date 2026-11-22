// Relations beside the v1 memory document: conversion of stored version-2 memory, pruning after older writers, atomicity.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LiveMemory, MemoryDoc, type MemoryState } from "../src/memory.ts";
import { forgetMemory, rememberMemory } from "../src/operations.ts";
import { type MemoryRelation, MemoryRelationsDoc, reconcileMemoryLayout } from "../src/relations-doc.ts";
import { type SqliteFixture, sqliteFixture } from "./sqlite-fixture.ts";

const context = BACKGROUND_CONTEXT;
let fixture: SqliteFixture;

beforeEach(async () => {
	fixture = await sqliteFixture();
});
afterEach(async () => {
	await fixture.close();
});

// The unreleased version-2 definition from edfa9d085, as builds of this branch wrote it before relations moved out.
const VersionTwoMemoryDoc = defineDoc<MemoryState & { relations: Record<string, MemoryRelation> }>({
	kind: "unit.memory",
	version: 2,
	scope: "session",
	initial: () => ({ ...MemoryDoc.definition.initial(), relations: {} }),
	migrate: (value) => ({ ...(value as MemoryState), relations: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});

const provenance = {
	origin: "user" as const,
	conversationId: 1 as ConversationId,
	entryIds: [],
	derivation: "explicit" as const,
};

function live(id: string, revision = 1): LiveMemory {
	return {
		state: "live",
		id,
		revision,
		content: `statement ${id}`,
		kind: "fact",
		importance: 0.5,
		createdAt: 1,
		updatedAt: 1,
		provenance,
		tier: { kind: "working", consolidation: { state: "pending" } },
	};
}

function relation(id: string, from: string, to: string, toRevision = 1): MemoryRelation {
	return {
		id,
		kind: "supports",
		from: { id: from, revision: 1 },
		to: { id: to, revision: toRevision },
		createdAt: 2,
		provenance: { derivation: "consolidation", taskId: 9 as TaskId },
	};
}

async function storedVersion(kind: string): Promise<number | undefined> {
	const record = await fixture.storage.findDocument({ kind, scope: { kind: "session" } }, "current", context);
	return record === undefined ? undefined : (await fixture.storage.document(record.id, "current", context))?.version;
}

describe("memory layout at owner open", () => {
	it("marks a new Session's layout with an empty relations document and leaves absent memory absent", async () => {
		await reconcileMemoryLayout(fixture.session, context);
		expect(await fixture.session.snapshot(MemoryDoc, context)).toBeUndefined();
		expect(await fixture.session.snapshot(MemoryRelationsDoc, context)).toEqual({ relations: {} });
	});

	it("keeps a version-1 memory document written by a published reader as stored", async () => {
		await fixture.session.commit(async (tx) => {
			const memory = await tx.doc(MemoryDoc);
			memory.records.a = live("a");
			memory.revision = 4;
		}, context);
		await fixture.reopen();
		await reconcileMemoryLayout(fixture.session, context);
		expect(await storedVersion("unit.memory")).toBe(1);
		expect(await fixture.session.snapshot(MemoryDoc, context)).toMatchObject({
			revision: 4,
			records: { a: live("a") },
		});
		expect(await fixture.session.snapshot(MemoryRelationsDoc, context)).toEqual({ relations: {} });
	});

	it("rewrites stored version-2 memory as version 1 plus the relations document, keeping every field", async () => {
		const links = { "relation:ab": relation("relation:ab", "a", "b") };
		await fixture.session.commit(async (tx) => {
			const memory = await tx.doc(VersionTwoMemoryDoc);
			memory.records.a = live("a");
			memory.records.b = live("b");
			memory.records.gone = { state: "forgotten", id: "gone", revision: 2 };
			memory.receipts.write = { kind: "remember", memoryId: "a" };
			memory.captures.run = { taskId: 4 as TaskId, outcome: { state: "pending" } };
			memory.consolidation = { state: "scheduled", taskId: 5 as TaskId };
			memory.relations = links;
			memory.revision = 11;
		}, context);
		await fixture.reopen();
		await expect(fixture.session.snapshot(MemoryDoc, context)).rejects.toThrow("newer version 2 than 1");

		await reconcileMemoryLayout(fixture.session, context);
		await fixture.reopen();
		expect(await storedVersion("unit.memory")).toBe(1);
		expect(await fixture.session.snapshot(MemoryDoc, context)).toEqual({
			revision: 11,
			records: { a: live("a"), b: live("b"), gone: { state: "forgotten", id: "gone", revision: 2 } },
			receipts: { write: { kind: "remember", memoryId: "a" } },
			captures: { run: { taskId: 4, outcome: { state: "pending" } } },
			consolidation: { state: "scheduled", taskId: 5 },
		});
		expect(await fixture.session.snapshot(MemoryRelationsDoc, context)).toEqual({ relations: links });
		// A second open finds the layout marked and changes nothing.
		await reconcileMemoryLayout(fixture.session, context);
		expect(await fixture.session.snapshot(MemoryRelationsDoc, context)).toEqual({ relations: links });
	});

	it("drops relations whose endpoint a relation-unaware writer forgot or changed, and keeps live ones", async () => {
		await fixture.session.commit(async (tx) => {
			const memory = await tx.doc(MemoryDoc);
			for (const id of ["a", "b", "c", "d", "e"]) memory.records[id] = live(id);
			(await tx.doc(MemoryRelationsDoc)).relations = {
				keep: relation("keep", "a", "b"),
				forgotten: relation("forgotten", "a", "c"),
				changed: relation("changed", "b", "d"),
				tombstoned: relation("tombstoned", "a", "e"),
			};
		}, context);
		// What the published 0.0.9 owner does: forget through the v1 document alone, never opening relations.
		await fixture.session.commit(async (tx) => {
			const memory = await tx.doc(MemoryDoc);
			memory.records.c = { state: "forgotten", id: "c", revision: 2 };
			memory.records.d = { ...live("d"), revision: 2 };
			// Liveness, not the revision alone: a tombstone that kept the pinned revision still ends the relation.
			memory.records.e = { state: "forgotten", id: "e", revision: 1 };
			memory.revision++;
		}, context);
		await fixture.reopen();
		await reconcileMemoryLayout(fixture.session, context);
		expect(Object.keys((await fixture.session.snapshot(MemoryRelationsDoc, context))!.relations)).toEqual(["keep"]);
	});

	it("writes nothing when every stored relation is still pinned", async () => {
		await fixture.session.commit(async (tx) => {
			const memory = await tx.doc(MemoryDoc);
			for (const id of ["a", "b"]) memory.records[id] = live(id);
			(await tx.doc(MemoryRelationsDoc)).relations = { keep: relation("keep", "a", "b") };
		}, context);
		const record = await fixture.storage.findDocument(
			{ kind: MemoryRelationsDoc.definition.kind, scope: { kind: "session" } },
			"current",
			context,
		);
		const before = await fixture.storage.document(record!.id, "current", context);
		await reconcileMemoryLayout(fixture.session, context);
		expect(await fixture.storage.document(record!.id, "current", context)).toEqual(before);
	});
});

describe("relations in the memory commit", () => {
	it("stores a memory and its named relations together or not at all", async () => {
		const target = await fixture.session.commit(
			async (tx) =>
				rememberMemory(await tx.doc(MemoryDoc), { writeKey: "target", content: "target", now: 1, provenance }),
			context,
		);
		await expect(
			fixture.session.commit(async (tx) => {
				rememberMemory(
					await tx.doc(MemoryDoc),
					{
						writeKey: "linked",
						content: "linked",
						now: 2,
						provenance,
						relations: [{ id: target, kind: "updates" }],
					},
					await tx.doc(MemoryRelationsDoc),
				);
				throw new Error("interrupted before commit");
			}, context),
		).rejects.toThrow("interrupted before commit");
		expect((await fixture.session.snapshot(MemoryDoc, context))?.records["memory:linked"]).toBeUndefined();
		expect(await fixture.session.snapshot(MemoryRelationsDoc, context)).toBeUndefined();

		await fixture.session.commit(async (tx) => {
			rememberMemory(
				await tx.doc(MemoryDoc),
				{ writeKey: "linked", content: "linked", now: 2, provenance, relations: [{ id: target, kind: "updates" }] },
				await tx.doc(MemoryRelationsDoc),
			);
		}, context);
		await fixture.session.commit(async (tx) => {
			forgetMemory(await tx.doc(MemoryDoc), { writeKey: "forget", id: target }, await tx.doc(MemoryRelationsDoc));
		}, context);
		await fixture.reopen();
		expect((await fixture.session.snapshot(MemoryDoc, context))?.records[target]?.state).toBe("forgotten");
		expect(await fixture.session.snapshot(MemoryRelationsDoc, context)).toEqual({ relations: {} });
	});
});
