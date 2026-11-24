// Shared display of the work run: state words, meters, limit rows and the unknown-results sentence, used by Status and Mission.
import type { MissionRunView } from "../contract.ts";
import { type Ctx, commandName, unknownResults } from "../state.ts";
import { callout, command, tag } from "./blocks.ts";
import { text } from "./classes.ts";
import { attrs, el } from "./dom.ts";
import { plural } from "./format.ts";

type TagTone = Parameters<typeof tag>[1];

/** The work run's state as a tag word and tone: blocked is the only red, paused needs a look. */
export const runStates: Record<MissionRunView["status"], { word: string; tone: TagTone; sentence: string }> = {
	ready: { word: "Ready", tone: "neutral", sentence: "Ready, not started." },
	running: { word: "Running", tone: "ok", sentence: "Running now." },
	waiting: { word: "Waiting", tone: "neutral", sentence: "Waiting for its next wake." },
	paused: { word: "Paused", tone: "warn", sentence: "Paused." },
	blocked: { word: "Blocked", tone: "danger", sentence: "Blocked." },
	completed: { word: "Completed", tone: "ok", sentence: "Completed." },
	stopped: { word: "Stopped", tone: "neutral", sentence: "Stopped." },
};

const meterFills = { normal: "bg-accent", high: "bg-warn" } as const;

/** A meter: a track with a fill whose width is set through CSSOM (the CSP forbids style attributes). */
export function meter(name: string, value: number, max: number, height: string): HTMLElement {
	const ratio = max > 0 ? Math.min(value / max, 1) : 0;
	const fill = el("div", `h-full rounded-full ${ratio >= 0.8 ? meterFills.high : meterFills.normal}`);
	fill.style.width = `${Math.round(ratio * 100)}%`;
	const track = el("div", `w-full overflow-hidden rounded-full bg-fill ${height}`, fill);
	return attrs(track, {
		role: "meter",
		"aria-label": name,
		"aria-valuemin": "0",
		"aria-valuemax": String(max),
		"aria-valuenow": String(Math.min(value, max)),
		"aria-valuetext": `${Math.round(ratio * 100)} percent used`,
	});
}

/** One limit: its name and numbers on a line, a thin bar under it; the bar turns amber from 80 percent. */
export function limitRow(entry: { name: string; value: number; max: number; words: string }): HTMLElement {
	const reached = entry.value >= entry.max;
	const head = el(
		"div",
		"flex min-w-0 items-baseline justify-between gap-3",
		el("span", text.strong, entry.name),
		el("span", text.meta, reached ? `${entry.words}, limit reached` : entry.words),
	);
	return el("div", "flex min-w-0 flex-col gap-1.5", head, meter(entry.name, entry.value, entry.max, "h-1"));
}

/** What the run reports as unknown, as one sentence; null when nothing is unknown. */
export function unknownSentence(run: MissionRunView): string | null {
	if (unknownResults(run) === 0) return null;
	const parts: string[] = [];
	if (run.unknownRequests > 0) parts.push(plural(run.unknownRequests, "model request", "model requests"));
	if (run.uncertainTools > 0) parts.push(plural(run.uncertainTools, "tool call", "tool calls"));
	const sentences: string[] = [];
	if (parts.length > 0) sentences.push(`${parts.join(" and ")} ${run.unknownRequests + run.uncertainTools === 1 ? "has an unknown result" : "have unknown results"}.`);
	if (run.unpricedResponses > 0) sentences.push(`${plural(run.unpricedResponses, "response has", "responses have")} no known price.`);
	return sentences.join(" ");
}

/**
 * Why a run needs the owner, as one paragraph: the blocker (only when blocked), what is unknown, and what the agent
 * waits for. The one wording for the Status and Mission callouts and the shell strip.
 */
export function blockedExplanation(run: MissionRunView, name: string): { blocked: boolean; body: string } {
	const blocked = run.status === "blocked";
	const unknown = unknownSentence(run);
	const reason = blocked ? (run.blocker ?? `${name} reports it cannot continue.`) : null;
	const next = unknown
		? `${name} will not continue until you review ${unknownResults(run) === 1 ? "it" : "them"} in a terminal.`
		: `${name} will not continue until you look at it in a terminal.`;
	return { blocked, body: [reason, unknown, next].filter((part) => part !== null).join(" ") };
}

/** The callout for a run that needs the owner: the explanation and the command that shows the details. */
export function blockedCallout(ctx: Ctx, run: MissionRunView, key: string): HTMLElement {
	const { blocked, body } = blockedExplanation(run, ctx.name);
	return callout({
		tone: blocked ? "danger" : "warn",
		title: blocked ? "Blocked." : "Needs your review.",
		body,
		role: "status",
		children: [command(`${commandName(ctx.name)} mission status`, key, ctx.act.copy)],
	});
}

/** Inline code chips for a list of identifiers (tool names, chain of command). */
export function chips(items: readonly string[]): HTMLElement {
	return el("span", "flex flex-wrap gap-1.5", ...items.map((item) => el("code", "rounded-xs bg-fill px-1.5 py-0.5 font-mono text-xs text-fg [overflow-wrap:anywhere]", item)));
}

/** A bulleted list, or a plain sentence when the list is empty. */
export function bullets(items: readonly string[], none = "None listed."): HTMLElement {
	if (items.length === 0) return el("span", text.body, none);
	return attrs(el("ul", "m-0 flex list-disc flex-col gap-1 pl-4", ...items.map((item) => el("li", text.strong, item))), { role: "list" });
}
