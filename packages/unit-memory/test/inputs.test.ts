// Issue #5: Host input provenance remains atomic and local to its original conversation.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryInputEntry, MemoryInputsDoc, recordMemoryInput } from "../src/inputs.ts";
import { type SqliteFixture, sqliteFixture } from "./sqlite-fixture.ts";

const context = BACKGROUND_CONTEXT;
let fixture: SqliteFixture;

beforeEach(async () => {
	fixture = await sqliteFixture();
});
afterEach(async () => {
	await fixture.close();
});

describe("conversation input metadata", () => {
	it("persists human and mission queries with their immutable transcript provenance", async () => {
		const conversation = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		await fixture.session.commit(async (tx) => {
			const human = await tx.appendEntry(MemoryInputEntry, conversation.id, { data: { origin: "human" } });
			const humanSubmission = await tx.createSubmission({
				type: "input",
				conversationId: conversation.id,
				status: "placed",
				entry: human.id,
			});
			const mission = await tx.appendEntry(MemoryInputEntry, conversation.id, { data: { origin: "mission" } });
			const missionSubmission = await tx.createSubmission({
				type: "input",
				conversationId: conversation.id,
				status: "placed",
				entry: mission.id,
			});
			const inputs = await tx.doc(MemoryInputsDoc, conversation.id);
			inputs.inputs[humanSubmission.id] = { origin: "human", query: "testing preferences" };
			inputs.inputs[missionSubmission.id] = { origin: "mission", query: "verify release readiness" };
		}, context);
		const expected = await fixture.session.snapshot(MemoryInputsDoc, conversation.id, context);
		await fixture.reopen();
		expect(await fixture.session.snapshot(MemoryInputsDoc, conversation.id, context)).toEqual(expected);
		const entries = await fixture.session.commit(
			(tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 10),
			context,
		);
		expect(entries.items.filter(MemoryInputEntry.is).map((entry) => entry.data.origin)).toEqual(["human", "mission"]);
	});

	it("rolls input metadata back with the submission and transcript entry", async () => {
		const conversation = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		await expect(
			fixture.session.commit(async (tx) => {
				const entry = await tx.appendEntry(MemoryInputEntry, conversation.id, { data: { origin: "human" } });
				const submission = await tx.createSubmission({
					type: "input",
					conversationId: conversation.id,
					status: "placed",
					entry: entry.id,
					requestId: "rolled-back",
				});
				(await tx.doc(MemoryInputsDoc, conversation.id)).inputs[submission.id] = {
					origin: "human",
					query: "must not survive",
				};
				throw new Error("admission failed");
			}, context),
		).rejects.toThrow("admission failed");
		await fixture.reopen();
		expect(await fixture.session.snapshot(MemoryInputsDoc, conversation.id, context)).toBeUndefined();
		expect(await fixture.storage.submissionByRequest(conversation.id, "rolled-back", context)).toBeUndefined();
		const entries = await fixture.session.commit(
			(tx) => tx.scanEntries({ conversationId: conversation.id }, 10),
			context,
		);
		expect(entries.items).toHaveLength(0);
	});

	it("starts fork input metadata empty and isolates unrelated conversations", async () => {
		const parent = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const at = await fixture.session.commit(async (tx) => {
			(await tx.doc(MemoryInputsDoc, parent.id)).inputs.pending = { origin: "human", query: "parent only" };
			return tx.appendEntry(MemoryInputEntry, parent.id, { data: { origin: "human" } });
		}, context);
		const fork = await fixture.session.commit(
			(tx) => tx.forkConversation(parent.id, at.id, { ownership: { kind: "ownerless" } }),
			context,
		);
		const sibling = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		for (const conversation of [fork, sibling]) {
			expect(await fixture.session.snapshot(MemoryInputsDoc, conversation.id, context)).toBeUndefined();
			await fixture.session.commit(async (tx) => {
				const input = await tx.doc(MemoryInputsDoc, conversation.id);
				expect(input.inputs).toEqual({});
				input.inputs.own = { origin: "mission", query: `conversation ${conversation.id}` };
			}, context);
		}
		await fixture.reopen();
		expect(await fixture.session.snapshot(MemoryInputsDoc, parent.id, context)).toEqual({
			inputs: { pending: { origin: "human", query: "parent only" } },
		});
		expect((await fixture.session.snapshot(MemoryInputsDoc, fork.id, context))?.inputs.own.query).toBe(
			`conversation ${fork.id}`,
		);
	});
	// Issue #6: a deduplicated submission must never replace the first admission's provenance.
	it("preserves original admission metadata across retries and SQLite restart", async () => {
		const conversation = await fixture.session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const id = await fixture.session.commit(async (tx) => {
			const entry = await tx.appendEntry(MemoryInputEntry, conversation.id, { data: { origin: "human" } });
			const submission = await tx.createSubmission({
				type: "input",
				conversationId: conversation.id,
				status: "placed",
				entry: entry.id,
				requestId: "stable",
			});
			await recordMemoryInput(tx, conversation.id, submission.id, "human", "original query");
			return submission.id;
		}, context);
		await fixture.reopen();
		await fixture.session.commit(
			(tx) => recordMemoryInput(tx, conversation.id, id, "human", "original query"),
			context,
		);
		await expect(
			fixture.session.commit(
				(tx) => recordMemoryInput(tx, conversation.id, id, "mission", "replacement query"),
				context,
			),
		).rejects.toThrow("conflicts");
		expect((await fixture.session.snapshot(MemoryInputsDoc, conversation.id, context))?.inputs[id]).toEqual({
			origin: "human",
			query: "original query",
		});
	});
});
