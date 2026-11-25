// #21: Rich attached terminals retain drafts while the public TUI renderer updates bounded owner views.
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getCapabilities,
	getKeybindings,
	KeybindingsManager,
	setCapabilities,
	setKeybindings,
	stripTerminalSequences,
	type Terminal,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { commandCatalog } from "../src/commands/catalog.ts";
import { createDraftStore, type DraftStore } from "../src/draft-store.ts";
import { type SendAdmission, sendDigest } from "../src/send-receipt.ts";
import type { ServiceView } from "../src/service.ts";
import type { ServiceClient, ServiceClientEvent } from "../src/service-client.ts";
import type { SendOptions, TerminalInputResult, TerminalState } from "../src/terminal-controller.ts";
import { DEFAULT_APP_KEYBINDINGS, RichAttachView, runRichAttach, runRichServiceAttach } from "../src/terminal-ui.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	input: (data: string) => void = () => {};
	resize: () => void = () => {};
	stopped = false;
	events: string[] = [];
	start(input: (data: string) => void, resize: () => void): void {
		this.stopped = false;
		this.input = input;
		this.resize = resize;
	}
	stop(): void {
		this.stopped = true;
		this.events.push("stop");
	}
	async drainInput(): Promise<void> {
		this.events.push("drain");
	}
	writes: string[] = [];
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

// Models ProcessTerminal's keyboard negotiation: start enables the Kitty protocol, and draining input pops it again.
class NegotiatingTerminal extends FakeTerminal {
	started = false;
	override start(input: (data: string) => void, resize: () => void): void {
		super.start(input, resize);
		this.started = true;
		this.kittyProtocolActive = true;
	}
	override async drainInput(): Promise<void> {
		this.events.push("drain");
		this.kittyProtocolActive = false;
	}
}

// Everything the terminal was asked to print, without control sequences.
const shown = (terminal: FakeTerminal) => stripTerminalSequences(terminal.writes.join(""));
// The same with wrapped lines joined, for notices longer than one terminal row.
const prose = (terminal: FakeTerminal) => shown(terminal).replace(/\s+/g, " ");

const base: ServiceView = {
	pid: 42,
	version: "1.0.0",
	name: "bob",
	installationId: null,
	model: { provider: "faux", modelId: "faux-1" },
	usage: null,
	entries: [
		{ id: 1, role: "user", text: "Explain this", truncated: false },
		{
			id: 2,
			role: "assistant",
			text: "## Result\n\nUse **bold** and `code`.\n\n```ts\nconst ready = true;\n```",
			truncated: false,
		},
	],
	busy: false,
	text: "",
	textTruncated: false,
	tools: [],
	historyTruncated: false,
};

function launch(drafts?: DraftStore) {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false, copyOnSelect: false });
	const actions = {
		// Like the controller, it calls `beforeDispatch` before returning.
		submit: vi.fn((text: string, options?: SendOptions): TerminalInputResult => {
			const send = { requestId: "r1", digest: sendDigest(text.trim()) };
			void options?.beforeDispatch?.(send);
			return { status: "submitted", ...send, outcome: new Promise(() => {}) };
		}),
		cancel: vi.fn(),
		detach: vi.fn(),
		dismissSuggestions: vi.fn(),
		admission: vi.fn((): Promise<never> => new Promise(() => {})),
	};
	const view = new RichAttachView(tui, "default", actions, {
		colorMode: "monochrome",
		...(drafts === undefined ? {} : { drafts }),
	});
	tui.setLayoutRoot(view);
	tui.setFocus(view.editor);
	tui.addInputListener((data) => view.handleGlobalInput(data));
	tui.start();
	const update = (value: ServiceView = base, change: Partial<TerminalState> = {}) => {
		view.update({ connection: "attached", view: value, sending: false, cancelling: false, notices: [], ...change });
		tui.renderNow(true);
	};
	const screen = () => tui.getScreenLines().map(stripTerminalSequences);
	return { terminal, tui, view, actions, update, screen };
}

describe("rich service terminal", () => {
	// #26: reconnecting must preserve local input without implying that stale owner state accepts sends.
	it.each([
		[80, 24],
		[40, 12],
	])("keeps the draft and cursor while reconnecting at %ix%i", (columns, rows) => {
		const app = launch();
		try {
			app.terminal.columns = columns;
			app.terminal.rows = rows;
			app.terminal.resize();
			app.update();
			app.view.editor.setText("first line\nsecond line");
			app.terminal.input("\x1b[D");
			const cursor = app.view.editor.getCursor();
			app.update({ ...base, busy: true }, { connection: "connecting", unresolvedRequestIds: ["pending-id"] });
			expect(app.screen().at(-2)).toContain("Connecting · draft kept locally");
			expect(app.screen().join("\n")).not.toContain("Enter send");
			expect(app.screen().join("\n")).toContain("pending-id");
			expect(app.view.editor.getCursor()).toEqual(cursor);
			app.update();
			expect(app.view.editor.getExpandedText()).toBe("first line\nsecond line");
			expect(app.view.editor.getCursor()).toEqual(cursor);
			expect(app.actions.submit).not.toHaveBeenCalled();
			expect(app.actions.cancel).not.toHaveBeenCalled();
			expect(app.screen().every((line) => visibleWidth(line) <= columns)).toBe(true);
		} finally {
			app.tui.stop();
		}
	});
	// #26: fatal disconnects leave an unsent draft available for recovery before terminal exit.
	it.each([
		[80, 24],
		[40, 12],
	])("keeps failed-client drafts editable without submitting at %ix%i", (columns, rows) => {
		const app = launch();
		try {
			app.terminal.columns = columns;
			app.terminal.rows = rows;
			app.terminal.resize();
			app.update();
			app.view.editor.setText("keep this draft");
			app.update(base, { connection: "failed", unresolvedRequestIds: ["pending-id"] });
			expect(app.screen().join("\n")).toContain("keep this draft");
			expect(app.screen().join("\n")).toContain("Unsent draft");
			expect(app.screen().at(-2)).toContain("Copy draft before exit; it is not saved.");
			app.terminal.input(" revised");
			app.terminal.input("\r");
			expect(app.view.editor.getExpandedText()).toBe("keep this draft revised");
			expect(app.actions.submit).not.toHaveBeenCalled();
			app.terminal.input(`\x1b[200~${"x".repeat(17000)}\x1b[201~`);
			expect(app.view.editor.getExpandedText()).toBe("keep this draft revised");
			app.tui.renderNow(true);
			expect(app.screen().join("\n")).not.toContain("Enter send");
			expect(app.screen().every((line) => visibleWidth(line) <= columns)).toBe(true);
			app.terminal.input("\x03");
			expect(app.actions.detach).toHaveBeenCalledOnce();
			expect(app.actions.cancel).not.toHaveBeenCalled();
		} finally {
			app.tui.stop();
		}
	});
	it("retains a draft typed before the initial connection fails (#26)", () => {
		const app = launch();
		try {
			app.terminal.input("initial draft");
			app.view.update({ connection: "failed", sending: false, cancelling: false, notices: [] });
			app.tui.renderNow(true);
			expect(app.screen().join("\n")).toContain("initial draft");
			app.terminal.input("\r");
			expect(app.view.editor.getExpandedText()).toBe("initial draft");
			expect(app.actions.submit).not.toHaveBeenCalled();
		} finally {
			app.tui.stop();
		}
	});
	it("sends a reconnected draft only after explicit submission through the same client (#26)", async () => {
		const terminal = new FakeTerminal();
		const abort = new AbortController();
		let observe: (event: ServiceClientEvent) => void = () => {};
		const request = vi.fn<ServiceClient["request"]>(async () => ({
			type: "reply",
			reply: { status: "answered", text: "Fixture answer" },
		}));
		const watch = vi.fn<ServiceClient["watch"]>(async (listener, signal) => {
			observe = listener;
			listener({ type: "view", view: { ...base, busy: true } });
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		});
		const client: ServiceClient = { session: "shared@fixture", ownerSession: "shared", request, watch };
		const running = runRichServiceAttach(client, terminal, abort.signal);
		try {
			terminal.input("keep my draft");
			observe({ type: "connecting", message: "Remote reconnecting" });
			terminal.input("\r");
			expect(request).not.toHaveBeenCalled();
			observe({ type: "view", view: base });
			expect(request).not.toHaveBeenCalled();
			terminal.input("\r");
			// The send leaves once the draft file holds its request ID, a tick after Enter.
			await expect.poll(() => request.mock.calls.length).toBe(1);
			expect(request.mock.calls[0][0]).toMatchObject({ type: "send", prompt: "keep my draft" });
			terminal.input("\x04");
			expect(await running).toBe(0);
			expect(watch).toHaveBeenCalledOnce();
			expect(request).toHaveBeenCalledOnce();
		} finally {
			abort.abort();
			await running;
		}
	});
	it.each([
		[80, 24],
		[40, 12],
	])("selects suggestions into the editor without executing at %ix%i (#59)", (columns, rows) => {
		const app = launch();
		try {
			app.terminal.columns = columns;
			app.terminal.rows = rows;
			app.terminal.resize();
			const suggestions = commandCatalog("slash").filter((command) =>
				["memory", "memory.forget"].includes(command.id),
			);
			app.view.editor.setText("/memroy private note");
			app.update(base, { suggestions });
			expect(app.screen().join("\n")).toContain("Did you mean?");
			expect(app.screen().every((line) => visibleWidth(line) <= columns)).toBe(true);
			app.terminal.input("\x1b[B");
			app.terminal.input("\r");
			expect(app.view.editor.getText()).toBe("/memory forget private note");
			expect(app.actions.submit).not.toHaveBeenCalled();
			expect(app.actions.dismissSuggestions).toHaveBeenCalledOnce();
			app.update(base, { suggesting: true });
			app.terminal.input("\x1b");
			expect(app.actions.dismissSuggestions).toHaveBeenCalledTimes(2);
			expect(app.actions.cancel).not.toHaveBeenCalled();
		} finally {
			app.tui.stop();
		}
	});
	it("dismisses stale suggestions when editing the draft (#59)", () => {
		const app = launch();
		try {
			app.view.editor.setText("/memroy");
			app.update(base, { suggestions: commandCatalog("slash").filter((command) => command.id === "memory") });
			app.terminal.input(" changed");
			expect(app.actions.dismissSuggestions).toHaveBeenCalledOnce();
			expect(app.view.editor.getText()).toContain("changed");
			expect(app.actions.submit).not.toHaveBeenCalled();
		} finally {
			app.tui.stop();
		}
	});
	it("#55 restarts the editor when mission setup ends during a remote reconnect", async () => {
		const terminal = new FakeTerminal();
		const abort = new AbortController();
		const setup = Promise.withResolvers<number>();
		const missionSetup = vi.fn(() => setup.promise);
		let observe: (event: ServiceClientEvent) => void = () => {};
		const client: ServiceClient = {
			session: "default@fixture",
			ownerSession: "default",
			async request() {
				return { type: "error", message: "Unsupported mission" };
			},
			async watch(listener, signal) {
				observe = listener;
				listener({ type: "view", view: base });
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		};
		const running = runRichServiceAttach(client, terminal, abort.signal, { missionSetup });
		try {
			terminal.input("/mission setup");
			terminal.input("\r");
			await expect.poll(() => missionSetup.mock.calls.length).toBe(1);
			expect(terminal.stopped).toBe(true);
			observe({ type: "connecting", message: "Remote reconnecting" });
			setup.resolve(130);
			await expect.poll(() => terminal.stopped).toBe(false);
			observe({ type: "view", view: base });
			terminal.input("\x04");
			expect(await running).toBe(0);
		} finally {
			setup.resolve(130);
			abort.abort();
			await running;
		}
	});
	it("#55 keeps an unconfirmed request ID visible at narrow widths despite rolling notices", () => {
		const app = launch();
		const id = "aa49e3de-4cb1-4caf-9b98-26e4c399c12d";
		try {
			app.terminal.columns = 40;
			app.terminal.rows = 12;
			app.terminal.resize();
			app.update(base, {
				unresolvedRequestIds: [id],
				notices: Array.from({ length: 8 }, () => ({ kind: "info" as const, text: "Reconnecting view" })),
			});
			expect(app.screen().join("\n")).toContain(`ID ${id}`);
			expect(app.screen().at(-2)).toContain("cost unknown");
			expect(app.screen().at(-1)).toContain("detach");
		} finally {
			app.tui.stop();
		}
	});
	it("labels the composer and shows typing immediately without submitting", () => {
		// #36: real typing feedback and a named composer are acceptance requirements, not just action results.
		const app = launch();
		try {
			app.update();
			expect(app.screen().join("\n")).toContain("Ask bob");
			app.terminal.input("Can you explain");
			app.tui.renderNow(true);
			expect(app.screen().join("\n")).toContain("Can you explain");
			expect(app.screen().join("\n")).toContain("Message");
			expect(app.actions.submit).not.toHaveBeenCalled();
			app.update({ ...base, busy: true, text: "A live answer" });
			expect(app.screen().join("\n")).toContain("Can you explain");
		} finally {
			app.tui.stop();
		}
	});

	it("keeps model, send, newline and detach guidance visible at 40 by 12", () => {
		// #36: optional process metadata must not displace the primary model or send action on SSH terminals.
		const app = launch();
		try {
			app.terminal.columns = 40;
			app.terminal.rows = 12;
			app.terminal.resize();
			app.update({ ...base, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } });
			const screen = app.screen();
			expect(screen).toHaveLength(12);
			expect(screen[1]).toContain("anthropic/claude-sonnet-5-5");
			expect(screen[1]).not.toContain("PID");
			expect(screen.join("\n")).toContain("Ctrl+J newline");
			expect(screen.at(-2)).toContain("Enter send");
			expect(screen.at(-2)).toContain("cost unknown");
			expect(screen.at(-1)).toContain("Ctrl+C exit");
			expect(screen.at(-1)).toContain("Ctrl+D detach");
			expect(screen.every((line) => visibleWidth(line) <= 40)).toBe(true);
			app.update({ ...base, busy: true });
			expect(app.screen().at(-1)).toContain("Ctrl+C cancel");
		} finally {
			app.tui.stop();
		}
	});

	it("uses one line per tool outcome and distinguishes actionable failures from notices", () => {
		// #36: compact outcome rows preserve conversation space; failures must be visible without color.
		const app = launch();
		try {
			app.update(
				{
					...base,
					tools: [
						{ callId: "one", name: "read", status: "succeeded" },
						{ callId: "two", name: "bash", status: "failed" },
					],
				},
				{
					notices: [
						{ kind: "error", text: "Send failed: connection lost" },
						{ kind: "info", text: "Submitting request fixture" },
					],
				},
			);
			const screen = app.screen();
			expect(screen.filter((line) => line.includes("[succeeded] read"))).toHaveLength(1);
			expect(screen.filter((line) => line.includes("[failed] bash"))).toHaveLength(1);
			expect(screen.join("\n")).toContain("Error · Send failed: connection lost");
			expect(screen.join("\n")).toContain("Notice · Request submitted.");
			expect(screen.join("\n")).not.toContain("Submitting request fixture");
			app.update(base, {
				notices: [{ kind: "error", text: "Send failed: connection lost; retry request fixture-recovery-id." }],
			});
			expect(app.screen().join("\n")).toContain("fixture-recovery-id");
		} finally {
			app.tui.stop();
		}
	});
	it("shows owner activity while a submission awaits its final reply", () => {
		// #25: awaiting the final send reply must not hide authoritative running or cancelling activity.
		const app = launch();
		try {
			app.update(base, { sending: true });
			expect(app.screen()[0]).toContain("SENDING");
			app.update({ ...base, busy: true }, { sending: true });
			expect(app.screen()[0]).toContain("WORKING");
			expect(app.screen()[0]).not.toContain("SENDING");
			app.update({ ...base, busy: true }, { sending: true, cancelling: true });
			expect(app.screen()[0]).toContain("CANCELLING");
			app.update();
			expect(app.screen()[0]).toContain("READY");
		} finally {
			app.tui.stop();
		}
	});
	it.each(["edit", "submit"] as const)(
		"dismisses an oversized-paste warning after a valid %s without losing the preserved draft",
		(action) => {
			// #23: input warnings survive owner updates but stop describing a problem after valid input succeeds.
			const app = launch();
			try {
				app.update();
				app.view.editor.setText("preserved draft");
				app.terminal.input(`\x1b[200~${"x".repeat(17000)}\x1b[201~`);
				app.tui.renderNow(true);
				expect(app.screen().join("\n")).toContain("Input exceeds 16 KiB");
				expect(app.view.editor.getExpandedText()).toBe("preserved draft");
				app.update({ ...base, busy: true, text: "Owner progress\n" });
				expect(app.screen().join("\n")).toContain("Input exceeds 16 KiB");
				if (action === "edit") {
					app.terminal.input(" revised");
					expect(app.view.editor.getExpandedText()).toBe("preserved draft revised");
				} else {
					app.terminal.input("\r");
					expect(app.actions.submit).toHaveBeenCalledWith("preserved draft", expect.objectContaining({ replayRequestId: undefined }));
					expect(app.view.editor.getExpandedText()).toBe("");
				}
				app.tui.renderNow(true);
				expect(app.screen().join("\n")).not.toContain("Input exceeds 16 KiB");
			} finally {
				app.tui.stop();
			}
		},
	);
	it("bounds completed and fragmented pastes and typed drafts while preserving existing input", () => {
		const app = launch();
		try {
			app.update();
			app.view.editor.setText("existing draft");
			app.terminal.input(`\x1b[200~${"x".repeat(17000)}\x1b[201~`);
			expect(app.view.editor.getExpandedText()).toBe("existing draft");
			app.terminal.input(`\x1b[200~${"x".repeat(9000)}`);
			app.terminal.input(`${"x".repeat(9000)}\x1b[201~`);
			expect(app.view.editor.getExpandedText()).toBe("existing draft");
			app.terminal.input("x".repeat(9000));
			const bounded = app.view.editor.getExpandedText();
			app.terminal.input("x".repeat(9000));
			expect(app.view.editor.getExpandedText()).toBe(bounded);
			expect(app.actions.submit).not.toHaveBeenCalled();
		} finally {
			app.tui.stop();
		}
	});
	it.skipIf(process.platform === "win32").each(["signal", "disconnect"] as const)(
		"restores the terminal after runner %s without cancelling the owner",
		async (kind) => {
			const directory = await mkdtemp(join(tmpdir(), "u1-rich-"));
			const endpoint = join(directory, "default.sock");
			const requests: unknown[] = [];
			let client: Socket | undefined;
			const server = createServer((socket) => {
				socket.on("error", () => {});
				socket.once("data", (data) => {
					const request: unknown = JSON.parse(String(data).trim());
					requests.push(request);
					if (typeof request === "object" && request !== null && "type" in request && request.type === "watch") {
						client = socket;
						socket.write(`${JSON.stringify({ type: "view", view: base })}\n`);
					} else
						socket.end(
							`${JSON.stringify({ type: "error", message: "Mission inspection unavailable in this fixture" })}\n`,
						);
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpoint, resolve);
			});
			const terminal = new FakeTerminal();
			const controller = new AbortController();
			const running = runRichAttach(endpoint, terminal, controller.signal, { colorMode: "monochrome" });
			try {
				// #14: first attach inspects mission status, but must never submit work or cancel the owner.
				await expect.poll(() => requests.length).toBe(2);
				if (kind === "signal") controller.abort();
				else {
					client?.destroy();
					await expect.poll(() => terminal.stopped).toBe(false);
					await new Promise((resolve) => setTimeout(resolve, 30));
					terminal.input("\x04");
				}
				expect(await running).toBe(kind === "signal" ? 0 : 1);
				expect(terminal.events).toEqual(["drain", "stop"]);
				expect(requests).toEqual([{ type: "watch" }, { type: "mission", request: { operation: "status" } }]);
			} finally {
				controller.abort();
				await running;
				client?.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
	it("ignores Kitty action releases after cancellation makes the view idle", () => {
		const app = launch();
		try {
			app.update({ ...base, busy: true });
			app.terminal.input("\x03");
			expect(app.actions.cancel).toHaveBeenCalledOnce();
			app.update(base);
			app.terminal.input("\x1b[99;5:3u");
			app.terminal.input("\x1b[100;5:3u");
			expect(app.actions.cancel).toHaveBeenCalledOnce();
			expect(app.actions.detach).not.toHaveBeenCalled();
		} finally {
			app.tui.stop();
		}
	});
	it("keeps usage visible after notices and removes active Markdown link targets", () => {
		const previous = getCapabilities();
		setCapabilities({ ...previous, hyperlinks: true });
		const app = launch();
		try {
			app.update(
				{
					...base,
					entries: [
						{
							id: 1,
							role: "assistant",
							text: "[Open](javascript:alert(1))\n\n[site](https://example.com)",
							truncated: false,
						},
					],
				},
				{ notices: [{ kind: "error", text: "Provider error details remain readable here." }] },
			);
			const text = app.tui.getScreenLines().join("\n");
			expect(text).not.toMatch(/\x1b\]8;;(?:javascript:|https:)/);
			expect(app.screen().join("\n")).toContain("Provider error details");
			expect(app.screen().at(-2)).toContain("cost unknown");
			expect(text).not.toMatch(/\x1b\[(?:3[0-9]|9[0-7])m/);
		} finally {
			app.tui.stop();
			setCapabilities(previous);
		}
	});
	it("expands multiline bracketed pastes without submitting until Enter", () => {
		const app = launch();
		try {
			app.update();
			const paste = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
			app.terminal.input(`\x1b[200~${paste}\x1b[201~`);
			expect(app.view.editor.getExpandedText()).toBe(paste);
			expect(app.actions.submit).not.toHaveBeenCalled();
			app.terminal.input("\r");
			expect(app.actions.submit).toHaveBeenCalledWith(paste, expect.objectContaining({ replayRequestId: undefined }));
		} finally {
			app.tui.stop();
		}
	});
	it("uses inherited key overrides in actions, editor behavior, and footer hints", () => {
		const previous = getKeybindings();
		setKeybindings(
			new KeybindingsManager(
				{ ...TUI_KEYBINDINGS, ...DEFAULT_APP_KEYBINDINGS },
				{
					"unit.attach.cancel": "ctrl+x",
					"unit.attach.detach": "ctrl+q",
					"tui.input.submit": "ctrl+s",
					"tui.input.newLine": "alt+enter",
				},
			),
		);
		const app = launch();
		try {
			app.update({ ...base, busy: true });
			app.terminal.input("\x18");
			expect(app.actions.cancel).toHaveBeenCalledOnce();
			expect(app.screen().at(-1)).toContain("Ctrl+X");
			expect(app.screen().at(-1)).toContain("Alt+Enter");
			app.view.editor.setText("draft");
			app.terminal.input("\x13");
			expect(app.actions.submit).toHaveBeenCalledWith("draft", expect.objectContaining({ replayRequestId: undefined }));
		} finally {
			app.tui.stop();
			setKeybindings(previous);
		}
	});
	it("renders a fixed identity/model header, Markdown conversation, tools, and action footer", () => {
		const app = launch();
		try {
			app.update({ ...base, tools: [{ callId: "read-1", name: "read", status: "running" }] });
			const screen = app.screen();
			expect(screen).toHaveLength(24);
			expect(screen[0]).toContain("bob  /  default");
			expect(screen[1]).toContain("faux/faux-1");
			expect(screen.join("\n")).toContain("const ready = true;");
			expect(screen.join("\n")).toContain("read");
			expect(screen.at(-1)).toContain("Enter send");
			expect(screen.at(-2)).toContain("cost unknown");
		} finally {
			app.tui.stop();
		}
	});
	// #26 second review, finding 6: the card's 12-unit ID prefix never ends in half of a surrogate pair.
	it("cuts the tool card's call ID prefix without splitting a surrogate pair", () => {
		const app = launch();
		try {
			app.update({ ...base, tools: [{ callId: "abcdefghijk\u{1F600}tail", name: "read", status: "failed" }] });
			const card = app.screen().find((line) => line.includes("[failed] read")) ?? "";
			expect(card).toContain("abcdefghijk");
			expect(card).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
			expect(app.terminal.writes.join("")).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		} finally {
			app.tui.stop();
		}
	});
	it("retains a multiline draft and cursor through live updates and a narrow resize", () => {
		const app = launch();
		try {
			app.update();
			app.view.editor.setText("first line\nsecond line");
			app.terminal.input("\x1b[D");
			const cursor = app.view.editor.getCursor();
			app.update({ ...base, busy: true, text: "Live **answer** arriving\n" });
			app.terminal.columns = 40;
			app.terminal.rows = 12;
			app.terminal.resize();
			app.tui.renderNow(true);
			expect(app.view.editor.getText()).toBe("first line\nsecond line");
			expect(app.view.editor.getCursor()).toEqual(cursor);
			expect(app.screen()).toHaveLength(12);
			expect(app.screen().every((line) => visibleWidth(line) <= 40)).toBe(true);
			expect(app.screen()[0]).toContain("bob");
			expect(app.screen().at(-1)).toContain("cancel");
			expect(app.screen().at(-1)).toContain("detach");
		} finally {
			app.tui.stop();
		}
	});
	it("uses controller actions and restores rejected drafts instead of losing input", () => {
		const app = launch();
		try {
			app.update({ ...base, busy: true });
			app.terminal.input("\x03");
			expect(app.actions.cancel).toHaveBeenCalledOnce();
			app.terminal.input("\x04");
			expect(app.actions.detach).toHaveBeenCalledOnce();
			app.actions.submit.mockReturnValue({ status: "rejected" });
			app.view.editor.setText("keep my draft");
			app.terminal.input("\r");
			expect(app.view.editor.getText()).toBe("keep my draft");
		} finally {
			app.tui.stop();
		}
	});
	it("sanitizes remote fields before styling and labels bounded text and cost estimates", () => {
		const app = launch();
		try {
			app.update({
				...base,
				name: "bob\x1b]52;unsafe\x07",
				entries: [{ id: 3, role: "assistant", text: "safe\x1b[2J result", truncated: true }],
				usage: {
					scope: "conversation-models",
					input: 10,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { kind: "estimate", usd: 0.001 },
				},
			});
			const text = app.screen().join("\n");
			expect(text).toContain("safe result");
			expect(text).toContain("Text truncated");
			expect(text).toContain("30 conversation tokens");
			expect(text).toContain("estimated");
			expect(text).not.toContain("unsafe");
			expect(text).not.toMatch(/[\x00\x1b\x7f-\x9f]/);
		} finally {
			app.tui.stop();
		}
	});
	it("shows a branded empty workspace and distinguishes foreground exit from service detach", () => {
		// #36: the normal source launcher must look like the same application, without claiming a service remains alive.
		const terminal = new FakeTerminal();
		const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false, copyOnSelect: false });
		const actions = {
			submit: vi.fn((): TerminalInputResult => ({ status: "command" })),
			cancel: vi.fn(),
			detach: vi.fn(),
			dismissSuggestions: vi.fn(),
			admission: vi.fn((): Promise<never> => new Promise(() => {})),
		};
		const view = new RichAttachView(tui, "default", actions, { ownership: "foreground", colorMode: "monochrome" });
		tui.setLayoutRoot(view);
		tui.start();
		try {
			view.update({
				connection: "attached",
				view: { ...base, entries: [] },
				sending: false,
				cancelling: false,
				notices: [],
			});
			tui.renderNow(true);
			const screen = tui.getScreenLines().map(stripTerminalSequences).join("\n");
			expect(screen).toContain("unit-001");
			expect(screen).toContain("Durable agent workspace");
			expect(screen).toContain("Work with your agent or form its mission");
			expect(screen).toContain("/mission setup");
			expect(screen).toContain("foreground");
			expect(screen).toContain("Ctrl+D exit");
			expect(screen).not.toContain("Ctrl+D detach");
		} finally {
			tui.stop();
		}
	});

	it("renders fenced code as a labeled code block at narrow widths", () => {
		// #36: Markdown fence syntax should not make a formatted reply look like raw source.
		const app = launch();
		try {
			app.terminal.columns = 40;
			app.terminal.resize();
			app.update({
				...base,
				entries: [{ id: 1, role: "assistant", text: "```bash\nsudo agent setup\n```", truncated: false }],
				text: "",
			});
			const screen = app.screen().join("\n");
			expect(screen).toContain("── bash");
			expect(screen).toContain("sudo agent setup");
			expect(screen).not.toContain("```");
		} finally {
			app.tui.stop();
		}
	});

	it("keeps an actionable unavailable screen until the user exits", () => {
		const terminal = new FakeTerminal();
		terminal.columns = 40;
		terminal.rows = 12;
		const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false, copyOnSelect: false });
		const actions = {
			submit: vi.fn((): TerminalInputResult => ({ status: "rejected" })),
			cancel: vi.fn(),
			detach: vi.fn(),
			dismissSuggestions: vi.fn(),
			admission: vi.fn((): Promise<never> => new Promise(() => {})),
		};
		const view = new RichAttachView(tui, "default", actions, {
			name: "bob",
			colorMode: "monochrome",
			unavailableHint: "Configure: sudo bob setup\nStart: sudo bob start\nOpen: sudo bob",
		});
		tui.setLayoutRoot(view);
		tui.addInputListener((data) => view.handleGlobalInput(data));
		tui.start();
		try {
			// #36: failure can follow an error notice with no new snapshot or notice array.
			const state: TerminalState = {
				connection: "connecting",
				sending: false,
				cancelling: false,
				notices: [{ kind: "error", text: "Endpoint unavailable" }],
			};
			view.update(state);
			view.update({ ...state, connection: "failed" });
			tui.renderNow(true);
			const screen = tui.getScreenLines().map(stripTerminalSequences).join("\n");
			expect(screen).toContain("bob");
			expect(screen).toContain("Agent unavailable");
			expect(screen).toContain("sudo bob setup");
			expect(screen).toContain("sudo bob start");
			expect(screen).not.toContain("Connecting");
			expect(screen).not.toContain("Ask agent");
			expect(screen).not.toContain("Enter send");
			expect(screen).toContain("Ctrl+D exit");
			terminal.input("\x03");
			expect(actions.detach).toHaveBeenCalledOnce();
			expect(actions.cancel).not.toHaveBeenCalled();
		} finally {
			tui.stop();
		}
	});
});

// #26: drafts survive client exit and return only into the editor.
describe("draft recovery across client exit", () => {
	async function withDraftDirectory(run: (directory: string) => Promise<void>): Promise<void> {
		const directory = await mkdtemp(join(tmpdir(), "unit-ui-drafts-"));
		try {
			await run(directory);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
	const storeFor = (directory: string, installationId = "install-a") =>
		createDraftStore({ directory, installationId, session: "shared@fixture" });
	const jsonFiles = async (directory: string) =>
		(await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json"));
	function client(request: ServiceClient["request"]): ServiceClient {
		const watch = vi.fn<ServiceClient["watch"]>(async (listener, signal) => {
			listener({ type: "view", view: base });
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		});
		return { session: "shared@fixture", ownerSession: "shared", request, watch };
	}
	const answered = () =>
		vi.fn<ServiceClient["request"]>(async () => ({ type: "reply", reply: { status: "answered", text: "ok" } }));
	async function attach(directory: string, request: ServiceClient["request"], installationId?: string) {
		const terminal = new FakeTerminal();
		const idle = terminal.input;
		const abort = new AbortController();
		const running = runRichServiceAttach(client(request), terminal, abort.signal, {
			colorMode: "monochrome",
			drafts: storeFor(directory, installationId),
		});
		await expect.poll(() => terminal.input !== idle).toBe(true);
		return { terminal, running, abort };
	}

	it("restores a draft after exit, never sends it, and clears it once the owner confirms a send", async () => {
		await withDraftDirectory(async (directory) => {
			const first = await attach(directory, answered());
			first.terminal.input("unsent thought");
			first.terminal.input("\x04");
			expect(await first.running).toBe(0);
			expect(await jsonFiles(directory)).toHaveLength(1);

			const request = answered();
			const second = await attach(directory, request);
			// Past the short window in which Enter is ignored after a restore.
			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(request).not.toHaveBeenCalled();
			second.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(1);
			expect(request.mock.calls[0][0]).toMatchObject({ type: "send", prompt: "unsent thought" });
			await expect.poll(async () => (await jsonFiles(directory)).length, { timeout: 3000 }).toBe(0);
			second.terminal.input("\x04");
			expect(await second.running).toBe(0);
			expect(await jsonFiles(directory)).toEqual([]);
		});
	});

	it("keeps a submitted draft with its request ID when the client exits before the owner answers", async () => {
		await withDraftDirectory(async (directory) => {
			const request = vi.fn<ServiceClient["request"]>(() => new Promise(() => {}));
			const first = await attach(directory, request);
			first.terminal.input("in flight");
			first.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(1);
			first.terminal.input("\x04");
			expect(await first.running).toBe(0);
			expect(await storeFor(directory).load()).toEqual({
				status: "restored",
				draft: {
					text: "",
					unconfirmed: { text: "in flight", requestId: expect.any(String), digest: sendDigest("in flight") },
				},
			});
		});
	});

	it("keeps both an unconfirmed send and new typing, and shows both after restore", async () => {
		await withDraftDirectory(async (directory) => {
			const request = vi.fn<ServiceClient["request"]>(() => new Promise(() => {}));
			const first = await attach(directory, request);
			first.terminal.input("first message");
			first.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(1);
			first.terminal.input("second thought");
			first.terminal.input("\x04");
			expect(await first.running).toBe(0);
			expect(await storeFor(directory).load()).toEqual({
				status: "restored",
				draft: {
					text: "second thought",
					unconfirmed: { text: "first message", requestId: expect.any(String), digest: sendDigest("first message") },
				},
			});

			const second = await attach(directory, answered());
			await expect.poll(() => shown(second.terminal)).toContain("first message");
			expect(shown(second.terminal)).toContain("second thought");
			expect(shown(second.terminal)).toContain("unconfirmed");
			// Keys typed right after a restore are type-ahead and dropped, so exit after that window.
			await new Promise((resolve) => setTimeout(resolve, 250));
			second.terminal.input("\x04");
			await second.running;
		});
	});

	// #26: on re-attach the owner answers whether the unconfirmed send was admitted; the user no longer has to guess.
	describe("unconfirmed send lookup", () => {
		async function leaveUnconfirmed(directory: string, text: string): Promise<string> {
			const request = vi.fn<ServiceClient["request"]>(() => new Promise(() => {}));
			const first = await attach(directory, request);
			first.terminal.input(text);
			first.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(1);
			first.terminal.input("\x04");
			await first.running;
			const sent = request.mock.calls[0][0];
			if (sent.type !== "send" || sent.requestId === undefined) throw new Error("expected a send with an ID");
			return sent.requestId;
		}
		const owner = (admission: SendAdmission) =>
			vi.fn<ServiceClient["request"]>(async (request) =>
				request.type === "admission"
					? { type: "admission", admission }
					: { type: "reply", reply: { status: "answered", text: "ok" } },
			);

		it("asks once by request ID and digest, then clears an admitted send from the editor and the file", async () => {
			await withDraftDirectory(async (directory) => {
				const id = await leaveUnconfirmed(directory, "in flight");
				const request = owner({ status: "admitted", source: "model", binding: "exact", outcome: "answered" });
				const second = await attach(directory, request);
				await expect.poll(() => shown(second.terminal)).toContain("was received and answered");
				expect(request.mock.calls.map(([sent]) => sent)).toEqual([
					{ type: "admission", requestId: id, digest: sendDigest("in flight") },
				]);
				expect(shown(second.terminal)).toContain("The editor was cleared.");
				// Keys typed right after a restore are type-ahead and dropped, so exit after that window.
				await new Promise((resolve) => setTimeout(resolve, 250));
				second.terminal.input("\x04");
				await second.running;
				expect(await jsonFiles(directory)).toEqual([]);
			});
		});

		it("keeps a send the owner has no record of and resends the same text under the same request ID", async () => {
			await withDraftDirectory(async (directory) => {
				const id = await leaveUnconfirmed(directory, "in flight");
				const request = owner({ status: "not-found" });
				const second = await attach(directory, request);
				await expect.poll(() => shown(second.terminal)).toContain("has no record of request");
				await new Promise((resolve) => setTimeout(resolve, 600));
				second.terminal.input("\r");
				await expect.poll(() => request.mock.calls.length).toBe(2);
				expect(request.mock.calls[1][0]).toEqual({ type: "send", prompt: "in flight", requestId: id });
				second.terminal.input("\x04");
				await second.running;
			});
		});

		it("resends under a new request ID when the ID belongs to a different prompt", async () => {
			await withDraftDirectory(async (directory) => {
				const id = await leaveUnconfirmed(directory, "in flight");
				const request = owner({ status: "rejected", reason: "different-prompt" });
				const second = await attach(directory, request);
				await expect.poll(() => shown(second.terminal)).toContain("belongs to a different prompt");
				await new Promise((resolve) => setTimeout(resolve, 600));
				second.terminal.input("\r");
				await expect.poll(() => request.mock.calls.length).toBe(2);
				expect(request.mock.calls[1][0]).toMatchObject({ type: "send", prompt: "in flight" });
				expect(request.mock.calls[1][0]).not.toMatchObject({ requestId: id });
				second.terminal.input("\x04");
				await second.running;
			});
		});

		it("drops an exactly admitted earlier send from the file but leaves newer typing in the editor", async () => {
			await withDraftDirectory(async (directory) => {
				const writer = storeFor(directory);
				const earlier = { text: "earlier", requestId: "req-1", digest: sendDigest("earlier") };
				writer.save({ text: "newer", unconfirmed: earlier });
				await writer.flush();
				const request = owner({ status: "admitted", source: "model", binding: "exact", outcome: "queued" });
				const second = await attach(directory, request);
				await expect.poll(() => shown(second.terminal)).toContain("is queued behind other work");
				expect(request.mock.calls[0][0]).toEqual({ type: "admission", requestId: "req-1", digest: earlier.digest });
				await new Promise((resolve) => setTimeout(resolve, 250));
				second.terminal.input("\x04");
				await second.running;
				expect(await storeFor(directory).load()).toEqual({ status: "restored", draft: { text: "newer" } });
			});
		});

		// #26 review: a confirmed ID does not confirm the text; only an exact binding may take the text away.
		it.each([
			["unverified", { text: "earlier", requestId: "req-1", digest: sendDigest("earlier") }],
			["recorded", { text: "earlier", requestId: "req-1" }],
		] as const)("keeps the text of a send admitted with a %s binding", async (binding, earlier) => {
			await withDraftDirectory(async (directory) => {
				const writer = storeFor(directory);
				writer.save({ text: "", unconfirmed: earlier });
				await writer.flush();
				const request = owner({ status: "admitted", source: "model", binding, outcome: "placed" });
				const second = await attach(directory, request);
				await expect.poll(() => prose(second.terminal)).toContain("placed in the conversation; it has no answer yet");
				expect(prose(second.terminal)).toContain("could not confirm this is the text it received");
				expect(prose(second.terminal)).toContain("stays in the editor");
				expect(second.terminal.writes.join("")).not.toContain("is running");
				await new Promise((resolve) => setTimeout(resolve, 600));
				// The ID is settled as admitted, so sending the kept text again is a new request.
				second.terminal.input("\r");
				await expect.poll(() => request.mock.calls.length).toBe(2);
				expect(request.mock.calls[1][0]).toMatchObject({ type: "send", prompt: "earlier" });
				expect(request.mock.calls[1][0]).not.toMatchObject({ requestId: "req-1" });
				second.terminal.input("\x04");
				await second.running;
			});
		});

		it("keeps an earlier send below newer typing when its binding is not exact", async () => {
			await withDraftDirectory(async (directory) => {
				const writer = storeFor(directory);
				const earlier = { text: "earlier", requestId: "req-1", digest: sendDigest("earlier") };
				writer.save({ text: "newer", unconfirmed: earlier });
				await writer.flush();
				const request = owner({ status: "admitted", source: "model", binding: "unverified", outcome: "queued" });
				const second = await attach(directory, request);
				await expect.poll(() => prose(second.terminal)).toContain("Its text is kept below.");
				await new Promise((resolve) => setTimeout(resolve, 250));
				second.terminal.input("\x04");
				await second.running;
				expect(await storeFor(directory).load()).toEqual({
					status: "restored",
					draft: { text: "newer", unconfirmed: earlier },
				});
			});
		});

		// #26 review: the file kept a restored ID only while it was in flight or carried, so editing lost it.
		it("keeps a restored send the owner has no record of in the file through an edit and its undo", async () => {
			await withDraftDirectory(async (directory) => {
				const writer = storeFor(directory);
				const restored = { text: "in flight", requestId: "req-4", digest: sendDigest("in flight") };
				writer.save({ text: "", unconfirmed: restored });
				await writer.flush();
				const request = owner({ status: "not-found" });
				const second = await attach(directory, request);
				await expect.poll(() => shown(second.terminal)).toContain("has no record of request");
				await new Promise((resolve) => setTimeout(resolve, 250));
				second.terminal.input("!");
				second.terminal.input("\x7f");
				second.terminal.input("\x04");
				await second.running;
				expect(await storeFor(directory).load()).toEqual({
					status: "restored",
					draft: { text: "in flight", unconfirmed: restored },
				});
			});
		});

		// #26 v2 review, blocker 1: the loader dropped an unconfirmed send whose text sanitized to nothing, ID and all.
		it("keeps the ID of a prompt that sanitizes to nothing and asks about it after a reopen", async () => {
			await withDraftDirectory(async (directory) => {
				const id = await leaveUnconfirmed(directory, "​");
				const request = owner({ status: "not-found" });
				const second = await attach(directory, request);
				await expect.poll(() => request.mock.calls.length).toBe(1);
				expect(request.mock.calls[0][0]).toEqual({ type: "admission", requestId: id, digest: sendDigest("​") });
				expect(prose(second.terminal)).toContain("no printable characters");
				await new Promise((resolve) => setTimeout(resolve, 250));
				second.terminal.input("\x04");
				await second.running;
				expect(await storeFor(directory).load()).toEqual({
					status: "restored",
					draft: { text: "", unconfirmed: { text: "", requestId: id, digest: sendDigest("​") } },
				});
			});
		});

		// #26 review: saved text is sanitized; reusing the ID for text whose digest differs would bind another prompt.
		it("sends restored text under a new ID when it no longer matches the saved digest", async () => {
			await withDraftDirectory(async (directory) => {
				const writer = storeFor(directory);
				writer.save({ text: "", unconfirmed: { text: "in flight", requestId: "req-6", digest: sendDigest("in​flight") } });
				await writer.flush();
				const request = owner({ status: "not-found" });
				const second = await attach(directory, request);
				await expect.poll(() => shown(second.terminal)).toContain("has no record of request");
				await new Promise((resolve) => setTimeout(resolve, 600));
				second.terminal.input("\r");
				await expect.poll(() => request.mock.calls.length).toBe(2);
				expect(request.mock.calls[1][0]).toMatchObject({ type: "send", prompt: "in flight" });
				expect(request.mock.calls[1][0]).not.toMatchObject({ requestId: "req-6" });
				second.terminal.input("\x04");
				await second.running;
			});
		});
	});

	// #26 review, blocker 1: the deferred save used to run up to 750 ms after the send left, so a crash lost the ID.
	it("saves the request ID and prompt digest before the send leaves the client", async () => {
		await withDraftDirectory(async (directory) => {
			let atDispatch: Awaited<ReturnType<DraftStore["load"]>> | undefined;
			const request = vi.fn<ServiceClient["request"]>(async () => {
				atDispatch = await storeFor(directory).load();
				return new Promise(() => {});
			});
			const app = await attach(directory, request);
			app.terminal.input("in flight");
			app.terminal.input("\r");
			await expect.poll(() => atDispatch).toBeDefined();
			const sent = request.mock.calls[0][0];
			if (sent.type !== "send" || sent.requestId === undefined) throw new Error("expected a send with an ID");
			expect(atDispatch).toEqual({
				status: "restored",
				draft: { text: "", unconfirmed: { text: "in flight", requestId: sent.requestId, digest: sendDigest("in flight") } },
			});
			app.abort.abort();
			await app.running;
		});
	});

	// #26 v2 review, blocker 1: a failed write used to be reported and the send dispatched anyway, so a crash restored
	// the earlier draft without the ID of a send the owner may have admitted.
	it("holds a send whose ID cannot be saved, keeps the earlier draft file, and sends only on a second Enter", async () => {
		await withDraftDirectory(async (directory) => {
			const writer = storeFor(directory);
			writer.save({ text: "earlier draft" });
			await writer.flush();
			const request = vi.fn<ServiceClient["request"]>(() => new Promise(() => {}));
			const app = await attach(directory, request);
			await new Promise((resolve) => setTimeout(resolve, 600));
			try {
				// Every later write fails: the directory is no longer private.
				await chmod(directory, 0o755);
				app.terminal.input("\r");
				await expect.poll(() => prose(app.terminal)).toContain("Press Enter again to send it unsaved");
				expect(request).not.toHaveBeenCalled();
				const held = /Request (\S+) was not sent\./.exec(prose(app.terminal))?.[1];
				expect(held).toBeDefined();
				// A crash here restores the earlier draft, and no send left this client under an ID missing from it.
				await chmod(directory, 0o700);
				expect(await storeFor(directory).load()).toEqual({ status: "restored", draft: { text: "earlier draft" } });
				await chmod(directory, 0o755);
				app.terminal.input("\r");
				await expect.poll(() => request.mock.calls.length).toBe(1);
				expect(request.mock.calls[0][0]).toEqual({ type: "send", prompt: "earlier draft", requestId: held });
				await expect.poll(() => prose(app.terminal)).toContain(`Sent request ${held} without saving it`);
				app.abort.abort();
				await app.running;
			} finally {
				await chmod(directory, 0o700);
			}
		});
	});

	// #26 v3 review: holding a same-ID retry dropped the earlier attempt's in-flight record and unresolved ID, so once
	// storage recovered the file held the text without its ID and a reopen sent it under a new one.
	it("keeps a lost reply's ID through a held same-ID retry, storage recovery and a reopen", async () => {
		await withDraftDirectory(async (directory) => {
			const lost = vi.fn<ServiceClient["request"]>(async () => {
				throw new Error("connection reset");
			});
			const first = await attach(directory, lost);
			first.terminal.input("lost reply");
			first.terminal.input("\r");
			await expect.poll(() => prose(first.terminal)).toContain("Send failed; retry request");
			const sent = lost.mock.calls[0][0];
			if (sent.type !== "send" || sent.requestId === undefined) throw new Error("expected a send with an ID");
			const id = sent.requestId;
			const saved = { text: "lost reply", requestId: id, digest: sendDigest("lost reply") };
			expect(await storeFor(directory).load()).toEqual({ status: "restored", draft: { text: "", unconfirmed: saved } });
			try {
				// Every later write fails: the directory is no longer private.
				await chmod(directory, 0o755);
				first.terminal.input("lost reply");
				first.terminal.input("\r");
				await expect.poll(() => prose(first.terminal)).toContain("Press Enter again to send it unsaved");
				expect(lost).toHaveBeenCalledTimes(1);
				expect(prose(first.terminal)).toContain(`Request ${id} was not sent.`);
			} finally {
				// Storage recovers; the exit flush writes what the view holds.
				await chmod(directory, 0o700);
			}
			first.terminal.input("\x04");
			expect(await first.running).toBe(0);
			expect(first.terminal.writes).toContain(
				`Unconfirmed request ID ${id}; inspect persisted work before an explicit retry.\n`,
			);
			expect(await storeFor(directory).load()).toEqual({
				status: "restored",
				draft: { text: "lost reply", unconfirmed: saved },
			});

			const owner = vi.fn<ServiceClient["request"]>(async (request) =>
				request.type === "admission"
					? { type: "admission", admission: { status: "not-found" } }
					: { type: "reply", reply: { status: "answered", text: "ok" } },
			);
			const second = await attach(directory, owner);
			await expect.poll(() => owner.mock.calls.length).toBe(1);
			expect(owner.mock.calls[0][0]).toEqual({ type: "admission", requestId: id, digest: saved.digest });
			await new Promise((resolve) => setTimeout(resolve, 600));
			second.terminal.input("\r");
			await expect.poll(() => owner.mock.calls.length).toBe(2);
			expect(owner.mock.calls[1][0]).toEqual({ type: "send", prompt: "lost reply", requestId: id });
			second.terminal.input("\x04");
			await second.running;
		});
	});

	// #26 v3 review: sending unsaved must not take the file's place from an earlier send whose outcome is unknown.
	it("does not send unsaved text that would drop the saved ID of an earlier send whose reply was lost", async () => {
		await withDraftDirectory(async (directory) => {
			const lost = vi.fn<ServiceClient["request"]>(async () => {
				throw new Error("connection reset");
			});
			const app = await attach(directory, lost);
			app.terminal.input("first");
			app.terminal.input("\r");
			await expect.poll(() => prose(app.terminal)).toContain("Send failed; retry request");
			const sent = lost.mock.calls[0][0];
			if (sent.type !== "send" || sent.requestId === undefined) throw new Error("expected a send with an ID");
			try {
				await chmod(directory, 0o755);
				app.terminal.input("second");
				app.terminal.input("\r");
				const refusal = `would drop the saved record of request ${sent.requestId}`;
				await expect.poll(() => prose(app.terminal)).toContain(refusal);
				expect(prose(app.terminal)).not.toContain("Press Enter again to send it unsaved");
				// A second Enter is not consent here: it is held again.
				app.terminal.input("\r");
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(lost).toHaveBeenCalledTimes(1);
			} finally {
				await chmod(directory, 0o700);
			}
			app.terminal.input("\x04");
			await app.running;
			expect(await storeFor(directory).load()).toEqual({
				status: "restored",
				draft: {
					text: "second",
					unconfirmed: { text: "first", requestId: sent.requestId, digest: sendDigest("first") },
				},
			});
		});
	});

	// #26 v2 review, blocker 2: the first attempt's refusal outlived the retry, so an answered prompt came back.
	it("does not give back a send whose same-ID retry was answered after a refusal", async () => {
		await withDraftDirectory(async (directory) => {
			let refusals = 1;
			const request = vi.fn<ServiceClient["request"]>(async (sent) => {
				if (sent.type === "admission") return { type: "admission", admission: { status: "not-found" } };
				if (refusals-- > 0) return { type: "error", message: "Service is held for maintenance." };
				return { type: "reply", reply: { status: "answered", text: "ok" } };
			});
			const app = await attach(directory, request);
			app.terminal.input("held then answered");
			app.terminal.input("\r");
			await expect.poll(() => shown(app.terminal)).toContain("owner rejected the send");
			app.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(3);
			expect(request.mock.calls[2][0]).toEqual(request.mock.calls[0][0]);
			// The answer settles the send: nothing comes back to the editor, so nothing is left to save.
			await new Promise((resolve) => setTimeout(resolve, 50));
			app.terminal.input("\x04");
			expect(await app.running).toBe(0);
			expect(await storeFor(directory).load()).toEqual({ status: "none" });
		});
	});

	// #26 v2 review, blocker 3: a live lookup that confirmed the ID but not the text dropped the text.
	it("gives back the text of a send admitted with an unverified binding and resends it under a new ID", async () => {
		await withDraftDirectory(async (directory) => {
			const request = vi.fn<ServiceClient["request"]>(async (sent) =>
				sent.type === "admission"
					? {
							type: "admission",
							admission: { status: "admitted", source: "model", binding: "unverified", outcome: "answered" },
						}
					: { type: "error", message: "Request ID already identifies an admitted send." },
			);
			const app = await attach(directory, request);
			app.terminal.input("cannot be compared");
			app.terminal.input("\r");
			await expect.poll(() => prose(app.terminal)).toContain("Your text is back in the editor");
			expect(prose(app.terminal)).toContain("cannot confirm it was this text");
			app.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBeGreaterThanOrEqual(3);
			const [[first], , [second]] = request.mock.calls;
			if (first.type !== "send" || second.type !== "send") throw new Error("expected two sends");
			expect(second.prompt).toBe("cannot be compared");
			expect(second.requestId).not.toBe(first.requestId);
			app.abort.abort();
			await app.running;
		});
	});

	// #26 review, blocker 2: an error that follows the admission commit (a reply over 1 MiB) is not a refusal.
	it("settles a send the owner admitted before replying with an error, and does not give it back", async () => {
		await withDraftDirectory(async (directory) => {
			const request = vi.fn<ServiceClient["request"]>(async (sent) =>
				sent.type === "admission"
					? { type: "admission", admission: { status: "admitted", source: "model", binding: "exact", outcome: "answered" } }
					: { type: "error", message: "Service response exceeds 1 MiB." },
			);
			const app = await attach(directory, request);
			app.terminal.input("long answer please");
			app.terminal.input("\r");
			await expect.poll(() => prose(app.terminal)).toContain("but replied with an error");
			const [[send], [lookup]] = request.mock.calls;
			if (send.type !== "send") throw new Error("expected the send first");
			expect(lookup).toEqual({ type: "admission", requestId: send.requestId, digest: sendDigest("long answer please") });
			expect(shown(app.terminal)).not.toContain("owner rejected the send");
			app.terminal.input("\x04");
			expect(await app.running).toBe(0);
			expect(await jsonFiles(directory)).toEqual([]);
		});
	});

	it("keeps the request ID when the owner cannot be asked about a send that failed", async () => {
		await withDraftDirectory(async (directory) => {
			const request = vi.fn<ServiceClient["request"]>(async () => ({ type: "error", message: "Owner busy." }));
			const app = await attach(directory, request);
			app.terminal.input("uncertain");
			app.terminal.input("\r");
			await expect.poll(() => prose(app.terminal)).toContain("stays unconfirmed");
			app.terminal.input("\x04");
			await app.running;
			const sent = request.mock.calls[0][0];
			if (sent.type !== "send") throw new Error("expected the send first");
			expect(await storeFor(directory).load()).toEqual({
				status: "restored",
				draft: { text: "", unconfirmed: { text: "uncertain", requestId: sent.requestId, digest: sendDigest("uncertain") } },
			});
		});
	});

	// #26 second review, finding 2: discarding type-ahead must not tear down the negotiated keyboard protocol.
	it("drops type-ahead after a restore without draining the terminal, and keeps terminal replies flowing", async () => {
		await withDraftDirectory(async (directory) => {
			const writer = storeFor(directory);
			writer.save({ text: "restored text" });
			await writer.flush();
			const terminal = new NegotiatingTerminal();
			const abort = new AbortController();
			const request = answered();
			const running = runRichServiceAttach(client(request), terminal, abort.signal, {
				colorMode: "monochrome",
				drafts: storeFor(directory),
			});
			await expect.poll(() => terminal.started).toBe(true);
			await expect.poll(() => shown(terminal)).toContain("restored text");
			// Buffered keys from before the attach: plain text, a Kitty-encoded key, Enter and a paste.
			for (const typed of ["stale", "\x1b[97u", "\r", "\x1b[200~pasted\x1b[201~"]) terminal.input(typed);
			expect(terminal.events).not.toContain("drain");
			expect(terminal.kittyProtocolActive).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 600));
			terminal.input(" now");
			terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(1);
			expect(request.mock.calls[0][0]).toMatchObject({ type: "send", prompt: "restored text now" });
			terminal.input("\x04");
			expect(await running).toBe(0);
			// Only the exit path drains, after the view has stopped taking input.
			expect(terminal.events).toEqual(["drain", "stop"]);
		});
	});

	it("treats only keys and pastes as type-ahead, so replies to the renderer's queries still pass", () => {
		const app = launch();
		try {
			app.view.restoreDraft({ text: "" });
			for (const typed of ["x", "\r", "\x03", "\x1b[97u", "\x1b[13u", "\x1b[A", "\x1b[200~p\x1b[201~"])
				expect(app.view.handleGlobalInput(typed), JSON.stringify(typed)).toEqual({ consume: true });
			// Cell size and color replies answer the renderer's own queries; they are not keys.
			for (const reply of ["\x1b[6;20;10t", "\x1b]11;rgb:0000/0000/0000\x07"])
				expect(app.view.handleGlobalInput(reply)?.consume, JSON.stringify(reply)).not.toBe(true);
		} finally {
			app.tui.stop();
		}
	});

	it("ignores Enter right after a restore and sends only on a later deliberate Enter", async () => {
		await withDraftDirectory(async (directory) => {
			const writer = storeFor(directory);
			writer.save({ text: "restored text" });
			await writer.flush();
			const request = answered();
			const app = await attach(directory, request);
			app.terminal.input("\r");
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(request).not.toHaveBeenCalled();
			await new Promise((resolve) => setTimeout(resolve, 600));
			app.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(1);
			expect(request.mock.calls[0][0]).toMatchObject({ type: "send", prompt: "restored text" });
			app.terminal.input("\x04");
			await app.running;
		});
	});

	// A slow terminal start must not use up the restore guard before the first buffered Enter arrives.
	it("ignores a buffered Enter after a restore even when the terminal starts slowly", async () => {
		await withDraftDirectory(async (directory) => {
			const writer = storeFor(directory);
			writer.save({ text: "restored text" });
			await writer.flush();
			let now = Date.now();
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			class SlowTerminal extends FakeTerminal {
				override start(input: (data: string) => void, resize: () => void): void {
					now += 600;
					super.start(input, resize);
				}
			}
			const terminal = new SlowTerminal();
			const abort = new AbortController();
			const request = answered();
			const running = runRichServiceAttach(client(request), terminal, abort.signal, {
				colorMode: "monochrome",
				drafts: storeFor(directory),
			});
			try {
				await expect.poll(() => shown(terminal)).toContain("restored text");
				terminal.input("\r");
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(request).not.toHaveBeenCalled();
			} finally {
				abort.abort();
				await running;
				clock.mockRestore();
			}
		});
	});

	it("never puts terminal escapes from a planted draft file into the editor", async () => {
		await withDraftDirectory(async (directory) => {
			const writer = storeFor(directory);
			writer.save({ text: "placeholder" });
			await writer.flush();
			const [name] = await jsonFiles(directory);
			const path = join(directory, name);
			const file = JSON.parse(await readFile(path, "utf8"));
			await writeFile(path, JSON.stringify({ ...file, text: "\u001b]0;pwned\u0007hello\u001b[2J" }), { mode: 0o600 });
			const app = launch(storeFor(directory));
			try {
				const loaded = await storeFor(directory).load();
				if (loaded.status !== "restored") throw new Error("expected a restored draft");
				app.view.restoreDraft(loaded.draft);
				expect(app.view.editor.getExpandedText()).toBe("hello");
			} finally {
				app.tui.stop();
			}
		});
	});

	// A maintenance hold refuses before admission: the owner then has no record under the ID.
	const held = (release?: Promise<void>) =>
		vi.fn<ServiceClient["request"]>(async (sent) => {
			if (sent.type === "admission") return { type: "admission", admission: { status: "not-found" } };
			await release;
			return { type: "error", message: "Service is held for maintenance." };
		});

	it("gives text back to an empty editor and keeps the file when the owner rejects the send", async () => {
		await withDraftDirectory(async (directory) => {
			const request = held();
			const app = await attach(directory, request);
			app.terminal.input("deploy day prompt");
			app.terminal.input("\r");
			// A rejection is not an answer: the text returns to the editor and stays on disk.
			await expect.poll(() => shown(app.terminal)).toContain("owner rejected the send");
			const [[send], [lookup]] = request.mock.calls;
			if (send.type !== "send" || send.requestId === undefined) throw new Error("expected the send first");
			expect(lookup).toMatchObject({ type: "admission", requestId: send.requestId });
			// With no record under the ID, the same text goes again under the same ID.
			app.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(4);
			expect(request.mock.calls[2][0]).toEqual(send);
			await expect.poll(() => shown(app.terminal).split("owner rejected the send").length).toBe(3);
			app.terminal.input("\x04");
			expect(await app.running).toBe(0);
			expect(await storeFor(directory).load()).toEqual({
				status: "restored",
				draft: {
					text: "deploy day prompt",
					unconfirmed: { text: "deploy day prompt", requestId: send.requestId, digest: sendDigest("deploy day prompt") },
				},
			});
		});
	});

	it("keeps a rejected send in the file when the editor already holds new typing", async () => {
		await withDraftDirectory(async (directory) => {
			const release = Promise.withResolvers<void>();
			const request = held(release.promise);
			const app = await attach(directory, request);
			app.terminal.input("rejected one");
			app.terminal.input("\r");
			await expect.poll(() => request.mock.calls.length).toBe(1);
			app.terminal.input("newer typing");
			release.resolve();
			await expect.poll(() => shown(app.terminal)).toContain("owner rejected the send");
			app.terminal.input("\x04");
			await app.running;
			expect(await storeFor(directory).load()).toEqual({
				status: "restored",
				draft: {
					text: "newer typing",
					unconfirmed: { text: "rejected one", requestId: expect.any(String), digest: sendDigest("rejected one") },
				},
			});
		});
	});

	it("refuses a draft directory others can enter and says so instead of restoring", async () => {
		await withDraftDirectory(async (directory) => {
			const writer = storeFor(directory);
			writer.save({ text: "planted" });
			await writer.flush();
			await chmod(directory, 0o755);
			const request = answered();
			const app = await attach(directory, request);
			await expect.poll(() => shown(app.terminal)).toContain("Saved draft not restored");
			app.terminal.input("\r");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(request).not.toHaveBeenCalled();
			app.terminal.input("\x04");
			await app.running;
		});
	});

	it("ignores a draft saved for another installation", async () => {
		await withDraftDirectory(async (directory) => {
			const writer = storeFor(directory, "install-a");
			writer.save({ text: "for a" });
			await writer.flush();
			const request = answered();
			const other = await attach(directory, request, "install-b");
			other.terminal.input("\r");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(request).not.toHaveBeenCalled();
			other.terminal.input("\x04");
			expect(await other.running).toBe(0);
			expect(await storeFor(directory, "install-a").load()).toEqual({ status: "restored", draft: { text: "for a" } });
		});
	});

	it("writes the draft file with mode 0600", async () => {
		await withDraftDirectory(async (directory) => {
			const first = await attach(directory, answered());
			first.terminal.input("private");
			first.terminal.input("\x04");
			await first.running;
			const [name] = await jsonFiles(directory);
			expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(join(directory, name), "utf8"))).toMatchObject({ text: "private" });
		});
	});

	it.each([
		[80, 24],
		[40, 12],
	])("shows a one-line restore notice and a saved-draft footer at %ix%i", async (columns, rows) => {
		await withDraftDirectory(async (directory) => {
			const app = launch(storeFor(directory));
			try {
				app.terminal.columns = columns;
				app.terminal.rows = rows;
				app.terminal.resize();
				app.update();
				app.view.restoreDraft({ text: "line one\nline two" });
				app.tui.renderNow(true);
				expect(app.view.editor.getExpandedText()).toBe("line one\nline two");
				expect(app.screen().join("\n")).toContain("Restored unsent draft");
				app.view.restoreDraft({ text: "", unconfirmed: { text: "resent?", requestId: "req-9" } });
				app.tui.renderNow(true);
				expect(app.screen().join("\n")).toContain("unconfirmed");
				app.update(base, { connection: "failed" });
				expect(app.screen().at(-2)).toContain("Draft saved; restored on next attach.");
				expect(app.screen().every((line) => visibleWidth(line) <= columns)).toBe(true);
				expect(app.actions.submit).not.toHaveBeenCalled();
				// Past the type-ahead window that follows a restore, typing edits the restored text.
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(Date.now() + 250);
				app.terminal.input("\x1b[D");
				app.terminal.input("!");
				expect(app.view.editor.getExpandedText()).toContain("!");
			} finally {
				vi.useRealTimers();
				app.tui.stop();
			}
		});
	});
});
