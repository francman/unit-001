// The brain the memory map forms: a side-view outline as plain data, an inside test, and seeded evenly spread points inside it.
import { seeded } from "./memory-graph-layout.ts";

/** The outline lives in a unit box: x from 0 to 1, y from 0 to this, y growing downward. */
export const brainHeight = 0.8;

/** A cubic Bezier piece: first control point, second control point, end point. */
type Curve = readonly [number, number, number, number, number, number];

/** The outline and the faint strokes drawn with it, flattened to points (`x, y, x, y, ...`) so inside tests and drawing need no canvas. */
export interface BrainShape {
	/** Closed: the last point equals the first. */
	outline: Float64Array;
	/** The sylvian fissure, the central sulcus and the cerebellar line. */
	details: readonly Float64Array[];
	outlineLength: number;
	detailLengths: readonly number[];
	/** Area of the outline in unit squares. */
	area: number;
}

/** The world box the brain is drawn in: `width` by `height`, centered on the map's origin. */
export interface BrainFrame {
	width: number;
	height: number;
}

// Facing left: the frontal lobe at the left, the occipital lobe at the right, the temporal lobe bulging below the sylvian notch,
// the cerebellum tucked under the occipital lobe and the brain stem hanging down in the middle.
const outlineStart = [0.03, 0.4] as const;
const outlineCurves: readonly Curve[] = [
	[0.03, 0.2, 0.16, 0.06, 0.34, 0.05],
	[0.52, 0.02, 0.74, 0.03, 0.86, 0.14],
	[0.95, 0.22, 0.98, 0.36, 0.94, 0.48],
	[0.93, 0.52, 0.9, 0.54, 0.87, 0.55],
	[0.95, 0.6, 0.9, 0.74, 0.76, 0.73],
	[0.68, 0.72, 0.64, 0.66, 0.62, 0.62],
	[0.62, 0.7, 0.6, 0.76, 0.58, 0.8],
	[0.55, 0.8, 0.52, 0.8, 0.5, 0.78],
	[0.5, 0.72, 0.5, 0.66, 0.49, 0.63],
	[0.42, 0.67, 0.31, 0.66, 0.25, 0.58],
	[0.24, 0.55, 0.23, 0.52, 0.22, 0.5],
	[0.13, 0.53, 0.03, 0.5, 0.03, 0.4],
];
const detailStrokes: readonly { start: readonly [number, number]; curve: Curve }[] = [
	{ start: [0.22, 0.5], curve: [0.34, 0.47, 0.5, 0.45, 0.64, 0.34] },
	{ start: [0.52, 0.04], curve: [0.5, 0.14, 0.46, 0.26, 0.44, 0.36] },
	{ start: [0.87, 0.55], curve: [0.8, 0.58, 0.7, 0.57, 0.62, 0.54] },
];
const stepsPerCurve = 24;

/** Targets keep this far from the outline, so no memory sits on the line. */
const rimMargin = 0.014;
const candidatesPerPoint = 12;
const targetSeed = 0x9e3779b1;

/** The brain, flattened once. */
export const brain: BrainShape = buildBrain();

/** True when the point (unit coordinates) lies inside the outline. */
export function insideBrain(x: number, y: number): boolean {
	const points = brain.outline;
	let inside = false;
	for (let at = 0, before = points.length - 2; at < points.length; before = at, at += 2) {
		const ax = points[at];
		const ay = points[at + 1];
		const bx = points[before];
		const by = points[before + 1];
		if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
	}
	return inside;
}

/** The distance from the point to the nearest part of the outline, in unit coordinates. */
export function distanceToOutline(x: number, y: number): number {
	const points = brain.outline;
	let best = Infinity;
	for (let at = 0; at + 3 < points.length; at += 2) {
		const ax = points[at];
		const ay = points[at + 1];
		const dx = points[at + 2] - ax;
		const dy = points[at + 3] - ay;
		const along = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
		best = Math.min(best, Math.hypot(x - (ax + along * dx), y - (ay + along * dy)));
	}
	return best;
}

/**
 * `count` points inside the outline (`x, y, x, y, ...`, unit coordinates), evenly spread without a grid look: each new point is
 * the farthest from the ones before it among a few random candidates. The same count gives the same points, and fewer points
 * are always the start of more, so one memory more or less moves almost nothing.
 */
export function brainTargets(count: number): Float64Array {
	const random = seeded(targetSeed);
	const points = new Float64Array(count * 2);
	for (let placed = 0; placed < count; placed++) {
		let bestX = 0;
		let bestY = 0;
		let bestGap = -1;
		for (let candidate = 0; candidate < candidatesPerPoint; candidate++) {
			let x: number;
			let y: number;
			do {
				x = random();
				y = random() * brainHeight;
			} while (!insideBrain(x, y) || distanceToOutline(x, y) < rimMargin);
			const gap = nearestGap(points, placed, x, y);
			if (gap > bestGap) {
				bestGap = gap;
				bestX = x;
				bestY = y;
			}
		}
		points[placed * 2] = bestX;
		points[placed * 2 + 1] = bestY;
	}
	return points;
}

/**
 * The world box that gives every memory room: its area follows the memories' drawn sizes, with a floor so a handful of
 * memories still make a brain of readable size (links are 90 to 120 units long).
 */
export function brainFrame(radii: ArrayLike<number>): BrainFrame {
	let area = 0;
	for (let index = 0; index < radii.length; index++) area += (Math.PI * (radii[index] + 4) ** 2) / 0.55;
	const width = Math.max(360, Math.sqrt(area / brain.area));
	return { width, height: width * brainHeight };
}

/** Unit points as world points, centered on the origin. */
export function worldPoints(unit: Float64Array, frame: BrainFrame): Float64Array {
	const world = new Float64Array(unit.length);
	for (let at = 0; at < unit.length; at += 2) {
		world[at] = (unit[at] - 0.5) * frame.width;
		world[at + 1] = (unit[at + 1] - brainHeight / 2) * frame.width;
	}
	return world;
}

// The distance from a point to the nearest of the first `count` points.
function nearestGap(points: Float64Array, count: number, x: number, y: number): number {
	let best = Infinity;
	for (let at = 0; at < count * 2; at += 2) best = Math.min(best, (points[at] - x) ** 2 + (points[at + 1] - y) ** 2);
	return Math.sqrt(best);
}

function buildBrain(): BrainShape {
	const outline = flatten(outlineStart, outlineCurves);
	const details = detailStrokes.map((stroke) => flatten(stroke.start, [stroke.curve]));
	return { outline, details, outlineLength: lengthOf(outline), detailLengths: details.map(lengthOf), area: areaOf(outline) };
}

function flatten(start: readonly [number, number], curves: readonly Curve[]): Float64Array {
	const points = new Float64Array(2 + curves.length * stepsPerCurve * 2);
	points[0] = start[0];
	points[1] = start[1];
	let x0: number = start[0];
	let y0: number = start[1];
	let at = 2;
	for (const [x1, y1, x2, y2, x3, y3] of curves) {
		for (let step = 1; step <= stepsPerCurve; step++) {
			const t = step / stepsPerCurve;
			const u = 1 - t;
			points[at++] = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
			points[at++] = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
		}
		x0 = x3;
		y0 = y3;
	}
	return points;
}

function lengthOf(points: Float64Array): number {
	let length = 0;
	for (let at = 0; at + 3 < points.length; at += 2) length += Math.hypot(points[at + 2] - points[at], points[at + 3] - points[at + 1]);
	return length;
}

// The shoelace formula; the outline is closed, so the last point meets the first.
function areaOf(points: Float64Array): number {
	let twice = 0;
	for (let at = 0; at + 3 < points.length; at += 2) twice += points[at] * points[at + 3] - points[at + 2] * points[at + 1];
	return Math.abs(twice) / 2;
}
