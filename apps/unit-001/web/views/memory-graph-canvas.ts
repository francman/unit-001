// The map's canvas: owns the layout, the view, the hover and keyboard state and the frame loop; frames are drawn only while something moves.
import { attrs, el } from "../ui/dom.ts";
import type { GraphNode } from "./memory-graph-details.ts";
import { assignByBisection } from "./memory-graph-assign.ts";
import { type BrainFrame, brainFrame, brainTargets, worldPoints } from "./memory-graph-brain.ts";
import { type DrawnLabel, draw, type FormScene, nodeOpacity, type OutlineScene } from "./memory-graph-draw.ts";
import { createForm, edgeProgressAt, fadeAt, type Form, holdStrength, outlineAlphaAt, type Plan, planFor, revealAt, startTimes, strengthAt, traceAt } from "./memory-graph-form.ts";
import { fitBox, hitTest, nodeInDirection, panIntoView, type Placed, screenRadius, toWorld, type View, zoomAt } from "./memory-graph-geometry.ts";
import { type Input, type InputTarget, wireInput } from "./memory-graph-input.ts";
import { type LabelCandidate, labelOrder, placeLabels, zoomFade } from "./memory-graph-labels.ts";
import { bounds, createSimulation, type LayoutEdge, type LayoutNode, type Simulation, settleWithin } from "./memory-graph-layout.ts";
import { watchMedia, watchPixelRatio } from "./memory-graph-media.ts";
import { type GraphModel, litBy, sameLayout, topByDegree } from "./memory-graph-model.ts";
import { createProbes, type Theme, watchTheme } from "./memory-graph-theme.ts";

/** What the map reports to the page that owns it. */
export interface CanvasHandlers {
	/** A memory was clicked, or chosen with the keyboard. */
	onSelect(id: string): void;
	/** Empty space was clicked, or Escape cleared the selection. */
	onClear(): void;
	/** Escape with nothing selected; returns true when the page used it (it leaves the focus view). */
	onEscapeIdle(): boolean;
	/** The sentence a screen reader hears when the keyboard lands on a memory with `related` neighbours. */
	describe(node: GraphNode, related: number): string;
	/** The line under the hovered or keyboard-focused memory. */
	preview(node: GraphNode): string;
	/** The text of the memory's label on the map. */
	labelText(node: GraphNode): string;
}

/** The map's canvas and the little state it needs. The page decides what is selected, matched and shown. */
export interface GraphCanvas {
	/** The element to place in the page: the focusable frame around the canvas. */
	readonly frame: HTMLElement;
	/** The one-line preview of the hovered memory, shown at the frame's bottom-left. */
	readonly hover: HTMLElement;
	/**
	 * Shows another set of memories; memories that stay keep their place. Any drag in progress ends first. With `shape` the
	 * memories form a brain (when there are enough of them); without it they stay a plain layout, as in the focus view.
	 */
	setModel(model: GraphModel, options?: { shape: boolean }): void;
	setSelected(id: string | null): void;
	/** The ids that match the typed search, or null when nothing is typed. */
	setMatches(ids: ReadonlySet<string> | null): void;
	/** Lets pointer drags and wheel events manipulate the map instead of scrolling the page. */
	setGestures(enabled: boolean): void;
	/** Fits the map around the details panel. */
	fit(): void;
	zoomBy(factor: number): void;
	/** Tells screen readers something through the map's polite live region. */
	announce(text: string): void;
	/**
	 * Releases everything the map holds, for good: observers, listeners, timers and frames. Leaving the page does the same
	 * for the subscriptions outside the frame by itself (and wakes them when the frame is placed again); this is the end.
	 */
	dispose(): void;
}

const mixSeconds = 0.14;
const labelEase = 0.25;
const maxZoomOnFit = 1.6;
const ticksPerFrame = 2;
// While the map forms, the layout runs by time instead of by frame, so it settles equally fast on a 120 Hz screen.
const ticksPerSecond = 180;
const mostTicksPerFrame = 6;
// One batch of a reduced-motion settle: short enough that input and rendering stay responsive between batches.
const settleBatchMs = 8;

/** A layout being settled off to the side; it replaces the shown one in a single step once it has rested. */
interface Pending {
	model: GraphModel;
	simulation: Simulation;
	/** True when nothing was shown before, so the view fits the map even if it was moved. */
	fresh: boolean;
	/** Whether the memories are to form a brain. */
	shape: boolean;
	/** 1 for each memory that was not shown before. */
	isNew: Uint8Array;
	/** The share (0..1) of the memories that were shown before. */
	kept: number;
}

/** Builds the canvas. It draws nothing until it has a model and a size. */
export function createGraphCanvas(handlers: CanvasHandlers, panel: HTMLElement): GraphCanvas {
	const canvas = attrs(el("canvas", "absolute inset-0 block size-full select-none"), { role: "img", "aria-label": "Memory graph" });
	const context = canvas.getContext("2d");
	const probes = createProbes();
	const hover = attrs(
		el("p", "pointer-events-none absolute bottom-2 left-2 hidden max-w-[min(32rem,calc(100%-1rem))] truncate rounded-sm border border-stroke-3 bg-elevated px-2 py-1 text-sm text-fg"),
		{ "aria-hidden": "true" },
	);
	const hint = el(
		"p",
		"sr-only",
		"Press Enter to move between memories with the arrow keys, Enter again to open one, Escape to leave. Shift with an arrow key moves the view, plus and minus zoom, zero fits the whole map. The List view shows the same memories as text.",
	);
	hint.id = "graph-hint";
	const live = attrs(el("p", "sr-only"), { role: "status", "aria-live": "polite", "aria-atomic": "true" });
	const frame = attrs(el("div", "relative size-full min-w-0 overflow-hidden", canvas, hover, hint, live, probes.root), {
		tabindex: "0",
		role: "group",
		"aria-describedby": "graph-hint",
		"data-graph": "",
	});

	let model: GraphModel = { nodes: [], edges: [], neighbours: [], indexOf: new Map() };
	let paintedModel = model;
	const painted: Placed[] = [];
	let simulation: Simulation | null = null;
	let pending: Pending | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let view: View = { x: 0, y: 0, k: 1 };
	// False until the person pans or zooms; until then the view keeps fitting the map.
	let touched = false;
	let usableWidth = 0;
	let usableHeight = 0;
	let viewportDirty = true;
	let followSelection = false;
	let gestures = false;
	let width = 0;
	let height = 0;
	let dpr = 1;
	// Colors can only be read once the frame is in the page, so they are read at the first frame and after every theme change.
	let theme: Theme | null = null;
	let selectedId: string | null = null;
	let matchIds: ReadonlySet<string> | null = null;
	let hovered = -1;
	let current = -1;
	let top: ReadonlySet<number> = new Set();
	let mix = 0;
	let raf: number | null = null;
	let lastTime = 0;
	let ticksSinceLabels = 0;
	let relabelNeeded = true;
	let announceTimer: ReturnType<typeof setTimeout> | null = null;
	let dragging = false;
	// How the map forms: the memories appear, then settle into a brain (see memory-graph-form.ts). Null when everything is shown.
	let form: Form | null = null;
	// Whether the shown memories are held in the brain, and whether the last model asked for that.
	let shapeOn = false;
	let wantShape = true;
	// The map has drawn memories once; later changes re-form quickly instead of playing the intro again.
	let played = false;
	// Points of the brain for the largest map shown so far; fewer points are the start of more, so one cache serves every size.
	let unitTargets: Float64Array = new Float64Array(0);
	// Each memory's place in the brain (world units, in model order) and the size of the brain's box; set when they are matched.
	let places: Float64Array | null = null;
	let brainBox: BrainFrame | null = null;
	let starts: Float32Array = new Float32Array(0);
	let formScene: FormScene = { reveal: new Float32Array(0), edgeProgress: new Float32Array(0) };
	const outlineScene: OutlineScene = { size: 0, alpha: 0, trace: 0 };
	let tickDebt = 0;
	// Label widths by text; cleared whenever the shown memories change so old memory text is not kept.
	const widths = new Map<string, number>();
	const labels = new Map<number, { alpha: number; target: number; text: string; strong: boolean; rest: boolean }>();

	const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
	const reduced = () => reducedQuery.matches;
	const indexOfId = (id: string | null) => (id === null ? -1 : (model.indexOf.get(id) ?? -1));
	const selected = () => indexOfId(selectedId);
	// The memory whose neighbours stay lit: what the pointer or keyboard is on, else the selection.
	const focus = () => (hovered >= 0 ? hovered : current >= 0 ? current : selected());
	const nodeAt = (index: number) => model.nodes[index]?.node;
	// The search matches as indices into the shown memories; kept up to date when either side changes.
	let found: Set<number> | null = null;
	const findMatches = () => {
		found = null;
		if (matchIds === null) return;
		const ids = matchIds;
		found = new Set(model.nodes.flatMap((entry, index) => (ids.has(entry.node.id) ? [index] : [])));
	};

	// In the page and showing: a frame that was removed or hidden measures 0 x 0.
	function onScreen(): boolean {
		return frame.isConnected && frame.clientWidth > 0 && frame.clientHeight > 0;
	}

	function schedule(): void {
		if (raf === null) raf = requestAnimationFrame(frameLoop);
	}

	function invalidate(labelsToo: boolean): void {
		if (labelsToo) relabelNeeded = true;
		schedule();
	}

	function resize(): void {
		const nextWidth = frame.clientWidth;
		const nextHeight = frame.clientHeight;
		const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
		viewportDirty = false;
		const resized = nextWidth !== width || nextHeight !== height || nextDpr !== dpr;
		if (resized) {
			width = nextWidth;
			height = nextHeight;
			dpr = nextDpr;
			// Resizing the backing store clears the last painted shapes too.
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			painted.length = 0;
		}
		let freeWidth = width;
		let freeHeight = height;
		if (!panel.hidden) {
			const box = frame.getBoundingClientRect();
			const cover = panel.getBoundingClientRect();
			// The floating panel docks right at Tailwind's lg breakpoint, bottom otherwise.
			if (matchMedia("(min-width: 64rem)").matches) freeWidth = Math.max(1, cover.left - box.left);
			else freeHeight = Math.max(1, cover.top - box.top);
		}
		if (!resized && usableWidth === freeWidth && usableHeight === freeHeight) return;
		usableWidth = freeWidth;
		usableHeight = freeHeight;
		followSelection = selectedId !== null;
		if (!touched && simulation) view = fitView(simulation);
		invalidate(true);
	}

	function fit(): void {
		touched = false;
		followSelection = selectedId !== null;
		if (width > 0 && height > 0 && simulation) view = fitView(simulation);
		invalidate(true);
	}

	// The box around the map, centered in the part of the frame no panel covers. While the memories form a brain the box
	// includes the whole brain from the start, so the view does not jump when they are handed to it and the stem is not cut off.
	function fitView(layout: Simulation): View {
		const box = bounds(layout, 40);
		if (brainBox) {
			const margin = 40;
			box.x0 = Math.min(box.x0, -brainBox.width / 2 - margin);
			box.x1 = Math.max(box.x1, brainBox.width / 2 + margin);
			box.y0 = Math.min(box.y0, -brainBox.height / 2 - margin);
			box.y1 = Math.max(box.y1, brainBox.height / 2 + margin);
		}
		return fitBox(box, Math.max(1, usableWidth), Math.max(1, usableHeight), maxZoomOnFit);
	}

	function measure(text: string): number {
		const known = widths.get(text);
		if (known !== undefined) return known;
		if (!context) return text.length * 6;
		context.font = `11px ${theme?.font ?? "sans-serif"}`;
		const measured = context.measureText(text).width;
		widths.set(text, measured);
		return measured;
	}

	// Decides which labels exist: the top ~10% by degree at rest, plus the selected, hovered, lit and matching memories.
	function relabel(): void {
		relabelNeeded = false;
		ticksSinceLabels = 0;
		const focused = focus();
		const hovering = hovered >= 0 ? hovered : current;
		const picks = labelOrder({
			model,
			selected: selected() >= 0 ? selected() : null,
			hovered: hovering >= 0 ? hovering : null,
			neighbours: focused >= 0 ? litBy(model, focused) : new Set(),
			matches: found,
			top,
		});
		const fade = zoomFade(view.k);
		const candidates: LabelCandidate[] = [];
		const texts = new Map<number, string>();
		for (const pick of picks) {
			if (pick.rest && fade < 0.02) continue;
			const body = simulation?.bodies[pick.index];
			const node = nodeAt(pick.index);
			if (!body || !node) continue;
			const text = handlers.labelText(node);
			texts.set(pick.index, text);
			candidates.push({ ...pick, x: body.x * view.k + view.x, y: body.y * view.k + view.y, radius: screenRadius(body.radius, view.k), width: measure(text) });
		}
		const kept = placeLabels(candidates);
		for (const candidate of candidates) {
			const target = kept.has(candidate.index) ? (candidate.rest ? 0.85 * fade : 0.95) : 0;
			const known = labels.get(candidate.index);
			const strong = !candidate.rest;
			const text = texts.get(candidate.index) ?? "";
			if (known) Object.assign(known, { target, strong, rest: candidate.rest, text });
			else if (target > 0) labels.set(candidate.index, { alpha: reduced() ? target : 0, target, text, strong, rest: candidate.rest });
		}
		for (const [index, label] of labels) if (!candidates.some((candidate) => candidate.index === index)) label.target = 0;
	}

	function frameLoop(now: number): void {
		raf = null;
		// A frame that is out of the page measures as 0 x 0; drawing then would wreck the view. Placing it again wakes the loop.
		if (!onScreen()) {
			lastTime = 0;
			return;
		}
		activate();
		const seconds = Math.min(0.1, lastTime === 0 ? 0.016 : (now - lastTime) / 1000);
		lastTime = now;
		if (theme === null) theme = probes.read();
		if (viewportDirty || frame.clientWidth !== width || frame.clientHeight !== height) resize();
		if (form) advanceForm(seconds);
		let moving = false;
		// While a reduced-motion layout settles to the side, the shown one stands still.
		if (simulation?.active && pending === null) {
			moving = true;
			const ticks = form ? tickBudget(seconds) : ticksPerFrame;
			for (let tick = 0; tick < ticks && moving; tick++) moving = simulation.step();
			if (!touched && !dragging) view = fitView(simulation);
			ticksSinceLabels += 1;
			// While the layout moves the kept labels stay; they are decided again now and then, and once it stops.
			if (!moving || ticksSinceLabels > 20) relabelNeeded = true;
		}
		if (followSelection) {
			const body = simulation?.bodies[selected()];
			if (body) {
				const margin = screenRadius(body.radius, view.k) + 8;
				const { dx, dy } = panIntoView(body.x * view.k + view.x, body.y * view.k + view.y, usableWidth, usableHeight, margin);
				if (dx !== 0 || dy !== 0) {
					view = { ...view, x: view.x + dx, y: view.y + dy };
					relabelNeeded = true;
				}
			}
			if (!moving && !form && !pending) followSelection = false;
		}
		const wanted = focus() >= 0 ? 1 : 0;
		const stepMix = reduced() ? 1 : seconds / mixSeconds;
		const nextMix = mix < wanted ? Math.min(wanted, mix + stepMix) : Math.max(wanted, mix - stepMix);
		const mixing = nextMix !== mix;
		mix = nextMix;
		// Labels wait until the map has formed; deciding them while memories move and appear would only make them flicker.
		if (relabelNeeded && form === null) relabel();
		let fading = false;
		const drawn: DrawnLabel[] = [];
		const scene = { model, focus: focus() >= 0 ? focus() : null, mix, matches: found };
		for (const [index, label] of labels) {
			label.alpha = reduced() ? label.target : label.alpha + (label.target - label.alpha) * labelEase;
			if (Math.abs(label.target - label.alpha) > 0.01) fading = true;
			else label.alpha = label.target;
			if (label.alpha === 0 && label.target === 0) {
				labels.delete(index);
				continue;
			}
			const body = simulation?.bodies[index];
			if (!body) continue;
			drawn.push({
				index,
				text: label.text,
				x: body.x * view.k + view.x,
				y: body.y * view.k + view.y + screenRadius(body.radius, view.k) + 4,
				alpha: label.alpha * (label.rest ? nodeOpacity(scene, index) : 1),
				strong: label.strong,
			});
		}
		if (context && simulation && theme && width > 0 && height > 0) {
			draw(context, {
				...scene,
				width,
				height,
				dpr,
				view,
				theme,
				bodies: simulation.bodies,
				selected: selected() >= 0 ? selected() : null,
				current: current >= 0 ? current : null,
				labels: drawn,
				form: form ? formScene : null,
				outline: outlineFor(),
			}, painted);
			paintedModel = model;
			if (model.nodes.length > 0) played = true;
		}
		if (moving || mixing || fading || dragging || form !== null) schedule();
		else lastTime = 0;
	}

	// ── Forming: the memories appear, then settle into a brain ──

	// The layout's ticks for one frame while the map forms: by time, at most a few at once, so a slow frame does not stall the page.
	function tickBudget(seconds: number): number {
		tickDebt += seconds * ticksPerSecond;
		const ticks = Math.min(mostTicksPerFrame, Math.floor(tickDebt));
		tickDebt = Math.min(1, tickDebt - ticks);
		return ticks;
	}

	// Moves the clock on: hands the memories to the brain at the right moment, sets the pull and what has appeared so far.
	function advanceForm(seconds: number): void {
		const running = form;
		if (!running || !simulation) return;
		running.advance(seconds);
		const { plan, elapsed } = running;
		if (plan.shaped) {
			if (!running.assigned && elapsed >= plan.freeMs) {
				running.assigned = true;
				assignPlaces(simulation);
			}
			if (running.assigned && places) simulation.attract(places, strengthAt(plan, elapsed));
		}
		for (let index = 0; index < formScene.reveal.length; index++) formScene.reveal[index] = revealAt(starts[index], elapsed);
		model.edges.forEach((edge, index) => {
			formScene.edgeProgress[index] = edgeProgressAt(Math.max(starts[edge.from], starts[edge.to]), elapsed);
		});
		if (running.done) {
			form = null;
			frame.dataset.formed = "true";
			relabelNeeded = true;
			if (places) simulation.attract(places, holdStrength);
		}
	}

	// The outline of the brain, while the memories are held in it; null otherwise.
	function outlineFor(): OutlineScene | null {
		if (!shapeOn || brainBox === null) return null;
		const trace = form ? traceAt(form.plan, form.elapsed) : 1;
		outlineScene.size = brainBox.width;
		outlineScene.trace = trace;
		outlineScene.alpha = outlineAlphaAt(trace, form ? fadeAt(form.plan, form.elapsed) : 1);
		return outlineScene;
	}

	// Matches each memory to a place in the brain by where it is now, and returns the places in model order.
	function assignPlaces(layout: Simulation): Float64Array {
		const count = layout.bodies.length;
		prepareTargets(count);
		const box = brainBox ?? brainFrame(layout.bodies.map((body) => body.radius));
		const slots = worldPoints(unitTargets.subarray(0, count * 2), box);
		const now = new Float64Array(count * 2);
		layout.bodies.forEach((body, index) => {
			now[index * 2] = body.x;
			now[index * 2 + 1] = body.y;
		});
		const slotOf = assignByBisection(now, slots);
		const mine = new Float64Array(count * 2);
		for (let index = 0; index < count; index++) {
			mine[index * 2] = slots[slotOf[index] * 2];
			mine[index * 2 + 1] = slots[slotOf[index] * 2 + 1];
		}
		places = mine;
		brainBox = box;
		return mine;
	}

	// Choosing the brain's points is the one costly step (about 15 ms for 300 memories), so it is done when the memories arrive,
	// before the animation's clock starts, and only when the map has grown past the points chosen so far.
	function prepareTargets(count: number): void {
		if (unitTargets.length < count * 2) unitTargets = brainTargets(count);
	}

	// Ends the animation where it was going: every memory in its place in the brain, at rest.
	function settleIntoBrain(layout: Simulation): void {
		const mine = places ?? assignPlaces(layout);
		layout.attract(mine, holdStrength);
		layout.snap(mine);
	}

	// An intentional map action skips the remaining animation; the pointer target still comes from the last paint.
	function skipForm(): void {
		if (!form) return;
		form.skip();
		invalidate(false);
	}

	function setHovered(index: number): void {
		if (index === hovered) return;
		hovered = index;
		showPreview(index >= 0 ? index : current);
		frame.classList.toggle("cursor-pointer", index >= 0);
		frame.classList.toggle("cursor-grab", gestures && index < 0);
		invalidate(true);
	}

	function showPreview(index: number): void {
		const node = nodeAt(index);
		hover.classList.toggle("hidden", !node);
		hover.textContent = node ? handlers.preview(node) : "";
	}

	function announce(text: string): void {
		if (announceTimer !== null) clearTimeout(announceTimer);
		// Clearing is immediate: stale text about a memory that is gone or deselected must not linger.
		if (text === "") {
			announceTimer = null;
			live.textContent = "";
			return;
		}
		announceTimer = setTimeout(() => {
			announceTimer = null;
			live.textContent = text;
		}, 150);
	}

	function pan(dx: number, dy: number): void {
		skipForm();
		view = { ...view, x: view.x + dx, y: view.y + dy };
		touched = true;
		followSelection = false;
		invalidate(true);
	}

	function zoom(factor: number, px: number, py: number): void {
		skipForm();
		view = zoomAt(view, factor, px, py);
		touched = true;
		followSelection = false;
		invalidate(true);
	}

	function moveCurrent(index: number): void {
		const node = nodeAt(index);
		if (!node || !simulation) return;
		current = index;
		const body = simulation.bodies[index];
		if (body) {
			const { dx, dy } = panIntoView(body.x * view.k + view.x, body.y * view.k + view.y, usableWidth, usableHeight, 48);
			if (dx !== 0 || dy !== 0) pan(dx, dy);
		}
		showPreview(index);
		announce(handlers.describe(node, model.neighbours[index]?.length ?? 0));
		invalidate(true);
	}

	// ── Layout: a model arrives, is laid out and replaces the shown one ──

	function layoutNodes(next: GraphModel): LayoutNode[] {
		return next.nodes.map((entry) => ({ id: entry.node.id, radius: entry.radius, degree: entry.degree, square: entry.node.tier === "episodic" }));
	}

	function layoutEdges(next: GraphModel): LayoutEdge[] {
		return next.edges.map((edge) => ({ from: next.nodes[edge.from]?.node.id ?? "", to: next.nodes[edge.to]?.node.id ?? "", typed: edge.kind !== "summary" }));
	}

	// A layout for `next` that starts where the shown memories are now.
	function layoutFor(next: GraphModel, shape: boolean): Pending {
		const previous = new Map<string, { x: number; y: number }>();
		if (simulation) for (const body of simulation.bodies) previous.set(body.id, { x: body.x, y: body.y });
		const isNew = new Uint8Array(next.nodes.length);
		let kept = 0;
		next.nodes.forEach((entry, index) => {
			if (previous.has(entry.node.id)) kept += 1;
			else isNew[index] = 1;
		});
		return {
			model: next,
			simulation: createSimulation(layoutNodes(next), layoutEdges(next), previous),
			fresh: previous.size === 0,
			shape,
			isNew,
			kept: next.nodes.length === 0 ? 0 : kept / next.nodes.length,
		};
	}

	// Reduced motion: the layout runs to rest in short batches between frames, and only its final places are shown.
	function settleLater(next: Pending): void {
		cancelPending();
		pending = next;
		settleTimer = setTimeout(settleBatch, 0);
	}

	function settleBatch(): void {
		settleTimer = null;
		const next = pending;
		if (!next) return;
		if (!settleWithin(next.simulation, settleBatchMs)) {
			settleTimer = setTimeout(settleBatch, 0);
			return;
		}
		// A new layout can reorder the indices that an active press holds.
		input?.cancel();
		pending = null;
		commit(next);
	}

	function cancelPending(): void {
		if (settleTimer !== null) clearTimeout(settleTimer);
		settleTimer = null;
		pending = null;
	}

	// Makes a laid-out model the shown one, keeping what the person is on by id.
	function commit(next: Pending): void {
		const keepHovered = hovered >= 0 ? (model.nodes[hovered]?.node.id ?? null) : null;
		const keepCurrent = current >= 0 ? (model.nodes[current]?.node.id ?? null) : null;
		const plan = planFor({ played, kept: next.kept, wasShaped: shapeOn, nodeCount: next.model.nodes.length, wantShape: next.shape, reduced: reduced() });
		model = next.model;
		simulation = next.simulation;
		hovered = keepHovered === null ? -1 : (model.indexOf.get(keepHovered) ?? -1);
		current = keepCurrent === null ? -1 : (model.indexOf.get(keepCurrent) ?? -1);
		describeModel();
		labels.clear();
		startForm(plan, next);
		if (!touched || next.fresh) fit();
		followSelection = selectedId !== null;
		invalidate(true);
	}

	// Starts how the new memories are presented: an animation, or at once their final places (reduced motion).
	function startForm(plan: Plan, next: Pending): void {
		shapeOn = plan.shaped;
		places = null;
		brainBox = plan.shaped ? brainFrame(next.model.nodes.map((entry) => entry.radius)) : null;
		if (plan.shaped) prepareTargets(next.model.nodes.length);
		form = null;
		if (plan.shaped && !plan.animated) settleIntoBrain(next.simulation);
		if (plan.animated && model.nodes.length > 0) {
			form = createForm(plan);
			starts = startTimes(plan, model, next.isNew);
			formScene = { reveal: new Float32Array(model.nodes.length), edgeProgress: new Float32Array(model.edges.length) };
			tickDebt = 0;
		}
		frame.dataset.formed = String(form === null);
		frame.dataset.shaped = String(shapeOn);
	}

	// What follows from the shown memories alone: the busiest ones, the search matches, the map's description and the preview line.
	function describeModel(): void {
		top = topByDegree(model, 0.1);
		findMatches();
		widths.clear();
		canvas.setAttribute("aria-label", `Map of ${model.nodes.length} ${model.nodes.length === 1 ? "memory" : "memories"} and ${model.edges.length} ${model.edges.length === 1 ? "relation" : "relations"}`);
		showPreview(hovered >= 0 ? hovered : current);
	}

	// ── Input ──

	const target: InputTarget = {
		hit(px, py, slop) {
			const index = hitTest(painted, px, py, slop);
			if (paintedModel === model) return index;
			return indexOfId(paintedModel.nodes[index]?.node.id ?? null);
		},
		hover: setHovered,
		click(index) {
			skipForm();
			const node = nodeAt(index);
			if (node) {
				current = -1;
				handlers.onSelect(node.id);
			} else handlers.onClear();
		},
		dragNode(index, px, py, start) {
			if (!simulation) return;
			if (start) skipForm();
			const point = toWorld(view, px, py);
			touched = true;
			followSelection = false;
			simulation.pin(index, point.x, point.y);
			// Reduced motion: the node moves but the others do not wiggle; they settle once when it is let go.
			if (start && !reduced()) simulation.reheat();
			dragging = true;
			invalidate(false);
		},
		dropNode(index) {
			dragging = false;
			if (!simulation) return;
			simulation.release(index);
			if (pending) return;
			// Reduced motion: the dragged memory goes back to its place in the brain, or a new layout starts warm from where everything is now and settles to the side.
			if (reduced() && shapeOn && places) {
				simulation.attract(places, holdStrength);
				simulation.snap(places);
			} else if (reduced()) settleLater(layoutFor(model, shapeOn));
			invalidate(true);
		},
		pan,
		grabbing(on) {
			frame.classList.toggle("cursor-grabbing", on);
			frame.classList.toggle("cursor-grab", gestures && !on && hovered < 0);
		},
		zoom,
		arrow(dx, dy, panView) {
			skipForm();
			if (current >= 0 && !panView && simulation) moveCurrent(nodeInDirection(simulation.bodies, current, dx, dy));
			else pan(-dx * 48, -dy * 48);
		},
		activate() {
			skipForm();
			const node = nodeAt(current);
			if (node) handlers.onSelect(node.id);
			else if (model.nodes.length > 0) {
				// Enter on the frame starts moving between memories, from the selected one or the busiest.
				const start = selected() >= 0 ? selected() : [...top][0];
				moveCurrent(start ?? 0);
			}
		},
		escape() {
			if (selectedId !== null) {
				handlers.onClear();
				return true;
			}
			if (current >= 0) {
				current = -1;
				showPreview(hovered);
				invalidate(true);
				return true;
			}
			return handlers.onEscapeIdle();
		},
		zoomStep: (factor) => zoom(factor, width / 2, height / 2),
		fit: () => {
			skipForm();
			fit();
		},
		leave() {
			if (current < 0) return;
			current = -1;
			showPreview(hovered);
			invalidate(true);
		},
	};

	// ── Lifecycle: subscriptions exist only while the frame is in the page ──

	let input: Input | null = null;
	let stops: (() => void)[] = [];

	function activate(): void {
		if (input) return;
		input = wireInput(frame, target, () => gestures);
		// The preference may have changed while the frame was detached and had no listener.
		applyReducedMotion();
		viewportDirty = true;
		followSelection = selectedId !== null;
		// Colors may have changed while the map was away.
		theme = null;
		widths.clear();
		stops = [
			watchTheme(() => {
				theme = null;
				widths.clear();
				invalidate(true);
			}),
			watchMedia(reducedQuery, applyReducedMotion),
			watchPixelRatio(resize),
		];
		if (pending && settleTimer === null) settleTimer = setTimeout(settleBatch, 0);
		invalidate(true);
	}

	function applyReducedMotion(): void {
		if (!reduced()) return;
		if (form) {
			form = null;
			frame.dataset.formed = "true";
			if (shapeOn && simulation) settleIntoBrain(simulation);
			invalidate(true);
		}
		if (simulation?.active && pending === null) settleLater(layoutFor(model, shapeOn));
	}

	function deactivate(): void {
		if (!input) return;
		// Ends a drag, so nothing keeps the map warm or a node pinned.
		input.dispose();
		input = null;
		// The pointer and the keyboard left with the page; a removed frame gets neither pointerleave nor blur.
		current = -1;
		setHovered(-1);
		showPreview(-1);
		for (const stop of stops) stop();
		stops = [];
		if (raf !== null) cancelAnimationFrame(raf);
		raf = null;
		lastTime = 0;
		dragging = false;
		if (announceTimer !== null) clearTimeout(announceTimer);
		announceTimer = null;
		if (settleTimer !== null) clearTimeout(settleTimer);
		settleTimer = null;
	}

	// The frame joins and leaves the page as the Memory page is drawn, left, or replaced by the signed-out screen; its size changing to or from nothing says so.
	const watcher = new ResizeObserver(() => {
		if (!onScreen()) deactivate();
		else {
			activate();
			resize();
		}
	});
	watcher.observe(frame);
	watcher.observe(panel);

	return {
		frame,
		hover,
		setModel(next, options = { shape: true }) {
			// A drag holds an index into the shown model, which is about to change.
			input?.cancel();
			cancelPending();
			const sameShape = options.shape === wantShape;
			wantShape = options.shape;
			if (simulation && sameShape && sameLayout(model, next)) {
				// Same places and sizes: only what is drawn on them changed (labels, kinds, importance), so nothing moves.
				model = next;
				describeModel();
				labels.clear();
				invalidate(true);
				return;
			}
			const laidOut = layoutFor(next, options.shape);
			if (reduced()) settleLater(laidOut);
			else commit(laidOut);
		},
		setSelected(id) {
			if (selectedId === id) return;
			selectedId = id;
			viewportDirty = true;
			followSelection = id !== null;
			invalidate(true);
		},
		setMatches(ids) {
			matchIds = ids;
			findMatches();
			invalidate(true);
		},
		setGestures(enabled) {
			if (gestures === enabled) return;
			input?.cancel();
			gestures = enabled;
			frame.classList.toggle("touch-none", enabled);
			frame.classList.toggle("cursor-grab", enabled && hovered < 0);
		},
		fit,
		zoomBy: (factor) => zoom(factor, width / 2, height / 2),
		announce,
		dispose() {
			deactivate();
			watcher.disconnect();
			cancelPending();
		},
	};
}
