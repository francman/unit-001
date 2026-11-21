// Checks the map's view math: coordinates, zoom, fit, node size on screen, hit testing and arrow-key moves.
import { describe, expect, it } from "vitest";
import { fitBox, hitTest, nodeInDirection, panIntoView, screenRadius, toWorld, type View, zoomAt, zoomRange } from "./views/memory-graph-geometry.ts";

const bodies = [
	{ x: 0, y: 0, radius: 10 },
	{ x: 100, y: 0, radius: 6 },
	{ x: 100, y: 100, radius: 6 },
	{ x: -200, y: 0, radius: 8 },
];
const toScreen = (view: View, x: number, y: number) => ({ x: x * view.k + view.x, y: y * view.k + view.y });

describe("memory graph geometry", () => {
	it("converts between screen and world and back", () => {
		const view = { x: 40, y: -20, k: 2.5 };
		const screen = toScreen(view, 12, 34);
		expect(toWorld(view, screen.x, screen.y)).toEqual({ x: 12, y: 34 });
	});

	it("zooms around a point that stays where it is, within the range", () => {
		const view = { x: 10, y: 20, k: 1 };
		const next = zoomAt(view, 2, 300, 200);
		expect(toWorld(next, 300, 200)).toEqual(toWorld(view, 300, 200));
		expect(zoomAt(view, 1000, 0, 0).k).toBe(zoomRange.max);
		expect(zoomAt(view, 0.0001, 0, 0).k).toBe(zoomRange.min);
	});

	it("fits a box in the middle of the area without zooming past the limit", () => {
		const view = fitBox({ x0: -100, y0: -50, x1: 100, y1: 50 }, 800, 400, 1.6);
		expect(view.k).toBe(1.6);
		expect(toScreen(view, 0, 0)).toEqual({ x: 400, y: 200 });
		const tight = fitBox({ x0: -1000, y0: -1000, x1: 1000, y1: 1000 }, 800, 400, 1.6);
		expect(tight.k).toBeCloseTo(0.2, 5);
	});

	it("grows nodes slower than the world and never makes them vanish", () => {
		expect(screenRadius(10, 1)).toBe(10);
		expect(screenRadius(10, 4)).toBeLessThan(40);
		expect(screenRadius(10, 4)).toBeGreaterThan(10);
		expect(screenRadius(10, 0.15)).toBeGreaterThanOrEqual(5.5);
	});

	it.each([[0.5], [1], [3]])("finds the node at its own center at zoom %s, and nothing 40 px from every node", (k) => {
		const view = { x: 120, y: 80, k };
		bodies.forEach((body, index) => {
			const at = toScreen(view, body.x, body.y);
			expect(hitTest(bodies, view, at.x, at.y, 8)).toBe(index);
		});
		// A point 40 px (screen) away from the nearest node, beyond its radius and the slop.
		const nearest = toScreen(view, 100, 100);
		expect(hitTest(bodies, view, nearest.x + 40 + screenRadius(6, k), nearest.y, 8)).toBe(-1);
	});

	it("hits within the drawn radius or the slop, whichever is larger", () => {
		const view = { x: 0, y: 0, k: 1 };
		expect(hitTest(bodies, view, 9, 0, 8)).toBe(0);
		expect(hitTest(bodies, view, 100, 12, 8)).toBe(-1);
		expect(hitTest(bodies, view, 100, 12, 22)).toBe(1);
	});

	// Codex review: episodic nodes are drawn as rounded squares, so their corners must hit too.
	it.each([[0.5], [1], [3]])("hits just inside the corner of an episodic (rounded square) node after pan and zoom %s", (k) => {
		const view = { x: -35, y: 62, k };
		const square = [{ x: 40, y: 30, radius: 12, square: true }];
		const circle = [{ x: 40, y: 30, radius: 12 }];
		const half = screenRadius(12, k);
		const center = toScreen(view, 40, 30);
		// 1 px inside the straight edges' extremes: the corner region lies beyond the inscribed circle, so a circle misses it.
		const corner = { x: center.x + half - 1.2, y: center.y + half - 1.2 };
		expect(Math.hypot(corner.x - center.x, corner.y - center.y)).toBeGreaterThan(half);
		expect(hitTest(square, view, corner.x, corner.y, 0)).toBe(0);
		expect(hitTest(circle, view, corner.x, corner.y, 0)).toBe(-1);
		// Just outside the square on a side is still a miss, and so is the rounded-off tip of the corner.
		expect(hitTest(square, view, center.x + half + 1, center.y, 0)).toBe(-1);
		expect(hitTest(square, view, center.x + half + 0.2, center.y + half + 0.2, 0)).toBe(-1);
	});

	it("takes the nearest node, and the smaller one on a tie", () => {
		const view = { x: 0, y: 0, k: 1 };
		const close = [
			{ x: 0, y: 0, radius: 12 },
			{ x: 14, y: 0, radius: 6 },
		];
		expect(hitTest(close, view, 9, 0, 8)).toBe(1);
		const tie = [
			{ x: -10, y: 0, radius: 12 },
			{ x: 10, y: 0, radius: 6 },
		];
		expect(hitTest(tie, view, 0, 0, 12)).toBe(1);
	});

	it("moves between nodes by direction: cone first, then anywhere ahead, -1 when nothing is ahead", () => {
		expect(nodeInDirection(bodies, 0, 1, 0)).toBe(1);
		expect(nodeInDirection(bodies, 1, 0, 1)).toBe(2);
		expect(nodeInDirection(bodies, 0, -1, 0)).toBe(3);
		expect(nodeInDirection(bodies, 3, -1, 0)).toBe(-1);
		// From the node at (100, 0), straight up has nothing in its cone and nothing ahead at all.
		expect(nodeInDirection(bodies, 1, 0, -1)).toBe(-1);
		// A node off to the side is still reached when the cone is empty.
		expect(nodeInDirection(bodies, 2, 1, 0)).toBe(-1);
		expect(nodeInDirection(bodies, 2, 0, -1)).toBe(1);
	});

	it("pans a point at least a margin inside the area", () => {
		expect(panIntoView(100, 100, 800, 400, 36)).toEqual({ dx: 0, dy: 0 });
		expect(panIntoView(10, 100, 800, 400, 36)).toEqual({ dx: 26, dy: 0 });
		expect(panIntoView(790, 395, 800, 400, 36)).toEqual({ dx: -26, dy: -31 });
	});
});
