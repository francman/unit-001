// Checks that a reduced-motion settle of the 300-node preview fixture runs in time-bounded batches and reaches rest (codex review, medium).
import { describe, expect, it } from "vitest";
import { sampleMemoryGraph } from "./preview-memory-graph.ts";
import { assignByBisection } from "./views/memory-graph-assign.ts";
import { brainFrame, brainTargets, worldPoints } from "./views/memory-graph-brain.ts";
import { createSimulation, type LayoutEdge, type LayoutNode, settleWithin } from "./views/memory-graph-layout.ts";
import { degreesOf, nothingHidden, shownGraph } from "./views/memory-graph-model.ts";

// The same shape the canvas hands the layout.
function fixture(): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
	const graph = sampleMemoryGraph(Date.UTC(2026, 10, 21), "large");
	const model = shownGraph(graph.nodes, graph.edges, degreesOf(graph.nodes, graph.edges), nothingHidden, null, []);
	return {
		nodes: model.nodes.map((entry) => ({ id: entry.node.id, radius: entry.radius, degree: entry.degree, square: entry.node.tier === "episodic" })),
		edges: model.edges.map((edge) => ({ from: model.nodes[edge.from]?.node.id ?? "", to: model.nodes[edge.to]?.node.id ?? "", typed: edge.kind !== "summary" })),
	};
}

describe("reduced-motion settle", () => {
	it("uses the 300-node large fixture", () => {
		const { nodes, edges } = fixture();
		expect(nodes).toHaveLength(300);
		expect(edges.length).toBeGreaterThan(400);
	});

	it("yields in batches under a tick-count budget and reaches rest", () => {
		const { nodes, edges } = fixture();
		const simulation = createSimulation(nodes, edges);
		// A deterministic clock: each look at it costs 1 ms, and a batch gets 8 ms, so a batch may not run more than about 8 ticks.
		let reads = 0;
		const now = () => ++reads;
		let batches = 1;
		let longest = 0;
		for (let guard = 0; guard < 2000; guard++) {
			reads = 0;
			const done = settleWithin(simulation, 8, now);
			longest = Math.max(longest, reads);
			if (done) break;
			batches += 1;
			expect(simulation.active).toBe(true);
		}
		expect(batches).toBeGreaterThan(5);
		expect(longest).toBeLessThanOrEqual(9);
		expect(simulation.active).toBe(false);
		expect(simulation.step()).toBe(false);
		for (const body of simulation.bodies) {
			expect(Number.isFinite(body.x)).toBe(true);
			expect(Number.isFinite(body.y)).toBe(true);
		}
	});

	it("takes the same final positions in batches as in one run", () => {
		const { nodes, edges } = fixture();
		const whole = createSimulation(nodes, edges);
		expect(settleWithin(whole, Infinity)).toBe(true);
		const batched = createSimulation(nodes, edges);
		let clock = 0;
		// A 3-tick batch each time.
		while (!settleWithin(batched, 3, () => clock++)) clock += 0;
		expect(batched.bodies.map((body) => [body.x, body.y])).toEqual(whole.bodies.map((body) => [body.x, body.y]));
	});

	it("does not block for the whole settle on a real clock: the first batch returns early with a small budget", () => {
		const { nodes, edges } = fixture();
		const simulation = createSimulation(nodes, edges);
		// Budget zero: exactly one tick, never the full settle.
		expect(settleWithin(simulation, 0)).toBe(false);
		expect(simulation.active).toBe(true);
	});

	// The reduced-motion path with a brain: settle in batches to the side, then match to the brain and snap, all in one step.
	it("ends a batched settle with every memory exactly on its place in the brain", () => {
		const { nodes, edges } = fixture();
		const simulation = createSimulation(nodes, edges);
		let clock = 0;
		while (!settleWithin(simulation, 8, () => (clock += 1))) expect(simulation.active).toBe(true);
		const count = nodes.length;
		const slots = worldPoints(brainTargets(count), brainFrame(nodes.map((node) => node.radius)));
		const now = new Float64Array(count * 2);
		simulation.bodies.forEach((body, index) => {
			now[index * 2] = body.x;
			now[index * 2 + 1] = body.y;
		});
		const slotOf = assignByBisection(now, slots);
		const places = new Float64Array(count * 2);
		for (let index = 0; index < count; index++) {
			places[index * 2] = slots[(slotOf[index] ?? 0) * 2] ?? 0;
			places[index * 2 + 1] = slots[(slotOf[index] ?? 0) * 2 + 1] ?? 0;
		}
		simulation.attract(places, 0.1);
		simulation.snap(places);
		expect(simulation.active).toBe(false);
		expect(simulation.step()).toBe(false);
		simulation.bodies.forEach((body, index) => {
			expect(body.x).toBe(places[index * 2]);
			expect(body.y).toBe(places[index * 2 + 1]);
		});
		// Every place is used once.
		expect(new Set(slotOf).size).toBe(count);
	});
});
