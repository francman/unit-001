// Typed relations between memories: liveness, caps, explicit and consolidation writes, and removal on forget.
import { createHash } from "node:crypto";
import type { TaskId } from "@earendil-works/pi-durable";
import type { LiveMemory, MemoryRef, MemoryState } from "./memory.ts";
import type {
	MemoryRelation,
	MemoryRelationKind,
	MemoryRelationProvenance,
	MemoryRelationsState,
} from "./relations-doc.ts";

/** A relation the author of a new memory names to an existing live memory. */
export type MemoryRelationRequest = { id: string; kind: MemoryRelationKind };

/** Every relation kind, in a stable order for validation. */
export const MEMORY_RELATION_KINDS = ["relates", "supports", "contradicts", "updates"] as const;
/** Maximum stored relations in one Session. */
export const MEMORY_RELATION_LIMIT = 4096;
/** Maximum relations touching one memory. */
export const MEMORY_RELATION_DEGREE_LIMIT = 32;
/** Maximum relations one remember call may name. */
export const MEMORY_RELATIONS_PER_REMEMBER = 8;

/** True while both endpoints are live at the revisions the relation was made against. */
export function isLiveRelation(state: Readonly<MemoryState> | undefined, relation: MemoryRelation): boolean {
	return isPinned(state, relation.from) && isPinned(state, relation.to);
}

function isPinned(state: Readonly<MemoryState> | undefined, ref: MemoryRef): boolean {
	const record = state?.records[ref.id];
	return record?.state === "live" && record.revision === ref.revision;
}

/** Reject named relations to absent, forgotten or duplicate targets, or past a cap, before anything is written. */
export function checkRelationRequests(
	state: MemoryState,
	relations: MemoryRelationsState,
	requests: readonly MemoryRelationRequest[],
): void {
	// Tool arguments are a trust boundary: the schema bounds shape, not liveness or caps.
	if (requests.length > MEMORY_RELATIONS_PER_REMEMBER)
		throw new Error(`A memory may name at most ${MEMORY_RELATIONS_PER_REMEMBER} relations`);
	const targets = new Set<string>();
	for (const request of requests) {
		if (!MEMORY_RELATION_KINDS.includes(request.kind)) throw new Error("Unknown memory relation kind");
		if (targets.has(request.id)) throw new Error(`Memory ${request.id} is named more than once`);
		if (state.records[request.id]?.state !== "live") throw new Error(`Related memory ${request.id} is not live`);
		targets.add(request.id);
	}
	if (requests.length === 0) return;
	if (Object.keys(relations.relations).length + requests.length > MEMORY_RELATION_LIMIT)
		throw new Error("Memory relation limit reached");
	const degrees = relationDegrees(relations.relations);
	for (const id of targets)
		if ((degrees.get(id) ?? 0) >= MEMORY_RELATION_DEGREE_LIMIT)
			throw new Error(`Related memory ${id} already has ${MEMORY_RELATION_DEGREE_LIMIT} relations`);
}

/** Store checked relations from a new memory, pinned to each endpoint's current revision. */
export function addExplicitRelations(
	state: MemoryState,
	relations: MemoryRelationsState,
	from: LiveMemory,
	requests: readonly MemoryRelationRequest[],
	provenance: Extract<MemoryRelationProvenance, { derivation: "explicit" }>,
	now: number,
): void {
	for (const request of requests) {
		const target = state.records[request.id] as LiveMemory;
		const relation = makeRelation(
			request.kind,
			{ id: from.id, revision: from.revision },
			{ id: target.id, revision: target.revision },
			provenance,
			now,
		);
		relations.relations[relation.id] = relation;
	}
}

/** Store consolidation's `relates` pairs whose endpoints are still pinned, skipping known pairs and full caps. */
export function addConsolidationRelations(
	state: MemoryState,
	relations: MemoryRelationsState,
	pairs: readonly { from: MemoryRef; to: MemoryRef }[],
	taskId: TaskId,
	now: number,
): string[] {
	const degrees = relationDegrees(relations.relations);
	const known = new Set(
		Object.values(relations.relations).map((relation) => pairKey(relation.from.id, relation.to.id)),
	);
	let total = Object.keys(relations.relations).length;
	const added: string[] = [];
	for (const { from, to } of pairs) {
		const key = pairKey(from.id, to.id);
		// Background work never fails on a cap; it only stops adding.
		if (
			total >= MEMORY_RELATION_LIMIT ||
			known.has(key) ||
			!isPinned(state, from) ||
			!isPinned(state, to) ||
			(degrees.get(from.id) ?? 0) >= MEMORY_RELATION_DEGREE_LIMIT ||
			(degrees.get(to.id) ?? 0) >= MEMORY_RELATION_DEGREE_LIMIT
		)
			continue;
		const relation = makeRelation("relates", from, to, { derivation: "consolidation", taskId }, now);
		relations.relations[relation.id] = relation;
		known.add(key);
		degrees.set(from.id, (degrees.get(from.id) ?? 0) + 1);
		degrees.set(to.id, (degrees.get(to.id) ?? 0) + 1);
		total++;
		added.push(relation.id);
	}
	return added;
}

/** Delete every relation touching a forgotten memory; a tombstoned endpoint can never be live again. */
export function removeRelations(relations: MemoryRelationsState, forgotten: ReadonlySet<string>): void {
	for (const relation of Object.values(relations.relations))
		if (forgotten.has(relation.from.id) || forgotten.has(relation.to.id)) delete relations.relations[relation.id];
}

function makeRelation(
	kind: MemoryRelationKind,
	from: MemoryRef,
	to: MemoryRef,
	provenance: MemoryRelationProvenance,
	now: number,
): MemoryRelation {
	// `relates` is symmetric, so its identity ignores direction; directed kinds keep it.
	const ends = kind === "relates" ? [from.id, to.id].sort() : [from.id, to.id];
	const id = `relation:${createHash("sha256")
		.update(JSON.stringify([kind, ...ends]))
		.digest("hex")}`;
	return { id, kind, from, to, createdAt: now, provenance };
}

function relationDegrees(relations: MemoryRelationsState["relations"]): Map<string, number> {
	const degrees = new Map<string, number>();
	for (const relation of Object.values(relations)) {
		degrees.set(relation.from.id, (degrees.get(relation.from.id) ?? 0) + 1);
		degrees.set(relation.to.id, (degrees.get(relation.to.id) ?? 0) + 1);
	}
	return degrees;
}

function pairKey(a: string, b: string): string {
	return JSON.stringify(a < b ? [a, b] : [b, a]);
}
