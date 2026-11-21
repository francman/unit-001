// Draws the memory map on a canvas 2D context: relations with arrowheads, nodes sized by degree, rings and labels, all in screen pixels.
import type { EdgeKind, GraphNode } from "./memory-graph-details.ts";
import { type Placed, screenRadius, squareCorner, type View } from "./memory-graph-geometry.ts";
import type { GraphModel, ModelEdge } from "./memory-graph-model.ts";
import type { Theme } from "./memory-graph-theme.ts";

/** A label to draw: its text, the screen point of its top center, and how visible it is right now (0..1). */
export interface DrawnLabel {
	index: number;
	text: string;
	x: number;
	y: number;
	alpha: number;
	/** Selected, hovered and neighbour labels read in the strong text color. */
	strong: boolean;
}

/** Everything one frame needs. The caller decides what is hovered, selected or matched; this only paints it. */
export interface Scene {
	width: number;
	height: number;
	dpr: number;
	view: View;
	theme: Theme;
	model: GraphModel;
	bodies: readonly Placed[];
	/** The memory hovered or selected, whose neighbours stay lit; null when nothing is focused. */
	focus: number | null;
	/** 0 when the dimming is off, 1 when it is fully on; it moves between them over about 140 ms. */
	mix: number;
	/** Memories that contain the typed search, or null when nothing is typed. */
	matches: ReadonlySet<number> | null;
	selected: number | null;
	/** The memory the keyboard is on. */
	current: number | null;
	labels: readonly DrawnLabel[];
}

/** Strength of a memory that is not the focus or next to it, and of a relation that does not touch the focus. */
export const dimmedNode = 0.15;
export const dimmedEdge = 0.08;
const searchDimmed = 0.2;

/** How one kind of relation is drawn. `color` names the theme color, so tests can resolve it against the page's real tokens. */
export interface EdgeStyle {
	width: number;
	/** Strength at rest. Typed relations are the information; summary links are quieter, but every kind stays at 3:1 against the page. */
	alpha: number;
	dash: readonly number[];
	color: "fg3" | "ok" | "warn" | "info";
	head: "none" | "triangle" | "chevron" | "bar";
}

// Each relation kind differs by shape (dash and arrowhead) and also by color, so the map reads without color.
export const edgeStyles: Readonly<Record<EdgeKind, EdgeStyle>> = {
	summary: { width: 1, alpha: 0.8, dash: [], color: "fg3", head: "none" },
	relates: { width: 1.25, alpha: 0.85, dash: [2, 3], color: "fg3", head: "none" },
	supports: { width: 1.5, alpha: 0.85, dash: [], color: "ok", head: "triangle" },
	contradicts: { width: 1.5, alpha: 0.9, dash: [5, 3], color: "warn", head: "bar" },
	updates: { width: 1.5, alpha: 0.85, dash: [], color: "info", head: "chevron" },
};

const kindColors: Readonly<Record<GraphNode["kind"], (theme: Theme) => string>> = {
	fact: (theme) => theme.accent,
	preference: (theme) => theme.ok,
	decision: (theme) => theme.warn,
	observation: (theme) => theme.fg2,
};

/** The strength (0..1) a memory is drawn at: dimmed away from the focus, dimmed by a search it does not match. */
export function nodeOpacity(scene: Pick<Scene, "model" | "focus" | "mix" | "matches">, index: number): number {
	const matched = scene.matches === null || scene.matches.has(index) ? 1 : searchDimmed;
	if (scene.focus === null || scene.mix === 0) return matched;
	const lit = index === scene.focus || (scene.model.neighbours[scene.focus]?.includes(index) ?? false);
	return matched * (lit ? 1 : 1 - scene.mix * (1 - dimmedNode));
}

/** The strength a relation is drawn at: its own at rest, stronger when it touches the focus, nearly gone when it does not. */
export function edgeOpacity(scene: Pick<Scene, "focus" | "mix" | "matches">, edge: ModelEdge): number {
	const base = edgeStyles[edge.kind].alpha;
	const matched = scene.matches === null || scene.matches.has(edge.from) || scene.matches.has(edge.to) ? 1 : searchDimmed;
	if (scene.focus === null || scene.mix === 0) return base * matched;
	const touches = edge.from === scene.focus || edge.to === scene.focus;
	return matched * (touches ? base + scene.mix * (0.9 - base) : base + scene.mix * (dimmedEdge - base));
}

/** Paints one frame, replacing the last. The canvas stays transparent so the page shows through. */
export function draw(ctx: CanvasRenderingContext2D, scene: Scene): void {
	ctx.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);
	ctx.clearRect(0, 0, scene.width, scene.height);
	drawEdges(ctx, scene);
	drawNodes(ctx, scene);
	drawRings(ctx, scene);
	drawLabels(ctx, scene);
}

// Dimmed relations first, so the lit ones that touch the focus end up on top.
function drawEdges(ctx: CanvasRenderingContext2D, scene: Scene): void {
	const { model, view, bodies, focus } = scene;
	const order = model.edges
		.map((edge) => ({ edge, alpha: edgeOpacity(scene, edge), touches: focus !== null && (edge.from === focus || edge.to === focus) }))
		.sort((a, b) => Number(a.touches) - Number(b.touches));
	ctx.lineCap = "round";
	for (const { edge, alpha, touches } of order) {
		const from = bodies[edge.from];
		const to = bodies[edge.to];
		if (!from || !to || alpha < 0.005) continue;
		const style = edgeStyles[edge.kind];
		const x1 = from.x * view.k + view.x;
		const y1 = from.y * view.k + view.y;
		let x2 = to.x * view.k + view.x;
		let y2 = to.y * view.k + view.y;
		const length = Math.max(0.01, Math.hypot(x2 - x1, y2 - y1));
		const ux = (x2 - x1) / length;
		const uy = (y2 - y1) / length;
		const back = style.head === "none" ? 0 : screenRadius(to.radius, view.k) + 2;
		x2 -= ux * back;
		y2 -= uy * back;
		ctx.globalAlpha = alpha;
		ctx.strokeStyle = scene.theme[style.color];
		ctx.fillStyle = ctx.strokeStyle;
		ctx.lineWidth = touches && scene.mix > 0 ? style.width * 1.4 : style.width;
		ctx.setLineDash(style.dash);
		ctx.beginPath();
		ctx.moveTo(x1, y1);
		ctx.lineTo(x2, y2);
		ctx.stroke();
		if (style.head !== "none") {
			ctx.setLineDash([]);
			drawHead(ctx, style.head, x2, y2, ux, uy);
		}
	}
	ctx.setLineDash([]);
	ctx.globalAlpha = 1;
}

// The head's tip is at (x, y), pointing along (ux, uy): a filled triangle (supports), a chevron (updates) or a bar (contradicts).
function drawHead(ctx: CanvasRenderingContext2D, head: "triangle" | "chevron" | "bar", x: number, y: number, ux: number, uy: number): void {
	const size = 7;
	const px = -uy;
	const py = ux;
	ctx.beginPath();
	if (head === "bar") {
		ctx.moveTo(x - px * size * 0.55, y - py * size * 0.55);
		ctx.lineTo(x + px * size * 0.55, y + py * size * 0.55);
		ctx.lineWidth = 2;
		ctx.stroke();
		return;
	}
	const baseX = x - ux * size;
	const baseY = y - uy * size;
	if (head === "triangle") {
		ctx.moveTo(x, y);
		ctx.lineTo(baseX + px * size * 0.45, baseY + py * size * 0.45);
		ctx.lineTo(baseX - px * size * 0.45, baseY - py * size * 0.45);
		ctx.closePath();
		ctx.fill();
		return;
	}
	ctx.moveTo(baseX + px * size * 0.5, baseY + py * size * 0.5);
	ctx.lineTo(x, y);
	ctx.lineTo(baseX - px * size * 0.5, baseY - py * size * 0.5);
	ctx.lineWidth = 1.5;
	ctx.stroke();
}

// Dimmed memories first, then the lit ones on top. Working memories are circles, episodic ones rounded squares.
function drawNodes(ctx: CanvasRenderingContext2D, scene: Scene): void {
	const { model, view, bodies, theme } = scene;
	const order = model.nodes.map((_, index) => ({ index, alpha: nodeOpacity(scene, index) })).sort((a, b) => a.alpha - b.alpha);
	ctx.lineWidth = 1.5;
	for (const { index, alpha } of order) {
		const body = bodies[index];
		const entry = model.nodes[index];
		if (!body || !entry) continue;
		const x = body.x * view.k + view.x;
		const y = body.y * view.k + view.y;
		if (x < -40 || y < -40 || x > scene.width + 40 || y > scene.height + 40) continue;
		const radius = screenRadius(body.radius, view.k);
		// Importance is the secondary cue: the more important a memory, the more solid it is.
		ctx.globalAlpha = alpha * (0.68 + 0.32 * Math.min(1, Math.max(0, entry.node.importance)));
		ctx.fillStyle = kindColors[entry.node.kind](theme);
		ctx.strokeStyle = theme.canvas;
		shape(ctx, entry.node.tier === "working", x, y, radius);
		ctx.fill();
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
}

function shape(ctx: CanvasRenderingContext2D, round: boolean, x: number, y: number, radius: number): void {
	ctx.beginPath();
	if (round) ctx.arc(x, y, radius, 0, Math.PI * 2);
	else ctx.roundRect(x - radius, y - radius, radius * 2, radius * 2, squareCorner(radius));
}

// The selected memory gets a solid ring; the memory the keyboard is on gets a dashed accent ring.
function drawRings(ctx: CanvasRenderingContext2D, scene: Scene): void {
	const rings: [number | null, string, number, readonly number[]][] = [
		[scene.selected, scene.theme.fg, 3.5, []],
		[scene.current, scene.theme.accent, 7, [3, 3]],
	];
	ctx.lineWidth = 2;
	for (const [index, color, gap, dash] of rings) {
		const body = index === null ? undefined : scene.bodies[index];
		const entry = index === null ? undefined : scene.model.nodes[index];
		if (!body || !entry) continue;
		ctx.strokeStyle = color;
		ctx.setLineDash(dash);
		shape(ctx, entry.node.tier === "working", body.x * scene.view.k + scene.view.x, body.y * scene.view.k + scene.view.y, screenRadius(body.radius, scene.view.k) + gap);
		ctx.stroke();
	}
	ctx.setLineDash([]);
}

// Labels sit under their node, with a halo in the page color so lines behind them do not cut the text.
function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene): void {
	ctx.font = `11px ${scene.theme.font}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	ctx.lineJoin = "round";
	ctx.lineWidth = 3;
	for (const label of scene.labels) {
		if (label.alpha < 0.01) continue;
		ctx.globalAlpha = label.alpha;
		ctx.strokeStyle = scene.theme.canvas;
		ctx.strokeText(label.text, label.x, label.y);
		ctx.fillStyle = label.strong ? scene.theme.fg : scene.theme.fg2;
		ctx.fillText(label.text, label.x, label.y);
	}
	ctx.globalAlpha = 1;
}
