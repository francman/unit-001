// Checks how the map forms: which change gets which animation, and the time curves of appearing, pulling and drawing the outline.
import { describe, expect, it } from "vitest";
import {
	createForm,
	edgeProgressAt,
	fadeAt,
	holdStrength,
	introRanks,
	introStart,
	minShapeNodes,
	outlineAlphaAt,
	outlineRestAlpha,
	type PlanInput,
	planFor,
	revealAt,
	startTimes,
	strengthAt,
	traceAt,
} from "./views/memory-graph-form.ts";
import { degreesOf, nothingHidden, shownGraph } from "./views/memory-graph-model.ts";
import { sampleMemoryGraph } from "./preview-memory-graph.ts";

const first: PlanInput = { played: false, kept: 0, wasShaped: false, nodeCount: 60, wantShape: true, reduced: false };

describe("the plan for a change of memories", () => {
	it("forms a brain only from twelve memories on, and never in the focus view", () => {
		expect(planFor({ ...first, nodeCount: minShapeNodes - 1 }).shaped).toBe(false);
		expect(planFor({ ...first, nodeCount: minShapeNodes }).shaped).toBe(true);
		expect(planFor({ ...first, wantShape: false }).shaped).toBe(false);
	});

	it("plays the intro the first time and a quick re-form after that", () => {
		expect(planFor(first).kind).toBe("intro");
		expect(planFor({ ...first, played: true, kept: 0.9 }).kind).toBe("quick");
	});

	it("gives a small map only the appearing animation, a little shorter than the brain", () => {
		const small = planFor({ ...first, nodeCount: 5 });
		expect(small).toMatchObject({ kind: "intro", shaped: false, animated: true });
		expect(small.totalMs).toBeLessThan(planFor(first).totalMs);
	});

	it("shows the final state at once for reduced motion", () => {
		expect(planFor({ ...first, reduced: true })).toMatchObject({ kind: "static", shaped: true, animated: false });
		expect(planFor({ ...first, played: true, reduced: true }).kind).toBe("static");
	});

	it("lets the free layout run longer when fewer memories kept their places", () => {
		const base = { ...first, played: true };
		const shaped = planFor({ ...base, kept: 0.9, wasShaped: true });
		const kept = planFor({ ...base, kept: 0.9, wasShaped: false });
		const changed = planFor({ ...base, kept: 0.2, wasShaped: true });
		expect(shaped.freeMs).toBe(0);
		expect(kept.freeMs).toBeGreaterThan(shaped.freeMs);
		expect(changed.freeMs).toBeGreaterThan(kept.freeMs);
	});

	it("animates a quick change only when the memories end up in a brain", () => {
		expect(planFor({ ...first, played: true, kept: 1, nodeCount: 5 }).animated).toBe(false);
		expect(planFor({ ...first, played: true, kept: 1, wantShape: false }).animated).toBe(false);
		expect(planFor({ ...first, played: true, kept: 1 }).animated).toBe(true);
	});
});

describe("appearing", () => {
	it("starts the busiest memory at once and ends the last one within 560 ms", () => {
		expect(introStart(0, 300)).toBe(0);
		expect(introStart(299, 300) + 300).toBeLessThanOrEqual(560);
		expect(introStart(0, 1)).toBe(0);
	});

	it("is 0 before a memory starts, 1 after, and only grows in between", () => {
		expect(revealAt(100, 50)).toBe(0);
		expect(revealAt(100, 100)).toBe(0);
		expect(revealAt(100, 1000)).toBe(1);
		let before = 0;
		for (let ms = 100; ms <= 400; ms += 10) {
			const now = revealAt(100, ms);
			expect(now).toBeGreaterThanOrEqual(before);
			expect(now).toBeLessThanOrEqual(1);
			before = now;
		}
	});

	it("draws a relation after its later memory started, and never past the end", () => {
		expect(edgeProgressAt(200, 250)).toBe(0);
		expect(edgeProgressAt(200, 2000)).toBe(1);
		expect(edgeProgressAt(200, 400)).toBeGreaterThan(0);
		expect(edgeProgressAt(200, 400)).toBeLessThan(1);
	});

	it("ranks the most related memory first and gives every memory its own rank", () => {
		const graph = sampleMemoryGraph(Date.UTC(2026, 10, 21), "mid");
		const model = shownGraph(graph.nodes, graph.edges, degreesOf(graph.nodes, graph.edges), nothingHidden, null, []);
		const ranks = introRanks(model);
		expect([...ranks].sort((a, b) => a - b)).toEqual(model.nodes.map((_, index) => index));
		const busiest = Math.max(...model.nodes.map((entry) => entry.degree));
		expect(model.nodes[ranks.indexOf(0)]?.degree).toBe(busiest);
	});

	it("starts new memories at once in a quick re-form and keeps the others shown", () => {
		const graph = sampleMemoryGraph(Date.UTC(2026, 10, 21), "mid");
		const model = shownGraph(graph.nodes, graph.edges, degreesOf(graph.nodes, graph.edges), nothingHidden, null, []);
		const isNew = new Uint8Array(model.nodes.length);
		isNew[2] = 1;
		const starts = startTimes(planFor({ ...first, played: true, kept: 0.9 }), model, isNew);
		expect(starts[2]).toBe(0);
		expect(revealAt(starts[3] ?? 0, 0)).toBe(1);
		const intro = startTimes(planFor(first), model, isNew);
		expect(Math.min(...intro)).toBe(0);
		expect(Math.max(...intro)).toBeLessThanOrEqual(260);
	});
});

describe("the pull and the outline", () => {
	const plan = planFor(first);

	it("pulls nothing during the free layout, then ramps smoothly to the hold strength", () => {
		expect(strengthAt(plan, 0)).toBe(0);
		expect(strengthAt(plan, plan.freeMs)).toBe(0);
		expect(strengthAt(plan, plan.freeMs + plan.rampMs)).toBeCloseTo(holdStrength, 9);
		expect(strengthAt(plan, plan.freeMs + plan.rampMs + 5000)).toBeCloseTo(holdStrength, 9);
		let before = 0;
		for (let ms = plan.freeMs; ms <= plan.freeMs + plan.rampMs; ms += 20) {
			const now = strengthAt(plan, ms);
			expect(now).toBeGreaterThanOrEqual(before);
			before = now;
		}
		expect(strengthAt(planFor({ ...first, nodeCount: 5 }), 5000)).toBe(0);
	});

	it("draws the outline stroke by stroke in the intro, between 0 and 1 and only growing", () => {
		expect(traceAt(plan, 0)).toBe(0);
		expect(traceAt(plan, plan.totalMs)).toBe(1);
		let before = 0;
		for (let ms = 0; ms <= plan.totalMs; ms += 25) {
			const now = traceAt(plan, ms);
			expect(now).toBeGreaterThanOrEqual(before);
			expect(now).toBeLessThanOrEqual(1);
			before = now;
		}
		expect(traceAt(planFor({ ...first, nodeCount: 5 }), 5000)).toBe(0);
	});

	it("shows the outline whole after a quick change, fading in only when the memories travel first", () => {
		const waiting = planFor({ ...first, played: true, kept: 0.2 });
		expect(traceAt(waiting, 0)).toBe(1);
		expect(fadeAt(waiting, 0)).toBe(0);
		expect(fadeAt(waiting, waiting.freeMs + waiting.rampMs)).toBe(1);
		const instant = planFor({ ...first, played: true, kept: 0.9, wasShaped: true });
		expect(fadeAt(instant, 0)).toBe(1);
	});

	it("is a little stronger while it is drawn and then rests at one constant", () => {
		expect(outlineAlphaAt(1, 1)).toBeCloseTo(outlineRestAlpha, 9);
		expect(outlineAlphaAt(0, 1)).toBeGreaterThan(outlineAlphaAt(1, 1));
		expect(outlineAlphaAt(1, 0)).toBe(0);
	});
});

describe("the clock", () => {
	it("is done at the plan's end and not before", () => {
		const form = createForm(planFor(first));
		expect(form.done).toBe(false);
		form.advance(0.05);
		expect(form.elapsed).toBeCloseTo(50, 9);
		expect(form.done).toBe(false);
	});

	it("counts one huge frame as 100 ms, so a stalled page does not skip the animation", () => {
		const form = createForm(planFor(first));
		form.advance(30);
		expect(form.elapsed).toBeCloseTo(100, 9);
	});

	it("skips to the end: everything shown, the full pull, the outline complete", () => {
		const plan = planFor(first);
		const form = createForm(plan);
		form.skip();
		expect(form.done).toBe(true);
		expect(revealAt(introStart(299, 300), form.elapsed)).toBe(1);
		expect(strengthAt(plan, form.elapsed)).toBeCloseTo(holdStrength, 9);
		expect(traceAt(plan, form.elapsed)).toBe(1);
	});
});
