// Typed relations between memories: explicit writes, liveness, caps and removal on forget.
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { MemoryDoc, type MemoryState } from "../src/memory.ts";
import { forgetMemory, memoryStats, rememberMemory } from "../src/operations.ts";
import {
	addConsolidationRelations,
	isLiveRelation,
	MEMORY_RELATION_DEGREE_LIMIT,
	MEMORY_RELATION_LIMIT,
	type MemoryRelationRequest,
} from "../src/relations.ts";
import { MemoryRelationsDoc, type MemoryRelationsState } from "../src/relations-doc.ts";

// Plain values stand for the two documents one commit changes together.
type Store = MemoryState & { links: MemoryRelationsState };

function store(): Store {
	return { ...MemoryDoc.definition.initial(), links: MemoryRelationsDoc.definition.initial() };
}

function add(state: Store, key: string, conversation: number, relations?: MemoryRelationRequest[]): string {
	return rememberMemory(
		state,
		{
			writeKey: key,
			content: `statement ${key}`,
			now: 10,
			provenance: {
				origin: "agent",
				conversationId: conversation as ConversationId,
				entryIds: [],
				derivation: "explicit",
			},
			...(relations === undefined ? {} : { relations }),
		},
		state.links,
	);
}

function forget(state: Store, writeKey: string, id: string): boolean {
	return forgetMemory(state, { writeKey, id }, state.links);
}

describe("explicit relations from remember", () => {
	it("pins both endpoints, records provenance and is not repeated on replay", () => {
		const state = store();
		const old = add(state, "old", 1);
		const id = add(state, "new", 2, [{ id: old, kind: "contradicts" }]);
		const relations = Object.values(state.links.relations);
		expect(relations).toEqual([
			{
				id: expect.stringMatching(/^relation:[a-f0-9]{64}$/u),
				kind: "contradicts",
				from: { id, revision: 1 },
				to: { id: old, revision: 1 },
				createdAt: 10,
				provenance: { derivation: "explicit", origin: "agent", conversationId: 2, entryIds: [] },
			},
		]);
		expect(add(state, "new", 2, [{ id: old, kind: "contradicts" }])).toBe(id);
		expect(Object.keys(state.links.relations)).toHaveLength(1);
		expect(isLiveRelation(state, relations[0]!)).toBe(true);
	});

	it.each([
		["a forgotten target", [{ id: "memory:gone", kind: "relates" }], "is not live"],
		["an absent target", [{ id: "memory:none", kind: "relates" }], "is not live"],
		[
			"a duplicate target",
			[
				{ id: "memory:old", kind: "relates" },
				{ id: "memory:old", kind: "supports" },
			],
			"more than once",
		],
		["an unknown kind", [{ id: "memory:old", kind: "causes" }], "Unknown memory relation kind"],
		[
			"more than eight relations",
			Array.from({ length: 9 }, () => ({ id: "memory:old", kind: "relates" })),
			"at most 8",
		],
	])("rejects %s without writing the memory", (_name, relations, message) => {
		const state = store();
		add(state, "old", 1);
		add(state, "gone", 1);
		forget(state, "forget", "memory:gone");
		const revision = state.revision;
		expect(() => add(state, "new", 2, relations as MemoryRelationRequest[])).toThrow(message);
		expect(state.records["memory:new"]).toBeUndefined();
		expect(state.receipts.new).toBeUndefined();
		expect(state.revision).toBe(revision);
	});

	it("requires the relations document only when relations are named", () => {
		const state = store();
		const old = add(state, "old", 1);
		const provenance = {
			origin: "agent" as const,
			conversationId: 2 as ConversationId,
			entryIds: [],
			derivation: "explicit" as const,
		};
		expect(rememberMemory(state, { writeKey: "plain", content: "plain", now: 1, provenance })).toBe("memory:plain");
		expect(() =>
			rememberMemory(state, {
				writeKey: "linked",
				content: "linked",
				now: 1,
				provenance,
				relations: [{ id: old, kind: "relates" }],
			}),
		).toThrow("requires the relations document");
		expect(state.records["memory:linked"]).toBeUndefined();
	});

	it("rejects a target at the per-memory cap and a write past the Session cap", () => {
		const state = store();
		const hub = add(state, "hub", 1);
		for (let index = 0; index < MEMORY_RELATION_DEGREE_LIMIT; index++)
			add(state, `spoke-${index}`, 2, [{ id: hub, kind: "relates" }]);
		expect(() => add(state, "one-more", 2, [{ id: hub, kind: "relates" }])).toThrow(
			`already has ${MEMORY_RELATION_DEGREE_LIMIT} relations`,
		);
		const full = store();
		const target = add(full, "target", 1);
		for (let index = 0; index < MEMORY_RELATION_LIMIT; index++)
			full.links.relations[`relation:fill-${index}`] = {
				id: `relation:fill-${index}`,
				kind: "relates",
				from: { id: "memory:x", revision: 1 },
				to: { id: "memory:y", revision: 1 },
				createdAt: 0,
				provenance: { derivation: "consolidation", taskId: 1 as TaskId },
			};
		expect(() => add(full, "late", 2, [{ id: target, kind: "relates" }])).toThrow("relation limit reached");
	});
});

describe("relation liveness", () => {
	it("counts only live pinned relations, including consolidation, without a graph display cap", () => {
		expect(memoryStats(undefined, undefined).relations).toBe(0);
		const state = store();
		const a = add(state, "a", 1);
		const b = add(state, "b", 2, [{ id: a, kind: "supports" }]);
		const c = add(state, "c", 3);
		addConsolidationRelations(
			state,
			state.links,
			[{ from: { id: b, revision: 1 }, to: { id: c, revision: 1 } }],
			1 as TaskId,
			20,
		);
		expect(memoryStats(state, state.links).relations).toBe(2);
		const source = state.records[a]!;
		source.revision++;
		expect(memoryStats(state, state.links).relations).toBe(1);
		forget(state, "forget-c", c);
		expect(memoryStats(state, state.links).relations).toBe(0);
		for (let i = 0; i < 301; i++) {
			const target = add(state, `target-${i}`, 1);
			add(state, `related-${i}`, 2, [{ id: target, kind: "relates" }]);
		}
		expect(memoryStats(state, state.links).relations).toBe(301);
	});

	it("treats a relation pinned to another revision as stale", () => {
		const state = store();
		const old = add(state, "old", 1);
		add(state, "new", 2, [{ id: old, kind: "updates" }]);
		const relation = Object.values(state.links.relations)[0]!;
		expect(isLiveRelation(state, { ...relation, to: { id: old, revision: 2 } })).toBe(false);
	});

	it("removes relations touching a forgotten memory and its cascaded summaries", () => {
		const state = store();
		const a = add(state, "a", 1);
		const b = add(state, "b", 2, [{ id: a, kind: "supports" }]);
		const c = add(state, "c", 3);
		state.records["summary:s"] = {
			state: "live",
			id: "summary:s",
			revision: 1,
			content: "summary",
			kind: "fact",
			importance: 0.5,
			createdAt: 0,
			updatedAt: 0,
			provenance: { origin: "agent", conversationId: 3 as ConversationId, entryIds: [], derivation: "summary" },
			tier: { kind: "episodic", summaryOf: [{ id: c, revision: 1 }] },
		};
		add(state, "d", 2, [{ id: "summary:s", kind: "relates" }]);
		expect(Object.keys(state.links.relations)).toHaveLength(2);
		forget(state, "forget-c", c);
		expect(Object.values(state.links.relations).map((relation) => [relation.from.id, relation.to.id])).toEqual([
			[b, a],
		]);
		forget(state, "forget-a", a);
		expect(state.links.relations).toEqual({});
	});
});

describe("consolidation relations", () => {
	it("adds pinned pairs once, skips stale endpoints and known pairs, and stops at the degree cap", () => {
		const state = store();
		const a = add(state, "a", 1);
		const b = add(state, "b", 2);
		const c = add(state, "c", 3, [{ id: a, kind: "supports" }]);
		const task = 7 as TaskId;
		const added = addConsolidationRelations(
			state,
			state.links,
			[
				{ from: { id: a, revision: 1 }, to: { id: b, revision: 1 } },
				{ from: { id: b, revision: 1 }, to: { id: a, revision: 1 } },
				{ from: { id: a, revision: 1 }, to: { id: c, revision: 1 } },
				{ from: { id: b, revision: 1 }, to: { id: c, revision: 2 } },
			],
			task,
			20,
		);
		expect(added).toHaveLength(1);
		expect(state.links.relations[added[0]!]).toMatchObject({
			kind: "relates",
			from: { id: a, revision: 1 },
			to: { id: b, revision: 1 },
			createdAt: 20,
			provenance: { derivation: "consolidation", taskId: 7 },
		});
		const hub = add(state, "hub", 1);
		const pairs = Array.from({ length: MEMORY_RELATION_DEGREE_LIMIT + 2 }, (_, index) => ({
			from: { id: add(state, `spoke-${index}`, 2), revision: 1 },
			to: { id: hub, revision: 1 },
		}));
		expect(addConsolidationRelations(state, state.links, pairs, task, 30)).toHaveLength(MEMORY_RELATION_DEGREE_LIMIT);
	});
});
