// The text side of the memory graph: the selected memory's details panel and the List view that mirrors the graph.
import type { MemoryGraphView } from "../contract.ts";
import { tag } from "../ui/blocks.ts";
import { button, iconButton } from "../ui/controls.ts";
import { text } from "../ui/classes.ts";
import { attrs, el } from "../ui/dom.ts";
import { ago, dateTime } from "../ui/format.ts";
import { facts, listRow, rowList } from "../ui/page.ts";

/** One memory as the backend reports it. */
export type GraphNode = MemoryGraphView["nodes"][number];

/** The ways two memories can be related. */
export type EdgeKind = MemoryGraphView["edges"][number]["kind"];

/** Plain words for the four kinds. */
export const kindLabels: Readonly<Record<GraphNode["kind"], string>> = {
	fact: "Fact",
	preference: "Preference",
	decision: "Decision",
	observation: "Observation",
};

/** Plain words for the two tiers: working memories are recent, episodic ones are older and may sum up working ones. */
export const tierLabels: Readonly<Record<GraphNode["tier"], string>> = { working: "Working", episodic: "Episodic" };

/** How a relation reads from each end: `from` is the memory the edge starts at, `to` the one it points to. */
export const relationLabels: Readonly<Record<EdgeKind, { from: string; to: string; short: string }>> = {
	summary: { from: "Sums up", to: "Summed up in", short: "Summary" },
	relates: { from: "Relates to", to: "Relates to", short: "Relates" },
	supports: { from: "Supports", to: "Supported by", short: "Supports" },
	contradicts: { from: "Contradicts", to: "Contradicted by", short: "Contradicts" },
	updates: { from: "Updates", to: "Updated by", short: "Updates" },
};

/** One memory related to the selected one: who it is, how it relates, and which end of the relation the selected memory is. */
export interface Related {
	node: GraphNode;
	kind: EdgeKind;
	/** `from` when the selected memory is where the relation starts, `to` when it is where it points. */
	role: "from" | "to";
	/** Who drew the relation: the agent when it saved the memory, or background consolidation; null for summary links. */
	derivation: "explicit" | "consolidation" | null;
}

/** The first `limit` characters of a memory on one line, with an ellipsis when cut. */
export function preview(node: GraphNode, limit = 90): string {
	const flat = node.content.replace(/\s+/g, " ").trim();
	return flat.length > limit || node.truncated ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/** Who the memory came from, in the page's own wording ("From you"). */
export function originLabel(origin: GraphNode["origin"], agentName: string): string {
	if (origin === "user") return "From you";
	return origin === "agent" ? `From ${agentName}` : "From a tool";
}

/** Everything the panel needs; the caller owns what happens on each action. */
export interface DetailsOptions {
	node: GraphNode;
	/** The memories related to this one, with the relation named at each. */
	related: readonly Related[];
	name: string;
	/** Conversation labels by conversation key ("Conversation 2"). */
	conversations: ReadonlyMap<string, string>;
	/** True while the map shows only this memory and what is near it. */
	focused: boolean;
	/** False in the List view, which has no map to focus. */
	canFocus: boolean;
	onSelect(id: string): void;
	onClose(): void;
	/** Shows only this memory and its neighbours, or all memories again when it already does. */
	onFocus(): void;
	onForget(node: GraphNode, openerKey: string): void;
}

/** The details panel for one selected memory: its text, facts, related memories and the Forget action. */
export function renderDetails(options: DetailsOptions): HTMLElement {
	const { node } = options;
	const conversation = options.conversations.get(node.conversation) ?? "A conversation";
	const close = iconButton({ icon: "close", label: "Close details", key: "graph-close", onClick: options.onClose });
	// Focus sits in the head, not at the foot: on a phone the foot of the sheet is below the fold.
	const focus = button({ label: options.focused ? "Show all" : "Focus", key: "graph-focus", variant: "ghost", onClick: options.onFocus });
	focus.setAttribute("aria-label", options.focused ? "Show all memories again" : "Focus the map on this memory and its neighbours");
	const head = el(
		"div",
		"flex items-center justify-between gap-2",
		el("div", "flex items-center gap-1.5", tag(kindLabels[node.kind]), tag(tierLabels[node.tier])),
		el("div", "flex items-center gap-0.5", options.canFocus ? focus : null, close),
	);
	const body = el("p", `${text.strong} whitespace-pre-wrap`, node.content);
	const forgetKey = `graph-forget-${node.id}`;
	const forget = button({ label: "Forget", key: forgetKey, onClick: () => options.onForget(node, forgetKey) });
	forget.setAttribute("aria-label", `Forget memory: ${preview(node, 60)}`);
	return attrs(
		el(
			"div",
			"flex min-w-0 flex-col gap-3",
			head,
			body,
			node.truncated ? el("p", text.description, "Only the start of this memory is shown here.") : null,
			facts([
				["Origin", originLabel(node.origin, options.name)],
				["Conversation", conversation],
				["Created", `${dateTime(node.createdAt)} (${ago(node.createdAt)})`],
				["Importance", `${Math.round(node.importance * 100)}%`],
			]),
			relatedList(options),
			el("div", "flex flex-wrap items-center justify-end gap-2 pt-1", forget),
		),
		{ "data-details": node.id },
	);
}

// Each related memory is a button that opens it, with the relation and its conversation underneath.
function relatedList(options: DetailsOptions): HTMLElement | null {
	if (options.related.length === 0) return null;
	const items = options.related.map(({ node, kind, role, derivation }) => {
		const open = button({ label: preview(node, 70), key: `graph-link-${node.id}-${kind}-${role}`, variant: "link", onClick: () => options.onSelect(node.id) });
		open.className = `${open.className} h-auto max-w-full text-left [overflow-wrap:anywhere] whitespace-normal`;
		const where = options.conversations.get(node.conversation) ?? "A conversation";
		const parts = [relationLabels[kind][role], node.conversation === options.node.conversation ? "same conversation" : where];
		if (derivation === "consolidation") parts.push("found by consolidation");
		return el("li", "flex min-w-0 flex-col", open, el("span", text.meta, parts.join(" · ")));
	});
	return el(
		"div",
		"flex min-w-0 flex-col gap-1",
		el("h3", text.label, "Related memories"),
		attrs(el("ul", "m-0 flex list-none flex-col gap-1.5 p-0", ...items), { role: "list" }),
	);
}

/** What the List view needs: the memories newest first, who matches the search, and what is selected. */
export interface ListOptions {
	nodes: readonly GraphNode[];
	selected: string | null;
	/** Ids that match the typed search, or null when nothing is typed. */
	matches: ReadonlySet<string> | null;
	conversations: ReadonlyMap<string, string>;
	name: string;
	onSelect(id: string): void;
}

/** The List view: the same memories as the graph, as rows a keyboard and a screen reader can use. */
export function renderList(options: ListOptions): HTMLElement {
	const shown = options.nodes.filter((node) => options.matches === null || options.matches.has(node.id));
	if (shown.length === 0) return el("p", text.description, "No memory in the map matches that search.");
	return rowList(
		...shown.map((node) => {
			const open = button({
				label: "Details",
				key: `list-open-${node.id}`,
				variant: "ghost",
				onClick: () => options.onSelect(node.id),
			});
			open.setAttribute("aria-label", `Show details: ${preview(node, 60)}`);
			open.setAttribute("aria-pressed", String(options.selected === node.id));
			const row = listRow({
				title: el("span", "line-clamp-2", node.content),
				meta: `${kindLabels[node.kind]} · ${tierLabels[node.tier]} · ${originLabel(node.origin, options.name)} · ${options.conversations.get(node.conversation) ?? "A conversation"} · ${ago(node.createdAt)}`,
				trailing: [open],
			});
			if (options.selected === node.id) row.className = `${row.className} bg-fill`;
			return row;
		}),
	);
}
