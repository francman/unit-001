// Checks how strongly the map draws each memory and relation while one is hovered or selected, and while a search is typed.
import { describe, expect, it } from "vitest";
import type { MemoryGraphView } from "./contract.ts";
import { type Scene, dimmedEdge, dimmedNode, draw, edgeOpacity, nodeOpacity } from "./views/memory-graph-draw.ts";
import { hitTest, type Placed } from "./views/memory-graph-geometry.ts";
import type { Theme } from "./views/memory-graph-theme.ts";
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

// A context that records every call and every property it is given, so a frame can be compared with another one.
function recorder(): { ctx: CanvasRenderingContext2D; calls: string[] } {
	const calls: string[] = [];
	const show = (value: unknown) => (typeof value === "number" ? String(Math.round(value * 1000) / 1000) : Array.isArray(value) ? `[${value.join(",")}]` : String(value));
	const ctx = new Proxy({}, {
		get: (_, name) => (...args: unknown[]) => {
			calls.push(`${String(name)}(${args.map(show).join(",")})`);
		},
		set: (_, name, value) => {
			calls.push(`${String(name)}=${show(value)}`);
			return true;
		},
	}) as CanvasRenderingContext2D;
	return { ctx, calls };
}

const theme: Theme = { accent: "#00f", ok: "#0f0", warn: "#fa0", info: "#0af", fg: "#fff", fg2: "#ccc", fg3: "#999", canvas: "#000", font: "sans-serif" };
const bodies = [
	{ x: 0, y: 0, radius: 8 },
	{ x: 100, y: 0, radius: 8 },
	{ x: 100, y: 100, radius: 8 },
	{ x: 0, y: 100, radius: 8 },
];
const base: Scene = { model, focus: null, mix: 0, matches: null, width: 400, height: 400, dpr: 1, view: { x: 100, y: 100, k: 1 }, theme, bodies, selected: null, current: null, labels: [], form: null, outline: null };
const strokes = (calls: string[]) => calls.filter((call) => call === "stroke()").length;

describe("memory graph forming", () => {
	it("draws a fully revealed form exactly like a map that is not forming", () => {
		const plain = recorder();
		draw(plain.ctx, base);
		const formed = recorder();
		draw(formed.ctx, { ...base, form: { reveal: new Float32Array(4).fill(1), edgeProgress: new Float32Array(3).fill(1) } });
		expect(formed.calls).toEqual(plain.calls);
		expect(plain.calls.length).toBeGreaterThan(20);
	});

	it("draws no memory and no relation while nothing has appeared", () => {
		const { ctx, calls } = recorder();
		draw(ctx, { ...base, form: { reveal: new Float32Array(4), edgeProgress: new Float32Array(3) } });
		expect(strokes(calls)).toBe(0);
		expect(calls.some((call) => call.startsWith("arc(") || call.startsWith("roundRect(") || call === "fill()")).toBe(false);
	});

	it("draws a relation only part of the way, without its arrowhead, until it is nearly complete", () => {
		const { ctx, calls } = recorder();
		draw(ctx, { ...base, form: { reveal: new Float32Array(4).fill(1), edgeProgress: Float32Array.of(0, 0.5, 0) } });
		// b to c is a "supports" relation (a triangle head): b is at (200, 100) on screen and c at (200, 200). The line would end
		// 10 px short of c, at y = 190; halfway to there is y = 145.
		const lines = calls.filter((call) => call.startsWith("lineTo("));
		expect(lines).toEqual(["lineTo(200,145)"]);
		expect(calls).not.toContain("closePath()");
		const nearly = recorder();
		draw(nearly.ctx, { ...base, form: { reveal: new Float32Array(4).fill(1), edgeProgress: Float32Array.of(0, 0.99, 0) } });
		expect(nearly.calls).toContain("closePath()");
	});

	it("shrinks and fades a memory that is still appearing", () => {
		const half = recorder();
		draw(half.ctx, { ...base, form: { reveal: Float32Array.of(0.5, 0, 0, 0), edgeProgress: new Float32Array(3) } });
		const arcs = half.calls.filter((call) => call.startsWith("arc(") || call.startsWith("roundRect("));
		expect(arcs).toHaveLength(1);
		const whole = recorder();
		draw(whole.ctx, { ...base, form: { reveal: Float32Array.of(1, 0, 0, 0), edgeProgress: new Float32Array(3) } });
		expect(half.calls.join("|")).not.toEqual(whole.calls.join("|"));
	});

	it("hits the last painted center and radius but not a node that has yet to appear", () => {
		const { ctx } = recorder();
		const painted: Placed[] = [];
		draw(ctx, base, painted);
		expect(hitTest(painted, 200, 100, 22)).toBe(1);
		draw(ctx, { ...base, form: { reveal: Float32Array.of(0.5, 0, 0, 0), edgeProgress: new Float32Array(3) } }, painted);
		expect(hitTest(painted, 200, 100, 22)).toBe(-1);
		expect(hitTest(painted, 106, 100, 0)).toBe(0);
		expect(hitTest(painted, 107, 100, 0)).toBe(-1);
	});
});

describe("memory graph outline", () => {
	it("strokes nothing when its strength is 0, and a trace of 0 draws nothing yet", () => {
		const hidden = recorder();
		draw(hidden.ctx, { ...base, outline: { size: 400, alpha: 0, trace: 1 } });
		const plain = recorder();
		draw(plain.ctx, base);
		expect(hidden.calls).toEqual(plain.calls);
		const untraced = recorder();
		draw(untraced.ctx, { ...base, outline: { size: 400, alpha: 0.2, trace: 0 } });
		expect(untraced.calls).toEqual(plain.calls);
	});

	it("strokes the outline and three fissures under the relations", () => {
		const { ctx, calls } = recorder();
		draw(ctx, { ...base, outline: { size: 400, alpha: 0.2, trace: 1 } });
		const plain = recorder();
		draw(plain.ctx, base);
		expect(strokes(calls) - strokes(plain.calls)).toBe(4);
		// The outline comes first: before the first relation is stroked.
		expect(calls.indexOf("stroke()")).toBeLessThan(calls.indexOf("globalAlpha=0.8"));
	});

	it("shows only a part of the line while it is being traced", () => {
		const { ctx, calls } = recorder();
		draw(ctx, { ...base, outline: { size: 400, alpha: 0.2, trace: 0.5 } });
		expect(calls.some((call) => /^setLineDash\(\[\d+(\.\d+)?,\d+(\.\d+)?\]\)$/.test(call) && !call.includes("[]"))).toBe(true);
	});
});
