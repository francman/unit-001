// Matches every point of one set to a point of an equal-sized set by recursive median splits: neighbours stay neighbours and paths do not cross much.

/**
 * `from` and `to` hold the same number of points (`x, y, x, y, ...`). Returns, for each point of `from`, the index of its
 * partner in `to`; every partner is used once. Only the order along an axis is used, so the two sets need not share a
 * scale or a center.
 *
 * Each step splits the targets along their wider direction into a lower and an upper half, splits the points the same
 * way by rank, and matches the halves separately. A full optimal matching costs far more (cubic) for little visible gain.
 */
export function assignByBisection(from: Float64Array, to: Float64Array): Int32Array {
	const count = from.length / 2;
	const result = new Int32Array(count);
	const sources = Int32Array.from({ length: count }, (_, index) => index);
	const slots = Int32Array.from({ length: count }, (_, index) => index);
	match(from, to, sources, slots, result);
	return result;
}

// `sources` and `slots` are equal-sized windows; both are reordered in place.
function match(from: Float64Array, to: Float64Array, sources: Int32Array, slots: Int32Array, result: Int32Array): void {
	if (sources.length === 0) return;
	if (sources.length === 1) {
		result[sources[0]] = slots[0];
		return;
	}
	const axis = widerAxis(to, slots);
	sources.sort((a, b) => from[a * 2 + axis] - from[b * 2 + axis] || a - b);
	slots.sort((a, b) => to[a * 2 + axis] - to[b * 2 + axis] || a - b);
	const half = Math.floor(sources.length / 2);
	match(from, to, sources.subarray(0, half), slots.subarray(0, half), result);
	match(from, to, sources.subarray(half), slots.subarray(half), result);
}

// 0 for x or 1 for y: the direction in which the given points are spread widest.
function widerAxis(points: Float64Array, indices: Int32Array): 0 | 1 {
	let x0 = Infinity;
	let x1 = -Infinity;
	let y0 = Infinity;
	let y1 = -Infinity;
	for (const index of indices) {
		const x = points[index * 2];
		const y = points[index * 2 + 1];
		x0 = Math.min(x0, x);
		x1 = Math.max(x1, x);
		y0 = Math.min(y0, y);
		y1 = Math.max(y1, y);
	}
	return x1 - x0 >= y1 - y0 ? 0 : 1;
}
