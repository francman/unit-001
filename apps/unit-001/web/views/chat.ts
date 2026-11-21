// Chat page: transcript, live reply, tool rows and the composer; built once and patched in place so typing is never interrupted.
import type { Change, Ctx, Tool, Ui } from "../state.ts";
import { callout, spinner } from "../ui/blocks.ts";
import { text } from "../ui/classes.ts";
import { button, iconButton } from "../ui/controls.ts";
import { attrs, coarsePointer, el, paragraphs, srOnly } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";

/** The chat page instance the shell keeps for the whole session. */
export interface ChatView {
	/** The page element; the shell attaches it to the page region while Chat is open. */
	readonly root: HTMLElement;
	/** Applies a state change in place; the composer and its draft are never replaced. */
	update(change: Change): void;
	/** Moves focus to the composer. */
	focus(): void;
	/** Stops observers and timers. */
	destroy(): void;
}

type Entry = NonNullable<Ui["view"]>["entries"][number];

/**
 * One reading column shared by the purpose line, the thread and the composer, so their edges line up. Each row that holds
 * it reserves the same scrollbar gutter as the thread (`scrollbar-gutter: stable`), so a classic scrollbar never shifts one.
 */
const column = "mx-auto w-full max-w-[51rem] px-6 max-md:px-3";
const gutterRow = "shrink-0 overflow-hidden [scrollbar-gutter:stable]";

// Starting points that only fill the composer; worded as the owner would ask.
const suggestions = ["What needs my attention?", "What are you working on right now?", "What did you finish this week?"];

/** Creates the chat page; `context` is read on every update so it always sees the current state. */
export function createChat(context: () => Ctx): ChatView {
	const purposeRow = attrs(el("div", `${gutterRow} xl:hidden`), { "data-chat-top": "" });
	const noticeRow = el("div", gutterRow);
	const columnNode = attrs(el("div", `${column} flex min-h-full flex-col pt-6 pb-8 max-md:pt-4 max-md:pb-6`), { "data-column": "" });
	const thread = attrs(el("div", "h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus-visible:-outline-offset-2", columnNode), {
		id: "thread",
		role: "log",
		tabindex: "0",
		"aria-live": "off",
	});
	const jump = attrs(
		el(
			"button",
			"absolute bottom-3 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full border border-line bg-elevated text-fg-2 shadow-float hover:text-fg pointer-coarse:size-11",
			icon("arrowDown", "size-3.5 shrink-0"),
			srOnly("Jump to latest"),
		),
		{ type: "button", "data-key": "jump", title: "Jump to latest" },
	);
	jump.hidden = true;
	jump.addEventListener("click", () => thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" }));
	// Whether the person reads the end of the thread, and where they were otherwise. Kept across pages: while the chat is
	// detached its scroll offset is lost, so it is put back when the chat is shown again.
	let following = true;
	let savedTop = 0;
	thread.addEventListener("scroll", () => {
		following = nearBottom(thread);
		savedTop = thread.scrollTop;
		jump.hidden = following;
	});
	const composer = createComposer(context);
	const root = attrs(
		el("section", "flex min-h-0 min-w-0 flex-1 flex-col", purposeRow, noticeRow, el("div", "relative min-h-0 flex-1", thread, jump), composer.row),
		{ "aria-label": "Chat", "data-conversation": "" },
	);

	let historyKey = "";
	let purposeKey = "";
	let noticeKey = "";
	let live: HTMLElement | null = null;

	return {
		root,
		update(change) {
			const ctx = context();
			const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
			const focusedKey = focused?.dataset.key ?? null;
			thread.setAttribute("aria-label", `Conversation with ${ctx.name}`);
			if (change === "state") {
				const nextPurpose = purposeSignature(ctx);
				if (nextPurpose !== purposeKey) {
					purposeKey = nextPurpose;
					purposeRow.replaceChildren(...purposeLine(ctx));
				}
				const nextNotice = ctx.ui.unknown ? ctx.ui.unknown.requestId : "";
				if (nextNotice !== noticeKey) {
					noticeKey = nextNotice;
					noticeRow.replaceChildren(...(ctx.ui.unknown ? [el("div", `${column} pt-3`, unknownNotice(ctx))] : []));
				}
			}
			const nextHistory = historySignature(ctx);
			if (nextHistory !== historyKey) {
				historyKey = nextHistory;
				columnNode.replaceChildren(...history(ctx));
				live = null;
			}
			live = patchLive(ctx, columnNode, live);
			composer.update(ctx);
			// A rebuilt row loses focus; give it back to the control with the same key (copy, restore, purpose).
			if (focusedKey && !root.contains(focused))
				root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
			if (!root.isConnected) return;
			if (following) thread.scrollTop = thread.scrollHeight;
			else if (thread.scrollTop !== savedTop) thread.scrollTop = savedTop;
			jump.hidden = nearBottom(thread);
		},
		focus() {
			composer.input.focus({ preventScroll: true });
		},
		destroy() {
			composer.destroy();
		},
	};
}

function nearBottom(node: HTMLElement): boolean {
	return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function isEmpty(ui: Readonly<Ui>): boolean {
	return !ui.view?.entries.length && !ui.view?.busy;
}

// ── Purpose line ──

function purposeSignature(ctx: Ctx): string {
	const objective = ctx.ui.details?.mission.objective ?? "";
	return `${objective}|${isEmpty(ctx.ui)}|${ctx.ui.purposeOpen}`;
}

// The defining sentence above the thread below 1440 px (the Activity pane shows it from there). The button's text is exactly
// "Purpose" and the objective; it wraps to two lines and opens fully on request. The empty conversation shows it instead.
function purposeLine(ctx: Ctx): HTMLElement[] {
	const objective = ctx.ui.details?.mission.objective;
	if (!objective || isEmpty(ctx.ui)) return [];
	const line = el(
		"button",
		`${column} flex items-baseline gap-3 border-b border-stroke-4 py-2 text-left hover:bg-hover pointer-coarse:min-h-11`,
		el("span", `shrink-0 ${text.label}`, "Purpose"),
		el("span", ctx.ui.purposeOpen ? "min-w-0 text-sm text-fg-2" : "min-w-0 text-sm text-fg-2 line-clamp-1", objective),
	);
	line.type = "button";
	line.dataset.key = "purpose";
	line.title = objective;
	line.setAttribute("aria-expanded", String(ctx.ui.purposeOpen));
	line.addEventListener("click", () => ctx.act.togglePurpose());
	return [line];
}

// ── Transcript ──

function historySignature(ctx: Ctx): string {
	const view = ctx.ui.view;
	if (!view) return `none|${ctx.ui.connection}`;
	const last = view.entries.at(-1);
	return [
		view.entries.length,
		last?.id,
		last?.text.length,
		view.historyTruncated,
		isEmpty(ctx.ui),
		view.busy,
		ctx.ui.finishedTools.length,
		ctx.ui.stopped,
		ctx.name,
		isEmpty(ctx.ui) ? ctx.ui.details?.mission.objective : "",
	].join("|");
}

/** The column's content: a note when history is cut, then one group per turn (the owner's message and the replies to it). */
function history(ctx: Ctx): HTMLElement[] {
	const view = ctx.ui.view;
	if (!view) return [loading(ctx)];
	if (isEmpty(ctx.ui)) return [emptyChat(ctx)];
	const nodes: HTMLElement[] = [];
	if (view.historyTruncated) nodes.push(el("p", `mb-4 text-center ${text.meta}`, "Earlier messages are kept but not shown here."));
	let turn: HTMLElement | null = null;
	for (const entry of view.entries) {
		if (entry.role === "user" || !turn) {
			turn = attrs(el("div", "flex flex-col gap-3 pb-3 last:pb-0"), { "data-turn": "" });
			nodes.push(turn);
		}
		turn.append(entry.role === "user" ? userMessage(ctx, entry) : agentMessage(ctx, entry));
	}
	if (!view.busy && turn) {
		if (ctx.ui.finishedTools.length) turn.append(toolSummary(ctx.ui.finishedTools));
		if (ctx.ui.stopped) turn.append(el("p", `pl-3 ${text.meta}`, "Stopped. Work so far is kept."));
	}
	// The first group starts at the bottom of the pane, next to the composer, until the conversation fills it.
	nodes[0]?.classList.add("mt-auto");
	return nodes;
}

const notes = "mt-1.5 text-xs text-fg-3";

// Hermes.app: the owner's turn is a full-width bordered box that stays pinned at the top while its reply scrolls under it.
function userMessage(ctx: Ctx, entry: Entry): HTMLElement {
	const body = el("div", "max-h-[7.5rem] overflow-y-auto [overflow-wrap:anywhere]");
	paragraphs(body, entry.text, "mt-2 first:mt-0 whitespace-pre-wrap");
	const box = el(
		"article",
		"rounded-md border border-stroke-3 bg-bubble px-3 py-2 text-chat text-fg transition-colors duration-100 hover:border-stroke-2",
		srOnly("You said:"),
		body,
	);
	if (entry.source === "host") box.append(el("p", notes, `Sent from the computer ${ctx.name} runs on`));
	if (entry.truncated) box.append(el("p", notes, "Shortened in this view."));
	return el("div", "sticky top-0 z-10 -mx-1 bg-canvas px-1 pt-1", box);
}

// The agent's reply: plain text, no bubble, indented to the user box's text; a copy action appears on hover or focus.
function agentMessage(ctx: Ctx, entry: Entry): HTMLElement {
	const body = el("div", "[overflow-wrap:anywhere]");
	paragraphs(body, entry.text, "mt-3 first:mt-0 whitespace-pre-wrap");
	const actions = el(
		"div",
		"flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover/reply:opacity-100 group-focus-within/reply:opacity-100 pointer-coarse:hidden",
		iconButton({ icon: "copy", label: "Copy reply", key: `copy-reply-${entry.id}`, onClick: () => void ctx.act.copy(entry.text, "Reply") }),
	);
	const message = el("article", "group/reply flex flex-col gap-0.5 pl-3 text-chat text-fg", srOnly(`${ctx.name} said:`), body);
	if (entry.source === "host") message.append(el("p", notes, `Sent from the computer ${ctx.name} runs on`));
	if (entry.truncated) message.append(el("p", notes, "Shortened in this view."));
	message.append(el("div", "-ml-1.5", actions));
	return message;
}

// ── Live reply ──

/** Adds, updates or removes the streaming reply at the end of the last turn; only this node changes per token. */
function patchLive(ctx: Ctx, columnNode: HTMLElement, current: HTMLElement | null): HTMLElement | null {
	const view = ctx.ui.view;
	if (!view?.busy) {
		current?.remove();
		return null;
	}
	const node = current ?? attrs(el("article", "flex flex-col gap-3 pl-3 text-chat text-fg"), { "aria-busy": "true", "data-live": "" });
	if (!current) {
		const turns = columnNode.querySelectorAll<HTMLElement>("[data-turn]");
		(turns[turns.length - 1] ?? columnNode).append(node);
	}
	const parts: Node[] = [srOnly(`${ctx.name} is replying:`)];
	if (view.text) {
		const body = el("div", "[overflow-wrap:anywhere]");
		paragraphs(body, view.text, "mt-3 first:mt-0 whitespace-pre-wrap");
		body.lastElementChild?.append(
			attrs(el("span", "ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-accent animate-caret forced-colors:bg-[CanvasText]"), {
				"aria-hidden": "true",
			}),
		);
		parts.push(body);
	}
	if (view.tools.length) parts.push(toolRows(view.tools));
	parts.push(statusLine(ctx));
	if (view.textTruncated) parts.push(el("p", notes, "The live reply is shortened in this view."));
	node.replaceChildren(...parts);
	return node;
}

// Hermes's running-status line: 11 px tertiary with a spinner, saying what is happening now.
function statusLine(ctx: Ctx): HTMLElement {
	const running = ctx.ui.view?.tools.find((tool) => tool.status === "running");
	const words = ctx.ui.cancelling ? "Stopping after the current step" : running ? `Running ${running.name.split(" ")[0]}` : "Thinking";
	return el("p", "-ml-0.5 flex items-center gap-1.5 text-xs text-fg-3", spinner("size-3.5 shrink-0 text-fg-3"), el("span", "", words));
}

// ── Tool rows ──

function failed(tool: Tool): boolean {
	return tool.status === "error" || tool.status === "failed";
}

// Hermes.app tool rows: 12 px lines (state glyph, tool name, its argument), dimmed until hovered so the answer stays the loudest
// thing. The state is also a word for screen readers; a failed call stays at full strength in the danger color.
function toolRows(tools: readonly Tool[]): HTMLElement {
	const list = attrs(el("ul", "m-0 flex list-none flex-col p-0"), { role: "list", "aria-label": "Tool calls" });
	for (const tool of tools) {
		const bad = failed(tool);
		const glyph =
			tool.status === "running"
				? spinner("size-3.5 shrink-0 text-fg-3")
				: icon(bad ? "error" : "success", bad ? "size-3.5 shrink-0 text-danger" : "size-3.5 shrink-0 text-ok/85");
		const [command = "", ...rest] = tool.name.split(" ");
		list.append(
			el(
				"li",
				bad
					? "flex min-h-6 min-w-0 items-center gap-1.5 text-[0.75rem] text-danger"
					: "flex min-h-6 min-w-0 items-center gap-1.5 text-[0.75rem] text-fg-2 opacity-70 transition-opacity duration-100 hover:opacity-100",
				el("span", "grid size-3.5 shrink-0 place-items-center", glyph),
				el("span", "min-w-0 truncate", el("span", "font-medium", command), rest.length ? el("span", "font-mono text-fg-3", ` ${rest.join(" ")}`) : null),
				el("span", bad ? "shrink-0 text-xs" : "sr-only", tool.status === "running" ? ", running" : bad ? "failed" : ", done"),
			),
		);
	}
	return list;
}

// Finished tool work collapses to one line under the reply; a failure keeps it open.
function toolSummary(tools: readonly Tool[]): HTMLElement {
	const failures = tools.filter(failed).length;
	const details = el("details", "group/tools pl-3");
	details.open = failures > 0;
	const summary = el(
		"summary",
		"-ml-1 flex w-fit cursor-default list-none items-center gap-1.5 rounded-xs px-1 py-0.5 text-[0.75rem] text-fg-3 hover:bg-hover hover:text-fg-2 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden",
		icon("chevronRight", "size-3 shrink-0 transition-transform duration-100 group-open/tools:rotate-90"),
		icon("tool", "size-3.5 shrink-0"),
		`Used ${tools.length} tool${tools.length === 1 ? "" : "s"}`,
		failures ? el("span", "text-danger", `, ${failures} failed`) : null,
	);
	details.append(summary, el("div", "mt-1 pl-1", toolRows(tools)));
	return details;
}

// ── Empty and loading ──

function loading(ctx: Ctx): HTMLElement {
	return el(
		"div",
		"m-auto flex flex-col items-center gap-2 py-16",
		spinner("size-5 shrink-0 text-fg-3"),
		el("p", text.meta, ctx.ui.connection === "connecting" ? `Connecting to ${ctx.name}` : `Waiting for ${ctx.name}`),
	);
}

// Hermes's empty chat: a centered greeting, the purpose when there is one, and a few starting points that only fill the draft.
function emptyChat(ctx: Ctx): HTMLElement {
	const objective = ctx.ui.details?.mission.objective;
	const list = attrs(el("ul", "m-0 flex list-none flex-col gap-px p-0"), { role: "list" });
	suggestions.forEach((suggestion, index) => {
		const item = el(
			"button",
			"group flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-base text-fg-2 transition-colors duration-100 hover:bg-hover hover:text-fg pointer-coarse:h-11",
			icon("chevronRight", "size-3.5 shrink-0 text-fg-4 group-hover:text-fg-3"),
			suggestion,
		);
		item.type = "button";
		item.dataset.key = `suggestion-${index}`;
		item.addEventListener("click", () => ctx.act.useDraft(suggestion));
		list.append(el("li", "", item));
	});
	return el(
		"div",
		"my-auto flex w-full flex-col gap-6 py-8",
		el(
			"div",
			"flex flex-col gap-2",
			el("h2", "text-xl font-semibold tracking-[-0.02em] text-fg", `What can ${ctx.name} help with?`),
			objective ? el("p", "flex flex-col gap-1", el("span", text.label, "Purpose"), el("span", "text-base text-fg-2 [overflow-wrap:anywhere]", objective)) : null,
		),
		el("div", "-mx-2.5 flex flex-col gap-1", el("p", `px-2.5 ${text.label}`, "Start with"), list),
	);
}

// ── Uncertain delivery ──

function unknownNotice(ctx: Ctx): HTMLElement {
	const unknown = ctx.ui.unknown;
	const prompt = unknown?.prompt ?? "";
	const requestId = unknown?.requestId ?? "";
	return callout({
		tone: "warn",
		role: "alert",
		title: "Delivery not confirmed.",
		body: `${ctx.name} may have received your last message. It has not been sent again. Look for it above, then decide.`,
		children: [
			el("p", "font-mono text-xs text-fg-3 [overflow-wrap:anywhere]", `Request ID ${requestId}`),
			el(
				"div",
				"-ml-2 flex flex-wrap gap-1",
				button({
					label: "Restore message",
					key: "restore-draft",
					variant: "ghost",
					onClick: () => {
						ctx.act.useDraft(ctx.ui.draft.trim() ? `${ctx.ui.draft}\n${prompt}` : prompt);
						ctx.act.dismissUnknown();
					},
				}),
				button({ label: "I have checked", key: "dismiss-unknown", variant: "ghost", onClick: () => ctx.act.dismissUnknown() }),
				button({ label: "Copy request ID", key: "copy-request", variant: "ghost", onClick: () => void ctx.act.copy(requestId, "Request ID") }),
			),
		],
	});
}

// ── Composer ──

/**
 * Hermes's composer card: a 1 px accent ring that strengthens on hover and focus, the draft on the left, the model and one
 * send button on the right. Send becomes Stop while a reply runs, so the target never moves. One line when empty, grows to
 * 150 px (or 30 % of a short screen), then scrolls inside.
 */
function createComposer(context: () => Ctx): { row: HTMLElement; input: HTMLTextAreaElement; update(ctx: Ctx): void; destroy(): void } {
	const input = attrs(
		el(
			"textarea",
			"block max-h-[min(9.375rem,30dvh)] min-h-7 w-full min-w-0 flex-1 resize-none bg-transparent px-1 py-[5px] text-chat leading-[18px] text-fg outline-none placeholder:text-fg-3 pointer-coarse:min-h-11 pointer-coarse:py-[13px] pointer-coarse:text-[16px]",
		),
		{ id: "composer", rows: "1", maxlength: "16000", "aria-describedby": "composer-keys composer-hint", enterkeyhint: "send" },
	);
	const model = el("span", "hidden min-w-0 max-w-[12rem] items-center gap-1 truncate px-1 text-xs text-fg-3 sm:inline-flex");
	const send = el("button", "");
	send.dataset.key = "send";
	send.dataset.send = "";
	const hint = attrs(el("p", "min-h-0 px-1 pt-1 text-xs text-fg-3 empty:hidden"), { id: "composer-hint", "aria-live": "polite" });
	const card = el(
		"div",
		"flex min-w-0 items-end gap-1 rounded-lg border border-accent/25 bg-card py-[5px] pr-[5px] pl-2 shadow-composer transition-colors duration-200 hover:border-accent/45 focus-within:border-accent forced-colors:border-[CanvasText]",
		input,
		el("div", "flex h-7 shrink-0 items-center gap-1 pointer-coarse:h-11", model, send),
	);
	card.addEventListener("click", (event) => {
		if (event.target === card) input.focus();
	});
	const form = el(
		"form",
		`${column} pb-2.5 max-md:pb-2`,
		card,
		hint,
		attrs(el("p", "sr-only", "Enter sends, Shift and Enter add a line."), { id: "composer-keys" }),
	);
	const row = el("div", `${gutterRow} pt-1`, form);

	const busy = () => context().ui.view?.busy === true;
	const grow = () => {
		input.style.height = "auto";
		input.style.height = `${input.scrollHeight}px`;
	};
	const sync = (ctx: Ctx) => {
		const running = ctx.ui.view?.busy === true;
		send.type = running ? "button" : "submit";
		send.className = running
			? "grid size-[26px] shrink-0 place-items-center rounded-full bg-fg text-canvas transition-colors duration-100 hover:bg-fg-2 aria-disabled:opacity-50 pointer-coarse:size-11"
			: "grid size-[26px] shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-colors duration-100 hover:bg-accent/88 disabled:bg-fg-4 disabled:text-canvas pointer-coarse:size-11";
		send.replaceChildren(
			icon(running ? "stop" : "send", running ? "size-3 shrink-0" : "size-3.5 shrink-0"),
			srOnly(running ? "Stop current work" : "Send message"),
		);
		send.title = running ? "Stop (Esc)" : "Send (Enter)";
		send.disabled = running ? false : !ctx.ui.draft.trim() || ctx.ui.sending || ctx.ui.connection !== "connected";
		send.setAttribute("aria-disabled", String(running && ctx.ui.cancelling));
	};

	input.addEventListener("input", () => {
		context().act.setDraft(input.value);
		grow();
		sync(context());
	});
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing || coarsePointer()) return;
		event.preventDefault();
		if (!busy()) form.requestSubmit();
	});
	send.addEventListener("click", (event) => {
		if (!busy()) return;
		event.preventDefault();
		context().act.cancel();
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!busy()) context().act.send();
	});
	// Width changes re-wrap the draft, so the height is measured again; height-only callbacks (from grow) are ignored.
	let width = -1;
	const observer = new ResizeObserver((entries) => {
		const next = entries[0]?.contentRect.width ?? width;
		if (next === width) return;
		width = next;
		grow();
	});
	observer.observe(input);

	return {
		row,
		input,
		update(ctx) {
			if (input.value !== ctx.ui.draft) {
				input.value = ctx.ui.draft;
				grow();
			}
			const placeholder = `Message ${ctx.name}`;
			if (input.placeholder !== placeholder) {
				input.placeholder = placeholder;
				input.setAttribute("aria-label", placeholder);
			}
			const modelId = ctx.ui.view?.model?.modelId ?? "";
			if (model.textContent !== modelId) {
				model.replaceChildren(...(modelId ? [icon("cpu", "size-3 shrink-0"), el("span", "truncate", modelId)] : []));
				model.title = modelId ? `Model: ${ctx.ui.view?.model?.provider}/${modelId}` : "";
			}
			const words = ctx.ui.cancelling ? "Stopping after the current step." : "";
			if (hint.textContent !== words) hint.textContent = words;
			sync(ctx);
		},
		destroy() {
			observer.disconnect();
		},
	};
}
