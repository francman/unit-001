// Which memories get a label: priority order, zoom fade and collision avoidance. Pure; the canvas supplies positions and text widths.
import type { GraphModel } from "./memory-graph-model.ts";

/** A memory that wants a label, most important first. `must` labels are kept even where they overlap. */
export interface LabelPick {
	index: number;
	must: boolean;
	/** True when the memory is only named because it is among the busiest; those labels fade with the zoom, the others do not. */
	rest: boolean;
}

/** A pick with its place on screen: the memory's center and radius in pixels, and its label's text width. */
export interface LabelCandidate extends LabelPick {
	x: number;
	y: number;
	radius: number;
	width: number;
}

/** Where a kept label is drawn: the text's box in screen pixels, centered under its node. */
export interface LabelBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** What decides the order: who is selected or hovered, who is lit around them, who matches the search, and the busiest memories. */
export interface LabelInput {
	model: GraphModel;
	selected: number | null;
	hovered: number | null;
	/** Neighbours of the focused (hovered or selected) memory. */
	neighbours: ReadonlySet<number>;
	matches: ReadonlySet<number> | null;
	/** The top ~10% by degree, which are named at rest. */
	top: ReadonlySet<number>;
}

/** Text height in pixels and the space kept free around every label. */
export const labelHeight = 14;
const pad = 3;
const cell = 64;
const labelLimit = 60;

/** Labels are hidden when zoomed far out and fade in between these zooms. */
const fade = { from: 0.3, to: 0.6 } as const;

/** 0 when zoomed far out, 1 when zoomed in enough, smooth between; the rest-state labels use it as their opacity. */
export function zoomFade(k: number): number {
	const t = Math.min(1, Math.max(0, (k - fade.from) / (fade.to - fade.from)));
	return t * t * (3 - 2 * t);
}

/** The memories that want a label, in the order they win a contested place: selected, hovered, neighbours, search matches, then the busiest. */
export function labelOrder(input: LabelInput): LabelPick[] {
	const { model } = input;
	const picks: LabelPick[] = [];
	const seen = new Set<number>();
	const add = (index: number | null, must: boolean, rest: boolean) => {
		if (index === null || seen.has(index) || index < 0 || index >= model.nodes.length) return;
		seen.add(index);
		picks.push({ index, must, rest });
	};
	add(input.selected, true, false);
	add(input.hovered, true, false);
	for (const index of byImportance(model, input.neighbours)) add(index, false, false);
	for (const index of byImportance(model, input.matches ?? [])) add(index, false, false);
	for (const index of byImportance(model, input.top)) add(index, false, true);
	return picks;
}

/**
 * Keeps labels in priority order unless they would overlap one already kept or the circle of a memory whose label was kept.
 * `must` labels are always kept. At most 60 others are kept. Returns the box of every kept label by memory index.
 */
export function placeLabels(candidates: readonly LabelCandidate[]): Map<number, LabelBox> {
	const kept = new Map<number, LabelBox>();
	const grid = new Map<string, LabelBox[]>();
	const hits = (box: LabelBox) => {
		for (const bucket of cellsOf(box)) for (const other of grid.get(bucket) ?? []) if (overlaps(box, other)) return true;
		return false;
	};
	const insert = (box: LabelBox) => {
		for (const bucket of cellsOf(box)) grid.set(bucket, [...(grid.get(bucket) ?? []), box]);
	};
	let others = 0;
	for (const candidate of candidates) {
		const box = labelBox(candidate);
		if (!candidate.must && (others >= labelLimit || hits(box))) continue;
		if (!candidate.must) others += 1;
		kept.set(candidate.index, box);
		insert(box);
		insert({ x0: candidate.x - candidate.radius, y0: candidate.y - candidate.radius, x1: candidate.x + candidate.radius, y1: candidate.y + candidate.radius });
	}
	return kept;
}

function labelBox(candidate: LabelCandidate): LabelBox {
	const top = candidate.y + candidate.radius + 4;
	return { x0: candidate.x - candidate.width / 2 - pad, y0: top - pad, x1: candidate.x + candidate.width / 2 + pad, y1: top + labelHeight + pad };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
	return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function cellsOf(box: LabelBox): string[] {
	const cells: string[] = [];
	for (let column = Math.floor(box.x0 / cell); column <= Math.floor(box.x1 / cell); column++)
		for (let row = Math.floor(box.y0 / cell); row <= Math.floor(box.y1 / cell); row++) cells.push(`${column}:${row}`);
	return cells;
}

// Within one group the busiest and most important memories come first; the id breaks ties so the order is stable.
function byImportance(model: GraphModel, indices: Iterable<number>): number[] {
	return [...indices].sort((a, b) => {
		const left = model.nodes[a];
		const right = model.nodes[b];
		if (!left || !right) return 0;
		return right.degree - left.degree || right.node.importance - left.node.importance || (left.node.id < right.node.id ? -1 : 1);
	});
}
