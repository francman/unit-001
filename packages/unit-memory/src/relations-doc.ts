// The Session's memory relations document, kept beside the v1 memory document, and the startup step that brings stored memory into that layout.
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type EntryId, type Session, type TaskId } from "@earendil-works/pi-durable";
import { MemoryDoc, type MemoryProvenance, type MemoryRef, type MemoryState } from "./memory.ts";
import { isLiveRelation } from "./relations.ts";

/** How two memories relate: `relates` is symmetric; the others read "from supports/contradicts/updates to". */
export type MemoryRelationKind = "relates" | "supports" | "contradicts" | "updates";

/** Who established a relation: the author of a memory that named it, or background consolidation. */
export type MemoryRelationProvenance =
	| {
			derivation: "explicit";
			origin: MemoryProvenance["origin"];
			conversationId: ConversationId;
			entryIds: EntryId[];
	  }
	| { derivation: "consolidation"; taskId: TaskId };

/** A typed link between two memories; it holds only while both endpoints are live at their pinned revisions. */
export type MemoryRelation = {
	id: string;
	kind: MemoryRelationKind;
	from: MemoryRef;
	to: MemoryRef;
	createdAt: number;
	provenance: MemoryRelationProvenance;
};

/** Every typed relation between the memories of one Session. */
export type MemoryRelationsState = { relations: Record<string, MemoryRelation> };

/**
 * Relations have their own Session document so the v1 `unit.memory` contract stays exactly what published readers
 * (0.0.9 and earlier) open and write; those readers never load this kind. Writers change both documents in one commit.
 */
export const MemoryRelationsDoc = defineDoc<MemoryRelationsState>({
	kind: "unit.memory.relations",
	version: 1,
	scope: "session",
	initial: () => ({ relations: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});

/**
 * Bring stored memory into the v1 layout, then drop relations whose endpoints are no longer live at their pinned
 * revisions. Call once when the owner opens, before anything reads memory and before scheduling resumes.
 */
export async function reconcileMemoryLayout(session: Session, context: Context): Promise<void> {
	if ((await session.snapshot(MemoryRelationsDoc, context)) === undefined) await splitStoredMemory(session, context);
	const memory = await session.snapshot(MemoryDoc, context);
	const current = await session.snapshot(MemoryRelationsDoc, context);
	// An older reader may have forgotten an endpoint since the last write here; it never touches this document.
	if (current === undefined || Object.values(current.relations).every((relation) => isLiveRelation(memory, relation)))
		return;
	await session.commit(async (tx) => {
		const relations = await tx.doc(MemoryRelationsDoc);
		const state = await tx.doc(MemoryDoc);
		for (const relation of Object.values(relations.relations))
			if (!isLiveRelation(state, relation)) delete relations.relations[relation.id];
	}, context);
}

// `unit.memory` version 2 (unreleased builds from edfa9d085) stored relations inside the memory document. This reader
// opens either version without writing: a version 1 value comes back as stored, without `relations`.
type StoredMemory = MemoryState & { relations?: Record<string, MemoryRelation> };
const StoredMemoryDoc = defineDoc<StoredMemory>({
	kind: "unit.memory",
	version: 2,
	scope: "session",
	initial: () => ({ ...MemoryDoc.definition.initial(), relations: {} }),
	migrate: (value) => value as StoredMemory,
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});

// The relations document's existence marks the v1 layout, so this runs once per Session; the version-2 reader
// costs one copy of the memory document on that first open only.
async function splitStoredMemory(session: Session, context: Context): Promise<void> {
	const stored = await session.snapshot(StoredMemoryDoc, context);
	await session.commit(async (tx) => {
		const relations = await tx.doc(MemoryRelationsDoc);
		if (stored?.relations === undefined) return;
		// Read the version-2 draft inside the commit, retire that incarnation, and recreate it at version 1.
		const { relations: links, ...memory } = JSON.parse(JSON.stringify(await tx.doc(StoredMemoryDoc))) as StoredMemory;
		await tx.retireDoc(StoredMemoryDoc);
		Object.assign(await tx.doc(MemoryDoc), memory);
		relations.relations = links ?? {};
	}, context);
}
