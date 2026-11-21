// Checks that a snapshot which changes a visible memory's whole-graph degree, with the visible topology held fixed, yields a different model key, radius and label priority (codex review, medium).
import { describe, expect, it } from "vitest";
import type { MemoryGraphView } from "./contract.ts";
import { degreesOf, modelKey, nodeRadius, nothingHidden, sameLayout, shownGraph, topByDegree } from "./views/memory-graph-model.ts";

type Node = MemoryGraphView["nodes"][number];
type Edge = MemoryGraphView["edges"][number];

function node(id: string, kind: Node["kind"] = "fact"): Node {
	return { id, content: `memory ${id}`, truncated: false, kind, tier: "working", origin: "user", importance: 0.5, createdAt: 1, conversation: "c" };
}

// Shown: a and b joined by a relation. Hidden by the observation filter: h1, h2, h3, all related to b. After: b loses h2 and h3 and a gains h1.
const nodes = [node("a"), node("b"), node("h1", "observation"), node("h2", "observation"), node("h3", "observation")];
const before: Edge[] = [
	{ from: "a", to: "b", kind: "summary" },
	{ from: "b", to: "h1", kind: "summary" },
	{ from: "b", to: "h2", kind: "summary" },
	{ from: "b", to: "h3", kind: "summary" },
];
const after: Edge[] = [
	{ from: "a", to: "b", kind: "summary" },
	{ from: "a", to: "h1", kind: "summary" },
];
const hidden = { ...nothingHidden, kinds: new Set<Node["kind"]>(["observation"]) };

function model(edges: Edge[]) {
	return shownGraph(nodes, edges, degreesOf(nodes, edges), hidden, null, []);
}

describe("render data change detection", () => {
	it("holds the visible ids and edges fixed while the degrees move", () => {
		const one = model(before);
		const two = model(after);
		expect(one.nodes.map((entry) => entry.node.id)).toEqual(["a", "b"]);
		expect(two.nodes.map((entry) => entry.node.id)).toEqual(["a", "b"]);
		expect(one.edges).toEqual(two.edges);
		expect(one.nodes.map((entry) => entry.degree)).toEqual([1, 4]);
		expect(two.nodes.map((entry) => entry.degree)).toEqual([2, 1]);
	});

	it("gives a different model key", () => {
		expect(modelKey(model(after))).not.toBe(modelKey(model(before)));
		expect(modelKey(model(before))).toBe(modelKey(model(before)));
	});

	it("updates the radius of the shown memories", () => {
		const one = model(before);
		const two = model(after);
		expect(one.nodes[1]?.radius).toBe(nodeRadius(4));
		expect(two.nodes[1]?.radius).toBe(nodeRadius(1));
		expect(two.nodes[0]?.radius).toBe(nodeRadius(2));
		expect(two.nodes[1]?.radius).toBeLessThan(one.nodes[1]?.radius ?? 0);
		// The layout depends on the radius, so the model is no longer the same layout.
		expect(sameLayout(one, two)).toBe(false);
	});

	it("updates which memory gets a label first", () => {
		expect([...topByDegree(model(before), 0.01)]).toEqual([1]);
		expect([...topByDegree(model(after), 0.01)]).toEqual([0]);
	});
});
