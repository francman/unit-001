// Checks the brain the memory map forms: a closed outline of sensible size, a working inside test, and evenly spread, repeatable targets.
import { describe, expect, it } from "vitest";
import { brain, brainFrame, brainHeight, brainTargets, distanceToOutline, insideBrain, worldPoints } from "./views/memory-graph-brain.ts";

describe("brain outline", () => {
	it("is closed and stays inside the unit box", () => {
		const points = brain.outline;
		expect(points[0]).toBeCloseTo(points[points.length - 2], 9);
		expect(points[1]).toBeCloseTo(points[points.length - 1], 9);
		for (let at = 0; at < points.length; at += 2) {
			expect(points[at]).toBeGreaterThanOrEqual(0);
			expect(points[at]).toBeLessThanOrEqual(1);
			expect(points[at + 1]).toBeGreaterThanOrEqual(0);
			expect(points[at + 1]).toBeLessThanOrEqual(brainHeight + 1e-9);
		}
	});

	it("has a plausible area and three faint fissure strokes inside the box", () => {
		// About 60% of the 1 x 0.8 box: a brain fills its bounding box far more than a bean would.
		expect(brain.area).toBeGreaterThan(0.4);
		expect(brain.area).toBeLessThan(0.6);
		expect(brain.details).toHaveLength(3);
		expect(brain.outlineLength).toBeGreaterThan(2);
		for (const length of brain.detailLengths) expect(length).toBeGreaterThan(0.2);
	});

	it("tells inside from outside", () => {
		for (const [x, y] of [
			[0.5, 0.3],
			[0.8, 0.3],
		] as const)
			expect(insideBrain(x, y)).toBe(true);
		for (const [x, y] of [
			[0.02, 0.75],
			[0.97, 0.02],
			[0.1, 0.7],
		] as const)
			expect(insideBrain(x, y)).toBe(false);
	});

	it("measures the distance to the outline", () => {
		expect(distanceToOutline(0.5, 0.3)).toBeGreaterThan(0.1);
		const start = [brain.outline[0], brain.outline[1]] as const;
		expect(distanceToOutline(start[0], start[1])).toBeCloseTo(0, 9);
		expect(distanceToOutline(start[0] - 0.05, start[1])).toBeGreaterThan(0.04);
	});
});

describe("brain targets", () => {
	it("gives exactly the number asked for, again and again the same", () => {
		for (const count of [0, 1, 2, 12, 64, 300]) {
			const first = brainTargets(count);
			expect(first).toHaveLength(count * 2);
			expect(Array.from(brainTargets(count))).toEqual(Array.from(first));
		}
	});

	it("keeps every target inside the outline and off the line", () => {
		const points = brainTargets(300);
		for (let at = 0; at < points.length; at += 2) {
			expect(insideBrain(points[at], points[at + 1])).toBe(true);
			expect(distanceToOutline(points[at], points[at + 1])).toBeGreaterThanOrEqual(0.014);
		}
	});

	it("spreads the targets evenly: no two are much closer than the average spacing", () => {
		const count = 300;
		const points = brainTargets(count);
		let closest = Infinity;
		for (let a = 0; a < count; a++)
			for (let b = a + 1; b < count; b++) closest = Math.min(closest, Math.hypot(points[a * 2] - points[b * 2], points[a * 2 + 1] - points[b * 2 + 1]));
		expect(closest).toBeGreaterThanOrEqual(0.3 * Math.sqrt(brain.area / count));
	});

	it("makes fewer targets the start of more, so one memory more or less moves almost nothing", () => {
		const fewer = brainTargets(299);
		const more = brainTargets(300);
		expect(Array.from(fewer)).toEqual(Array.from(more.subarray(0, 598)));
	});
});

describe("brain frame", () => {
	const radii = (count: number, radius: number) => Array.from({ length: count }, () => radius);

	it("grows with the number of memories and never drops under 360", () => {
		expect(brainFrame(radii(3, 6)).width).toBe(360);
		expect(brainFrame(radii(60, 8)).width).toBeLessThanOrEqual(brainFrame(radii(300, 8)).width);
		expect(brainFrame(radii(300, 8)).width).toBeGreaterThan(360);
		expect(brainFrame(radii(300, 12)).width).toBeGreaterThan(brainFrame(radii(300, 6)).width);
	});

	it("is 0.8 as high as wide and gives the memories at least the room they need", () => {
		const sizes = radii(300, 9);
		const frame = brainFrame(sizes);
		expect(frame.height).toBeCloseTo(frame.width * brainHeight, 9);
		const needed = sizes.reduce((sum, radius) => sum + (Math.PI * (radius + 4) ** 2) / 0.55, 0);
		expect(brain.area * frame.width ** 2).toBeGreaterThanOrEqual(needed - 1e-6);
	});

	it("places unit points around the origin", () => {
		const frame = { width: 400, height: 320 };
		const world = worldPoints(Float64Array.of(0.5, brainHeight / 2, 1, 0), frame);
		expect(Array.from(world)).toEqual([0, 0, 200, -160]);
	});
});
