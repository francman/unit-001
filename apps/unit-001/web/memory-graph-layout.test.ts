// Checks that the memory graph layout is deterministic, finite, separated, linked, stable under small changes, draggable and settles.
import { describe, expect, it } from "vitest";
import { bounds, createSimulation, type LayoutEdge, type LayoutNode, settleWithin } from "./views/memory-graph-layout.ts";

function sample(count: number): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
	const nodes = Array.from({ length: count }, (_, index) => ({ id: `n${index}`, radius: 6 + (index % 5) * 2, degree: index % 4 }));
	const edges = nodes.filter((_, index) => index % 2 === 0).map((node, index) => ({ from: node.id, to: `n${(index * 3 + 1) % count}`, typed: index % 3 === 0 }));
	return { nodes, edges };
}

function positions(simulation: ReturnType<typeof createSimulation>): number[] {
	return simulation.bodies.flatMap((body) => [body.x, body.y]);
}

describe("memory graph layout", () => {
	it("gives the same positions for the same input", () => {
		const { nodes, edges } = sample(60);
		const first = createSimulation(nodes, edges);
		const second = createSimulation(nodes, edges);
		// The first layout is the same before any tick too: the start is seeded, not random.
		expect(positions(first)).toEqual(positions(second));
		settleWithin(first, Infinity);
		settleWithin(second, Infinity);
		expect(positions(first)).toEqual(positions(second));
	});

	it("settles within the tick limit and then stops moving", () => {
		const { nodes, edges } = sample(60);
		const simulation = createSimulation(nodes, edges);
		let steps = 0;
		while (simulation.step()) steps += 1;
		expect(steps).toBeLessThanOrEqual(500);
		expect(simulation.active).toBe(false);
		const before = positions(simulation);
		expect(simulation.step()).toBe(false);
		expect(positions(simulation)).toEqual(before);
	});

	it("keeps every position finite, including nodes that start on the same spot and graphs without links", () => {
		const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, radius: 8, degree: 0 }));
		const stacked = new Map(nodes.map((node) => [node.id, { x: 5, y: 5 }]));
		const simulation = createSimulation(nodes, [], stacked);
		settleWithin(simulation, Infinity);
		for (const value of positions(simulation)) expect(Number.isFinite(value)).toBe(true);
		const spread = new Set(simulation.bodies.map((body) => `${Math.round(body.x)}:${Math.round(body.y)}`));
		expect(spread.size).toBeGreaterThan(8);
	});

	it("ignores links to nodes that are not there and links from a node to itself", () => {
		const nodes = [
			{ id: "a", radius: 6, degree: 1 },
			{ id: "b", radius: 6, degree: 1 },
		];
		const simulation = createSimulation(nodes, [
			{ from: "a", to: "missing", typed: false },
			{ from: "b", to: "b", typed: true },
		]);
		settleWithin(simulation, Infinity);
		for (const value of positions(simulation)) expect(Number.isFinite(value)).toBe(true);
	});

	it("keeps nodes apart", () => {
		const { nodes, edges } = sample(80);
		const simulation = createSimulation(nodes, edges);
		settleWithin(simulation, Infinity);
		let worst = Infinity;
		for (let a = 0; a < nodes.length; a++)
			for (let b = a + 1; b < nodes.length; b++) {
				const left = simulation.bodies[a];
				const right = simulation.bodies[b];
				if (!left || !right) continue;
				worst = Math.min(worst, Math.hypot(left.x - right.x, left.y - right.y) - (left.radius + right.radius));
			}
		// Circles may touch a little in a dense spot but never sit on top of each other.
		expect(worst).toBeGreaterThan(-4);
	});

	it("draws linked nodes toward the link distance, summary links shorter than typed ones", () => {
		const nodes = Array.from({ length: 4 }, (_, index) => ({ id: `n${index}`, radius: 6, degree: 1 }));
		const summary = createSimulation(nodes.slice(0, 2), [{ from: "n0", to: "n1", typed: false }]);
		const typed = createSimulation(nodes.slice(2), [{ from: "n2", to: "n3", typed: true }]);
		settleWithin(summary, Infinity);
		settleWithin(typed, Infinity);
		const length = (simulation: typeof summary) => Math.hypot((simulation.bodies[0]?.x ?? 0) - (simulation.bodies[1]?.x ?? 0), (simulation.bodies[0]?.y ?? 0) - (simulation.bodies[1]?.y ?? 0));
		expect(length(summary)).toBeGreaterThan(70);
		expect(length(summary)).toBeLessThan(length(typed));
		expect(length(typed)).toBeLessThan(150);
	});

	it("lets a small change leave the surviving nodes where they were", () => {
		const { nodes, edges } = sample(60);
		const full = createSimulation(nodes, edges);
		settleWithin(full, Infinity);
		const before = new Map(full.bodies.map((body) => [body.id, { x: body.x, y: body.y }]));
		const fewer = createSimulation(
			nodes.filter((node) => node.id !== "n7"),
			edges.filter((edge) => edge.from !== "n7" && edge.to !== "n7"),
			before,
		);
		settleWithin(fewer, Infinity);
		const moved = fewer.bodies.map((body) => Math.hypot(body.x - (before.get(body.id)?.x ?? 0), body.y - (before.get(body.id)?.y ?? 0))).sort((a, b) => a - b);
		expect(moved[Math.floor(moved.length / 2)]).toBeLessThanOrEqual(12);
	});

	it("starts a new node beside the linked node that was kept", () => {
		const previous = new Map([["a", { x: 400, y: -300 }]]);
		const simulation = createSimulation(
			[
				{ id: "a", radius: 6, degree: 1 },
				{ id: "b", radius: 6, degree: 1 },
			],
			[{ from: "a", to: "b", typed: true }],
			previous,
		);
		const [a, b] = simulation.bodies;
		expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))).toBeLessThanOrEqual(61);
	});

	it("pins a dragged node, moves its neighbours while it is held and cools down after release", () => {
		const { nodes, edges } = sample(30);
		const simulation = createSimulation(nodes, edges);
		settleWithin(simulation, Infinity);
		const neighbour = simulation.bodies[1];
		const before = { x: neighbour?.x ?? 0, y: neighbour?.y ?? 0 };
		simulation.pin(0, 500, 500);
		simulation.reheat();
		for (let tick = 0; tick < 40; tick++) simulation.step();
		expect(simulation.bodies[0]?.x).toBe(500);
		expect(simulation.bodies[0]?.y).toBe(500);
		// Held warm: the layout is still active however many ticks pass.
		for (let tick = 0; tick < 600; tick++) simulation.step();
		expect(simulation.active).toBe(true);
		expect(Math.hypot((neighbour?.x ?? 0) - before.x, (neighbour?.y ?? 0) - before.y)).toBeGreaterThan(5);
		simulation.release(0);
		settleWithin(simulation, Infinity);
		expect(simulation.active).toBe(false);
		expect(simulation.bodies[0]?.fx).toBeNull();
	});

	// Codex review: a reduced-motion settle of 300 nodes held the main thread for 137-156 ms.
	it("settles in time-bounded batches that end where a single run ends", () => {
		const { nodes, edges } = sample(300);
		const whole = createSimulation(nodes, edges);
		settleWithin(whole, Infinity);
		const batched = createSimulation(nodes, edges);
		// A fake clock that advances 1 ms every time the batch looks at it, which is once per tick.
		let reads = 0;
		const now = () => ++reads;
		let batches = 0;
		let mostReads = 0;
		for (;;) {
			reads = 0;
			const done = settleWithin(batched, 5, now);
			mostReads = Math.max(mostReads, reads);
			if (done) break;
			batches += 1;
			expect(batched.active).toBe(true);
		}
		expect(batches).toBeGreaterThan(10);
		// Each batch stopped at its 5 ms budget (the first read starts the clock) instead of running the whole layout.
		expect(mostReads).toBeLessThanOrEqual(6);
		expect(batched.active).toBe(false);
		expect(positions(batched)).toEqual(positions(whole));
	});

	it("stops a batch when the budget is spent and says so", () => {
		const { nodes, edges } = sample(60);
		const simulation = createSimulation(nodes, edges);
		let clock = 0;
		expect(settleWithin(simulation, 0, () => clock++)).toBe(false);
		expect(simulation.active).toBe(true);
		expect(settleWithin(simulation, Infinity)).toBe(true);
	});

	// Codex review: after a reduced-motion drag, the original (cooled) solver ran one near-zero tick on release.
	it("a layout restarted from kept places has fresh alpha and moves the others, while releasing a cooled one does not", () => {
		const { nodes, edges } = sample(40);
		const cooled = createSimulation(nodes, edges);
		settleWithin(cooled, Infinity);
		cooled.pin(0, 400, 400);
		cooled.release(0);
		let releasedSteps = 0;
		while (cooled.step()) releasedSteps += 1;
		expect(releasedSteps).toBeLessThanOrEqual(1);
		const kept = new Map(cooled.bodies.map((body) => [body.id, { x: body.x, y: body.y }]));
		const restarted = createSimulation(nodes, edges, kept);
		let restartedSteps = 0;
		while (restarted.step()) restartedSteps += 1;
		expect(restartedSteps).toBeGreaterThan(20);
	});

	it("reports a box around all bodies", () => {
		const simulation = createSimulation(
			[
				{ id: "a", radius: 10, degree: 0 },
				{ id: "b", radius: 10, degree: 0 },
			],
			[],
			new Map([
				["a", { x: -50, y: 0 }],
				["b", { x: 50, y: 20 }],
			]),
		);
		const box = bounds(simulation, 5);
		expect(box.x0).toBe(-65);
		expect(box.x1).toBe(65);
		expect(box.y0).toBe(-15);
		expect(box.y1).toBe(35);
	});

	it("handles an empty graph", () => {
		const simulation = createSimulation([], []);
		expect(simulation.step()).toBe(false);
		expect(bounds(simulation, 10).x1).toBe(100);
	});
});

describe("memory graph layout pulled toward a shape", () => {
	const threeNodes = () => Array.from({ length: 3 }, (_, index) => ({ id: `n${index}`, radius: 6, degree: 0 }));
	const places = Float64Array.of(-200, -50, 0, 120, 210, -40);

	it("brings three nodes to within three units of their places", () => {
		const simulation = createSimulation(threeNodes(), []);
		simulation.attract(places, 0.1);
		for (let tick = 0; tick < 400; tick++) simulation.step();
		simulation.bodies.forEach((body, index) => {
			expect(Math.hypot(body.x - (places[index * 2] ?? 0), body.y - (places[index * 2 + 1] ?? 0))).toBeLessThan(3);
		});
		expect(simulation.shaped).toBe(true);
	});

	it("pulls the same way every time", () => {
		const { nodes, edges } = sample(40);
		const targets = Float64Array.from({ length: 80 }, (_, at) => ((at * 37) % 400) - 200);
		const run = () => {
			const simulation = createSimulation(nodes, edges);
			simulation.attract(targets, 0.1);
			settleWithin(simulation, Infinity);
			return positions(simulation);
		};
		expect(run()).toEqual(run());
	});

	it("stops pulling when the places are taken away", () => {
		const simulation = createSimulation(threeNodes(), []);
		settleWithin(simulation, Infinity);
		simulation.attract(places, 0.1);
		for (let tick = 0; tick < 100; tick++) simulation.step();
		simulation.attract(null, 0);
		expect(simulation.shaped).toBe(false);
		simulation.reheat();
		const before = positions(simulation);
		for (let tick = 0; tick < 100; tick++) simulation.step();
		// Held warm without a pull, the three unlinked nodes only drift apart; they do not return to the places.
		const moved = simulation.bodies.map((body, index) => Math.hypot(body.x - (places[index * 2] ?? 0), body.y - (places[index * 2 + 1] ?? 0)));
		expect(Math.max(...moved)).toBeGreaterThan(3);
		expect(positions(simulation)).not.toEqual(before);
	});

	it("wakes a layout that had rested when the pull starts", () => {
		const simulation = createSimulation(threeNodes(), []);
		settleWithin(simulation, Infinity);
		expect(simulation.active).toBe(false);
		simulation.attract(places, 0);
		expect(simulation.active).toBe(false);
		simulation.attract(places, 0.05);
		expect(simulation.active).toBe(true);
	});

	it("puts every node exactly on its place and rests", () => {
		const simulation = createSimulation(threeNodes(), []);
		simulation.snap(places);
		expect(simulation.active).toBe(false);
		expect(positions(simulation)).toEqual(Array.from(places));
	});

	it("holds a dragged layout less warm while a shape pulls everything back", () => {
		const loose = createSimulation(threeNodes(), []);
		loose.reheat();
		expect(loose.alphaTarget).toBe(0.3);
		const shaped = createSimulation(threeNodes(), []);
		shaped.attract(places, 0.1);
		shaped.reheat();
		expect(shaped.alphaTarget).toBe(0.1);
		shaped.release(0);
		expect(shaped.alphaTarget).toBe(0);
	});

	it("springs a dragged node back to its place after it is let go", () => {
		const { nodes, edges } = sample(30);
		const simulation = createSimulation(nodes, edges);
		const targets = Float64Array.from({ length: 60 }, (_, at) => (at % 2 === 0 ? ((at / 2) % 6) * 80 - 200 : Math.floor(at / 12) * 80 - 160));
		simulation.attract(targets, 0.1);
		settleWithin(simulation, Infinity);
		simulation.pin(0, 600, 600);
		simulation.reheat();
		for (let tick = 0; tick < 60; tick++) simulation.step();
		simulation.release(0);
		settleWithin(simulation, Infinity);
		const body = simulation.bodies[0];
		expect(Math.hypot((body?.x ?? 0) - (targets[0] ?? 0), (body?.y ?? 0) - (targets[1] ?? 0))).toBeLessThan(25);
	});
});
