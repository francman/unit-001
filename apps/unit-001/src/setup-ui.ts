// Presents guided setup with native terminal pickers and a masked credential field.
import { writeSync } from "node:fs";
import {
	type Component,
	getKeybindings,
	Input,
	isKeyRelease,
	KeybindingsManager,
	type ProgramStatus,
	type SelectItem,
	SelectList,
	StdinBuffer,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	type Terminal as TuiTerminal,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./render.ts";
import type { Terminal } from "./repl.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"unit.setup.cancel": true;
		"unit.setup.eof": true;
		"unit.setup.back": true;
	}
}

export const DEFAULT_SETUP_KEYBINDINGS = {
	"unit.setup.cancel": { defaultKeys: "ctrl+c", description: "Cancel setup" },
	"unit.setup.eof": { defaultKeys: "ctrl+d", description: "Cancel setup when the field is empty" },
	"unit.setup.back": { defaultKeys: "escape", description: "Return to the previous setup step" },
} as const;

export interface SetupChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export interface SetupScreen {
	readonly step: number;
	readonly title: string;
	readonly description: string;
	readonly detail?: readonly string[];
}

export class SetupBack extends Error {}
export class SetupCancelled extends Error {}

const MAX_INPUT_BYTES = 8192;
const NAVIGATION_ACTIONS = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const;

/** Owns one setup terminal and releases it completely while a provider login owns input. */
export class SetupUI implements Component {
	readonly #cancel = new AbortController();
	readonly signal: AbortSignal = this.#cancel.signal;
	focused = true;
	readonly capturesViewportInput = true;
	readonly #terminal: SetupStreamTerminal;
	readonly #tui: TuiAltScreen;
	readonly #name: string;
	readonly #color: boolean;
	readonly #keys = new KeybindingsManager(
		{ ...TUI_KEYBINDINGS, ...DEFAULT_SETUP_KEYBINDINGS },
		getKeybindings().getUserBindings(),
	);
	#screen: SetupScreen = { step: 1, title: "Getting ready", description: "Loading provider configuration…" };
	#input: Input = new Input({ prompt: "" });
	#choices: readonly SetupChoice[] = [];
	#filtered: readonly SetupChoice[] = [];
	#list: SelectList | undefined;
	#preferred: string | undefined;
	#mode: "choice" | "secret" | "busy" = "choice";
	#notice = "";
	#running = false;
	#pending: { resolve: (value: string) => void; reject: (error: Error) => void; cleanup: () => void } | undefined;

	constructor(terminal: Terminal, name: string, color: boolean) {
		this.#name = safe(name);
		this.#color = color;
		this.#terminal = new SetupStreamTerminal(terminal, () => this.cancel());
		this.#tui = new TuiAltScreen(this.#terminal, true, undefined, { mouse: false, copyOnSelect: false });
		this.#tui.setLayoutRoot(this);
		this.#tui.setFocus(this);
		this.#tui.addInputListener((data) => {
			this.handleInput(data);
			return { consume: true };
		});
	}

	/** Selects a provider, authentication method, model or final action with a live filter. */
	choose(
		screen: SetupScreen,
		choices: readonly SetupChoice[],
		preferred: string | undefined,
		signal: AbortSignal,
	): Promise<string> {
		this.#screen = screen;
		this.#mode = "choice";
		this.#choices = choices;
		this.#preferred = preferred;
		this.#input = new Input({
			prompt: "",
			placeholder: "Type to search",
			placeholderStyle: (text) => this.muted(text),
		});
		this.#input.focused = true;
		this.#input.onSubmit = () => {
			const selected = this.#list?.getSelectedItem();
			if (selected) this.finish(selected.value);
		};
		this.refilter();
		return this.wait(signal);
	}

	/** Reads a key with visible mask/cursor feedback; raw credentials never reach terminal output. */
	secret(screen: SetupScreen, signal: AbortSignal): Promise<string> {
		this.#screen = screen;
		this.#mode = "secret";
		this.#input = new MaskedInput();
		this.#input.focused = true;
		this.#input.onSubmit = (value) => {
			if (!value.trim() || /\s/.test(value)) {
				this.#notice = "Enter a non-empty key without spaces or newlines.";
				return;
			}
			this.finish(value);
		};
		return this.wait(signal);
	}

	/** Releases raw mode, screen and input listeners before another interactive flow starts. */
	async suspend(): Promise<void> {
		if (!this.#running) return;
		await this.#terminal.drainInput();
		this.#tui.stop();
		this.#running = false;
	}

	/** Always restores terminal state and discards the current field on exit. */
	async close(): Promise<void> {
		this.finish(new SetupCancelled());
		await this.suspend();
		this.#input.setValue("");
	}

	/** Shows pending writes while retaining cancellation and keeping secrets out of the frame. */
	busy(screen: SetupScreen): void {
		this.#screen = screen;
		this.#mode = "busy";
		this.#input.setValue("");
		this.#tui.requestRender();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (
			this.#keys.matches(data, "unit.setup.cancel") ||
			(this.#keys.matches(data, "unit.setup.eof") && this.#input.getValue() === "")
		) {
			this.cancel();
			return;
		}
		if (!this.#pending) return;
		if (this.#keys.matches(data, "unit.setup.back")) {
			this.finish(new SetupBack());
			return;
		}
		if (data.startsWith("\x1b[200~")) {
			const content = data.slice(6, -6);
			if (/[\r\n\x00-\x1f\x7f-\x9f]/.test(content) || Buffer.byteLength(content) > MAX_INPUT_BYTES) {
				this.#notice =
					Buffer.byteLength(content) > MAX_INPUT_BYTES
						? "Paste is limited to 8 KiB. Nothing was entered."
						: "Paste one line into the current field. Nothing was entered.";
				this.#tui.requestRender();
				return;
			}
		}
		if (this.#mode === "choice" && NAVIGATION_ACTIONS.some((action) => this.#keys.matches(data, action))) {
			this.#list?.handleInput(data);
		} else {
			const before = this.#input.getValue();
			this.#input.handleInput(data);
			if (Buffer.byteLength(this.#input.getValue()) > MAX_INPUT_BYTES) {
				this.#input.setValue(before);
				this.#notice = "Input is limited to 8 KiB.";
			} else if (this.#input.getValue() !== before) {
				this.#notice = "";
				if (this.#mode === "choice") this.refilter();
			}
		}
		this.#tui.requestRender();
	}

	render(width: number): string[] {
		const height = this.#terminal.rows;
		const compact = width < 50 || height < 16;
		const inner = Math.max(1, width - 4);
		const lines = [this.accent(`${this.#name} / setup`) + this.muted(`  ·  Step ${this.#screen.step} of 4`)];
		if (!compact) lines.push("");
		lines.push(this.accent(this.#screen.title));
		if (!compact) lines.push(this.muted(this.#screen.description), "");
		const label =
			this.#mode === "secret"
				? "API key"
				: this.#screen.step === 1
					? "Search providers"
					: this.#screen.step === 3
						? "Search models"
						: "Search choices";
		const body: string[] = [];
		if (this.#screen.detail) {
			for (const detail of this.#screen.detail) {
				let remaining = safe(detail);
				// Preserve model-name segments instead of orphaning their version on a new row.
				while (visibleWidth(remaining) > inner) {
					const slash = remaining.lastIndexOf("/", inner - 1);
					if (slash < 0) break;
					body.push(remaining.slice(0, slash + 1));
					remaining = remaining.slice(slash + 1);
				}
				body.push(...wrapTextWithAnsi(remaining, inner));
			}
		}
		if (this.#mode === "choice") {
			const maxItems = Math.max(
				1,
				Math.min(10, height - lines.length - body.length - (compact ? 8 : 7) + (this.#screen.step === 4 ? 2 : 0)),
			);
			const selected = this.#list?.getSelectedItem()?.value;
			this.buildList(maxItems, selected);
			const renderedList = this.#list?.render(inner) ?? [];
			const listLines = compact && this.#screen.step === 4 ? renderedList.slice(0, maxItems) : renderedList;
			const reserved = Math.min(maxItems, this.#choices.length) + (this.#choices.length > maxItems ? 1 : 0);
			body.push(...listLines);
			while (body.length < reserved) body.push("");
		}
		if (this.#mode === "busy") body.push(this.muted("Saving…"));
		else if (this.#screen.step !== 4) body.push(this.muted(label), ...this.#input.render(inner));
		if (this.#mode === "secret")
			body.push(this.muted(`${Array.from(this.#input.getValue()).length} characters · hidden`));
		lines.push(this.muted(`╭${"─".repeat(Math.max(0, width - 2))}╮`));
		for (const line of body)
			lines.push(
				this.muted("│ ") +
					truncateToWidth(line, inner, "") +
					" ".repeat(Math.max(0, inner - visibleWidth(line))) +
					this.muted(" │"),
			);
		lines.push(this.muted(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		if (this.#notice) lines.push(this.warning(this.#notice));
		const help =
			this.#mode === "secret"
				? `${this.hint("tui.input.submit")} continue  ${this.hint("unit.setup.back")} back  ${this.hint("unit.setup.cancel")} cancel`
				: `${this.hint("tui.select.up")}/${this.hint("tui.select.down")} select  ${this.hint("tui.input.submit")} confirm  ${this.hint("unit.setup.back")} back  ${this.hint("unit.setup.cancel")} cancel`;
		if (this.#mode === "busy") lines.push(this.muted(`${this.hint("unit.setup.cancel")} cancel`));
		else if (compact) {
			lines.push(
				this.muted(
					this.#mode === "secret"
						? `${this.hint("tui.input.submit")} continue`
						: `${this.hint("tui.select.up")}/${this.hint("tui.select.down")} select  ${this.hint("tui.input.submit")} confirm`,
				),
			);
			lines.push(this.muted(`${this.hint("unit.setup.back")} back  ${this.hint("unit.setup.cancel")} cancel`));
		} else lines.push(this.muted(help));
		return lines.slice(0, Math.max(1, height)).map((line) => truncateToWidth(line, Math.max(1, width), ""));
	}

	invalidate(): void {
		this.#input.invalidate();
		this.#list?.invalidate();
	}

	private wait(signal: AbortSignal): Promise<string> {
		this.#notice = "";
		return new Promise((resolve, reject) => {
			const onAbort = () => this.finish(new SetupCancelled());
			this.#pending = { resolve, reject, cleanup: () => signal.removeEventListener("abort", onAbort) };
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			if (!this.#running) {
				this.#tui.start();
				this.#running = true;
			}
			this.#tui.requestRender();
		});
	}

	private finish(result: string | Error): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (!pending) return;
		pending.cleanup();
		if (result instanceof Error) pending.reject(result);
		else pending.resolve(result);
	}

	private cancel(): void {
		this.#cancel.abort();
		this.finish(new SetupCancelled());
	}

	private refilter(): void {
		const query = this.#input.getValue().toLowerCase();
		this.#filtered = this.#choices.filter((choice) => `${choice.id} ${choice.label}`.toLowerCase().includes(query));
		this.buildList(10, this.#filtered.some((choice) => choice.id === query) ? query : this.#preferred);
	}

	private buildList(maxItems: number, preferred: string | undefined): void {
		const items: SelectItem[] = this.#filtered.map((choice) => ({
			value: choice.id,
			label: safe(choice.label),
			...(choice.description ? { description: safe(choice.description) } : {}),
		}));
		this.#list = new SelectList(
			items,
			maxItems,
			{
				selectedPrefix: (text) => this.accent(text),
				selectedText: (text) => this.accent(text),
				description: (text) => this.muted(text),
				scrollInfo: (text) => this.muted(text),
				noMatch: () => this.muted("  No matches. Edit your search."),
			},
			{ minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 45 },
		);
		this.#list.setSelectedIndex(
			Math.max(
				0,
				items.findIndex((item) => item.value === preferred),
			),
		);
	}

	private hint(action: Parameters<KeybindingsManager["getKeys"]>[0]): string {
		return (
			this.#keys
				.getKeys(action)
				.at(-1)
				?.split("+")
				.map((part) =>
					part === "ctrl"
						? "Ctrl"
						: part === "enter"
							? "Enter"
							: part === "escape"
								? "Esc"
								: part === "up"
									? "↑"
									: part === "down"
										? "↓"
										: part.toUpperCase(),
				)
				.join("+") ?? "unbound"
		);
	}
	private accent(text: string): string {
		return this.#color ? `\x1b[1m${text}\x1b[0m` : text;
	}
	private muted(text: string): string {
		return this.#color ? `\x1b[90m${text}\x1b[0m` : text;
	}
	private warning(text: string): string {
		return this.#color ? `\x1b[1m${text}\x1b[0m` : text;
	}
}

class MaskedInput extends Input {
	constructor() {
		super({ prompt: "" });
	}
	override render(width: number): string[] {
		// Preserve the native editor's cursor/scroll sequences while replacing every visible key glyph.
		return super
			.render(width)
			.map((line) =>
				line.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07)|[^\x1b]+/gu, (token) =>
					token.startsWith("\x1b")
						? token
						: Array.from(token, (character) =>
								/\s/.test(character) ? character : "•".repeat(Math.max(1, visibleWidth(character))),
							).join(""),
				),
			);
	}
}

function safe(text: string): string {
	return sanitizeTerminalText(text).replace(/\s/g, " ").slice(0, 200);
}

class SetupStreamTerminal implements TuiTerminal {
	readonly #input: NodeJS.ReadableStream & {
		isRaw?: boolean;
		readableEnded?: boolean;
		setRawMode?: (raw: boolean) => unknown;
	};
	readonly #output: NodeJS.WritableStream & { columns?: number; rows?: number; fd?: number };
	readonly #onEnd: () => void;
	#raw = false;
	#buffer: StdinBuffer | undefined;
	#data: ((data: string | Buffer) => void) | undefined;
	#resize: (() => void) | undefined;
	#pasteActive = false;
	#pasteProbe = "";
	#pasteBytes = 0;
	#discardPaste = false;

	constructor(terminal: Terminal, onEnd: () => void) {
		this.#input = terminal.input;
		if (!terminal.output) throw new Error("Setup requires terminal output.");
		this.#output = terminal.output;
		this.#onEnd = onEnd;
	}
	get columns(): number {
		return this.#output.columns ?? 80;
	}
	get rows(): number {
		return this.#output.rows ?? 24;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#pasteActive = false;
		this.#pasteProbe = "";
		this.#pasteBytes = 0;
		this.#discardPaste = false;
		this.#raw = this.#input.isRaw ?? false;
		this.#input.setRawMode?.(true);
		this.#input.setEncoding("utf8");
		this.#buffer = new StdinBuffer({ escapeTimeout: 100 });
		this.#buffer.on("data", onInput);
		this.#buffer.on("paste", (content) => onInput(`\x1b[200~${content}\x1b[201~`));
		this.#data = (data) => {
			const text = data.toString();
			const probe = this.#pasteProbe + text;
			const bracketed = this.#pasteActive || probe.includes("\x1b[200~");
			if (probe.includes("\x1b[200~")) this.#pasteActive = true;
			if (probe.includes("\x1b[201~")) this.#pasteActive = false;
			this.#pasteProbe = probe.slice(-5);
			if (this.#discardPaste) {
				if (!this.#pasteActive) this.#discardPaste = false;
				return;
			}
			if (bracketed) this.#pasteBytes += Buffer.byteLength(text);
			else this.#pasteBytes = 0;
			if (Buffer.byteLength(text) > MAX_INPUT_BYTES + 12 || this.#pasteBytes > MAX_INPUT_BYTES + 12) {
				this.#buffer?.clear();
				this.#discardPaste = this.#pasteActive;
				this.#pasteBytes = 0;
				onInput(`\x1b[200~${"x".repeat(MAX_INPUT_BYTES + 1)}\x1b[201~`);
				return;
			}
			if (!this.#pasteActive) this.#pasteBytes = 0;
			// Unbracketed multiline input must not feed secret answers to subsequent screens.
			if (!bracketed && /[\r\n]/.test(text) && !/^[^\r\n]*[\r\n]$/.test(text)) {
				onInput("\x1b[200~\n\x1b[201~");
				return;
			}
			this.#buffer?.process(text);
		};
		this.#resize = onResize;
		this.#input.on("data", this.#data);
		this.#input.on("end", this.#onEnd);
		this.#output.on("resize", onResize);
		this.write("\x1b[?2004h");
		this.#input.resume();
		if (this.#input.readableEnded) queueMicrotask(this.#onEnd);
	}
	stop(): void {
		if (this.#data) this.#input.removeListener("data", this.#data);
		this.#input.removeListener("end", this.#onEnd);
		if (this.#resize) this.#output.removeListener("resize", this.#resize);
		this.#buffer?.destroy();
		this.#buffer = undefined;
		this.#input.pause();
		this.#input.setRawMode?.(this.#raw);
		this.write("\x1b[?2004l");
	}
	async drainInput(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	restoreOnExit(before: string, after: string): void {
		const sequence = `${before}\x1b[?2004l${after}`;
		if (this.#output.fd !== undefined) {
			try {
				writeSync(this.#output.fd, sequence);
				return;
			} catch {}
		}
		this.write(sequence);
	}
	write(data: string): void {
		this.#output.write(data);
	}
	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(_status: ProgramStatus): void {}
}
