// The memory graph widget: a canvas map of memories with a Graph/List switch, filters, a focus view, search highlight and a details panel.
import type { Ctx, Ui } from "../state.ts";
import { callout, spinner } from "../ui/blocks.ts";
import { button } from "../ui/controls.ts";
import { text } from "../ui/classes.ts";
import { attrs, el } from "../ui/dom.ts";
import { count, plural } from "../ui/format.ts";
import { createGraphCanvas, type GraphCanvas } from "./memory-graph-canvas.ts";
import {
	type GraphNode,
	kindLabels,
	originLabel,
	preview,
	type Related,
	renderDetails,
	renderList,
	tierLabels,
} from "./memory-graph-details.ts";
import { createLegend, type HiddenState } from "./memory-graph-legend.ts";
import { degreesOf, type Focus, type GraphModel, modelKey, shownGraph } from "./memory-graph-model.ts";

/** What the Memory page places: the Graph/List switch for its header, the map section, and the search highlight hook. */
export interface MemoryMap {
	switcher: HTMLElement;
	section: HTMLElement;
	/** Dims memories that do not contain the typed text; an empty string clears it. Never redraws the page. */
	highlight(query: string): void;
	/** True when the map has memories to show. */
	hasNodes: boolean;
	/** True when a successful snapshot confirms there are no memories. */
	isEmpty: boolean;
}

// The page's reading column; the map itself spans the whole work area, only its text lines follow the column.
const column = "mx-auto w-full max-w-[52rem] px-6 max-sm:px-3";
// The details panel floats over the map's edge; in the List view it follows the list.
const panelFloating =
	"absolute right-2 bottom-2 left-2 z-10 max-h-[60%] min-w-0 overflow-y-auto rounded-md border border-stroke-3 bg-card p-4 shadow-lg lg:top-2 lg:bottom-auto lg:left-auto lg:w-72 lg:max-h-[calc(100%-1rem)]";
const panelStaticBox = "min-w-0 rounded-md border border-stroke-3 bg-card p-4";

type Mode = "graph" | "list";

interface Widget {
	ctx: Ctx;
	canForget: boolean;
	data: ReturnType<typeof readGraph> | null;
	signature: string;
	mode: Mode | null;
	selected: string | null;
	listOpener: string | null;
	query: string;
	matches: ReadonlySet<string> | null;
	hidden: HiddenState;
	focus: Focus | null;
	canvas: GraphCanvas | null;
	/** What Graph and List show after the legend filters and focus scope. */
	model: GraphModel | null;
	modelKey: string;
	section: HTMLElement;
	switcher: HTMLElement;
	modeButtons: Record<Mode, HTMLButtonElement>;
	legend: HTMLElement;
	notice: HTMLElement;
	body: HTMLElement;
	note: HTMLElement;
	status: HTMLElement;
	controls: HTMLElement;
	focusBar: HTMLElement;
	stage: HTMLElement;
	listRows: HTMLElement;
	panel: HTMLElement;
}

// One widget per workspace state object: views are redrawn from scratch, but the layout, zoom and selection must survive that.
const widgets = new WeakMap<Readonly<Ui>, Widget>();

/** Builds (or returns the living) memory map for this workspace; safe to call on every redraw of the Memory page. */
export function memoryMap(ctx: Ctx): MemoryMap {
	let widget = widgets.get(ctx.ui);
	if (!widget) {
		widget = createWidget(ctx);
		widgets.set(ctx.ui, widget);
	}
	const living = widget;
	living.ctx = ctx;
	const restore = keepFocus(living);
	const canForget = ctx.ui.connection === "connected";
	if (living.canForget !== canForget) {
		living.canForget = canForget;
		fillPanel(living);
	}
	if (ctx.ui.graph) adopt(living, ctx.ui.graph);
	show(living);
	applyHighlight(living, ctx.ui.query);
	// The page is rebuilt around this element, which drops focus from whatever was focused inside; give it back (List rows are rebuilt too, so by key).
	queueMicrotask(() => restore(fallbackFocus(living)));
	return {
		switcher: living.switcher,
		section: living.section,
		highlight: (query) => applyHighlight(living, query),
		hasNodes: (living.data?.nodes.length ?? 0) > 0,
		isEmpty: !ctx.ui.graphFailed && living.data?.nodes.length === 0,
	};
}

/** Ends the map for a workspace for good (sign-out, shell teardown): its observers, listeners and timers go, and the next Memory page builds a new one. */
export function disposeMemoryMap(ui: Readonly<Ui>): void {
	widgets.get(ui)?.canvas?.dispose();
	widgets.delete(ui);
}

function readGraph(graph: NonNullable<Ui["graph"]>) {
	const nodes: GraphNode[] = [...graph.nodes];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const edges = graph.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
	const related = new Map<string, Related[]>();
	for (const edge of edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to) continue;
		const derivation = edge.kind === "summary" ? null : edge.derivation;
		related.set(from.id, [...(related.get(from.id) ?? []), { node: to, kind: edge.kind, role: "from", derivation }]);
		related.set(to.id, [...(related.get(to.id) ?? []), { node: from, kind: edge.kind, role: "to", derivation }]);
	}
	// Newest related memory first inside each list.
	for (const list of related.values()) list.sort((a, b) => b.node.createdAt - a.node.createdAt);
	// Conversations are named by their order of key, which never changes for a given set; the key itself is opaque.
	const keys = [...new Set(nodes.map((node) => node.conversation))].sort();
	const conversations = new Map(keys.map((key, index) => [key, `Conversation ${index + 1}`]));
	const kinds = [...new Set(edges.map((edge) => edge.kind))];
	return { nodes, byId, related, conversations, keys, kinds, edges, degrees: degreesOf(nodes, edges), total: graph.total, limited: graph.limited };
}

// ── Building the widget ──

function createWidget(ctx: Ctx): Widget {
	const modeButtons = { graph: modeButton("Graph"), list: modeButton("List") };
	const switcher = attrs(
		el("div", "inline-flex shrink-0 items-center rounded-sm bg-fill p-px", modeButtons.graph, modeButtons.list),
		{ role: "group", "aria-label": "Memory view" },
	);
	const heading = el("h2", "sr-only", "Memory map");
	const notice = el("div", `${column} flex flex-col gap-3 empty:hidden`);
	const focusBar = el("div", "flex min-w-0 flex-wrap items-center gap-1");
	focusBar.hidden = true;
	const controls = el("div", `${column} flex flex-wrap items-center gap-1`);
	const status = attrs(el("p", `${text.description} empty:hidden`), { role: "status" });
	const note = el("p", `${text.description} empty:hidden`);
	const stage = el("div", "relative min-w-0");
	const listRows = el("div", "empty:hidden");
	const panel = attrs(el("aside", panelFloating), { "aria-label": "Memory details", id: "graph-details", hidden: "", tabindex: "-1" });
	const legend = el("div", `${column} min-w-0`);
	const info = el("div", `${column} flex min-w-0 flex-col gap-1`, focusBar, note, status);
	const body = el("div", "flex min-w-0 flex-col gap-2", legend, info, controls, stage);
	const section = attrs(el("section", "flex min-w-0 flex-col gap-3 pb-6", heading, notice, body), { "aria-labelledby": "memory-map-title" });
	heading.id = "memory-map-title";
	const widget: Widget = {
		ctx,
		canForget: ctx.ui.connection === "connected",
		data: null,
		signature: "",
		mode: null,
		selected: null,
		listOpener: null,
		query: "",
		matches: null,
		hidden: { kinds: new Set(), tiers: new Set(), relations: new Set() },
		focus: null,
		canvas: null,
		model: null,
		modelKey: "",
		section,
		switcher,
		modeButtons,
		legend,
		notice,
		body,
		note,
		status,
		controls,
		focusBar,
		stage,
		listRows,
		panel,
	};
	for (const mode of ["graph", "list"] as const) modeButtons[mode].addEventListener("click", () => setMode(widget, mode));
	const gestures = button({
		label: "Graph gestures",
		key: "graph-gestures",
		variant: "ghost",
		onClick: () => {
			const enabled = gestures.getAttribute("aria-pressed") !== "true";
			gestures.setAttribute("aria-pressed", String(enabled));
			widget.canvas?.setGestures(enabled);
		},
	});
	gestures.className += " aria-pressed:bg-fill aria-pressed:text-fg";
	attrs(gestures, { "aria-pressed": "false", "aria-describedby": "graph-gestures-help" });
	const help = el("span", text.description, "Turn on to drag, pan or wheel-zoom the graph. Turn off to scroll the page.");
	help.id = "graph-gestures-help";
	controls.append(
		button({ label: "Zoom out", key: "graph-zoom-out", variant: "ghost", onClick: () => widget.canvas?.zoomBy(0.8) }),
		button({ label: "Zoom in", key: "graph-zoom-in", variant: "ghost", onClick: () => widget.canvas?.zoomBy(1.25) }),
		button({ label: "Fit", key: "graph-fit", variant: "ghost", onClick: () => widget.canvas?.fit() }),
		gestures,
		help,
	);
	return widget;
}

function modeButton(label: string): HTMLButtonElement {
	const node = el(
		"button",
		"inline-flex h-6 items-center rounded-xs px-2.5 text-sm font-medium text-fg-2 transition-colors duration-100 hover:text-fg aria-pressed:bg-canvas aria-pressed:text-fg pointer-coarse:h-11 pointer-coarse:px-4",
		label,
	);
	node.type = "button";
	node.dataset.key = `graph-mode-${label.toLowerCase()}`;
	return node;
}

// The canvas is made once, when the first memories arrive, and then only shown other memories.
function ensureCanvas(widget: Widget): GraphCanvas {
	if (widget.canvas) return widget.canvas;
	const canvas = createGraphCanvas({
		onSelect: (id) => {
			widget.listOpener = null;
			select(widget, id);
		},
		onClear: () => select(widget, null),
		onEscapeIdle: () => {
			if (!widget.focus) return false;
			setFocus(widget, null);
			return true;
		},
		describe: (node, related) => describeNode(widget, node, related),
		preview: (node) => `${kindLabels[node.kind]} · ${tierLabels[node.tier]}: ${preview(node, 140)}`,
		labelText: (node) => preview(node, 28),
	}, widget.panel);
	widget.canvas = canvas;
	return canvas;
}

// What a screen reader hears for one memory: "Fact, working, from you: text, 3 related".
function describeNode(widget: Widget, node: GraphNode, related: number): string {
	return `${kindLabels[node.kind]}, ${tierLabels[node.tier].toLowerCase()}, ${originLabel(node.origin, widget.ctx.name).toLowerCase()}: ${preview(node, 120)}, ${related} related`;
}

// ── Data ──

// Takes a new snapshot: when only its identity changed everything stays; otherwise the shown memories are rebuilt, keeping surviving positions.
function adopt(widget: Widget, graph: NonNullable<Ui["graph"]>): void {
	const signature = JSON.stringify([graph.nodes, graph.edges, graph.total, graph.limited]);
	if (signature === widget.signature && widget.data) return;
	widget.data = readGraph(graph);
	widget.signature = signature;
	// The focus scope cannot outlive its center.
	if (widget.focus && !widget.data.byId.has(widget.focus.id)) widget.focus = null;
	if (widget.mode === null && widget.data.nodes.length > 0) widget.mode = "graph";
	if (widget.data.nodes.length > 0) ensureCanvas(widget);
	widget.legend.replaceChildren(createLegend(widget.data.kinds, widget.hidden, () => {
		const restore = keepFocus(widget);
		if (refreshModel(widget)) fillPanel(widget);
		if (widget.mode === "list") renderStage(widget);
		restore(fallbackFocus(widget));
	}));
	widget.canvas?.frame.setAttribute(
		"aria-label",
		`Memory graph: ${plural(widget.data.nodes.length, "memory", "memories")} from ${plural(widget.data.keys.length, "conversation", "conversations")}`,
	);
	refreshModel(widget);
	renderFocusBar(widget);
	fillPanel(widget);
}

// Both views read the same model. Reports when rebuilding it closes an out-of-scope selection.
function refreshModel(widget: Widget): boolean {
	const data = widget.data;
	const canvas = widget.canvas;
	if (!data || !canvas) return false;
	const model = shownGraph(data.nodes, data.edges, data.degrees, widget.hidden, widget.focus, [widget.selected, widget.focus?.id ?? null]);
	const lostSelection = widget.selected !== null && !model.indexOf.has(widget.selected);
	if (lostSelection) {
		widget.selected = null;
		widget.listOpener = null;
		canvas.setSelected(null);
		canvas.announce("");
	}
	// Not only the shown ids and relations: a memory can change its size or text while the shape of what is shown stays the same.
	// The focus view is not a brain, so whether the map forms one is part of what changed.
	const shape = widget.focus === null;
	const key = `${shape ? "brain" : "plain"}|${modelKey(model)}`;
	widget.model = model;
	if (key !== widget.modelKey) {
		widget.modelKey = key;
		canvas.setModel(model, { shape });
	}
	updateNote(widget);
	refreshMatches(widget);
	return lostSelection;
}

function updateNote(widget: Widget): void {
	const data = widget.data;
	if (!data) return;
	const parts: string[] = [];
	if (data.limited) parts.push(`Showing the newest ${count(data.nodes.length)} of ${count(data.total)} memories. Search to reach the others.`);
	if (widget.model && widget.model.nodes.length === 0) parts.push("No memory is shown with these filters.");
	widget.note.textContent = parts.join(" ");
}

// Shows the state the data is in: loading, failed, empty, or the map itself.
function show(widget: Widget): void {
	const { ui } = widget.ctx;
	const data = widget.data;
	const hasNodes = data !== null && data.nodes.length > 0;
	widget.switcher.hidden = !hasNodes;
	widget.body.hidden = !hasNodes;
	const notices: HTMLElement[] = [];
	if (ui.graph === null && !ui.graphFailed)
		notices.push(attrs(el("p", `flex items-center gap-2 ${text.description}`, spinner(), "Loading the memory map"), { role: "status" }));
	else if (ui.graphFailed && data === null)
		notices.push(callout({ tone: "warn", title: "The memory map could not be read.", body: "Search still works. Open this page again to retry.", role: "alert" }));
	else if (ui.graphFailed)
		notices.push(callout({ tone: "warn", body: "The memory map could not be refreshed. This is the last one that was read.", role: "status" }));
	widget.section.hidden = !hasNodes && notices.length === 0;
	widget.notice.replaceChildren(...notices);
	if (!hasNodes || !data) return;
	for (const mode of ["graph", "list"] as const) widget.modeButtons[mode].setAttribute("aria-pressed", String(widget.mode === mode));
	widget.controls.hidden = widget.mode !== "graph";
	renderStage(widget);
}

function renderStage(widget: Widget): void {
	const { data, model } = widget;
	if (!data || !model) return;
	if (widget.mode === "list") {
		widget.stage.className = "min-w-0";
		widget.panel.className = panelStaticBox;
		if (!widget.stage.contains(widget.listRows)) {
			widget.stage.replaceChildren(el("div", `${column} flex flex-col gap-4`, widget.listRows, widget.panel));
		}
		const rows = renderList({
			nodes: model.nodes,
			selected: widget.selected,
			matches: widget.matches,
			conversations: data.conversations,
			name: widget.ctx.name,
			onSelect: (id) => {
				widget.listOpener = id;
				select(widget, id);
				widget.panel.focus();
			},
		});
		if (rows) widget.listRows.replaceChildren(rows);
		else widget.listRows.replaceChildren();
		return;
	}
	widget.stage.className = "relative h-[max(28rem,calc(100dvh-15rem))] min-w-0 max-sm:h-[max(24rem,calc(100dvh-17rem))]";
	widget.panel.className = panelFloating;
	if (widget.canvas && widget.stage.firstElementChild !== widget.canvas.frame) widget.stage.replaceChildren(widget.canvas.frame, widget.panel);
}

function refreshMatches(widget: Widget): void {
	const { query, model } = widget;
	let matches: Set<string> | null = null;
	if (query && model && model.nodes.length > 0) {
		matches = new Set();
		for (const { node } of model.nodes) if (node.content.toLowerCase().includes(query)) matches.add(node.id);
	}
	widget.matches = matches;
	widget.canvas?.setMatches(matches);
	const status = matches ? `${matches.size} of ${model?.nodes.length} shown memories contain “${query}”.` : "";
	if (widget.status.textContent !== status) widget.status.textContent = status;
}

function applyHighlight(widget: Widget, query: string): void {
	const next = query.trim().toLowerCase();
	if (next === widget.query) return;
	widget.query = next;
	refreshMatches(widget);
	if (widget.mode === "list") renderStage(widget);
}

function setMode(widget: Widget, mode: Mode): void {
	if (widget.mode === mode) return;
	widget.mode = mode;
	show(widget);
}

// ── Selection, focus and the details panel ──

function select(widget: Widget, requested: string | null): void {
	const restore = keepFocus(widget);
	if (!requested) widget.listOpener = null;
	widget.selected = requested;
	// A memory chosen from the details panel may lie outside the focus view; the view follows it.
	if (requested && widget.focus && !widget.model?.indexOf.has(requested)) {
		widget.focus = { id: requested, depth: widget.focus.depth };
		renderFocusBar(widget);
	}
	refreshModel(widget);
	const id = widget.selected;
	const canvas = widget.canvas;
	if (canvas) {
		canvas.setSelected(id);
		const node = id ? widget.data?.byId.get(id) : undefined;
		const index = id ? widget.model?.indexOf.get(id) : undefined;
		if (!node) canvas.announce("");
		else canvas.announce(`${describeNode(widget, node, index === undefined ? 0 : (widget.model?.neighbours[index]?.length ?? 0))}. Details are open.`);
	}
	fillPanel(widget);
	if (widget.mode === "list") renderStage(widget);
	if (id || widget.mode !== "list") restore(fallbackFocus(widget));
}

// Remembers which control inside the map has focus. The returned function puts focus back after a redraw: on the control
// with the same key (redraws replace controls), or on `fallback` when that control is gone.
function keepFocus(widget: Widget): (fallback: HTMLElement | null) => void {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !widget.section.contains(active)) return () => undefined;
	const key = active.dataset.key;
	return (fallback) => {
		const same = key === undefined ? active : widget.section.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
		if (same?.isConnected && !same.closest("[hidden]")) {
			if (same !== document.activeElement) same.focus({ preventScroll: true });
		} else if (fallback !== document.activeElement) fallback?.focus();
	};
}

// Where focus goes when the control that had it is gone.
function fallbackFocus(widget: Widget): HTMLElement | null {
	if (widget.section.hidden || widget.body.hidden) return document.getElementById("memory-query");
	if (!widget.panel.hidden) return widget.panel;
	return widget.mode === "graph" ? (widget.canvas?.frame ?? null) : widget.modeButtons.list;
}

// Shows one memory with what is within reach of it, or all memories again, fitted into what the panel leaves free.
function setFocus(widget: Widget, focus: Focus | null): void {
	const restore = keepFocus(widget);
	widget.focus = focus;
	refreshModel(widget);
	widget.canvas?.fit();
	renderFocusBar(widget);
	fillPanel(widget);
	if (widget.mode === "list") renderStage(widget);
	// Clear focus removes the bar; move to the still-open details, or back to the active view.
	restore(fallbackFocus(widget));
}

function renderFocusBar(widget: Widget): void {
	const focus = widget.focus;
	const node = focus ? widget.data?.byId.get(focus.id) : undefined;
	if (!focus || !node) {
		widget.focusBar.replaceChildren();
		widget.focusBar.hidden = true;
		return;
	}
	widget.focusBar.hidden = false;
	const depth = (value: 1 | 2) => {
		const node = button({ label: String(value), key: `graph-depth-${value}`, variant: "ghost", onClick: () => setFocus(widget, { id: focus.id, depth: value }) });
		node.setAttribute("aria-label", `Show memories within ${value === 1 ? "1 relation" : "2 relations"}`);
		node.setAttribute("aria-pressed", String(focus.depth === value));
		node.className = `${node.className} aria-pressed:bg-fill aria-pressed:text-fg`;
		return node;
	};
	widget.focusBar.replaceChildren(
		el("span", text.description, `Focused on “${preview(node, 45)}”`),
		attrs(el("div", "flex items-center", depth(1), depth(2)), { role: "group", "aria-label": "Focus depth" }),
		button({ label: "Clear focus", key: "graph-focus-off", variant: "ghost", onClick: () => setFocus(widget, null) }),
	);
}

function fillPanel(widget: Widget): void {
	const data = widget.data;
	const node = widget.selected && data ? data.byId.get(widget.selected) : undefined;
	if (!data || !node) {
		widget.panel.hidden = true;
		widget.panel.replaceChildren();
		return;
	}
	widget.panel.hidden = false;
	widget.panel.replaceChildren(
		renderDetails({
			node,
			related: data.related.get(node.id) ?? [],
			conversations: data.conversations,
			name: widget.ctx.name,
			focused: widget.focus?.id === node.id,
			canForget: widget.canForget,
			onSelect: (id) => select(widget, id),
			onClose: () => {
				const opener = widget.listOpener;
				select(widget, null);
				const target = widget.mode === "list"
					? (opener && widget.listRows.querySelector<HTMLElement>(`[data-key="${CSS.escape(`list-open-${opener}`)}"]`)) || widget.modeButtons.list
					: widget.canvas?.frame;
				target?.focus();
			},
			onFocus: () => setFocus(widget, widget.focus?.id === node.id ? null : { id: node.id, depth: widget.focus?.depth ?? 1 }),
			onForget: (target, openerKey) => widget.ctx.act.askForget(target.id, target.truncated ? `${target.content}…` : target.content, openerKey),
		}),
	);
}
