// Checks that the bisection matching is a true one-to-one matching, recovers an exact match and keeps neighbours together.
import { describe, expect, it } from "vitest";
import { assignByBisection } from "./views/memory-graph-assign.ts";
import { seeded } from "./views/memory-graph-layout.ts";

function randomPoints(count: number, seed: number): Float64Array {
	const random = seeded(seed);
	return Float64Array.from({ length: count * 2 }, () => random() * 1000);
}

function isPermutation(result: Int32Array): boolean {
	return [...result].sort((a, b) => a - b).every((value, index) => value === index);
}

describe("assignByBisection", () => {
	it("matches every point to a different partner, for any size", () => {
		for (const count of [0, 1, 2, 7, 300]) expect(isPermutation(assignByBisection(randomPoints(count, count + 1), randomPoints(count, count + 99)))).toBe(true);
	});

	it("still matches one to one when many points share a coordinate", () => {
		const same = Float64Array.from({ length: 40 }, (_, at) => (at % 2 === 0 ? 5 : at % 4 === 1 ? 1 : 2));
		expect(isPermutation(assignByBisection(same, same))).toBe(true);
		expect(isPermutation(assignByBisection(new Float64Array(20), randomPoints(10, 4)))).toBe(true);
	});

	it("gives the same answer every time", () => {
		const from = randomPoints(80, 3);
		const to = randomPoints(80, 8);
		expect(Array.from(assignByBisection(from, to))).toEqual(Array.from(assignByBisection(from, to)));
	});

	it("finds the exact partner when the points are a shuffled copy of the targets", () => {
		const targets = randomPoints(120, 5);
		const random = seeded(77);
		const order = Array.from({ length: 120 }, (_, index) => index).sort(() => random() - 0.5);
		const shuffled = new Float64Array(240);
		order.forEach((source, index) => {
			shuffled[index * 2] = targets[source * 2];
			shuffled[index * 2 + 1] = targets[source * 2 + 1];
		});
		const result = assignByBisection(shuffled, targets);
		order.forEach((source, index) => expect(result[index]).toBe(source));
	});

	it("sends a left cluster into the left half and a right cluster into the right half", () => {
		const random = seeded(9);
		const from = new Float64Array(200);
		const to = new Float64Array(200);
		for (let index = 0; index < 100; index++) {
			const left = index < 50;
			from[index * 2] = (left ? 0 : 900) + random() * 50;
			from[index * 2 + 1] = random() * 400;
			to[index * 2] = (left ? 0 : 1000) + random() * 300;
			to[index * 2 + 1] = random() * 300;
		}
		const result = assignByBisection(from, to);
		for (let index = 0; index < 100; index++) expect(to[result[index] * 2] < 500).toBe(index < 50);
	});

	it("keeps linked points close: far shorter links than a random matching", () => {
		const count = 200;
		const random = seeded(21);
		// A chain of clusters: points of a cluster sit together, and links join neighbours inside it.
		const from = new Float64Array(count * 2);
		const links: [number, number][] = [];
		for (let index = 0; index < count; index++) {
			const cluster = Math.floor(index / 20);
			from[index * 2] = (cluster % 5) * 300 + random() * 60;
			from[index * 2 + 1] = Math.floor(cluster / 5) * 300 + random() * 60;
			if (index % 20 !== 0) links.push([index, index - 1]);
		}
		const to = randomPoints(count, 6);
		const matched = assignByBisection(from, to);
		const shuffled = Int32Array.from({ length: count }, (_, index) => index).sort(() => random() - 0.5);
		const mean = (result: Int32Array) => links.reduce((sum, [a, b]) => sum + Math.hypot(to[result[a] * 2] - to[result[b] * 2], to[result[a] * 2 + 1] - to[result[b] * 2 + 1]), 0) / links.length;
		expect(mean(matched)).toBeLessThan(0.6 * mean(shuffled));
	});
});
