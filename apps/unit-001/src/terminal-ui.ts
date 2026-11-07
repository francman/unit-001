// Renders the attached service with a fixed editor and a scrolling, bounded Markdown conversation.
import { basename } from "node:path";
import {
	type Component,
	Container,
	Editor,
	type EditorTheme,
	getKeybindings,
	isKeyRelease,
	KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	ScrollView,
	type Terminal,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	type TuiInputListenerResult,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./render.ts";
import type { ServiceView } from "./service.ts";
import { createTerminalController, type TerminalController, type TerminalState } from "./terminal-controller.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"unit.attach.cancel": true;
		"unit.attach.detach": true;
	}
}

export const DEFAULT_APP_KEYBINDINGS = {
	"unit.attach.cancel": { defaultKeys: "ctrl+c", description: "Cancel busy work; detach when idle" },
	"unit.attach.detach": { defaultKeys: "ctrl+d", description: "Detach without cancelling work" },
} as const;

export interface RichAttachOptions {
	readonly colorMode?: "color" | "monochrome";
}

type Actions = Pick<TerminalController, "submit" | "cancel" | "detach">;

const MAX_DRAFT_BYTES = 16_384;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Runs the rich socket client and restores terminal modes on every exit path. */
export async function runRichAttach(
	endpoint: string,
	terminal: Terminal,
	signal: AbortSignal,
	options: RichAttachOptions = {},
): Promise<number> {
	if (signal.aborted) return 0;
	const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false, copyOnSelect: false });
	let controller: TerminalController;
	const actions: Actions = {
		submit: (text) => controller.submit(text),
		cancel: () => controller.cancel(),
		detach: () => controller.detach(),
	};
	const view = new RichAttachView(tui, basename(endpoint, ".sock"), actions, options);
	tui.setLayoutRoot(view);
	tui.setFocus(view.editor);
	tui.addInputListener((data) => view.handleGlobalInput(data));
	controller = createTerminalController(endpoint, (state) => view.update(state), signal);
	try {
		tui.start();
		return await controller.closed;
	} finally {
		controller.detach();
		try {
			await terminal.drainInput(1000);
		} finally {
			tui.stop();
		}
	}
}

/** Retains editor state while differential rendering updates the conversation and metadata around it. */
export class RichAttachView extends VStack {
	readonly editor: Editor;
	readonly transcript = new Container();
	readonly scroll: ScrollView;
	readonly #tui: TuiAltScreen;
	readonly #session: string;
	readonly #actions: Actions;
	readonly #theme: ReturnType<typeof createTheme>;
	readonly #header: StatusLines;
	readonly #footer: StatusLines;
	readonly #messages = new Map<number, { text: string; role: string; truncated: boolean; card: Component }>();
	readonly #keys = new KeybindingsManager(
		{ ...TUI_KEYBINDINGS, ...DEFAULT_APP_KEYBINDINGS },
		getKeybindings().getUserBindings(),
	);
	readonly #live: PassiveMarkdown;
	#liveText = "";
	#draft = "";
	#restoringDraft = false;
	#paste: string | undefined;
	#pasteBytes = 0;
	#pasteBaseBytes = 0;
	#discardPaste = false;
	#inputNotice = "";
	#state: TerminalState = { connection: "connecting", sending: false, cancelling: false, notices: [] };

	constructor(tui: TuiAltScreen, session: string, actions: Actions, options: RichAttachOptions = {}) {
		super();
		this.#tui = tui;
		this.#session = label(session);
		this.#actions = actions;
		this.#theme = createTheme(options.colorMode !== "monochrome");
		this.#header = new StatusLines((width) => this.header(width));
		this.#footer = new StatusLines((width) => this.footer(width));
		this.#live = new PassiveMarkdown("", 1, 0, this.#theme.markdown);
		this.editor = new Editor(tui, this.#theme.editor, { paddingX: 1 });
		this.editor.onChange = () => {
			if (this.#restoringDraft) return;
			const draft = this.editor.getExpandedText();
			if (Buffer.byteLength(draft) <= MAX_DRAFT_BYTES) {
				this.#draft = draft;
				return;
			}
			this.#restoringDraft = true;
			try {
				this.editor.setText(this.#draft);
			} finally {
				this.#restoringDraft = false;
			}
			this.rejectInput();
		};
		this.editor.onSubmit = (text) => {
			const result = this.#actions.submit(text);
			if (result.status === "rejected") this.editor.setText(text);
			else if (result.status === "submitted") this.editor.addToHistory(text);
			this.#tui.requestRender();
		};
		this.scroll = new ScrollView(this.transcript, { follow: "end", primary: true, scrollbar: "auto" });
		this.addChild(this.#header, { basis: 2, minSize: 1, shrink: 0 });
		this.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
		this.addChild(this.editor, { basis: "auto", minSize: 3, maxSize: 8, shrink: 1 });
		this.addChild(this.#footer, { basis: 2, minSize: 1, shrink: 0 });
		this.update(this.#state);
	}

	/** Applies a bounded owner snapshot without changing the draft or cursor. */
	update(state: TerminalState): void {
		const changed = state.view !== this.#state.view || state.notices !== this.#state.notices;
		this.#state = state;
		if (changed || this.transcript.children.length === 0) this.updateTranscript(state.view);
		this.#tui.requestRender();
	}

	/** Handles configurable application actions before the focused editor consumes ordinary input. */
	handleGlobalInput(data: string): TuiInputListenerResult {
		if (isKeyRelease(data)) return { consume: true };
		if (this.#keys.matches(data, "unit.attach.detach")) {
			this.#actions.detach();
			return { consume: true };
		}
		if (this.#keys.matches(data, "unit.attach.cancel")) {
			if (this.#state.view?.busy || this.#state.sending) this.#actions.cancel();
			else this.#actions.detach();
			return { consume: true };
		}
		if (this.#paste !== undefined || data.startsWith(PASTE_START)) {
			if (this.#paste === undefined) {
				this.#paste = "";
				this.#pasteBytes = 0;
				this.#pasteBaseBytes = Buffer.byteLength(this.#draft);
				data = data.slice(PASTE_START.length);
			}
			const end = data.indexOf(PASTE_END);
			const part = end === -1 ? data : data.slice(0, end);
			if (!this.#discardPaste) {
				const bytes = Buffer.byteLength(part);
				if (this.#pasteBaseBytes + this.#pasteBytes + bytes > MAX_DRAFT_BYTES) {
					this.#discardPaste = true;
					this.#paste = "";
					this.rejectInput();
				} else {
					this.#paste += part;
					this.#pasteBytes += bytes;
				}
			}
			if (end === -1) return { consume: true };
			const paste = this.#paste;
			this.#paste = undefined;
			if (this.#discardPaste) {
				this.#discardPaste = false;
				return { consume: true };
			}
			return { data: `${PASTE_START}${paste}${PASTE_END}${data.slice(end + PASTE_END.length)}` };
		}
		if (Buffer.byteLength(data) > MAX_DRAFT_BYTES) {
			this.rejectInput();
			return { consume: true };
		}
		return undefined;
	}

	private rejectInput(): void {
		this.#inputNotice = "Input exceeds 16 KiB; existing draft preserved.";
		this.updateTranscript(this.#state.view);
		this.#tui.requestRender();
	}

	private header(width: number): string[] {
		const view = this.#state.view;
		const name = view === undefined ? "agent" : label(view.name);
		const activity =
			this.#state.connection !== "attached"
				? this.#state.connection
				: this.#state.cancelling
					? "cancelling"
					: this.#state.sending
						? "sending"
						: view?.busy
							? "working"
							: "ready";
		const model =
			view?.model == null ? "model unknown" : `${label(view.model.provider)}/${label(view.model.modelId)}`;
		const title = truncateToWidth(`${name}  /  ${this.#session}`, Math.max(1, width - activity.length - 2));
		const gap = " ".repeat(Math.max(1, width - visibleWidth(title) - activity.length));
		return [
			this.#theme.accent(title) + gap + this.#theme.muted(activity.toUpperCase()),
			this.#theme.muted(`${model}${view === undefined ? "" : `  ·  PID ${view.pid}  ·  v${label(view.version)}`}`),
		];
	}

	private footer(width: number): string[] {
		const usage = this.#state.view?.usage;
		const cost =
			usage == null || usage.cost.kind === "unknown"
				? "cost unknown"
				: `~$${usage.cost.usd.toFixed(4)} ${width < 64 ? "est" : "estimated"}`;
		const tokens =
			usage == null
				? "tokens unknown"
				: `${usage.totalTokens.toLocaleString("en-US")} ${width < 64 ? "tokens" : "conversation tokens"}`;
		return [
			this.#theme.muted(`${tokens}  ·  ${cost}`),
			this.#theme.muted(
				width < 64
					? `${this.keyHint("unit.attach.cancel")} cancel · ${this.keyHint("unit.attach.detach")} detach · /help`
					: `${this.keyHint("tui.input.submit")} send · ${this.keyHint("tui.input.newLine")} newline · ${this.keyHint("unit.attach.cancel")} cancel/exit · ${this.keyHint("unit.attach.detach")} detach · /help`,
			),
		];
	}

	private keyHint(action: Parameters<KeybindingsManager["getKeys"]>[0]): string {
		const key = this.#keys.getKeys(action).at(-1);
		return key === undefined
			? "unbound"
			: key
					.split("+")
					.map((part) => part[0].toUpperCase() + part.slice(1))
					.join("+");
	}

	private updateTranscript(view: ServiceView | undefined): void {
		this.transcript.clear();
		const retained = new Set<number>();
		if (view === undefined)
			this.transcript.addChild(new Text(this.#theme.muted("Connecting to the running agent…"), 1, 1));
		else {
			if (view.historyTruncated)
				this.transcript.addChild(new Text(this.#theme.muted("Recent history · earlier entries omitted"), 1, 0));
			for (const entry of view.entries) {
				retained.add(entry.id);
				let cached = this.#messages.get(entry.id);
				if (
					cached === undefined ||
					cached.text !== entry.text ||
					cached.role !== entry.role ||
					cached.truncated !== entry.truncated
				) {
					const card = new Container();
					card.addChild(
						new Text(
							entry.role === "user"
								? this.#theme.user("YOU")
								: this.#theme.accent(label(view.name).toUpperCase()),
							1,
							0,
						),
					);
					card.addChild(new PassiveMarkdown(sanitizeTerminalText(entry.text), 1, 0, this.#theme.markdown));
					if (entry.truncated)
						card.addChild(new Text(this.#theme.warning("[Text truncated in this bounded view]"), 1, 0));
					card.addChild(new Text("", 0, 1));
					cached = { text: entry.text, role: entry.role, truncated: entry.truncated, card };
					this.#messages.set(entry.id, cached);
				}
				this.transcript.addChild(cached.card);
			}
			const last = view.entries.at(-1);
			const committed =
				last?.role === "assistant" &&
				(last.text === view.text || (last.truncated && view.text.startsWith(last.text)));
			const live = committed ? "" : sanitizeTerminalText(view.text);
			if (live !== this.#liveText) {
				this.#live.setText(live);
				this.#liveText = live;
			}
			if (live !== "") {
				this.transcript.addChild(new Text(this.#theme.accent(`${label(view.name).toUpperCase()}  ·  LIVE`), 1, 0));
				this.transcript.addChild(this.#live);
				if (view.textTruncated)
					this.transcript.addChild(new Text(this.#theme.warning("[Live text truncated]"), 1, 0));
			}
			for (const tool of view.tools)
				this.transcript.addChild(new ToolCard(label(tool.name), tool.status, this.#theme));
			if (view.entries.length === 0 && live === "")
				this.transcript.addChild(
					new Text(this.#theme.muted("Conversation ready. Send a task or a question below."), 1, 1),
				);
		}
		for (const id of this.#messages.keys()) if (!retained.has(id)) this.#messages.delete(id);
		for (const notice of this.#state.notices.slice(-3))
			this.transcript.addChild(new Text(this.#theme.muted(sanitizeTerminalText(notice)), 1, 0));
		if (this.#inputNotice !== "") this.transcript.addChild(new Text(this.#theme.warning(this.#inputNotice), 1, 0));
	}
}

// Markdown may create OSC 8 links after parsing; keep formatted text without active terminal URLs.
class PassiveMarkdown extends Markdown {
	#source: string[] | undefined;
	#lines: string[] = [];
	override render(width: number): string[] {
		const source = super.render(width);
		if (source !== this.#source) {
			this.#source = source;
			this.#lines = source.map((line) => line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));
		}
		return this.#lines;
	}
}

class StatusLines implements Component {
	readonly #lines: (width: number) => string[];
	constructor(lines: (width: number) => string[]) {
		this.#lines = lines;
	}
	render(width: number): string[] {
		return this.#lines(width).map((line) => truncateToWidth(line, width));
	}
	invalidate(): void {}
}

class ToolCard implements Component {
	readonly #name: string;
	readonly #status: string;
	readonly #theme: ReturnType<typeof createTheme>;
	constructor(name: string, status: string, theme: ReturnType<typeof createTheme>) {
		this.#name = name;
		this.#status = status;
		this.#theme = theme;
	}
	render(width: number): string[] {
		const style =
			this.#status === "succeeded"
				? this.#theme.success
				: this.#status === "failed"
					? this.#theme.error
					: this.#status === "done"
						? this.#theme.muted
						: this.#theme.warning;
		return [
			style(truncateToWidth(` ┌ ${this.#name}`, width)),
			this.#theme.muted(truncateToWidth(` └ ${this.#status}`, width)),
		];
	}
	invalidate(): void {}
}

function label(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function createTheme(color: boolean) {
	const ansi = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
	const accent = ansi("1;36");
	const muted = ansi("90");
	const user = ansi("1;34");
	const success = ansi("32");
	const warning = ansi("33");
	const error = ansi("31");
	const markdown: MarkdownTheme = {
		heading: accent,
		link: ansi("36"),
		linkUrl: muted,
		code: warning,
		codeBlock: (text) => text,
		codeBlockBorder: muted,
		quote: muted,
		quoteBorder: muted,
		hr: muted,
		listBullet: accent,
		bold: ansi("1"),
		italic: ansi("3"),
		strikethrough: ansi("9"),
		underline: ansi("4"),
	};
	const editor: EditorTheme = {
		borderColor: accent,
		selectList: {
			selectedPrefix: accent,
			selectedText: accent,
			description: muted,
			scrollInfo: muted,
			noMatch: muted,
		},
	};
	return { accent, muted, user, success, warning, error, markdown, editor };
}
