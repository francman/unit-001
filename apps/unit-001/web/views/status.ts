// Status page and Activity pane: what the owner reports about scheduled work, memory and runtime; read-only. Purpose, limits and checks live on Mission.
import type { MemoryStatsView, MissionAgreementView, MissionRunView, WorkspaceDetails } from "../contract.ts";
import { type Ctx, commandName, runBlocked, type Tone } from "../state.ts";
import { callout, command, dot, emptyState, stat, tag } from "../ui/blocks.ts";
import { surfaces, text } from "../ui/classes.ts";
import { button } from "../ui/controls.ts";
import { attrs, type Child, el } from "../ui/dom.ts";
import { ago, clock, count, dateTime, duration, memorySentence, money, plural, until } from "../ui/format.ts";
import { facts, pageFrame, panel, section } from "../ui/page.ts";
import { blockedCallout, meter, runStates } from "../ui/run.ts";
import { connectionSentence } from "./connections.ts";

/** Memories at which the capacity evidence recommends a review; a recommendation, not a limit. */
const capacityReview = 1000;

/** The whole state of the page's data as one value, so each section reads the same run and limits. */
interface Facts {
	details: WorkspaceDetails;
	run: MissionRunView | null;
	limits: MissionAgreementView["limits"] | null;
}

/** Renders the Status page; read-only, a step only a terminal can do is a copyable command. */
export function renderStatus(ctx: Ctx): HTMLElement {
	const details = ctx.ui.details;
	const run = details?.mission.run ?? null;
	const state = run ? runStates[run.status] : null;
	const { root, body } = pageFrame({
		title: "Status",
		key: "status",
		lead: `What ${ctx.name} reports about its work, limits and memory.`,
		actions: state ? [tag(state.word, state.tone)] : [],
	});
	if (!details) {
		body.append(missingDetails(ctx));
		return root;
	}
	const data: Facts = { details, run, limits: details.mission.agreement?.limits ?? null };
	const sections = [
		attention(ctx, data),
		totals(data),
		scheduledWork(ctx, data),
		memorySection(details.memory.stats),
		usageSection(ctx),
		runtimeSection(ctx, data),
	];
	for (const item of sections) if (item) body.append(item);
	return root;
}

/** Renders the Activity pane's content (beside the chat from 1440 px); the shell owns the pane around it. */
export function renderActivity(ctx: Ctx): HTMLElement {
	const details = ctx.ui.details;
	const root = el("div", "flex min-h-full flex-col gap-5 p-4");
	if (!details) {
		root.append(el("p", text.description, ctx.ui.detailsFailed ? "Status could not be loaded." : "Loading status."));
		root.append(fullStatus(ctx));
		return root;
	}
	const data: Facts = { details, run: details.mission.run, limits: details.mission.agreement?.limits ?? null };
	root.append(
		railGroup("Purpose", el("p", text.strong, details.mission.objective ?? "No purpose agreed yet.")),
		railGroup("Scheduled work", ...railWork(data)),
		railGroup("Memory", el("p", text.body, details.memory.stats ? memorySentence(details.memory.stats.working, details.memory.stats.episodic) : "Counts could not be read.")),
		railGroup("Connections", el("p", text.body, connectionSentence(details.channels))),
	);
	if (ctx.ui.connection !== "connected") root.append(el("p", text.description, "Last reported before the connection dropped."));
	root.append(el("div", "mt-auto pt-1", fullStatus(ctx)));
	return root;
}

/** The callout for a run that needs the owner; null when the run needs nothing. */
function attention(ctx: Ctx, data: Facts): HTMLElement | null {
	const { run } = data;
	return run && runBlocked(run) ? blockedCallout(ctx, run, "copy-mission-status") : null;
}

/** The totals the run reports, as one strip like Hermes' usage cards; retries and stalls only once they matter. */
function totals(data: Facts): HTMLElement | null {
	const { run, limits } = data;
	if (!run) return null;
	const cells = [stat(count(run.cycles), "Cycles"), stat(count(run.requests), "Model requests"), stat(money(run.estimatedCost), "Estimated cost")];
	if (run.retries > 0 || (limits?.maxRetries ?? 0) > 0) cells.push(stat(count(run.retries), "Retries"));
	if (run.noProgress > 0 || (limits?.maxNoProgress ?? 0) > 0) cells.push(stat(count(run.noProgress), "Runs without progress"));
	const strip = attrs(
		el("div", `grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-6 gap-y-4 ${surfaces.panel} ${surfaces.panelBody}`, ...cells),
		{ role: "group", "aria-label": "Totals for the work run" },
	);
	return strip;
}

function scheduledWork(ctx: Ctx, data: Facts): HTMLElement {
	const { run, details } = data;
	if (!run) {
		return section({
			title: "Scheduled work",
			icon: "clock",
			trailing: openMission(ctx),
			children: [
				panel(
					el(
						"div",
						`flex flex-col gap-3 ${surfaces.panelBody}`,
						el("p", text.body, "No scheduled work has started. Starting it is a step you take in a terminal."),
						command(`${commandName(ctx.name)} mission status`, "copy-mission-none", ctx.act.copy),
					),
				),
			],
		});
	}
	const state = runStates[run.status];
	const maxCost = details.mission.agreement?.limits.maxEstimatedCost ?? null;
	const rows: (readonly [string, Child])[] = [
		["State", el("span", "inline-flex items-center gap-2", tag(state.word, state.tone), run.status === "blocked" ? null : state.sentence)],
		// A blocked run's reason is in the callout at the top of the page; it is not said twice.
		...(run.status === "blocked" ? [] : [["Reason", run.blocker ?? "Nothing is holding it back."] as const]),
		["Next wake", run.nextWakeAt === null ? "None scheduled" : `${until(run.nextWakeAt)} (${dateTime(run.nextWakeAt)})`],
		["Updated", ago(run.observedAt)],
	];
	if (maxCost === null || maxCost <= 0) rows.push(["Cost limit", "None set"]);
	return section({
		title: "Scheduled work",
		icon: "clock",
		trailing: openMission(ctx),
		children: [panel(el("div", surfaces.panelBody, facts(rows))), el("p", text.description, "Limits and recorded checks are on the Mission page. Next wake is a retry or maintenance wake only. Costs are estimates.")],
	});
}

function openMission(ctx: Ctx): HTMLButtonElement {
	return button({ label: "Open Mission", key: "open-mission", variant: "link", onClick: () => ctx.act.go("mission") });
}

function memorySection(stats: MemoryStatsView | null): HTMLElement {
	if (!stats) return section({ title: "Memory", icon: "memory", children: [emptyState("memory", "Memory counts could not be read.")] });
	const notices: HTMLElement[] = [];
	if (stats.failedCaptures > 0)
		notices.push(
			callout({
				tone: "warn",
				title: "Not saved.",
				body: `${plural(stats.failedCaptures, "memory", "memories")} could not be saved, so ${stats.failedCaptures === 1 ? "it was" : "they were"} not kept.`,
			}),
		);
	const rows: (readonly [string, Child])[] = [
		["Kept in mind", count(stats.working)],
		["Older memories", count(stats.episodic)],
		["Forgotten", `${count(stats.tombstones)} kept as markers`],
		["Waiting to be saved", count(stats.pendingCaptures)],
		["Tidying up", stats.consolidation === "scheduled" ? "Scheduled" : "Not scheduled"],
	];
	return section({
		title: "Memory",
		icon: "memory",
		children: [
			...notices,
			panel(el("div", surfaces.panelBody, facts(rows))),
			stats.working + stats.episodic >= capacityReview
				? el("p", text.description, `About ${count(capacityReview)} memories is where a review is advised. It is not a limit.`)
				: null,
		],
	});
}

function usageSection(ctx: Ctx): HTMLElement | null {
	const usage = ctx.ui.view?.usage ?? null;
	if (!usage) return null;
	const cost = usage.cost.kind === "estimate" ? `about ${money(usage.cost.usd)}` : "cost unknown";
	const rows: (readonly [string, Child])[] = [
		["Total", `${plural(usage.totalTokens, "token", "tokens")}, ${cost}`],
		["Input", count(usage.input)],
		["Output", count(usage.output)],
		["Cache read", count(usage.cacheRead)],
		["Cache write", count(usage.cacheWrite)],
	];
	return section({
		title: "This chat",
		icon: "chat",
		children: [panel(el("div", surfaces.panelBody, facts(rows))), el("p", text.description, "Token counts are for this conversation. Costs are estimates, not billing.")],
	});
}

function runtimeSection(ctx: Ctx, data: Facts): HTMLElement {
	const { owner } = data.details;
	const model = ctx.ui.view?.model ?? null;
	const rows: (readonly [string, Child])[] = [["Model", model ? `${model.provider} / ${model.modelId}` : "No model configured"]];
	if (typeof owner?.uptimeMs === "number") rows.push(["Running for", duration(owner.uptimeMs)]);
	if (ctx.ui.view) rows.push(["Version", ctx.ui.view.version]);
	if (owner) rows.push(["Maintenance", owner.held ? "On hold. No new work is accepted." : "Not on hold"]);
	if (owner?.inhibited) rows.push(["Sleep", "The owner is keeping this computer awake."]);
	if (!owner) rows.push(["Owner", "Its state could not be read."]);
	return section({ title: "Runtime", icon: "terminal", children: [panel(el("div", surfaces.panelBody, facts(rows)))] });
}

function missingDetails(ctx: Ctx): HTMLElement {
	if (ctx.ui.detailsFailed) return emptyState("alert", "Status could not be loaded. It is read again when you open this page.");
	return emptyState("clock", `Loading what ${ctx.name} reports.`);
}

function railGroup(title: string, ...children: Child[]): HTMLElement {
	return el("section", "flex flex-col gap-1.5", el("h2", text.label, title), ...children);
}

const stateTones: Record<MissionRunView["status"], Tone> = {
	ready: "waiting",
	running: "working",
	waiting: "waiting",
	paused: "attention",
	blocked: "blocked",
	completed: "idle",
	stopped: "waiting",
};

function railWork(data: Facts): HTMLElement[] {
	const { run, limits } = data;
	if (!run) return [el("p", text.body, "Not started.")];
	const state = runStates[run.status];
	const items: HTMLElement[] = [
		el("p", "flex min-w-0 items-center gap-2 text-base text-fg", dot(stateTones[run.status]), state.word, runBlocked(run) && run.status !== "blocked" ? tag("Needs you", "warn") : null),
	];
	if (run.nextWakeAt !== null) items.push(el("p", text.description, `Next wake ${until(run.nextWakeAt)} (${clock(run.nextWakeAt)}).`));
	if (run.blocker && run.status !== "blocked") items.push(el("p", text.body, run.blocker));
	const maxCost = limits?.maxEstimatedCost ?? null;
	const list = el("dl", "m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5");
	for (const [label, value] of [
		["Cycles", `${count(run.cycles)}${limits ? ` of ${count(limits.maxCycles)}` : ""}`],
		["Requests", `${count(run.requests)}${limits ? ` of ${count(limits.maxRequests)}` : ""}`],
		["Cost", `~${money(run.estimatedCost)}${maxCost !== null && maxCost > 0 ? ` of ${money(maxCost)}` : ""}`],
	] as const)
		list.append(el("dt", text.meta, label), el("dd", "m-0 text-right text-xs text-fg tabular-nums", value));
	items.push(list);
	const closest = closestLimit(run, limits);
	if (closest) items.push(meter(`Closest limit: ${closest.name}, ${Math.round(closest.ratio * 100)} percent used`, closest.ratio, 1, "h-1"));
	return items;
}

/** The limit the run is nearest to, so one bar says how much room is left. */
function closestLimit(run: MissionRunView, limits: MissionAgreementView["limits"] | null): { name: string; ratio: number } | null {
	if (!limits) return null;
	const candidates = [
		{ name: "cycles", value: run.cycles, max: limits.maxCycles },
		{ name: "requests", value: run.requests, max: limits.maxRequests },
		{ name: "cost", value: run.estimatedCost, max: limits.maxEstimatedCost ?? 0 },
	].filter((item) => item.max > 0);
	let best: { name: string; ratio: number } | null = null;
	for (const item of candidates) {
		const ratio = Math.min(item.value / item.max, 1);
		if (best === null || ratio > best.ratio) best = { name: item.name, ratio };
	}
	return best;
}

function fullStatus(ctx: Ctx): HTMLElement {
	return button({ label: "Full status", key: "activity-status", variant: "ghost", icon: "status", onClick: () => ctx.act.go("status") });
}
