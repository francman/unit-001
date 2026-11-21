// Checks the shown graph: sizes by degree, the legend's filters, the focus subgraph and which memories are lit around one.
import { describe, expect, it } from "vitest";
import type { MemoryGraphView } from "./contract.ts";
import { degreesOf, litBy, modelKey, nodeRadius, nothingHidden, sameLayout, shownGraph, topByDegree, withinDepth } from "./views/memory-graph-model.ts";

type Node = MemoryGraphView["nodes"][number];
type Edge = MemoryGraphView["edges"][number];

function node(id: string, kind: Node["kind"] = "fact", tier: Node["tier"] = "working", importance = 0.5): Node {
	return { id, content: id, truncated: false, kind, tier, origin: "user", importance, createdAt: 1, conversation: "c" };
}

// a - b - c - d - e in a line, plus f hanging off b by a typed relation, and g alone.
const nodes = [node("a"), node("b", "decision"), node("c", "fact", "episodic"), node("d"), node("e", "observation"), node("f", "preference"), node("g")];
const edges: Edge[] = [
	{ from: "a", to: "b", kind: "summary" },
	{ from: "b", to: "c", kind: "summary" },
	{ from: "c", to: "d", kind: "summary" },
	{ from: "d", to: "e", kind: "summary" },
	{ from: "b", to: "f", kind: "supports", derivation: "explicit" },
];
const degrees = degreesOf(nodes, edges);
const ids = (model: ReturnType<typeof shownGraph>) => model.nodes.map((entry) => entry.node.id).sort();

describe("memory graph model", () => {
	it("counts relations per memory and ignores relations to memories that are not there", () => {
		const counted = degreesOf(nodes, [...edges, { from: "a", to: "missing", kind: "summary" }]);
		expect(counted.get("b")).toBe(3);
		expect(counted.get("a")).toBe(1);
		expect(counted.get("g")).toBe(0);
	});

	it("sizes by degree: more relations, bigger node, never past the cap", () => {
		expect(nodeRadius(0)).toBe(4.5);
		expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1));
		expect(nodeRadius(10_000)).toBe(24);
	});

	it("shows everything when nothing is hidden and no focus is set", () => {
		const model = shownGraph(nodes, edges, degrees, nothingHidden, null, []);
		expect(model.nodes).toHaveLength(7);
		expect(model.edges).toHaveLength(5);
		expect(model.neighbours[model.indexOf.get("b") ?? -1]).toHaveLength(3);
	});

	it("hides memories by kind and by tier, with the relations that touch them", () => {
		const byKind = shownGraph(nodes, edges, degrees, { ...nothingHidden, kinds: new Set(["decision"]) }, null, []);
		expect(ids(byKind)).not.toContain("b");
		expect(byKind.edges).toHaveLength(2);
		const byTier = shownGraph(nodes, edges, degrees, { ...nothingHidden, tiers: new Set(["episodic"]) }, null, []);
		expect(ids(byTier)).not.toContain("c");
		expect(byTier.edges.map((edge) => `${byTier.nodes[edge.from]?.node.id}${byTier.nodes[edge.to]?.node.id}`).sort()).toEqual(["ab", "bf", "de"]);
	});

	it("hides relation types but keeps the memories", () => {
		const model = shownGraph(nodes, edges, degrees, { ...nothingHidden, relations: new Set(["summary"]) }, null, []);
		expect(model.nodes).toHaveLength(7);
		expect(model.edges).toHaveLength(1);
		expect(model.edges[0]?.kind).toBe("supports");
	});

	it("never filters out a memory it was told to keep", () => {
		const model = shownGraph(nodes, edges, degrees, { ...nothingHidden, kinds: new Set(["decision"]) }, null, ["b"]);
		expect(ids(model)).toContain("b");
	});

	it("keeps degree from the whole graph, so a memory does not shrink when its neighbours are hidden", () => {
		const model = shownGraph(nodes, edges, degrees, { ...nothingHidden, kinds: new Set(["fact"]) }, null, []);
		const b = model.nodes[model.indexOf.get("b") ?? -1];
		expect(b?.degree).toBe(3);
	});

	it("finds the memories within a depth of one", () => {
		expect([...withinDepth(edges, "b", 1)].sort()).toEqual(["a", "b", "c", "f"]);
		expect([...withinDepth(edges, "b", 2)].sort()).toEqual(["a", "b", "c", "d", "f"]);
		expect([...withinDepth(edges, "g", 2)]).toEqual(["g"]);
	});

	it("focus shows fewer memories: the center, its neighbours and only the relations among them", () => {
		const depthOne = shownGraph(nodes, edges, degrees, nothingHidden, { id: "b", depth: 1 }, []);
		expect(ids(depthOne)).toEqual(["a", "b", "c", "f"]);
		expect(depthOne.edges).toHaveLength(3);
		const depthTwo = shownGraph(nodes, edges, degrees, nothingHidden, { id: "b", depth: 2 }, []);
		expect(ids(depthTwo)).toEqual(["a", "b", "c", "d", "f"]);
		expect(depthTwo.nodes.length).toBeGreaterThan(depthOne.nodes.length);
	});

	it("applies the filters inside the focus view, and shows everything when the focus memory is gone", () => {
		const filtered = shownGraph(nodes, edges, degrees, { ...nothingHidden, relations: new Set(["supports"]) }, { id: "b", depth: 1 }, []);
		expect(ids(filtered)).toEqual(["a", "b", "c"]);
		const gone = shownGraph(nodes, edges, degrees, nothingHidden, { id: "missing", depth: 1 }, []);
		expect(gone.nodes).toHaveLength(7);
	});

	it("names the top tenth by degree, at least one, busiest first", () => {
		const model = shownGraph(nodes, edges, degrees, nothingHidden, null, []);
		expect([...topByDegree(model, 0.1)].map((index) => model.nodes[index]?.node.id)).toEqual(["b"]);
		expect(topByDegree(model, 0.5).size).toBe(4);
	});

	// Codex review: a hidden neighbour's deletion changes a shown memory's degree while the shown ids and relations stay the same.
	it("changes its key when a shown memory's degree changes although the shown ids and relations do not", () => {
		const hideKinds = { ...nothingHidden, kinds: new Set<Node["kind"]>(["preference"]) };
		const before = shownGraph(nodes, edges, degrees, hideKinds, null, []);
		// f (a hidden preference) loses its link to b: b's whole-graph degree falls from 3 to 2.
		const fewer = edges.filter((edge) => edge.to !== "f");
		const after = shownGraph(nodes, fewer, degreesOf(nodes, fewer), hideKinds, null, []);
		expect(after.nodes.map((entry) => entry.node.id)).toEqual(before.nodes.map((entry) => entry.node.id));
		expect(after.edges).toEqual(before.edges);
		// The key the widget used before (shown ids and relations only) could not tell the two apart.
		const shape = (model: ReturnType<typeof shownGraph>) => JSON.stringify([model.nodes.map((entry) => entry.node.id), model.edges]);
		expect(shape(after)).toBe(shape(before));
		expect(after.nodes[after.indexOf.get("b") ?? -1]?.radius).toBeLessThan(before.nodes[before.indexOf.get("b") ?? -1]?.radius ?? 0);
		expect(modelKey(after)).not.toBe(modelKey(before));
		expect(sameLayout(before, after)).toBe(false);
	});

	it("changes its key for a new text, kind or importance, and not for the same data", () => {
		const base = shownGraph(nodes, edges, degrees, nothingHidden, null, []);
		expect(modelKey(shownGraph(nodes, edges, degrees, nothingHidden, null, []))).toBe(modelKey(base));
		const edited = nodes.map((entry) => (entry.id === "a" ? { ...entry, content: "a, reworded" } : entry));
		const reworded = shownGraph(edited, edges, degrees, nothingHidden, null, []);
		expect(modelKey(reworded)).not.toBe(modelKey(base));
		// A new text moves nothing: the map keeps its places and only redraws.
		expect(sameLayout(base, reworded)).toBe(true);
		const recolored = shownGraph(
			nodes.map((entry) => (entry.id === "a" ? { ...entry, kind: "decision" as const, importance: 0.9 } : entry)),
			edges,
			degrees,
			nothingHidden,
			null,
			[],
		);
		expect(modelKey(recolored)).not.toBe(modelKey(base));
		expect(sameLayout(base, recolored)).toBe(true);
	});

	it("lights a memory and its direct neighbours only", () => {
		const model = shownGraph(nodes, edges, degrees, nothingHidden, null, []);
		const lit = litBy(model, model.indexOf.get("c") ?? -1);
		expect([...lit].map((index) => model.nodes[index]?.node.id).sort()).toEqual(["b", "c", "d"]);
	});
});
