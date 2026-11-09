// Issues #7/#8: mutation receipts and content-free forgetting survive real SQLite reopen.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { MemoryDoc } from "../src/memory.ts";
import { forgetMemory, memoryStats, rememberMemory } from "../src/operations.ts";
import { sqliteFixture } from "./sqlite-fixture.ts";

const context = BACKGROUND_CONTEXT;

describe("replay-safe memory mutations", () => {
	it("preserves remember identity and first forget result after restart without retaining content", async () => {
		const fixture = await sqliteFixture();
		try {
			const conversation = await fixture.session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const input = {
				writeKey: "remember:1",
				content: "private redis preference",
				now: 100,
				provenance: {
					origin: "user" as const,
					conversationId: conversation.id,
					entryIds: [],
					derivation: "explicit" as const,
				},
			};
			const id = await fixture.session.commit(async (tx) => rememberMemory(await tx.doc(MemoryDoc), input), context);
			await fixture.reopen();
			expect(
				await fixture.session.commit(async (tx) => rememberMemory(await tx.doc(MemoryDoc), input), context),
			).toBe(id);
			expect(
				await fixture.session.commit(
					async (tx) => forgetMemory(await tx.doc(MemoryDoc), { writeKey: "forget:1", id }),
					context,
				),
			).toBe(true);
			await fixture.reopen();
			expect(
				await fixture.session.commit(
					async (tx) => forgetMemory(await tx.doc(MemoryDoc), { writeKey: "forget:1", id }),
					context,
				),
			).toBe(true);
			expect(
				await fixture.session.commit(
					async (tx) => forgetMemory(await tx.doc(MemoryDoc), { writeKey: "forget:2", id }),
					context,
				),
			).toBe(false);
			expect(
				await fixture.session.commit(async (tx) => rememberMemory(await tx.doc(MemoryDoc), input), context),
			).toBe(id);
			const state = await fixture.session.snapshot(MemoryDoc, context);
			expect(state?.records[id]).toEqual({ state: "forgotten", id, revision: 2 });
			expect(JSON.stringify(state)).not.toContain("private redis preference");
			expect(memoryStats(state)).toMatchObject({ working: 0, tombstones: 1 });
		} finally {
			await fixture.close();
		}
	});
	it("rolls records and receipts back together and rejects invalid operator content", async () => {
		const fixture = await sqliteFixture();
		try {
			const conversation = await fixture.session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const input = {
				writeKey: "invalid",
				content: " ",
				now: 0,
				provenance: {
					origin: "agent" as const,
					conversationId: conversation.id,
					entryIds: [],
					derivation: "explicit" as const,
				},
			};
			await expect(
				fixture.session.commit(async (tx) => rememberMemory(await tx.doc(MemoryDoc), input), context),
			).rejects.toThrow("1–2000");
			expect(await fixture.session.snapshot(MemoryDoc, context)).toBeUndefined();
		} finally {
			await fixture.close();
		}
	});
	it("invalidates derived summaries in the same transaction as their source", async () => {
		const fixture = await sqliteFixture();
		try {
			const conversation = await fixture.session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const id = await fixture.session.commit(async (tx) => {
				const state = await tx.doc(MemoryDoc);
				const id = rememberMemory(state, {
					writeKey: "source",
					content: "redis secret",
					now: 0,
					provenance: { origin: "user", conversationId: conversation.id, entryIds: [], derivation: "explicit" },
				});
				const source = state.records[id];
				if (source.state !== "live") throw new Error("source absent");
				state.records.summary = {
					...source,
					id: "summary",
					content: "derived secret",
					tier: { kind: "episodic", summaryOf: [{ id, revision: 1 }] },
				};
				return id;
			}, context);
			await fixture.session.commit(async (tx) => {
				forgetMemory(await tx.doc(MemoryDoc), { writeKey: "forget", id });
			}, context);
			await fixture.reopen();
			const state = await fixture.session.snapshot(MemoryDoc, context);
			expect(state?.records.summary).toEqual({ state: "forgotten", id: "summary", revision: 2 });
			expect(JSON.stringify(state)).not.toContain("secret");
		} finally {
			await fixture.close();
		}
	});
});
