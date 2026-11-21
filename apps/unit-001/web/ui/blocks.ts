// Small display blocks: tags, dots, callouts, copyable commands, empty states, spinners and keyboard hints.
import type { Tone } from "../state.ts";
import { callouts, dots, tags, text } from "./classes.ts";
import { attrs, type Child, el } from "./dom.ts";
import { type IconName, icon } from "./icons.ts";

/** A small status word (Hermes Badge). Red only for real failures; ambiguous states stay neutral. */
export function tag(label: string, tone: keyof typeof tags = "neutral", glyph?: IconName): HTMLElement {
	return el("span", tags[tone], glyph ? icon(glyph, "size-3 shrink-0") : null, label);
}

/** A 6 px state dot; decorative, always next to the word it colors. */
export function dot(tone: Tone): HTMLElement {
	return attrs(el("span", dots[tone]), { "aria-hidden": "true" });
}

const calloutIcons = { danger: "error", warn: "warning", info: "info" } as const satisfies Record<keyof typeof callouts, IconName>;
const calloutIconColors = { danger: "text-danger", warn: "text-warn", info: "text-fg-3" } as const;
const calloutTitles = { danger: "font-semibold text-danger", warn: "font-semibold text-warn", info: "font-semibold text-fg" } as const;

/**
 * A callout block (Hermes error card): icon, an optional bold lead-in, the sentence, then optional children
 * (a command, actions). `role` is set by the caller when it must be announced ("alert" or "status").
 */
export function callout(options: {
	tone: keyof typeof callouts;
	title?: string;
	body: string;
	children?: Child[];
	role?: "alert" | "status";
}): HTMLElement {
	const sentence = el("p", "[overflow-wrap:anywhere]", options.title ? el("strong", calloutTitles[options.tone], `${options.title} `) : null, options.body);
	const content = el("div", "flex min-w-0 flex-1 flex-col gap-2", sentence, ...(options.children ?? []));
	const box = el("div", callouts[options.tone], el("span", `mt-px ${calloutIconColors[options.tone]}`, icon(calloutIcons[options.tone], "size-4 shrink-0")), content);
	if (options.role) box.setAttribute("role", options.role);
	return box;
}

/**
 * A terminal command to copy (Hermes approval card's command block): mono, hairline, `$` prompt, a Copy button.
 * This is how anything that changes the agent is offered: never an Approve or Start button.
 * `key` must be unique on the page; the button's text is exactly "Copy".
 */
export function command(line: string, key: string, copy: (text: string, label: string) => Promise<boolean>): HTMLElement {
	const code = el("code", "min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-sm whitespace-pre text-fg [scrollbar-width:thin]", line);
	const label = el("span", "", "Copy");
	const glyph = el("span", "grid place-items-center", icon("copy", "size-3.5 shrink-0"));
	const copyButton = el(
		"button",
		"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-1.5 text-xs font-medium text-fg-2 hover:bg-hover hover:text-fg pointer-coarse:h-11 pointer-coarse:px-3",
		glyph,
		label,
	);
	copyButton.type = "button";
	copyButton.dataset.key = key;
	copyButton.setAttribute("aria-label", `Copy command: ${line}`);
	copyButton.addEventListener("click", () => {
		void copy(line, "Command").then((copied) => {
			if (!copied) return;
			// The check replaces the copy glyph for a moment; the text stays "Copy" so the button never changes width.
			glyph.replaceChildren(icon("check", "size-3.5 shrink-0 text-ok"));
			setTimeout(() => glyph.replaceChildren(icon("copy", "size-3.5 shrink-0")), 1500);
		});
	});
	return el(
		"div",
		"flex min-w-0 items-center gap-2 rounded-sm border border-stroke-3 bg-card pr-1 pl-2.5",
		attrs(el("span", "font-mono text-sm text-fg-3 select-none", "$"), { "aria-hidden": "true" }),
		code,
		copyButton,
	);
}

/** An empty state (Hermes PanelEmpty): a muted icon, one sentence, an optional action. */
export function emptyState(glyph: IconName, sentence: string, action?: HTMLElement): HTMLElement {
	return el(
		"div",
		"flex flex-col items-center justify-center gap-2 px-4 py-10 text-center",
		el("span", "text-fg-4", icon(glyph, "size-5 shrink-0")),
		el("p", `max-w-[40ch] ${text.description}`, sentence),
		action ?? null,
	);
}

/** A 14 px spinner for running work; pair it with a word or a `srOnly` label. */
export function spinner(className = "size-3.5 shrink-0 text-accent"): SVGSVGElement {
	return icon("spinner", `${className} animate-spin`);
}

/** A keyboard hint chip (Hermes kbd): decorative, hidden from screen readers. */
export function kbd(keys: string): HTMLElement {
	return attrs(
		el("kbd", "inline-grid h-4 min-w-4 place-items-center rounded-xs border border-stroke-3 px-1 font-sans text-2xs text-fg-3", keys),
		{ "aria-hidden": "true" },
	);
}

/** A labelled number for a stats strip: value above, label below. */
export function stat(value: string, label: string): HTMLElement {
	return el("div", "flex min-w-0 flex-col gap-0.5", el("span", text.stat, value), el("span", text.meta, label));
}
