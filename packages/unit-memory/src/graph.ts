// Bounded, read-only projection of live memories, their summary links and their relations for display.
import { createHmac, randomBytes } from "node:crypto";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { LiveMemory, MemoryRelation, MemoryRelationKind, MemoryState } from "./memory.ts";
import { isLiveRelation } from "./relations.ts";

/** One live memory as shown in a graph; content is truncated and provenance is reduced to an opaque cluster key. */
export type MemoryGraphNode = {
	id: string;
	content: string;
	truncated: boolean;
	kind: LiveMemory["kind"];
	tier: LiveMemory["tier"]["kind"];
	origin: LiveMemory["provenance"]["origin"];
	importance: number;
	createdAt: number;
	conversation: string;
};

/** A live relation: `from` states it about `to`; `relates` is undirected in meaning. */
export type MemoryGraphRelationEdge = {
	from: string;
	to: string;
	kind: MemoryRelationKind;
	derivation: MemoryRelation["provenance"]["derivation"];
};

/** A summary link from an episodic summary to one of its working sources, or a relation between two memories. */
export type MemoryGraphEdge = { from: string; to: string; kind: "summary" } | MemoryGraphRelationEdge;

/** The newest live memories and the links among them, with the live total for context. */
export type MemoryGraph = {
	nodes: MemoryGraphNode[];
	edges: MemoryGraphEdge[];
	total: number;
	limited: boolean;
};

/** Maximum nodes in one graph read; the newest by update time are kept. */
export const MEMORY_GRAPH_NODE_LIMIT = 300;
/** Maximum content code points per node. */
export const MEMORY_GRAPH_CONTENT_LIMIT = 280;
/** Maximum edges per graph read: summary links first, then relations newest first. */
export const MEMORY_GRAPH_EDGE_LIMIT = 1000;

/** Project live memories newest first, never forgotten records, with live edges only between returned nodes. */
export function memoryGraph(state: MemoryState | undefined): MemoryGraph {
	if (state === undefined) return { nodes: [], edges: [], total: 0, limited: false };
	const live: LiveMemory[] = [];
	for (const record of Object.values(state.records)) if (record.state === "live") live.push(record);
	live.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const selected = live.slice(0, MEMORY_GRAPH_NODE_LIMIT);
	const present = new Set(selected.map((record) => record.id));
	const edges: MemoryGraphEdge[] = [];
	for (const record of selected) {
		if (record.tier.kind !== "episodic") continue;
		for (const source of record.tier.summaryOf) {
			if (edges.length === MEMORY_GRAPH_EDGE_LIMIT) break;
			if (present.has(source.id)) edges.push({ from: record.id, to: source.id, kind: "summary" });
		}
	}
	const relations = Object.values(state.relations)
		.filter((relation) => present.has(relation.from.id) && present.has(relation.to.id))
		.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const relation of relations) {
		if (edges.length === MEMORY_GRAPH_EDGE_LIMIT) break;
		if (!isLiveRelation(state, relation)) continue;
		edges.push({
			from: relation.from.id,
			to: relation.to.id,
			kind: relation.kind,
			derivation: relation.provenance.derivation,
		});
	}
	const conversations = new Map<ConversationId, string>();
	return {
		nodes: selected.map((record) => graphNode(record, conversations)),
		edges,
		total: live.length,
		limited: selected.length < live.length,
	};
}

function graphNode(record: LiveMemory, conversations: Map<ConversationId, string>): MemoryGraphNode {
	const points = Array.from(record.content);
	const truncated = points.length > MEMORY_GRAPH_CONTENT_LIMIT;
	return {
		id: record.id,
		content: truncated ? points.slice(0, MEMORY_GRAPH_CONTENT_LIMIT).join("") : record.content,
		truncated,
		kind: record.kind,
		tier: record.tier.kind,
		origin: record.provenance.origin,
		importance: record.importance,
		createdAt: record.createdAt,
		conversation: conversationKey(record.provenance.conversationId, conversations),
	};
}

// Conversation ids are small sequential integers, so an unkeyed hash would be reversible by enumeration.
// A per-process key keeps grouping stable across refreshes of one owner without exposing the id.
const conversationSecret = randomBytes(32);

function conversationKey(conversationId: ConversationId, cache: Map<ConversationId, string>): string {
	let key = cache.get(conversationId);
	if (key === undefined) {
		key = createHmac("sha256", conversationSecret).update(String(conversationId)).digest("hex").slice(0, 12);
		cache.set(conversationId, key);
	}
	return key;
}
