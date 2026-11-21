// The map's legend. Every entry names a color, shape or line style in words and is a toggle that shows or hides what it names.
import { attrs, el } from "../ui/dom.ts";
import { type EdgeKind, type GraphNode, kindLabels, relationLabels, tierLabels } from "./memory-graph-details.ts";

/** What the legend has switched off; the page reads it and the legend writes it. */
export interface HiddenState {
	kinds: Set<GraphNode["kind"]>;
	tiers: Set<GraphNode["tier"]>;
	relations: Set<EdgeKind>;
}

const svgNamespace = "http://www.w3.org/2000/svg";

// Whole class literals so Tailwind finds them.
const kindDot = { fact: "bg-accent", preference: "bg-ok", decision: "bg-warn", observation: "bg-fg-2" } as const;

interface Sample {
	dash: string;
	width: string;
	stroke: string;
	head: "none" | "triangle" | "chevron" | "bar";
	headClass: string;
}

// The same dash and arrowhead as the map draws; also a different color per kind, so neither alone carries the meaning.
const samples: Readonly<Record<EdgeKind, Sample>> = {
	summary: { dash: "", width: "1", stroke: "stroke-fg-3", head: "none", headClass: "" },
	relates: { dash: "2 3", width: "1.25", stroke: "stroke-fg-3", head: "none", headClass: "" },
	supports: { dash: "", width: "1.5", stroke: "stroke-ok", head: "triangle", headClass: "fill-ok" },
	contradicts: { dash: "5 3", width: "1.5", stroke: "stroke-warn", head: "bar", headClass: "stroke-warn" },
	updates: { dash: "", width: "1.5", stroke: "stroke-info", head: "chevron", headClass: "stroke-info" },
};

const entryClass =
	"inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-fg-3 transition-colors duration-100 hover:bg-hover hover:text-fg aria-[pressed=false]:line-through aria-[pressed=false]:opacity-60 pointer-coarse:h-9 pointer-coarse:px-2.5";

const edgeOrder: readonly EdgeKind[] = ["summary", "relates", "supports", "contradicts", "updates"];

/**
 * Builds the legend. Pressing an entry flips it in `hidden` and calls `onChange`; an entry that is on is pressed.
 * Only the relation kinds that are in the data are listed.
 */
export function createLegend(present: readonly EdgeKind[], hidden: HiddenState, onChange: () => void): HTMLElement {
	const entry = (label: string, marker: Element, isHidden: () => boolean, flip: () => void) => {
		const node = el("button", entryClass, marker, label);
		node.type = "button";
		node.setAttribute("aria-pressed", String(!isHidden()));
		node.addEventListener("click", () => {
			flip();
			sync();
			onChange();
		});
		return { item: el("li", "flex", node), node, isHidden };
	};
	const toggle = <T>(set: Set<T>, value: T) => () => {
		if (!set.delete(value)) set.add(value);
	};
	const rows = [
		...(Object.keys(kindLabels) as GraphNode["kind"][]).map((kind) =>
			entry(kindLabels[kind], attrs(el("span", `size-2 shrink-0 rounded-full ${kindDot[kind]}`), { "aria-hidden": "true" }), () => hidden.kinds.has(kind), toggle(hidden.kinds, kind)),
		),
		...(Object.keys(tierLabels) as GraphNode["tier"][]).map((tier) =>
			entry(
				tierLabels[tier],
				attrs(el("span", `size-2 shrink-0 bg-fg-3 ${tier === "working" ? "rounded-full" : "rounded-xs"}`), { "aria-hidden": "true" }),
				() => hidden.tiers.has(tier),
				toggle(hidden.tiers, tier),
			),
		),
		...edgeOrder.filter((kind) => present.includes(kind)).map((kind) => entry(relationLabels[kind].short, edgeSample(kind), () => hidden.relations.has(kind), toggle(hidden.relations, kind))),
	];
	const reset = el("button", entryClass, "Show all");
	reset.type = "button";
	reset.dataset.key = "graph-filters-reset";
	reset.addEventListener("click", () => {
		hidden.kinds.clear();
		hidden.tiers.clear();
		hidden.relations.clear();
		sync();
		onChange();
	});
	const list = attrs(el("ul", "m-0 flex min-w-0 list-none flex-wrap items-center gap-x-1 gap-y-0.5 p-0 text-xs text-fg-3", ...rows.map((row) => row.item), el("li", "flex", reset)), {
		role: "list",
		"aria-label": "Legend and filters",
	});
	function sync(): void {
		for (const row of rows) row.node.setAttribute("aria-pressed", String(!row.isHidden()));
		reset.hidden = hidden.kinds.size + hidden.tiers.size + hidden.relations.size === 0;
	}
	sync();
	return list;
}

// A 26 px sample of a relation line in the legend, drawn with the same dash and arrowhead as in the map.
function edgeSample(kind: EdgeKind): SVGElement {
	const style = samples[kind];
	const sample = svg("svg", "h-2.5 w-7 shrink-0 overflow-visible", { viewBox: "0 0 28 10", "aria-hidden": "true", focusable: "false" });
	const end = style.head === "none" ? 27 : 20;
	const line = svg("line", style.stroke, { x1: "1", y1: "5", x2: String(end), y2: "5", "stroke-width": style.width });
	if (style.dash) line.setAttribute("stroke-dasharray", style.dash);
	sample.append(line);
	if (style.head === "triangle") sample.append(svg("path", `${style.headClass} stroke-none`, { d: "M20 1.5 L27 5 L20 8.5 Z" }));
	else if (style.head === "chevron") sample.append(svg("path", `${style.headClass} fill-none`, { d: "M20 1.5 L27 5 L20 8.5", "stroke-width": "1.5" }));
	else if (style.head === "bar") sample.append(svg("path", `${style.headClass} fill-none`, { d: "M24 0.5 L24 9.5", "stroke-width": "2" }));
	return sample;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className: string, values: Record<string, string>): SVGElementTagNameMap[K] {
	const node = document.createElementNS(svgNamespace, tag);
	node.setAttribute("class", className);
	for (const [name, value] of Object.entries(values)) node.setAttribute(name, value);
	return node;
}
