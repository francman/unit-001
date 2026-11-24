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
	parseKey,
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
import type { Agent } from "./agent.ts";
import { type DraftStore, MAX_DRAFT_BYTES, type StoredDraft, type UnconfirmedSend } from "./draft-store.ts";
import { cutText, sanitizeTerminalText } from "./render.ts";
import { type SendAdmission, sendDigest } from "./send-receipt.ts";
import type { ServiceView } from "./service.ts";
import type { ServiceClient } from "./service-client.ts";
import { providerProblemSummary, runFailureSummary, toolFailureSummary } from "./service-view.ts";
import {
	createForegroundTerminalController,
	createServiceTerminalController,
	createTerminalController,
	type PendingSend,
	type SendOutcome,
	type TerminalController,
	type TerminalState,
} from "./terminal-controller.ts";
import { evidenceLines } from "./tool-evidence.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"unit.attach.cancel": true;
		"unit.attach.detach": true;
		"unit.commands.next": true;
		"unit.commands.previous": true;
		"unit.commands.choose": true;
		"unit.commands.dismiss": true;
	}
}

export const DEFAULT_APP_KEYBINDINGS = {
	"unit.attach.cancel": { defaultKeys: "ctrl+c", description: "Cancel all work in this chat; detach when idle" },
	"unit.attach.detach": { defaultKeys: "ctrl+d", description: "Detach without cancelling work" },
	"unit.commands.next": { defaultKeys: "down", description: "Select next command suggestion" },
	"unit.commands.previous": { defaultKeys: "up", description: "Select previous command suggestion" },
	"unit.commands.choose": { defaultKeys: "enter", description: "Copy selected command into the editor" },
	"unit.commands.dismiss": { defaultKeys: "escape", description: "Dismiss command suggestions" },
} as const;

export interface RichAttachOptions {
	readonly colorMode?: "color" | "monochrome";
	readonly ownership?: "attached" | "foreground";
	readonly unavailableHint?: string;
	readonly name?: string;
	readonly missionSetup?: (signal: AbortSignal) => Promise<number>;
	/** Keeps the unsent draft across client exit; it is restored into the editor and never sent automatically. */
	readonly drafts?: DraftStore | undefined;
}

type Actions = Pick<TerminalController, "submit" | "cancel" | "detach"> &
	Partial<Pick<TerminalController, "dismissSuggestions" | "admission">>;

/**
 * The one send whose outcome this view has not settled. The draft file keeps it beside the editor text until the owner
 * settles it or another send replaces it: losing its ID would let a late admission under it be followed by the same
 * text under a new ID. `below` means its text is shown under the transcript, because the editor holds newer typing.
 */
type OpenSend =
	// Submitted from this view; its outcome is pending, or unknown after a lost reply.
	| { readonly kind: "in-flight"; readonly send: UnconfirmedSend }
	// Restored from an earlier client; the owner is asked about it once, on the first attached view.
	| { readonly kind: "unchecked"; readonly send: UnconfirmedSend; readonly below: boolean }
	// The owner has no record of its ID as of the last answer.
	| { readonly kind: "replayable"; readonly send: UnconfirmedSend; readonly below: boolean }
	// Its ID is settled, but the owner did not confirm this text; it stays below for the user to see.
	| { readonly kind: "kept"; readonly send: UnconfirmedSend };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Type-ahead is already buffered when the terminal starts reading, so it arrives within this window after a restore.
const TYPE_AHEAD_MS = 200;
// A stray Enter right after the type-ahead window must not send text the user has not looked at yet.
const RESTORE_ENTER_GUARD_MS = 300;

// Text, control keys, pastes and recognized key sequences; an unrecognized escape sequence is a terminal reply.
function typedInput(data: string): boolean {
	return !data.startsWith("\x1b") || data.startsWith(PASTE_START) || parseKey(data) !== undefined;
}

/** Runs the rich socket client and restores terminal modes on every exit path. */
export async function runRichAttach(
	endpoint: string,
	terminal: Terminal,
	signal: AbortSignal,
	options: RichAttachOptions = {},
): Promise<number> {
	return runRichConversation(
		basename(endpoint, ".sock"),
		terminal,
		signal,
		(onChange) => createTerminalController(endpoint, onChange, signal),
		options,
	);
}

/** Uses the existing rich terminal for an authenticated remote service client. */
export async function runRichServiceAttach(
	client: ServiceClient,
	terminal: Terminal,
	signal: AbortSignal,
	options: RichAttachOptions = {},
): Promise<number> {
	return runRichConversation(
		client.session,
		terminal,
		signal,
		(onChange) => createServiceTerminalController(client, onChange, signal),
		options,
	);
}

/** Renders the existing foreground owner without opening another database or creating a service. */
export async function runRichForeground(
	agent: Agent,
	session: string,
	version: string,
	terminal: Terminal,
	signal: AbortSignal,
	options: RichAttachOptions = {},
): Promise<number> {
	return runRichConversation(
		session,
		terminal,
		signal,
		(onChange) => createForegroundTerminalController(agent, session, version, onChange, signal),
		{ ...options, ownership: "foreground" },
	);
}

async function runRichConversation(
	session: string,
	terminal: Terminal,
	signal: AbortSignal,
	connect: (onChange: (state: TerminalState) => void) => TerminalController,
	options: RichAttachOptions,
): Promise<number> {
	if (signal.aborted) return 0;
	const loaded = options.drafts === undefined ? undefined : await options.drafts.load();
	const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false, copyOnSelect: false });
	let controller: TerminalController;
	let closeUnavailable: (() => void) | undefined;
	const flowAbort = new AbortController();
	let missionFlow: Promise<void> | undefined;
	const actions: Actions = {
		submit: (text, send) => {
			const result = controller.submit(text, send);
			if (result.status !== "mission-setup") return result;
			const missionSetup = options.missionSetup;
			if (missionSetup === undefined) return controller.submit("/mission");
			if (missionFlow !== undefined) return { status: "rejected" };
			missionFlow = (async () => {
				await terminal.drainInput(200, 25);
				tui.stop();
				try {
					await missionSetup(AbortSignal.any([signal, flowAbort.signal]));
				} catch (error) {
					terminal.write(
						`Mission setup: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}\r\n`,
					);
				} finally {
					missionFlow = undefined;
					if (!signal.aborted && !flowAbort.signal.aborted) {
						tui.start();
						if (controller.state.connection === "attached") controller.submit("/mission");
					}
				}
			})();
			return { status: "command" };
		},
		cancel: () => controller.cancel(),
		admission: (requestId, digest) => controller.admission(requestId, digest),
		dismissSuggestions: () => controller.dismissSuggestions(),
		detach: () => (closeUnavailable === undefined ? controller.detach() : closeUnavailable()),
	};
	const view = new RichAttachView(tui, session, actions, options);
	if (loaded?.status === "restored") view.restoreDraft(loaded.draft);
	else if (loaded?.status === "refused") view.refuseDraft(loaded.reason);
	tui.setLayoutRoot(view);
	tui.setFocus(view.editor);
	tui.addInputListener((data) => view.handleGlobalInput(data));
	controller = connect((state) => view.update(state));
	let result: number;
	try {
		tui.start();
		view.refreshRestoreGuard();
		result = await controller.closed;
		if (result !== 0 && !signal.aborted) {
			const closed = Promise.withResolvers<void>();
			closeUnavailable = closed.resolve;
			const abort = () => closed.resolve();
			signal.addEventListener("abort", abort, { once: true });
			try {
				if (signal.aborted) abort();
				await closed.promise;
			} finally {
				signal.removeEventListener("abort", abort);
			}
		}
	} finally {
		flowAbort.abort();
		await missionFlow;
		controller.detach();
		try {
			await terminal.drainInput(1000);
		} finally {
			tui.stop();
			const saved = await options.drafts?.flush();
			if (saved?.status === "failed") terminal.write(`Draft not saved: ${sanitizeTerminalText(saved.reason)}\n`);
			for (const id of controller.state.unresolvedRequestIds ?? [])
				terminal.write(`Unconfirmed request ID ${id}; inspect persisted work before an explicit retry.\n`);
		}
	}
	return result;
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
	readonly #ownership: "attached" | "foreground";
	readonly #unavailableHint: string;
	readonly #name: string;
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
	readonly #drafts: DraftStore | undefined;
	#open: OpenSend | undefined;
	// A send held because its ID could not be saved; sending the same text again is the user's consent to send it unsaved.
	#held: PendingSend | undefined;
	#restoredAt = Number.NEGATIVE_INFINITY;
	#paste: string | undefined;
	#pasteBytes = 0;
	#pasteBaseBytes = 0;
	#discardPaste = false;
	#inputNotice = "";
	#selectedSuggestion = 0;
	#state: TerminalState = { connection: "connecting", sending: false, cancelling: false, notices: [] };

	constructor(tui: TuiAltScreen, session: string, actions: Actions, options: RichAttachOptions = {}) {
		super();
		this.#tui = tui;
		this.#session = label(session);
		this.#actions = actions;
		this.#theme = createTheme(options.colorMode !== "monochrome");
		this.#ownership = options.ownership ?? "attached";
		this.#name = label(options.name ?? "agent");
		this.#drafts = options.drafts;
		this.#unavailableHint =
			options.unavailableHint ??
			(this.#ownership === "foreground"
				? "Reopen this foreground session to inspect saved work."
				: "Check the service and reopen this terminal.\nUse /status after reconnecting to inspect saved work.");
		this.#header = new StatusLines((width) => this.header(width));
		this.#footer = new StatusLines((width) => this.footer(width));
		this.#live = new PassiveMarkdown("", 1, 0, this.#theme.markdown);
		this.editor = new ComposerEditor(tui, this.#theme.editor, () => {
			if (this.#state.connection === "failed") return "Unsent draft";
			const name = label(this.#state.view?.name ?? "agent");
			return `${this.editor.getText() === "" ? `Ask ${name}` : "Message"} · ${this.keyHint("tui.input.newLine")} newline`;
		});
		this.editor.onChange = () => {
			if (this.#restoringDraft) return;
			const draft = this.editor.getExpandedText();
			if (Buffer.byteLength(draft) <= MAX_DRAFT_BYTES) {
				this.#draft = draft;
				this.persistDraft();
				this.clearInputNotice();
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
			if (this.#state.connection === "failed") {
				this.editor.setText(text);
				return;
			}
			const result = this.#actions.submit(text, {
				replayRequestId: this.replayIdFor(text),
				beforeDispatch: (send) => this.recordSend(text, send),
			});
			if (result.status === "rejected") this.editor.setText(text);
			else if (result.status === "submitted") {
				this.clearInputNotice();
				this.editor.addToHistory(text);
				void result.outcome.then((outcome) => this.settleSend(result.requestId, outcome));
			}
			this.#tui.requestRender();
		};
		this.scroll = new ScrollView(this.transcript, { follow: "end", primary: true, scrollbar: "auto" });
		this.addChild(this.#header, { basis: 2, minSize: 1, shrink: 0 });
		this.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
		this.addChild(new StatusLines((width) => this.suggestionLines(width)), {
			basis: "auto",
			maxSize: 4,
			shrink: 0,
			visible: () => (this.#state.suggestions?.length ?? 0) > 0 || this.#state.suggesting === true,
		});
		this.addChild(this.editor, {
			basis: "auto",
			minSize: 3,
			maxSize: 8,
			shrink: 1,
			visible: () => this.#state.connection !== "failed" || this.#state.view !== undefined || this.#draft !== "",
		});
		this.addChild(
			new StatusLines((width) => {
				const ids = this.#state.unresolvedRequestIds ?? [];
				const id = ids.at(-1) ?? "";
				return [
					this.#theme.warning(
						width < 64
							? `ID ${id}`
							: `Unconfirmed request ${id}${ids.length > 1 ? ` (+${ids.length - 1}; /status lists all)` : ""}`,
					),
				];
			}),
			{ basis: 1, minSize: 1, shrink: 0, visible: () => (this.#state.unresolvedRequestIds?.length ?? 0) > 0 },
		);
		this.addChild(this.#footer, { basis: 2, minSize: 1, shrink: 0 });
		this.update(this.#state);
	}

	/** Applies a bounded owner snapshot without changing the draft or cursor. */
	update(state: TerminalState): void {
		if (state.suggestions !== this.#state.suggestions) this.#selectedSuggestion = 0;
		const changed =
			state.view !== this.#state.view ||
			state.notices !== this.#state.notices ||
			state.evidence !== this.#state.evidence ||
			state.connection !== this.#state.connection;
		this.#state = state;
		if (state.connection === "failed" && state.view === undefined && this.#draft === "") this.#tui.setFocus(null);
		if (changed || this.transcript.children.length === 0) this.updateTranscript(state.view);
		const open = this.#open;
		if (state.connection === "attached" && open?.kind === "unchecked") this.checkUnconfirmed(open.send, open.below);
		this.#tui.requestRender();
	}

	/**
	 * Puts a draft saved by an earlier client into the editor with a notice; it is never submitted. Call it just before
	 * the terminal starts: type-ahead meant for the previous prompt is dropped for a short window after it, then Enter
	 * is ignored briefly. The view drops it, because draining the terminal would pop the keyboard protocol it negotiates.
	 */
	restoreDraft(stored: StoredDraft): void {
		const unconfirmed = stored.unconfirmed;
		// With both stored, the editor gets the newer typing and the earlier send is shown beside it, unless they are equal.
		this.putInEditor(stored.text !== "" ? stored.text : (unconfirmed?.text ?? ""));
		const below = stored.text !== "" && stored.text !== unconfirmed?.text;
		this.#open = unconfirmed === undefined ? undefined : { kind: "unchecked", send: unconfirmed, below };
		this.#restoredAt = Date.now();
		const id = unconfirmed === undefined ? "" : sanitizeTerminalText(unconfirmed.requestId);
		this.#inputNotice =
			unconfirmed === undefined
				? "Restored unsent draft from an earlier session. Nothing was sent."
				: !below
					? `Restored a draft whose send was unconfirmed (request ID ${id}).${blankHint(unconfirmed)} Checking whether the owner received it.`
					: `Restored your latest draft. An earlier send (request ID ${id}) is unconfirmed and kept below.${blankHint(unconfirmed)} Checking whether the owner received it.`;
		this.updateTranscript(this.#state.view);
		this.#tui.requestRender();
	}

	/** Restarts the restore guard windows from now; call it right after the terminal starts, so a slow start cannot use them up. */
	refreshRestoreGuard(): void {
		if (this.#restoredAt !== Number.NEGATIVE_INFINITY) this.#restoredAt = Date.now();
	}

	// Only the send still in flight under the ID changes; a later send or a held retry has already replaced it.
	private settleSend(requestId: string, outcome: SendOutcome): void {
		const open = this.#open;
		if (open?.kind !== "in-flight" || open.send.requestId !== requestId) return;
		if (outcome.kind === "settled") {
			this.#open = undefined;
			this.persistDraft();
		} else if (outcome.kind === "returned") this.giveBack(open.send, outcome.reason);
		this.#tui.requestRender();
	}

	// Asked once per restore; the owner reads committed state only, so asking can never send the prompt.
	private checkUnconfirmed(send: UnconfirmedSend, below: boolean): void {
		this.#open = { kind: "replayable", send, below };
		const lookup = this.#actions.admission;
		if (lookup === undefined) return;
		// The first view can arrive while the controller is still being constructed; ask once that has returned.
		void Promise.resolve()
			.then(() => lookup(send.requestId, send.digest))
			.then(
				(admission) => this.settleUnconfirmed(send, admission),
				(error: unknown) =>
					this.showInputNotice(
						`Could not check request ${send.requestId}: ${error instanceof Error ? error.message : String(error)}. ${replayHint(send)}`,
					),
			);
	}

	// A send admitted with this exact text leaves the editor and the file; any other answer keeps its text where the user
	// can see it, because only an exact binding shows that the admitted prompt is this text.
	private settleUnconfirmed(send: UnconfirmedSend, admission: SendAdmission): void {
		if (admission.status === "not-found") {
			this.showInputNotice(
				`The owner has no record of request ${send.requestId} as of now. ${replayHint(send)}`,
			);
			return;
		}
		// Any other answer settles the ID; unless the owner confirmed this exact text, text shown below stays there.
		const open = this.#open;
		const below = open?.send === send && shownBelow(open) !== undefined;
		const exact = admission.status === "admitted" && admission.binding === "exact";
		if (open?.send === send) this.#open = below && !exact ? { kind: "kept", send } : undefined;
		if (admission.status === "rejected") {
			this.persistDraft();
			this.showInputNotice(
				`Request ${send.requestId} belongs to ${admission.reason === "different-prompt" ? "a different prompt" : "another operation"}, so this text was not sent under it. Sending it again uses a new request ID.`,
			);
			return;
		}
		let kept = "";
		if (below) kept = exact ? "" : " Its text is kept below.";
		else if (this.#draft === send.text) {
			if (exact) this.putInEditor("");
			kept = exact ? " The editor was cleared." : " Its text stays in the editor; sending it again starts a new request.";
		}
		this.persistDraft();
		// `placed` means the input is in the transcript, owned by a run; an inhibited owner places work without running it.
		const outcome =
			admission.outcome === "answered"
				? "and answered; the reply is in the conversation"
				: admission.outcome === "unanswered"
					? `but ended without an answer (${admission.reason ?? "no reason recorded"})`
					: admission.outcome === "queued"
						? "and is queued behind other work"
						: "and placed in the conversation; it has no answer yet";
		const binding = exact
			? ""
			: admission.binding === "unverified"
				? " The owner keeps no prompt record for this ID, so it could not confirm this is the text it received."
				: " This saved send has no prompt digest, so the owner could not confirm this is the text it received.";
		this.showInputNotice(`Request ${send.requestId} was received ${outcome}.${binding}${kept}`);
	}

	// Sending an unconfirmed send's exact prompt again reuses its request ID instead of risking a second admission: a
	// restored send, one the owner has no record of, a held one, or one whose reply was lost. The digest decides: saved
	// text is sanitized and may differ from what was sent, and different text under the ID would be refused. A send
	// without a digest is never replayed.
	private replayIdFor(text: string): string | undefined {
		const digest = sendDigest(text.trim());
		const open = this.#open;
		const restored = open?.kind === "unchecked" || open?.kind === "replayable" ? open.send : undefined;
		const lost = open?.kind === "in-flight" && !this.#state.sending ? open.send : undefined;
		return [restored, this.#held, lost].find((send) => send?.digest === digest)?.requestId;
	}

	// Runs before the send leaves this client and waits for the file: after a deferred save, a crash in between would
	// restore the text without the ID of a send the owner may have admitted, and resending it would run it twice. When
	// the file cannot be written the send is held, and everything the file should hold stays as it was, including an
	// earlier send still in flight: a held retry of a send whose reply was lost must keep that send's ID, or the next
	// successful write saves its text without it and a reopen sends it under a new ID. Sending the same text again sends
	// it unsaved, unless that would take the file's place from an earlier send under another ID whose outcome is unknown.
	// Refusing for good would leave a broken drafts directory with no way to send from this terminal at all.
	private async recordSend(text: string, send: PendingSend): Promise<"dispatch" | "hold"> {
		const earlier = this.#open;
		this.#open = { kind: "in-flight", send: { text, ...send } };
		this.#draft = "";
		this.persistDraft();
		const saved = await this.#drafts?.flush();
		const id = send.requestId;
		if (saved?.status !== "failed") {
			this.#held = undefined;
			return "dispatch";
		}
		// Only a kept send's ID is settled; any other earlier send under another ID may still be admitted.
		const kept = earlier !== undefined && earlier.kind !== "kept" && earlier.send.requestId !== id ? earlier.send : undefined;
		if (this.#held?.requestId === id && kept === undefined) {
			this.#held = undefined;
			this.showInputNotice(
				`Sent request ${id} without saving it (${saved.reason}). If this terminal exits before the answer, check request ${id} before sending the text again.`,
			);
			return "dispatch";
		}
		this.#open = earlier;
		this.#held = send;
		// Typing that arrived while the file was written stays, after the held text.
		const typed = this.editor.getExpandedText();
		this.putInEditor(typed === "" ? text : `${text}\n\n${typed}`);
		this.persistDraft();
		this.showInputNotice(
			kept === undefined
				? `Not sent: request ${id} could not be saved first (${saved.reason}), and a crash after sending would lose it. Press Enter again to send it unsaved.`
				: `Not sent: request ${id} could not be saved first (${saved.reason}). Sending it unsaved would drop the saved record of request ${kept.requestId}, whose outcome is unknown. Send that request's text again, or fix the drafts directory, first.`,
		);
		return "hold";
	}

	private showInputNotice(text: string): void {
		this.#inputNotice = sanitizeTerminalText(text);
		this.updateTranscript(this.#state.view);
		this.#tui.requestRender();
	}

	/** Tells the user that the draft file was refused, so they know typed text will not be restored from it. */
	refuseDraft(reason: string): void {
		this.showInputNotice(`Saved draft not restored: ${reason}`);
	}

	/** Handles configurable application actions before the focused editor consumes ordinary input. */
	handleGlobalInput(data: string): TuiInputListenerResult {
		if (isKeyRelease(data)) return { consume: true };
		const sinceRestore = Date.now() - this.#restoredAt;
		// Only keys and pastes are type-ahead; terminal replies to the renderer's own queries still pass.
		if (sinceRestore < TYPE_AHEAD_MS && typedInput(data)) return { consume: true };
		if (sinceRestore < TYPE_AHEAD_MS + RESTORE_ENTER_GUARD_MS && this.#keys.matches(data, "tui.input.submit"))
			return { consume: true };
		const suggestions = this.#state.suggestions;
		if ((suggestions?.length ?? 0) > 0 || this.#state.suggesting) {
			if (this.#keys.matches(data, "unit.commands.dismiss")) {
				this.#actions.dismissSuggestions?.();
				return { consume: true };
			}
			if (suggestions !== undefined && suggestions.length > 0) {
				if (this.#keys.matches(data, "unit.commands.next") || this.#keys.matches(data, "unit.commands.previous")) {
					this.#selectedSuggestion =
						(this.#selectedSuggestion +
							(this.#keys.matches(data, "unit.commands.next") ? 1 : suggestions.length - 1)) %
						suggestions.length;
					this.#tui.requestRender();
					return { consume: true };
				}
				if (this.#keys.matches(data, "unit.commands.choose")) {
					const operands = this.editor
						.getExpandedText()
						.trimStart()
						.replace(/^\/\S*/, "");
					this.editor.setText(`/${suggestions[this.#selectedSuggestion].invocation}${operands}`);
					this.#actions.dismissSuggestions?.();
					this.#tui.requestRender();
					return { consume: true };
				}
			}
			// Editing abandons the old query so a later Enter cannot replace the new draft.
			this.#actions.dismissSuggestions?.();
		}
		if (this.#keys.matches(data, "unit.attach.detach")) {
			this.#actions.detach();
			return { consume: true };
		}
		if (this.#keys.matches(data, "unit.attach.cancel")) {
			if (this.#state.connection === "attached" && (this.#state.view?.busy || this.#state.sending))
				this.#actions.cancel();
			else this.#actions.detach();
			return { consume: true };
		}
		if (this.#state.connection === "failed" && this.#state.view === undefined && this.#draft === "")
			return { consume: true };
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

	private suggestionLines(width: number): string[] {
		if (this.#state.suggesting) return [this.#theme.muted(" Resolving command… Esc cancels")];
		return [
			this.#theme.muted(" Did you mean? Enter edits · Esc cancels"),
			...(this.#state.suggestions ?? []).map((command, index) =>
				truncateToWidth(
					`${index === this.#selectedSuggestion ? " >" : "  "} /${command.invocation} · ${command.summary}`,
					width,
				),
			),
		];
	}

	// The file holds the current text and, separately, the open send whatever the editor holds (see `OpenSend`).
	private persistDraft(): void {
		const unconfirmed = this.#open?.send;
		this.#drafts?.save({ text: this.#draft, ...(unconfirmed === undefined ? {} : { unconfirmed }) });
	}

	private putInEditor(text: string): void {
		this.#restoringDraft = true;
		try {
			this.editor.setText(text);
		} finally {
			this.#restoringDraft = false;
		}
		this.#draft = this.editor.getExpandedText();
	}

	// A returned send's text goes back to an empty editor, otherwise it stays in the file. With no record under the ID
	// the ID goes with it, so sending the same text again cannot be admitted twice; otherwise a resend gets a new ID.
	private giveBack(sent: UnconfirmedSend, reason: Extract<SendOutcome, { kind: "returned" }>["reason"]): void {
		const below = this.#draft !== "";
		this.#open =
			reason === "not-found"
				? { kind: "replayable", send: sent, below }
				: below
					? { kind: "kept", send: sent }
					: undefined;
		const why =
			reason === "unverified"
				? `The owner admitted request ${sent.requestId} but cannot confirm it was this text; sending it again starts a new request.`
				: "The owner rejected the send.";
		if (!below) {
			this.putInEditor(sent.text);
			this.#inputNotice = sanitizeTerminalText(`${why} Your text is back in the editor and still saved.`);
		} else this.#inputNotice = sanitizeTerminalText(`${why} Its text is kept in the saved draft file.`);
		this.persistDraft();
		this.updateTranscript(this.#state.view);
	}

	private rejectInput(): void {
		this.#inputNotice = "Input exceeds 16 KiB; existing draft preserved.";
		this.updateTranscript(this.#state.view);
		this.#tui.requestRender();
	}

	private clearInputNotice(): void {
		if (this.#inputNotice === "") return;
		this.#inputNotice = "";
		this.updateTranscript(this.#state.view);
		this.#tui.requestRender();
	}

	private header(width: number): string[] {
		const view = this.#state.view;
		const name = view === undefined ? this.#name : label(view.name);
		const activity =
			this.#state.connection !== "attached"
				? this.#state.connection
				: this.#state.cancelling
					? "cancelling"
					: view?.busy
						? "working"
						: this.#state.sending
							? "sending"
							: "ready";
		const model =
			view?.model == null ? "model unknown" : `${label(view.model.provider)}/${label(view.model.modelId)}`;
		const brand = width >= 64 ? "unit-001  ·  " : "";
		const title = truncateToWidth(`${brand}${name}  /  ${this.#session}`, Math.max(1, width - activity.length - 2));
		const gap = " ".repeat(Math.max(1, width - visibleWidth(title) - activity.length));
		const activityStyle =
			activity === "failed"
				? this.#theme.error
				: activity === "working" || activity === "sending" || activity === "cancelling"
					? this.#theme.warning
					: activity === "ready"
						? this.#theme.success
						: this.#theme.muted;
		const ownership = width >= 80 ? `  ·  ${this.#ownership === "foreground" ? "foreground" : "attached"}` : "";
		const version = view === undefined ? "" : `  ·  v${label(view.version)}${ownership}`;
		return [
			this.#theme.accent(title) + gap + activityStyle(activity.toUpperCase()),
			`${truncateToWidth(model, Math.max(1, width - visibleWidth(version)))}${this.#theme.muted(version)}`,
		];
	}

	private footer(width: number): string[] {
		if (this.#state.connection === "failed")
			return [
				this.#theme.muted(
					this.#draft === ""
						? "Run the command above, then reopen."
						: this.#drafts === undefined
							? "Copy draft before exit; it is not saved."
							: "Draft saved; restored on next attach.",
				),
				this.#theme.muted(
					`${this.keyHint("unit.attach.cancel")} exit · ${this.keyHint("unit.attach.detach")} exit`,
				),
			];
		const usage = this.#state.view?.usage;
		const close = this.#ownership === "foreground" ? "exit" : "detach";
		if (this.#state.connection === "connecting")
			return [
				this.#theme.muted("Connecting · draft kept locally"),
				this.#theme.muted(
					`${this.keyHint("unit.attach.cancel")} exit · ${this.keyHint("unit.attach.detach")} ${close}`,
				),
			];
		if (width < 64) {
			const tokens =
				usage == null
					? "tokens ?"
					: `${usage.totalTokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })} tok`;
			const cost =
				usage == null || usage.cost.kind === "unknown" ? "cost unknown" : `~$${usage.cost.usd.toFixed(4)} est`;
			const cancel =
				this.#state.connection === "attached" && (this.#state.view?.busy || this.#state.sending)
					? "cancel chat"
					: "exit";
			return [
				this.#theme.muted(`${this.keyHint("tui.input.submit")} send · ${tokens} · ${cost}`),
				this.#theme.muted(
					`${this.keyHint("unit.attach.cancel")} ${cancel} · ${this.keyHint("unit.attach.detach")} ${close} · /help`,
				),
			];
		}
		const cost =
			usage == null || usage.cost.kind === "unknown" ? "cost unknown" : `~$${usage.cost.usd.toFixed(4)} estimated`;
		const tokens =
			usage == null ? "tokens unknown" : `${usage.totalTokens.toLocaleString("en-US")} conversation tokens`;
		return [
			this.#theme.muted(`${tokens}  ·  ${cost}`),
			this.#theme.muted(
				`${this.keyHint("tui.input.submit")} send · ${this.keyHint("tui.input.newLine")} newline · ${this.keyHint("unit.attach.cancel")} cancel chat/exit · ${this.keyHint("unit.attach.detach")} ${close} · /help`,
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
		if (this.#state.connection === "failed") {
			this.transcript.addChild(new Text(this.#theme.error("Agent unavailable"), 1, 0));
			this.transcript.addChild(new Text(sanitizeTerminalText(this.#unavailableHint), 1, 0));
			return;
		}
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
								: this.#theme.accent(
										`${label(view.name).toUpperCase()}${entry.source === "host" ? " · HOST" : ""}`,
									),
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
				this.transcript.addChild(
					new ToolCard(
						label(tool.name),
						tool.status,
						label(tool.callId),
						tool.reason === undefined ? undefined : toolFailureSummary(tool.reason, tool.callId),
						this.#theme,
					),
				);
			if (view.retry !== undefined) {
				const retry = `Notice · Retrying (attempt ${view.retry.attempt}) at ${clock(view.retry.at)}: ${providerProblemSummary(view.retry.problem)}`;
				this.transcript.addChild(new Text(this.#theme.warning(retry), 1, 0));
			}
			if (view.failure !== undefined && !view.busy) {
				const failed = `Error · Request failed (${view.failure.reason}): ${runFailureSummary(view.failure)}`;
				this.transcript.addChild(new Text(this.#theme.error(failed), 1, 0));
			}
			if (this.#state.evidence !== undefined) {
				const text = `${evidenceLines(this.#state.evidence).join("\n")}\n/evidence close hides this.`;
				this.transcript.addChild(new Text(this.#theme.muted(text), 1, 0));
			}
			if (view.entries.length === 0 && live === "")
				this.transcript.addChild(new WelcomePanel(this.#theme, this.#ownership));
		}
		for (const id of this.#messages.keys()) if (!retained.has(id)) this.#messages.delete(id);
		for (const notice of this.#state.notices.slice(-3)) {
			const error = notice.kind === "error";
			const style = error ? this.#theme.error : this.#theme.muted;
			// Retry IDs matter after an uncertain failure, not on every successful submission.
			const text = notice.text.startsWith("Submitting request ") ? "Request submitted." : notice.text;
			this.transcript.addChild(
				new Text(style(`${error ? "Error" : "Notice"} · ${sanitizeTerminalText(text)}`), 1, 0),
			);
		}
		if (this.#inputNotice !== "") this.transcript.addChild(new Text(this.#theme.warning(this.#inputNotice), 1, 0));
		const below = shownBelow(this.#open);
		if (below !== undefined) {
			this.transcript.addChild(
				new Text(
					this.#theme.muted(`Earlier send, unconfirmed (request ID ${sanitizeTerminalText(below.requestId)}):`),
					1,
					0,
				),
			);
			this.transcript.addChild(new Text(sanitizeTerminalText(below.text), 2, 0));
		}
	}
}

// Give an empty conversation a clear purpose without spending rows on a splash screen.
class WelcomePanel implements Component {
	readonly #theme: ReturnType<typeof createTheme>;
	readonly #ownership: "attached" | "foreground";
	constructor(theme: ReturnType<typeof createTheme>, ownership: "attached" | "foreground") {
		this.#theme = theme;
		this.#ownership = ownership;
	}
	render(width: number): string[] {
		const title = width < 64 ? " Durable agent workspace" : "  unit-001  /  Durable agent workspace";
		return [
			this.#theme.accent(truncateToWidth(title, width)),
			this.#theme.muted(truncateToWidth(" Work with your agent or form its mission.", width)),
			this.#theme.muted(
				truncateToWidth(
					`/mission setup · /help · /status ${this.#ownership === "foreground" ? "session" : "agent"} details`,
					width,
				),
			),
		];
	}
	invalidate(): void {}
}

// The context lives in the existing border, preserving the editor's cursor and multiline scroll indicators.
class ComposerEditor extends Editor {
	readonly #caption: () => string;
	constructor(tui: TuiAltScreen, theme: EditorTheme, caption: () => string) {
		super(tui, theme, { paddingX: 1 });
		this.#caption = caption;
	}
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0 || width < 4) return super.renderTopBorder(width, hiddenLineCount);
		const caption = truncateToWidth(` ${this.#caption()} `, width - 2);
		return this.borderColor(`─${caption}${"─".repeat(Math.max(0, width - visibleWidth(caption) - 1))}`);
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
	readonly #callId: string;
	readonly #reason: string | undefined;
	readonly #theme: ReturnType<typeof createTheme>;
	constructor(
		name: string,
		status: string,
		callId: string,
		reason: string | undefined,
		theme: ReturnType<typeof createTheme>,
	) {
		this.#name = name;
		this.#status = status;
		this.#callId = callId;
		this.#reason = reason;
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
		// The ID prefix is what `/evidence` accepts; the reason is a fixed host summary, never tool output.
		const lines = [style(truncateToWidth(` [${this.#status}] ${this.#name} ${cutText(this.#callId, 12)}`, width))];
		if (this.#reason !== undefined) lines.push(style(truncateToWidth(`   ${label(this.#reason)}`, width)));
		return lines;
	}
	invalidate(): void {}
}

// The open send whose text is shown under the transcript, beside newer typing in the editor.
function shownBelow(open: OpenSend | undefined): UnconfirmedSend | undefined {
	if (open === undefined || open.kind === "in-flight") return undefined;
	return open.kind === "kept" || open.below ? open.send : undefined;
}

function replayHint(send: UnconfirmedSend): string {
	return send.digest === undefined
		? "This saved send has no prompt digest, so sending it again uses a new request ID."
		: `Sending the same text again reuses its ID, so the owner admits it at most once.${blankHint(send)}`;
}

// The saved text is sanitized; a prompt of format characters only (U+200B, say) is saved as nothing but its ID.
function blankHint(send: UnconfirmedSend): string {
	return send.text === "" ? " Its text had no printable characters, so none is shown." : "";
}

function clock(epochMs: number): string {
	return `${new Date(epochMs).toISOString().slice(11, 19)} UTC`;
}

function label(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function createTheme(color: boolean) {
	const ansi = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
	// Important text inherits the terminal's contrasting foreground on light and dark palettes.
	const accent = ansi("1;39");
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
		codeBlockBorder: (text) => muted(`──${text.length > 3 ? ` ${text.slice(3)}` : ""}`),
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
