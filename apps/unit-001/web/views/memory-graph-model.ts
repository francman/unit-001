// The graph as the map shows it: node sizes by degree, neighbours, the legend's filters and the focus (local) subgraph.
import type { MemoryGraphView } from "../contract.ts";
import type { EdgeKind, GraphNode } from "./memory-graph-details.ts";

type Edge = MemoryGraphView["edges"][number];

/** One memory placed on the map. */
export interface ModelNode {
	node: GraphNode;
	/** How many relations the memory has in the whole graph, not only in what is shown. */
	degree: number;
	/** Drawn radius in world units. */
	radius: number;
}

/** A relation between two shown memories, as indices into `GraphModel.nodes`. */
export interface ModelEdge {
	from: number;
	to: number;
	kind: EdgeKind;
}

/** What the map draws and lays out: shown memories, shown relations, and each memory's neighbours. */
export interface GraphModel {
	nodes: readonly ModelNode[];
	edges: readonly ModelEdge[];
	/** Indices of the memories directly related to each memory. */
	neighbours: readonly (readonly number[])[];
	indexOf: ReadonlyMap<string, number>;
}

/** What the legend has switched off. Everything not listed is shown. */
export interface Hidden {
	kinds: ReadonlySet<GraphNode["kind"]>;
	tiers: ReadonlySet<GraphNode["tier"]>;
	relations: ReadonlySet<EdgeKind>;
}

/** The focus (local) view: one memory and what is within `depth` relations of it. */
export interface Focus {
	id: string;
	depth: 1 | 2;
}

/** Nothing switched off. */
export const nothingHidden: Hidden = { kinds: new Set(), tiers: new Set(), relations: new Set() };

/** Radius from degree: the main size cue, as in Obsidian. Importance is only a secondary cue (drawn as opacity). */
export function nodeRadius(degree: number): number {
	return Math.min(24, 4.5 + 3 * Math.sqrt(degree));
}

/** How many relations each memory has. Relations to a memory that is not in the data are ignored. */
export function degreesOf(nodes: readonly GraphNode[], edges: readonly Edge[]): Map<string, number> {
	const degrees = new Map(nodes.map((node) => [node.id, 0]));
	for (const edge of edges) {
		const from = degrees.get(edge.from);
		const to = degrees.get(edge.to);
		if (from === undefined || to === undefined) continue;
		degrees.set(edge.from, from + 1);
		degrees.set(edge.to, to + 1);
	}
	return degrees;
}

/**
 * The shown graph: the legend's filters first, then the focus view. The memories in `keep` (the selected one, the focus
 * center) are never filtered out, so what the person is looking at cannot vanish under their hand.
 */
export function shownGraph(
	nodes: readonly GraphNode[],
	edges: readonly Edge[],
	degrees: ReadonlyMap<string, number>,
	hidden: Hidden,
	focus: Focus | null,
	keep: readonly (string | null)[],
): GraphModel {
	const kept = new Set(keep);
	const visible = nodes.filter((node) => kept.has(node.id) || (!hidden.kinds.has(node.kind) && !hidden.tiers.has(node.tier)));
	const ids = new Set(visible.map((node) => node.id));
	const shownEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && !hidden.relations.has(edge.kind));
	if (!focus || !ids.has(focus.id)) return buildModel(visible, shownEdges, degrees);
	const within = withinDepth(shownEdges, focus.id, focus.depth);
	return buildModel(
		visible.filter((node) => within.has(node.id)),
		shownEdges.filter((edge) => within.has(edge.from) && within.has(edge.to)),
		degrees,
	);
}

/** The ids of `start` and every memory at most `depth` relations away from it. */
export function withinDepth(edges: readonly Edge[], start: string, depth: number): Set<string> {
	const next = new Map<string, string[]>();
	for (const edge of edges) {
		next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
		next.set(edge.to, [...(next.get(edge.to) ?? []), edge.from]);
	}
	const seen = new Set([start]);
	let ring = [start];
	for (let level = 0; level < depth; level++) {
		const following: string[] = [];
		for (const id of ring)
			for (const other of next.get(id) ?? []) {
				if (seen.has(other)) continue;
				seen.add(other);
				following.push(other);
			}
		ring = following;
	}
	return seen;
}

/** Indices of the memories that get a label without being hovered: the top `fraction` by degree, then by importance. */
export function topByDegree(model: GraphModel, fraction: number): Set<number> {
	const order = model.nodes
		.map((entry, index) => ({ index, degree: entry.degree, importance: entry.node.importance, id: entry.node.id }))
		.sort((a, b) => b.degree - a.degree || b.importance - a.importance || (a.id < b.id ? -1 : 1));
	return new Set(order.slice(0, Math.max(1, Math.ceil(model.nodes.length * fraction))).map((entry) => entry.index));
}

/**
 * A string that changes exactly when the map has something new to draw: which memories and relations are shown, and
 * each memory's degree (its size), kind, tier, importance and text (its label). A hidden neighbour that goes away changes
 * a shown memory's degree without changing the shown ids or relations, so ids alone are not enough.
 */
export function modelKey(model: GraphModel): string {
	const nodes = model.nodes.map((entry) => {
		const { node } = entry;
		return [node.id, entry.degree, node.kind, node.tier, node.importance, node.truncated ? 1 : 0, node.content].join("\u0001");
	});
	const edges = model.edges.map((edge) => `${edge.from}-${edge.to}-${edge.kind}`);
	return `${nodes.join("\u0002")}\u0003${edges.join("|")}`;
}

/** True when two models lay out the same: the same memories in the same order at the same sizes, joined by the same typed or summary links. */
export function sameLayout(a: GraphModel, b: GraphModel): boolean {
	if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
	for (let index = 0; index < a.nodes.length; index++) {
		const left = a.nodes[index];
		const right = b.nodes[index];
		if (left?.node.id !== right?.node.id || left?.radius !== right?.radius || (left?.node.tier === "episodic") !== (right?.node.tier === "episodic")) return false;
	}
	return a.edges.every((edge, index) => {
		const other = b.edges[index];
		return other !== undefined && edge.from === other.from && edge.to === other.to && (edge.kind === "summary") === (other.kind === "summary");
	});
}

/** The memory and its direct neighbours: the ones that stay at full strength when it is hovered or selected. */
export function litBy(model: GraphModel, index: number): Set<number> {
	return new Set([index, ...(model.neighbours[index] ?? [])]);
}

function buildModel(nodes: readonly GraphNode[], edges: readonly Edge[], degrees: ReadonlyMap<string, number>): GraphModel {
	const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
	const entries = nodes.map((node) => {
		const degree = degrees.get(node.id) ?? 0;
		return { node, degree, radius: nodeRadius(degree) };
	});
	const shown: ModelEdge[] = [];
	const neighbours: number[][] = nodes.map(() => []);
	for (const edge of edges) {
		const from = indexOf.get(edge.from);
		const to = indexOf.get(edge.to);
		if (from === undefined || to === undefined) continue;
		shown.push({ from, to, kind: edge.kind });
		neighbours[from]?.push(to);
		neighbours[to]?.push(from);
	}
	return { nodes: entries, edges: shown, neighbours, indexOf };
}
