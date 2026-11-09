import { PassThrough, Writable } from "node:stream";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETUP_KEYBINDINGS, SetupBack, SetupCancelled, SetupUI } from "../src/setup-ui.ts";

const instances: SetupUI[] = [];
const originalKeys = getKeybindings();
afterEach(async () => {
	await Promise.all(instances.splice(0).map((ui) => ui.close()));
	setKeybindings(originalKeys);
});

function fixture(width = 80, height = 24) {
	const raw: boolean[] = [];
	const input = Object.assign(new PassThrough(), {
		isRaw: false,
		setRawMode(value: boolean) {
			this.isRaw = value;
			raw.push(value);
			return this;
		},
	});
	let wire = "";
	const output = Object.assign(
		new Writable({
			write(chunk, _encoding, callback) {
				wire += chunk.toString();
				callback();
			},
		}),
		{ columns: width, rows: height },
	);
	const ui = new SetupUI(
		{
			input,
			output,
			out: (text) => {
				wire += text;
			},
			err: (text) => {
				wire += text;
			},
		},
		"bob",
		false,
	);
	instances.push(ui);
	const controller = new AbortController();
	return {
		input,
		output,
		ui,
		controller,
		raw,
		wire: () => wire,
		screen: () => stripTerminalSequences(ui.render(output.columns).join("\n")),
	};
}

const choices = [
	{ id: "anthropic", label: "Anthropic (Claude)" },
	{ id: "openai", label: "OpenAI (ChatGPT)" },
	{ id: "google", label: "Google (Gemini)" },
	{ id: "openrouter", label: "OpenRouter" },
];
const provider = { step: 1, title: "Choose a provider", description: "Connect a model provider." };

describe("setup terminal input and rendering", () => {
	it("uses configured setup shortcuts in input handling and displayed help", async () => {
		setKeybindings(
			new KeybindingsManager({ ...TUI_KEYBINDINGS, ...DEFAULT_SETUP_KEYBINDINGS }, { "unit.setup.cancel": "ctrl+x" }),
		);
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		expect(state.screen()).toContain("Ctrl+X cancel");
		state.input.write("\x18");
		await expect(pending).rejects.toBeInstanceOf(SetupCancelled);
	});
	it("shows each filter edit immediately and retains the field position", async () => {
		// #36: actual renderer/input adapter must show normal typing before Enter.
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		const initial = state
			.screen()
			.split("\n")
			.findIndex((line) => line.includes("Search providers"));
		state.input.write("openroutez");
		expect(state.screen()).toContain("openroutez");
		state.input.write("\x7f");
		state.input.write("r");
		expect(state.screen()).toContain("openrouter");
		expect(
			state
				.screen()
				.split("\n")
				.findIndex((line) => line.includes("Search providers")),
		).toBe(initial);
		state.input.write("\r");
		expect(await pending).toBe("openrouter");
	});

	it("uses arrow keys to move selection while keeping the filter editable", async () => {
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("\x1b[B");
		state.input.write("\r");
		expect(await pending).toBe("openai");
	});

	it("masks secret glyphs while retaining cursor editing and immediate length feedback", async () => {
		const state = fixture();
		const pending = state.ui.secret(
			{ step: 2, title: "Enter an API key", description: "Hidden key" },
			state.controller.signal,
		);
		state.input.write("private-key");
		expect(state.screen()).toContain("11 characters · hidden");
		expect(state.screen()).toContain("•••••••••••");
		expect(state.wire()).not.toContain("private-key");
		state.input.write("\x1b[D");
		state.input.write("\x7f");
		state.input.write("X");
		state.input.write("\r");
		expect(await pending).toBe("private-kXy");
		expect(state.wire()).not.toContain("private-kXy");
	});

	it("rejects multiline bracketed paste without echoing or moving stages", async () => {
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("\x1b[200~openrouter\nkey\nprivate-paste\x1b[201~");
		expect(state.screen()).toContain("Paste one line");
		expect(state.wire()).not.toContain("private-paste");
		expect(state.screen()).toContain("Choose a provider");
		state.input.write("\r");
		expect(await pending).toBe("anthropic");
	});

	it("accepts a split single-line secret paste as one field without auto-submit", async () => {
		const state = fixture();
		const pending = state.ui.secret(
			{ step: 2, title: "Enter an API key", description: "Hidden key" },
			state.controller.signal,
		);
		state.input.write("\x1b[20");
		state.input.write("0~private");
		state.input.write("-key\x1b[201~");
		expect(state.screen()).toContain("11 characters · hidden");
		expect(state.wire()).not.toContain("private-key");
		state.input.write("\r");
		expect(await pending).toBe("private-key");
	});

	it("rejects raw multiline input before displaying any tail or submitting", async () => {
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("openrouter\nkey\nraw-private-key\n");
		expect(state.wire()).not.toContain("raw-private-key");
		expect(state.screen()).toContain("Paste one line");
		state.input.write("\r");
		expect(await pending).toBe("anthropic");
	});

	it("bounds an oversized split paste and resumes editing after its end marker", async () => {
		const state = fixture();
		const pending = state.ui.secret(
			{ step: 2, title: "Enter an API key", description: "Hidden key" },
			state.controller.signal,
		);
		state.input.write(`\x1b[200~${"private".repeat(1000)}`);
		state.input.write("private".repeat(1000));
		state.input.write("discarded-secret\x1b[201~");
		expect(state.screen()).toContain("Paste is limited to 8 KiB");
		expect(state.screen()).toContain("0 characters · hidden");
		expect(state.wire()).not.toContain("discarded-secret");
		state.input.write("new-key");
		state.input.write("\r");
		expect(await pending).toBe("new-key");
	});

	it("keeps the current screen's input from feeding a following screen", async () => {
		const state = fixture();
		const first = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("\r");
		expect(await first).toBe("anthropic");
		state.input.write("discarded-typeahead");
		const second = state.ui.choose(
			{ step: 2, title: "Authentication", description: "Choose" },
			[{ id: "key", label: "API key" }],
			"key",
			state.controller.signal,
		);
		expect(state.screen()).not.toContain("discarded-typeahead");
		state.input.write("\r");
		expect(await second).toBe("key");
	});

	it.each([1, 2, 3, 4])("preserves complete controls at 40×12 in step %s", async (step) => {
		const state = fixture(40, 12);
		const pending = state.ui.choose(
			{
				step,
				title: "Setup step",
				description: "A description",
				...(step === 4 ? { detail: ["Provider: OpenAI", "Model: openai/gpt-5", "Credentials: Keep existing"] } : {}),
			},
			choices,
			"anthropic",
			state.controller.signal,
		);
		expect(state.screen()).toContain("Enter confirm");
		expect(state.screen()).toContain("Esc back");
		expect(state.screen()).toContain("Ctrl+C cancel");
		expect(state.ui.render(40).length).toBeLessThanOrEqual(12);
		expect(state.screen()).not.toMatch(/\x1b\[[0-9;]*m/);
		state.input.write("\r");
		await pending;
	});

	it("wraps the complete chosen model in compact review without losing confirmation controls", async () => {
		const state = fixture(40, 12);
		const model = "openrouter/anthropic/claude-sonnet-5.5";
		const pending = state.ui.choose(
			{
				step: 4,
				title: "Review setup",
				description: "Review",
				detail: ["Provider: OpenRouter", `Model: ${model}`, "Credentials: New API key · hidden"],
			},
			[
				{ id: "save", label: "Save configuration" },
				{ id: "model", label: "Change model" },
				{ id: "authentication", label: "Change authentication" },
				{ id: "provider", label: "Change provider" },
			],
			"save",
			state.controller.signal,
		);
		const combined = state.ui
			.render(40)
			.map(stripTerminalSequences)
			.map((line) => line.replace(/^[│ ]+|[│ ]+$/g, ""))
			.join("");
		expect(combined).toContain(model);
		// #36: keep the model's version attached to its name on narrow review screens.
		expect(
			state.ui
				.render(40)
				.map(stripTerminalSequences)
				.some((line) => line.includes("claude-sonnet-5.5")),
		).toBe(true);
		expect(state.screen()).toContain("Enter confirm");
		expect(state.screen()).toContain("Ctrl+C cancel");
		state.input.write("\r");
		await pending;
	});

	it("releases input/raw mode on suspend and resumes without losing normal editing", async () => {
		const state = fixture();
		const first = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("\r");
		await first;
		await state.ui.suspend();
		expect(state.raw.at(-1)).toBe(false);
		expect(state.input.listenerCount("data")).toBe(0);
		const second = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("google");
		expect(state.screen()).toContain("google");
		state.input.write("\r");
		expect(await second).toBe("google");
		await state.ui.close();
		expect(state.raw.at(-1)).toBe(false);
	});

	it("shows pending save feedback and accepts cancellation while no prompt is waiting", async () => {
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("\r");
		await pending;
		state.ui.busy({ step: 4, title: "Saving configuration", description: "Saving private settings." });
		expect(state.screen()).toContain("Saving…");
		state.input.write("\x03");
		expect(state.ui.signal.aborted).toBe(true);
		await state.ui.close();
		expect(state.raw.at(-1)).toBe(false);
	});

	it.each(["\x03", "\x04"])("cancels empty input using %j and restores raw mode", async (data) => {
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write(data);
		await expect(pending).rejects.toBeInstanceOf(SetupCancelled);
		await state.ui.close();
		expect(state.raw.at(-1)).toBe(false);
	});

	it("returns Back on Escape and cancels on input EOF or external abort", async () => {
		const state = fixture();
		const pending = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.write("\x1b");
		await expect(pending).rejects.toBeInstanceOf(SetupBack);
		const next = state.ui.choose(provider, choices, "anthropic", state.controller.signal);
		state.input.end();
		await expect(next).rejects.toBeInstanceOf(SetupCancelled);
		const other = fixture();
		const aborted = other.ui.choose(provider, choices, "anthropic", other.controller.signal);
		other.controller.abort();
		await expect(aborted).rejects.toBeInstanceOf(SetupCancelled);
	});

	it("cancels immediately when a prior terminal owner has already consumed EOF", async () => {
		// #36: OAuth handoff must not reopen an unanswered picker after stdin has ended.
		const state = fixture();
		state.input.end();
		state.input.resume();
		await new Promise<void>((resolve) => state.input.once("end", resolve));
		await expect(state.ui.choose(provider, choices, "anthropic", state.controller.signal)).rejects.toBeInstanceOf(
			SetupCancelled,
		);
		await state.ui.close();
		expect(state.raw.at(-1)).toBe(false);
	});
});
