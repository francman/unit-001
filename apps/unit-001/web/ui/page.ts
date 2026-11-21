// Page anatomy for non-chat pages: a scrolling column with a header, sections, list rows and fact lists.
import { page as pageClasses, rows, surfaces, text } from "./classes.ts";
import { attrs, type Child, el } from "./dom.ts";
import { type IconName, icon } from "./icons.ts";

/**
 * The frame every non-chat page returns: `root` scrolls (keyed `data-scroll` so a redraw keeps its offset),
 * `body` is the centered column to fill with sections. The h1 is the page's name.
 */
export function pageFrame(options: {
	title: string;
	/** A count next to the title, e.g. the number of memories. */
	count?: number | null;
	/** One sentence under the title. */
	lead?: string;
	/** At most one or two small controls or tags at the right of the title. */
	actions?: Child[];
	/** Unique per page, for scroll restore: "status", "memory", "connections". */
	key: string;
}): { root: HTMLElement; body: HTMLElement } {
	const heading = el("h1", `flex min-w-0 items-baseline gap-2 ${text.title}`, options.title);
	if (options.count !== undefined && options.count !== null)
		heading.append(el("span", "text-base font-normal text-fg-3 tabular-nums", options.count.toLocaleString()));
	const titles = el("div", "flex min-w-0 flex-col gap-1", heading, options.lead ? el("p", text.body, options.lead) : null);
	const header = el("header", pageClasses.header, titles);
	if (options.actions?.length) header.append(el("div", "flex shrink-0 items-center gap-2", ...options.actions));
	const body = el("div", pageClasses.column, header);
	const root = attrs(el("div", pageClasses.scroll, body), { "data-scroll": options.key });
	return { root, body };
}

/** A page section: small heading row (optional icon and count, optional trailing control), then its content. */
export function section(options: {
	title: string;
	icon?: IconName;
	count?: number;
	trailing?: Child;
	children: Child[];
	/** Accessible name when the heading alone is ambiguous. */
	id?: string;
}): HTMLElement {
	const heading = el(
		"h2",
		`flex min-w-0 items-center gap-2 ${text.heading}`,
		options.icon ? el("span", "text-fg-3", icon(options.icon, "size-3.5 shrink-0")) : null,
		options.title,
		options.count !== undefined ? el("span", "font-normal text-fg-3 tabular-nums", String(options.count)) : null,
	);
	if (options.id) heading.id = options.id;
	const head = el("div", pageClasses.sectionHeader, heading, options.trailing ?? null);
	const node = el("section", pageClasses.section, head, ...options.children);
	if (options.id) node.setAttribute("aria-labelledby", options.id);
	return node;
}

/** A bordered group around rows or facts (settings style); use once per section, never nested. */
export function panel(...children: Child[]): HTMLElement {
	return el("div", surfaces.panel, ...children);
}

/**
 * A flat list row (Hermes ListRow): optional 16 px icon, title, description and meta lines, trailing
 * controls or tags. Rows have no dividers; put them in `rowList`.
 */
export function listRow(options: {
	title: Child;
	description?: Child;
	meta?: Child;
	icon?: IconName;
	trailing?: Child[];
}): HTMLLIElement {
	const main = el(
		"div",
		rows.listMain,
		el("div", rows.listTitle, options.title),
		options.description ? el("div", text.description, options.description) : null,
		options.meta ? el("div", text.meta, options.meta) : null,
	);
	return el(
		"li",
		rows.list,
		options.icon ? el("span", rows.listIcon, icon(options.icon, "size-4 shrink-0")) : null,
		main,
		options.trailing?.length ? el("div", rows.listTrailing, ...options.trailing) : null,
	);
}

/** The list around `listRow`s. */
export function rowList(...items: HTMLLIElement[]): HTMLUListElement {
	return attrs(el("ul", rows.group, ...items), { role: "list" });
}

/** A two-column fact list (label, value) as a `dl`; values may be nodes (tags, mono, times). */
export function facts(entries: readonly (readonly [string, Child])[]): HTMLDListElement {
	const list = el("dl", "m-0 grid grid-cols-[minmax(8rem,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 max-sm:grid-cols-1 max-sm:gap-y-0.5");
	for (const [label, value] of entries)
		list.append(el("dt", `${text.meta} max-sm:mt-2 max-sm:first:mt-0`, label), el("dd", `m-0 min-w-0 ${text.strong}`, value));
	return list;
}
