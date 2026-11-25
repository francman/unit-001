// #26: failure reasons, retry state and explicit evidence render readably at 80x24 and 40x12.
import {
	stripTerminalSequences,
	type Terminal,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ServiceView } from "../src/service.ts";
import type { TerminalInputResult, TerminalState } from "../src/terminal-controller.ts";
import type { ToolEvidence } from "../src/tool-evidence.ts";
import { RichAttachView } from "../src/terminal-ui.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
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
	entries: [],
	busy: false,
	text: "",
	textTruncated: false,
	tools: [],
	historyTruncated: false,
};

function launch(columns: number, rows: number) {
	const terminal = new FakeTerminal();
	terminal.columns = columns;
	terminal.rows = rows;
	const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false, copyOnSelect: false });
	const actions = {
		submit: vi.fn((_text: string): TerminalInputResult => ({ status: "command" })),
		cancel: vi.fn(),
		detach: vi.fn(),
		dismissSuggestions: vi.fn(),
		admission: vi.fn((): Promise<never> => new Promise(() => {})),
	};
	const view = new RichAttachView(tui, "default", actions, { colorMode: "monochrome" });
	tui.setLayoutRoot(view);
	tui.setFocus(view.editor);
	tui.start();
	const update = (value: ServiceView, change: Partial<TerminalState> = {}) => {
		view.update({ connection: "attached", view: value, sending: false, cancelling: false, notices: [], ...change });
		tui.renderNow(true);
	};
	const screen = () => tui.getScreenLines().map(stripTerminalSequences);
	return { tui, update, screen };
}

const failedTool = { callId: "toolu_01AbCdEfGhIjKl", name: "bash", status: "failed" as const };
const evidence: ToolEvidence = {
	kind: "found",
	callId: "toolu_01AbCdEfGhIjKl",
	name: "bash",
	status: "failed",
	arguments: { text: '{"command":"make"}', bytes: 18, truncated: false, redacted: false },
	output: { text: "make: *** error\nAuthorization: [redacted]\x1b[31mred", bytes: 40, truncated: true, redacted: true },
	diff: null,
	withheld: null,
	redaction: "pattern-only",
	sourceTruncated: false,
};

describe.each([
	[80, 24],
	[40, 12],
])("tool evidence rendering at %ix%i", (columns, rows) => {
	it("shows a tool failure reason and the call ID prefix without raw output", () => {
		const app = launch(columns, rows);
		try {
			app.update({ ...base, tools: [failedTool], failure: undefined });
			app.update({ ...base, tools: [{ ...failedTool, reason: { code: "exit_code", exitCode: 2 } }] });
			const screen = app.screen();
			expect(screen).toHaveLength(rows);
			const text = screen.join("\n");
			expect(text).toContain("[failed] bash toolu_01AbCd");
			expect(text).toContain("Exited with code 2.");
			expect(screen.every((line) => visibleWidth(line) <= columns)).toBe(true);
		} finally {
			app.tui.stop();
		}
	});

	it("shows why the request failed and the waiting retry to any observer", () => {
		const app = launch(columns, rows);
		try {
			// The transcript follows its newest line, so each state is checked on its own at narrow heights.
			const flat = () => app.screen().join(" ").replace(/\s+/g, " ");
			app.update({
				...base,
				retry: { attempt: 2, at: Date.UTC(2026, 10, 21, 12, 30, 5), problem: "rate_limited" },
			});
			expect(flat()).toContain("Retrying (attempt 2) at 12:30:05 UTC: provider rate limited");
			app.update({ ...base, failure: { reason: "model_error", problem: "overloaded" } });
			expect(flat()).toContain("Error · Request failed (model_error): provider overloaded");
			expect(app.screen().every((line) => visibleWidth(line) <= columns)).toBe(true);
			// A running request replaces its previous failure.
			app.update({ ...base, busy: true, failure: { reason: "model_error" } });
			expect(flat()).not.toContain("Request failed");
		} finally {
			app.tui.stop();
		}
	});

	it("renders explicit evidence as sanitized bounded lines and hides it when cleared", () => {
		const app = launch(columns, rows);
		try {
			app.update({ ...base, tools: [failedTool] }, { evidence });
			const text = app.screen().join(" ").replace(/\s+/g, " ");
			// At 40x12 the view follows the end of the evidence; PageUp reaches its header.
			if (columns >= 80) expect(text).toContain("Evidence · bash · failed");
			expect(text).toContain("Authorization: [redacted]");
			expect(text).toContain("/evidence close hides this.");
			expect(text).not.toContain("\x1b");
			expect(app.screen().every((line) => visibleWidth(line) <= columns)).toBe(true);
			app.update({ ...base, tools: [failedTool] }, { evidence: undefined });
			expect(app.screen().join(" ")).not.toContain("Evidence ·");
			app.update({ ...base, tools: [failedTool] }, { evidence: { kind: "unavailable", reason: "ambiguous" } });
			expect(app.screen().join(" ").replace(/\s+/g, " ")).toContain("use more characters");
		} finally {
			app.tui.stop();
		}
	});
});
