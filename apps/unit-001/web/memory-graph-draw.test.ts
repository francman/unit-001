// Checks how strongly the map draws each memory and relation while one is hovered or selected, and while a search is typed.
import { describe, expect, it } from "vitest";
import type { MemoryGraphView } from "./contract.ts";
import { dimmedEdge, dimmedNode, edgeOpacity, nodeOpacity } from "./views/memory-graph-draw.ts";
import { degreesOf, nothingHidden, shownGraph } from "./views/memory-graph-model.ts";

type Node = MemoryGraphView["nodes"][number];
type Edge = MemoryGraphView["edges"][number];

const nodes: Node[] = ["a", "b", "c", "d"].map((id) => ({ id, content: id, truncated: false, kind: "fact", tier: "working", origin: "user", importance: 0.5, createdAt: 1, conversation: "c" }));
const edges: Edge[] = [
	{ from: "a", to: "b", kind: "summary" },
	{ from: "b", to: "c", kind: "supports", derivation: "explicit" },
	{ from: "c", to: "d", kind: "summary" },
];
const model = shownGraph(nodes, edges, degreesOf(nodes, edges), nothingHidden, null, []);
const [ab, bc, cd] = model.edges;
const at = (id: string) => model.indexOf.get(id) ?? -1;

describe("memory graph emphasis", () => {
	it("draws everything at its own strength when nothing is focused", () => {
		const scene = { model, focus: null, mix: 0, matches: null };
		for (let index = 0; index < 4; index++) expect(nodeOpacity(scene, index)).toBe(1);
		expect(edgeOpacity(scene, ab as never)).toBeLessThan(edgeOpacity(scene, bc as never));
	});

	it("keeps the focus and its neighbours at full strength and dims the rest to about 0.15", () => {
		const scene = { model, focus: at("b"), mix: 1, matches: null };
		expect(nodeOpacity(scene, at("b"))).toBe(1);
		expect(nodeOpacity(scene, at("a"))).toBe(1);
		expect(nodeOpacity(scene, at("c"))).toBe(1);
		expect(nodeOpacity(scene, at("d"))).toBeCloseTo(dimmedNode, 5);
		expect(dimmedNode).toBeCloseTo(0.15, 5);
	});

	it("draws relations that touch the focus strongly and the others at about 0.08", () => {
		const scene = { model, focus: at("b"), mix: 1, matches: null };
		expect(edgeOpacity(scene, ab as never)).toBeCloseTo(0.9, 5);
		expect(edgeOpacity(scene, bc as never)).toBeCloseTo(0.9, 5);
		expect(edgeOpacity(scene, cd as never)).toBeCloseTo(dimmedEdge, 5);
		expect(dimmedEdge).toBeCloseTo(0.08, 5);
	});

	it("moves between the two states with the mix, so the change can be animated", () => {
		const half = nodeOpacity({ model, focus: at("b"), mix: 0.5, matches: null }, at("d"));
		expect(half).toBeGreaterThan(dimmedNode);
		expect(half).toBeLessThan(1);
	});

	it("draws summary links a little quieter than typed relations at rest (the contrast test holds both to 3:1)", () => {
		const scene = { model, focus: null, mix: 0, matches: null };
		expect(edgeOpacity(scene, ab as never)).toBeLessThan(edgeOpacity(scene, bc as never));
		expect(edgeOpacity(scene, bc as never)).toBeGreaterThanOrEqual(0.8);
	});

	it("dims memories that do not match the search to 0.2 and keeps matches at full strength", () => {
		const scene = { model, focus: null, mix: 0, matches: new Set([at("a")]) };
		expect(nodeOpacity(scene, at("a"))).toBe(1);
		expect(nodeOpacity(scene, at("c"))).toBeCloseTo(0.2, 5);
		expect(edgeOpacity(scene, cd as never)).toBeCloseTo(edgeOpacity({ ...scene, matches: null }, cd as never) * 0.2, 5);
		expect(edgeOpacity(scene, ab as never)).toBeCloseTo(edgeOpacity({ ...scene, matches: null }, ab as never), 5);
	});
});
