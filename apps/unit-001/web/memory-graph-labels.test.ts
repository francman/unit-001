// Checks which memories get a label: priority order, the zoom fade, collision avoidance and the cap.
import { describe, expect, it } from "vitest";
import type { MemoryGraphView } from "./contract.ts";
import { type LabelBox, type LabelCandidate, labelOrder, placeLabels, zoomFade } from "./views/memory-graph-labels.ts";
import { degreesOf, nothingHidden, shownGraph } from "./views/memory-graph-model.ts";

type Node = MemoryGraphView["nodes"][number];
type Edge = MemoryGraphView["edges"][number];

const nodes: Node[] = Array.from({ length: 10 }, (_, index) => ({
	id: `n${index}`,
	content: `memory ${index}`,
	truncated: false,
	kind: "fact",
	tier: "working",
	origin: "user",
	importance: index / 10,
	createdAt: 1,
	conversation: "c",
}));
// n0 is the busiest (degree 4), n1 next (2), then n2, n3, n4 (1 each); the rest have none.
const edges: Edge[] = [
	{ from: "n0", to: "n1", kind: "summary" },
	{ from: "n0", to: "n2", kind: "summary" },
	{ from: "n0", to: "n3", kind: "summary" },
	{ from: "n0", to: "n4", kind: "summary" },
	{ from: "n1", to: "n5", kind: "summary" },
];
const model = shownGraph(nodes, edges, degreesOf(nodes, edges), nothingHidden, null, []);

const candidate = (index: number, x: number, y: number, over: Partial<LabelCandidate> = {}): LabelCandidate => ({ index, must: false, rest: false, x, y, radius: 6, width: 80, ...over });
const overlap = (a: LabelBox, b: LabelBox) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

describe("memory graph labels", () => {
	it("fades labels in with the zoom: hidden far out, full near, smooth between", () => {
		expect(zoomFade(0.15)).toBe(0);
		expect(zoomFade(0.3)).toBe(0);
		expect(zoomFade(0.6)).toBe(1);
		expect(zoomFade(2)).toBe(1);
		const middle = zoomFade(0.45);
		expect(middle).toBeGreaterThan(0.2);
		expect(middle).toBeLessThan(0.8);
		expect(zoomFade(0.4)).toBeLessThan(zoomFade(0.5));
	});

	it("orders selected, hovered, neighbours, search matches, then the busiest", () => {
		const order = labelOrder({ model, selected: 7, hovered: 8, neighbours: new Set([9, 6]), matches: new Set([3, 6]), top: new Set([0, 1]) });
		expect(order.map((pick) => pick.index)).toEqual([7, 8, 9, 6, 3, 0, 1]);
		expect(order.filter((pick) => pick.must).map((pick) => pick.index)).toEqual([7, 8]);
		// Only the busiest are "rest" labels, which fade with the zoom; everything else is named whatever the zoom.
		expect(order.filter((pick) => pick.rest).map((pick) => pick.index)).toEqual([0, 1]);
	});

	it("does not list a memory twice, and drops indices that are not in the graph", () => {
		const order = labelOrder({ model, selected: 2, hovered: 2, neighbours: new Set([2, 99]), matches: null, top: new Set([2, 0]) });
		expect(order.map((pick) => pick.index)).toEqual([2, 0]);
	});

	it("keeps the label of a busier memory and drops one that would overlap it", () => {
		const kept = placeLabels([candidate(0, 100, 100), candidate(1, 110, 104), candidate(2, 400, 100)]);
		expect([...kept.keys()]).toEqual([0, 2]);
	});

	it("keeps no two labels overlapping, and none over the circle of a memory whose label was kept", () => {
		const many = Array.from({ length: 80 }, (_, index) => candidate(index, (index % 10) * 40, Math.floor(index / 10) * 30));
		const kept = [...placeLabels(many).values()];
		for (let a = 0; a < kept.length; a++) for (let b = a + 1; b < kept.length; b++) expect(overlap(kept[a] as LabelBox, kept[b] as LabelBox)).toBe(false);
		const onCircle = placeLabels([candidate(0, 100, 100, { radius: 30 }), candidate(1, 100, 118, { width: 20 })]);
		expect(onCircle.has(1)).toBe(false);
	});

	it("always keeps must labels, even over others", () => {
		const kept = placeLabels([candidate(0, 100, 100), candidate(1, 105, 100, { must: true })]);
		expect([...kept.keys()].sort()).toEqual([0, 1]);
	});

	it("keeps at most 60 labels that are not must labels", () => {
		const many = Array.from({ length: 200 }, (_, index) => candidate(index, (index % 20) * 120, Math.floor(index / 20) * 60));
		expect(placeLabels(many).size).toBe(60);
		const withMust = [...many.slice(0, 100), candidate(500, 5000, 5000, { must: true })];
		expect(placeLabels(withMust).has(500)).toBe(true);
	});

	it("places a label centered under its node", () => {
		const box = placeLabels([candidate(0, 200, 100, { radius: 8, width: 60 })]).get(0);
		expect(((box?.x0 ?? 0) + (box?.x1 ?? 0)) / 2).toBe(200);
		expect(box?.y0).toBeGreaterThan(108);
	});
});
