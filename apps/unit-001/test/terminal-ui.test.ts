// #21: Rich attached terminals retain drafts while the public TUI renderer updates bounded owner views.
import { mkdtemp, rm } from "node:fs/promises";
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
import type { ServiceView } from "../src/service.ts";
import type { ServiceClient, ServiceClientEvent } from "../src/service-client.ts";
import type { TerminalInputResult, TerminalState } from "../src/terminal-controller.ts";
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
	write(): void {}
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

function launch() {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false, copyOnSelect: false });
	const actions = {
		submit: vi.fn((_text: string): TerminalInputResult => ({ status: "submitted", requestId: "r1" })),
		cancel: vi.fn(),
		detach: vi.fn(),
		dismissSuggestions: vi.fn(),
	};
	const view = new RichAttachView(tui, "default", actions, { colorMode: "monochrome" });
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
					expect(app.actions.submit).toHaveBeenCalledWith("preserved draft");
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
			expect(app.actions.submit).toHaveBeenCalledWith(paste);
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
			expect(app.actions.submit).toHaveBeenCalledWith("draft");
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
