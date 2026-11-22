// How the map forms: when memories and relations appear, when the free layout hands over to the brain, how hard the brain pulls, and when its outline is drawn.
import type { GraphModel } from "./memory-graph-model.ts";

/** Fewer memories than this do not make a recognizable brain; they only get the appearing animation. */
export const minShapeNodes = 12;

/** How hard each memory is pulled toward its place in the brain, per tick, once the brain has formed. */
export const holdStrength = 0.1;

/** The outline's strength at rest (0..1). Zero removes the outline. */
export const outlineRestAlpha: number = 0.22;

// All times are in milliseconds from the first frame that is on screen.
const appearMs = 300;
// The first memory (the busiest) appears at 0, the last one this much later.
const introSpread = 260;
// A relation starts this long after the later of its two memories, and takes this long to reach the other end.
const edgeLag = 100;
const edgeMs = 260;
const introFreeMs = 900;
const introRampMs = 800;
const traceStartMs = 1300;
const traceMs = 700;
// Without a brain the intro is only memories and relations appearing.
const plainIntroMs = 680;
const quickRampMs = 500;
// A quick re-form waits for the free layout this long: when half or more of the memories kept their places, and when less did.
const quickFreeKeptMs = 350;
const quickFreeNewMs = 700;
// One long frame (a hidden tab, a stalled page) must not skip the animation.
const longestFrameSeconds = 0.1;

/** `intro`: the first time the map is shown. `quick`: later changes of the memories. `static`: reduced motion, the final state at once. */
export type PlanKind = "intro" | "quick" | "static";

/** What one change of the shown memories does. */
export interface Plan {
	kind: PlanKind;
	/** Whether the memories end up in the brain. */
	shaped: boolean;
	/** Whether anything is animated; false for `static`, and for `quick` without a brain. */
	animated: boolean;
	/** The free layout runs this long before the brain pulls. */
	freeMs: number;
	rampMs: number;
	/** When the whole animation is over. */
	totalMs: number;
	/** The outline fades in with the pull (a quick re-form that waits for the free layout) instead of being there at once. */
	fadeOutline: boolean;
}

/** What is known when the shown memories change. */
export interface PlanInput {
	/** The map has drawn memories before. */
	played: boolean;
	/** The share (0..1) of the new memories that were shown before. */
	kept: number;
	/** The memories were in the brain before the change. */
	wasShaped: boolean;
	nodeCount: number;
	/** False while the focus view shows a few memories, which are not a brain. */
	wantShape: boolean;
	reduced: boolean;
}

/** Decides how a change of the shown memories is presented. */
export function planFor(input: PlanInput): Plan {
	const shaped = input.wantShape && input.nodeCount >= minShapeNodes;
	if (input.reduced) return { kind: "static", shaped, animated: false, freeMs: 0, rampMs: 0, totalMs: 0, fadeOutline: false };
	if (!input.played) {
		const totalMs = shaped ? traceStartMs + traceMs : plainIntroMs;
		return { kind: "intro", shaped, animated: true, freeMs: introFreeMs, rampMs: introRampMs, totalMs, fadeOutline: false };
	}
	const mostKept = input.kept >= 0.5;
	const freeMs = input.wasShaped && mostKept ? 0 : mostKept ? quickFreeKeptMs : quickFreeNewMs;
	const totalMs = shaped ? Math.max(appearMs, freeMs + quickRampMs) : appearMs;
	return { kind: "quick", shaped, animated: shaped, freeMs, rampMs: quickRampMs, totalMs, fadeOutline: freeMs > 0 };
}

/** The running clock of one animation. */
export interface Form {
	readonly plan: Plan;
	/** Milliseconds shown so far. */
	elapsed: number;
	/** The memories have been matched to places in the brain. */
	assigned: boolean;
	readonly done: boolean;
	/** Moves the clock on by one frame; a single very long frame counts as 100 ms. */
	advance(seconds: number): void;
	/** Jumps to the end: everything visible, the brain pulling at full strength, the outline complete. */
	skip(): void;
}

/** Starts the clock for a plan that animates. */
export function createForm(plan: Plan): Form {
	return {
		plan,
		elapsed: 0,
		assigned: false,
		get done() {
			return this.elapsed >= plan.totalMs;
		},
		advance(seconds) {
			this.elapsed += Math.min(seconds, longestFrameSeconds) * 1000;
		},
		skip() {
			this.elapsed = Math.max(this.elapsed, plan.totalMs);
		},
	};
}

/** When each memory starts to appear: by rank in the intro (busiest first), at once for a new memory later, never for one already shown. */
export function startTimes(plan: Plan, model: GraphModel, isNew: Uint8Array): Float32Array {
	const starts = new Float32Array(model.nodes.length);
	if (plan.kind === "intro") {
		const ranks = introRanks(model);
		for (let index = 0; index < starts.length; index++) starts[index] = introStart(ranks[index], starts.length);
		return starts;
	}
	for (let index = 0; index < starts.length; index++) starts[index] = isNew[index] === 1 ? 0 : -appearMs;
	return starts;
}

/** Each memory's place in the order they appear: the most related first, then the most important, then by id. */
export function introRanks(model: GraphModel): Int32Array {
	const order = model.nodes
		.map((entry, index) => ({ index, degree: entry.degree, importance: entry.node.importance, id: entry.node.id }))
		.sort((a, b) => b.degree - a.degree || b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const ranks = new Int32Array(order.length);
	order.forEach((entry, rank) => {
		ranks[entry.index] = rank;
	});
	return ranks;
}

/** When the memory of this rank starts to appear. */
export function introStart(rank: number, count: number): number {
	return count <= 1 ? 0 : (introSpread * rank) / (count - 1);
}

/** How far a memory that starts at `start` has appeared (0..1): it fades in and grows, slowing down, without overshoot. */
export function revealAt(start: number, ms: number): number {
	return easeOut(clamp((ms - start) / appearMs));
}

/** How far a relation has been drawn (0..1), given when the later of its two memories started to appear. */
export function edgeProgressAt(start: number, ms: number): number {
	return easeOut(clamp((ms - start - edgeLag) / edgeMs));
}

/** How hard the brain pulls (0 up to `holdStrength`): nothing during the free layout, then a smooth ramp. */
export function strengthAt(plan: Plan, ms: number): number {
	return plan.shaped ? holdStrength * easeInOut(clamp((ms - plan.freeMs) / plan.rampMs)) : 0;
}

/** How much of the outline's length is drawn (0..1): the intro draws it stroke by stroke, later changes show it whole. */
export function traceAt(plan: Plan, ms: number): number {
	if (!plan.shaped) return 0;
	return plan.kind === "intro" ? easeInOut(clamp((ms - traceStartMs) / traceMs)) : 1;
}

/** How visible the outline is (0..1): it comes in with the pull when the memories have to travel first. */
export function fadeAt(plan: Plan, ms: number): number {
	if (!plan.shaped) return 0;
	return plan.fadeOutline ? easeInOut(clamp((ms - plan.freeMs) / plan.rampMs)) : 1;
}

/** The outline's strength: a little stronger while it is being drawn, then at rest. */
export function outlineAlphaAt(trace: number, fade: number): number {
	return outlineRestAlpha === 0 ? 0 : (outlineRestAlpha + 0.04 * (1 - trace)) * fade;
}

function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function easeOut(t: number): number {
	return 1 - (1 - t) ** 3;
}

function easeInOut(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
