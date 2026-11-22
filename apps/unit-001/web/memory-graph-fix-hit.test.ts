// Checks that the map hits an episodic node on its drawn rounded square, after pan and zoom (codex review, low: hit testing used a circle).
import { describe, expect, it } from "vitest";
import { hitTest, type Placed, screenRadius, squareCorner, type View } from "./views/memory-graph-geometry.ts";

const views: View[] = [
	{ x: 0, y: 0, k: 1 },
	{ x: 120, y: -40, k: 3 },
	{ x: -300, y: 210, k: 4 },
];

describe("memory graph hit testing on the drawn shape", () => {
	it.each(views)("hits just inside an episodic corner and misses just outside it at pan/zoom %o", (view) => {
		const radius = screenRadius(14, view.k);
		const corner = squareCorner(radius);
		const cx = 20 * view.k + view.x;
		const cy = -10 * view.k + view.y;
		const body: Placed = { x: cx, y: cy, radius, square: true };
		// The corner is rounded: the arc's center sits `corner` in from each edge; its diagonal extreme is corner * (1 - 1/sqrt 2) short of the square's corner.
		const inset = corner * (1 - Math.SQRT1_2);
		const slop = 0; // Isolate the shape: no center slop.
		const insideDiagonal = radius - inset - 0.5;
		const outsideDiagonal = radius - inset + 0.5;
		expect(hitTest([body], cx + insideDiagonal, cy + insideDiagonal, slop)).toBe(0);
		expect(hitTest([body], cx - insideDiagonal, cy + insideDiagonal, slop)).toBe(0);
		expect(hitTest([body], cx + outsideDiagonal, cy + outsideDiagonal, slop)).toBe(-1);
		// The straight edge reaches the full half-size, which a circle of the same radius would not at this height off-center.
		expect(hitTest([body], cx + radius - 0.5, cy, slop)).toBe(0);
		expect(hitTest([body], cx + radius + 0.5, cy, slop)).toBe(-1);
	});

	it("reaches a point near the corner that a circle of the same radius would miss", () => {
		const radius = screenRadius(20, 4);
		const square: Placed = { x: 0, y: 0, radius, square: true };
		const circle: Placed = { ...square, square: false };
		// 0.9 of the half-size on both axes: hypot is 1.27 radius, outside a circle, inside the square (corner radius is at most 3 px).
		const point = radius * 0.9;
		expect(hitTest([square], point, point, 0)).toBe(0);
		expect(hitTest([circle], point, point, 0)).toBe(-1);
	});

	it("still lets screen-pixel slop hit a square node and keeps the nearest-node tie break", () => {
		const radius = screenRadius(6, 2);
		const near: Placed = { x: 50, y: 50, radius, square: true };
		const far: Placed = { x: 44, y: 50, radius, square: false };
		// Beyond the drawn shape of both but within slop of the center: the nearer center wins.
		const px = 50 + radius + 2;
		expect(hitTest([far, near], px, 50, 14)).toBe(1);
		expect(hitTest([near], 50 + radius + 20, 50, 14)).toBe(-1);
	});
});
