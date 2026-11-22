// Memory page: search what the agent retains and forget a memory after confirming.
import type { Ctx } from "../state.ts";
import { callout, emptyState, spinner } from "../ui/blocks.ts";
import { button, searchField } from "../ui/controls.ts";
import { dialogContent, dialogTitleId } from "../ui/dialog.ts";
import { attrs, el, srOnly } from "../ui/dom.ts";
import { humanize, plural } from "../ui/format.ts";
import { listRow, pageFrame, rowList, section } from "../ui/page.ts";
import { fields, text } from "../ui/classes.ts";
import { memoryMap } from "./memory-graph.ts";

type MemoryRecord = NonNullable<Ctx["ui"]["details"]>["memory"]["records"][number];

/** Renders the Memory page: a search field, the memories found, then the memory map; forgetting is always confirmed first. */
export function renderMemory(ctx: Ctx): HTMLElement {
	const { ui } = ctx;
	const { recall } = ui;
	const memory = ui.details?.memory;
	const records = recall.kind === "done" ? recall.records : recall.kind === "idle" ? (memory?.records ?? []) : [];
	const map = memoryMap(ctx);
	const { root, body } = pageFrame({
		title: "Memory",
		count: map.isEmpty ? null : memory?.count || null,
		lead: map.isEmpty ? undefined : lead(ctx),
		key: "memory",
		actions: [map.switcher],
	});
	body.append(searchForm(ctx, map.highlight));
	if (recall.kind === "failed")
		body.append(callout({ tone: "danger", title: "Search failed.", body: "Check the connection and try again.", role: "alert" }));
	else if (recall.kind === "searching")
		body.append(attrs(el("p", `flex items-center gap-2 ${text.description}`, spinner(), "Searching", srOnly(" memories")), { role: "status" }));
	else if (recall.kind === "done") {
		if (recall.query) body.append(el("p", `${text.description} [overflow-wrap:anywhere]`, `Results for “${recall.query}”`));
		if (records.length === 0)
			body.append(emptyState("search", map.isEmpty ? `Nothing matched. ${ctx.name} has no memories yet.` : "Nothing matched. Try different words."));
	} else if (records.length === 0 && map.isEmpty) body.append(emptyState("memory", `${ctx.name} has no memories yet.`));
	if (records.length > 0)
		body.append(
			section({
				title: recall.kind === "done" ? "Results" : "Memories",
				icon: "memory",
				count: records.length,
				children: [rowList(...records.map((record) => memoryRow(ctx, record)))],
			}),
		);
	// The map comes after search results, so a search result's Forget button stays the first one on the page.
	// It spans the work area, outside the reading column, and sits right under the search.
	if (map.hasNodes) body.classList.replace("pb-12", "pb-4");
	root.append(map.section);
	return root;
}

/** Renders the forget confirmation shown in the shell's modal dialog while `ui.pendingForget` is set. */
export function renderForgetDialog(ctx: Ctx): HTMLElement {
	const { pendingForget, forgetNotice, forgetting } = ctx.ui;
	const busy = forgetting !== null;
	const keep = button({ label: "Keep memory", key: "dialog-keep", disabled: busy, onClick: () => ctx.act.closeForget() });
	keep.autofocus = true;
	const forget = button({
		label: forgetting ? "Forgetting" : "Forget memory",
		key: "dialog-forget",
		variant: "danger",
		disabled: busy || ctx.ui.connection !== "connected",
		onClick: () => ctx.act.confirmForget(),
	});
	const quote = el(
		"blockquote",
		"m-0 max-h-48 overflow-y-auto rounded-sm border border-stroke-3 bg-card px-3 py-2 text-base text-fg [overflow-wrap:anywhere] whitespace-pre-wrap",
		pendingForget?.content ?? "",
	);
	const content = dialogContent({
		title: "Forget this memory?",
		description: `${ctx.name} will no longer recall it. The original conversation history is kept.`,
		body: [quote, forgetNotice ? callout({ tone: "warn", body: forgetNotice, role: "alert" }) : null].filter(
			(node): node is HTMLElement => node !== null,
		),
		actions: [keep, forget],
	});
	const title = content.querySelector<HTMLElement>(`#${dialogTitleId}`);
	if (title) title.tabIndex = -1;
	return content;
}

function searchForm(ctx: Ctx, highlight: (query: string) => void): HTMLElement {
	const { ui, act } = ctx;
	const field = searchField({
		id: "memory-query",
		label: "Search memories",
		value: ui.query,
		placeholder: "",
		onInput: (value) => {
			act.setQuery(value);
			highlight(value);
		},
	});
	const label = el("label", fields.label, "Search memories");
	label.htmlFor = field.input.id;
	const help = el("p", text.description, "Search by topic, preference or rule.");
	help.id = "memory-query-help";
	field.input.removeAttribute("aria-label");
	field.input.setAttribute("aria-describedby", help.id);
	const submit = button({
		label: "Search",
		key: "memory-search",
		variant: "primary",
		type: "submit",
		disabled: ui.connection !== "connected",
		// The form's submit handler does the work.
		onClick: () => undefined,
	});
	const form = el("form", "flex min-w-0 flex-col gap-1.5", label, el("div", "flex min-w-0 items-center gap-3", field.root, submit), help);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		act.search();
	});
	return attrs(form, { role: "search" });
}

function memoryRow(ctx: Ctx, record: MemoryRecord): HTMLLIElement {
	const key = `forget-${record.id}`;
	const forget = button({ label: "Forget", key, variant: "ghost", disabled: ctx.ui.connection !== "connected", onClick: () => ctx.act.askForget(record.id, record.content, key) });
	forget.setAttribute("aria-label", `Forget memory: ${record.content.slice(0, 60)}`);
	return listRow({ title: record.content, meta: sourceLabel(record.source), trailing: [forget] });
}

// The page lead says how much is kept in the owner's words; storage kinds are not shown.
function lead(ctx: Ctx): string | undefined {
	const memory = ctx.ui.details?.memory;
	if (!memory) return undefined;
	const { stats, count } = memory;
	if (stats) {
		if (stats.working + stats.episodic === 0) return undefined;
		return `${ctx.name} keeps ${plural(stats.working, "memory", "memories")} in mind and ${plural(stats.episodic, "older one", "older ones")}.`;
	}
	return count ? `${ctx.name} keeps ${plural(count, "memory", "memories")}.` : undefined;
}

// Sources arrive as "creator/semantic": the part before the slash says who it came from, the rest is storage detail.
function sourceLabel(source: string): string {
	const origin = humanize(source.split("/")[0] ?? source);
	return origin === "creator" ? "From you" : `From ${origin}`;
}
