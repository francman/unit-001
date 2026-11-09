import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "../src/credentials.ts";
import * as login from "../src/login.ts";
import { runSetup, type SetupOptions } from "../src/setup.ts";

const directories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(answers: readonly string[], initial: Record<string, Credential> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "unit-setup-"));
	directories.push(directory);
	const file = join(directory, "auth.json");
	const credentials = new FileCredentialStore(file);
	for (const [provider, credential] of Object.entries(initial))
		await credentials.modify(provider, async () => credential);
	const raw: boolean[] = [];
	const input = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode: (value: boolean) => {
			raw.push(value);
			return input;
		},
	});
	let output = "";
	const terminalOutput = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			output += chunk.toString();
			callback();
		},
	});
	const pending = [...answers];
	const controller = new AbortController();
	const saved: string[] = [];
	const options: SetupOptions = {
		terminal: {
			input,
			output: terminalOutput,
			out: (text) => {
				output += text;
			},
			err: (text) => {
				output += text;
				if (
					text === "Choose: " ||
					text === "API key (hidden): " ||
					text.startsWith("Model [") ||
					text === "Save configuration? [Y/n]: "
				) {
					const answer = pending.shift();
					setImmediate(() => (answer === undefined ? input.end() : input.write(`${answer}\n`)));
				}
			},
		},
		interactive: true,
		env: {},
		credentials,
		platform: "linux",
		launch: { kind: "managed", name: "bob" },
		saveModel: async (model) => {
			saved.push(model);
		},
	};
	return { options, credentials, file, raw, input, saved, controller, output: () => output };
}

describe("guided setup", () => {
	it("stores a hidden API key and a validated model without printing the secret", async () => {
		const state = await fixture(["openrouter", "key", "sk-private-test-key", "", ""]);
		const result = await runSetup(state.options, state.controller.signal);
		expect(result).toEqual({ kind: "completed", model: "openrouter/anthropic/claude-sonnet-5.5" });
		expect(await state.credentials.read("openrouter")).toEqual({ type: "api_key", key: "sk-private-test-key" });
		expect(state.saved).toEqual(["openrouter/anthropic/claude-sonnet-5.5"]);
		expect(state.output()).not.toContain("sk-private-test-key");
		expect(state.output()).toContain("Set up bob");
		expect(state.raw.at(-1)).toBe(false);
		if (process.platform !== "win32") expect((await stat(state.file)).mode & 0o777).toBe(0o600);
	});

	it("never echoes an API key pasted ahead with the other setup answers", async () => {
		const state = await fixture([]);
		let sent = false;
		const terminal = {
			...state.options.terminal,
			err: (text: string) => {
				state.options.terminal.out(text);
				if (text === "Choose: " && !sent) {
					sent = true;
					setImmediate(() => state.input.write("openrouter\nkey\npasted-private-key\n\n\n"));
				}
			},
		};
		expect(await runSetup({ ...state.options, terminal }, state.controller.signal)).toMatchObject({
			kind: "completed",
		});
		expect(state.output()).not.toContain("pasted-private-key");
		expect(await state.credentials.read("openrouter")).toEqual({ type: "api_key", key: "pasted-private-key" });
		expect(state.raw.at(-1)).toBe(false);
	});

	it("preserves stored credentials by default and retains the selected model on rerun", async () => {
		const credential: Credential = { type: "oauth", access: "access", refresh: "refresh", expires: 1 };
		const state = await fixture(["", "", "", ""], {
			openai: credential,
			anthropic: { type: "api_key", key: "other-provider" },
		});
		const before = await readFile(state.file, "utf8");
		const result = await runSetup({ ...state.options, currentModel: "openai/gpt-5" }, state.controller.signal);
		expect(result).toEqual({ kind: "completed", model: "openai/gpt-5" });
		expect(await readFile(state.file, "utf8")).toBe(before);
		expect(state.output()).toContain("Keep stored subscription sign-in");
		expect(state.output()).not.toContain("access");
	});

	it("can retain a provider environment key without copying it into credentials", async () => {
		const state = await fixture(["google", "", "", ""]);
		await runSetup({ ...state.options, env: { GEMINI_API_KEY: "environment-secret" } }, state.controller.signal);
		expect(await state.credentials.list()).toEqual([]);
		expect(state.saved).toEqual(["google/gemini-3.5-flash"]);
		expect(state.output()).not.toContain("environment-secret");
	});

	it("rejects invalid choices and supports bounded model search", async () => {
		const state = await fixture(["9garbage", "openai", "key", "secret", "not-a-model", "/gpt-5", "gpt-5", ""]);
		await runSetup(state.options, state.controller.signal);
		expect(state.output()).toContain("Enter a listed number");
		expect(state.output()).toContain("Choose a model from this provider's catalog");
		expect(state.output()).toMatch(/showing (?:[0-9]|1[0-2]) of/);
		expect(state.saved).toEqual(["openai/gpt-5"]);
	});

	it("does not echo misplaced secrets or terminal escapes at nonsecret prompts", async () => {
		const misplaced = "sk-misplaced-private-key";
		const state = await fixture([
			misplaced,
			"openai",
			misplaced,
			"key",
			"actual-secret",
			misplaced,
			"/\u001b]52;c;clipboard\u0007",
			"gpt-5",
			misplaced,
			"",
		]);
		await runSetup(state.options, state.controller.signal);
		expect(state.output()).not.toContain(misplaced);
		expect(state.output()).not.toContain("actual-secret");
		expect(state.output()).not.toContain("clipboard");
		expect(state.output()).not.toContain("\u001b");
		expect(state.saved).toEqual(["openai/gpt-5"]);
	});

	it("leaves credentials and model unchanged when final confirmation is declined", async () => {
		const state = await fixture(["openai", "key", "replacement-key", "", "n"], {
			openai: { type: "api_key", key: "original-key" },
		});
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(await state.credentials.read("openai")).toEqual({ type: "api_key", key: "original-key" });
		expect(state.saved).toEqual([]);
		expect(state.raw.at(-1)).toBe(false);
	});

	it("treats EOF during hidden input as cancellation and restores terminal mode", async () => {
		const state = await fixture(["google", "key"]);
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(await state.credentials.list()).toEqual([]);
		expect(state.saved).toEqual([]);
		expect(state.raw.at(-1)).toBe(false);
	});

	it("cancels an unanswered prompt on abort", async () => {
		const state = await fixture([]);
		const pending = runSetup(state.options, state.controller.signal);
		state.controller.abort();
		expect(await pending).toEqual({ kind: "cancelled" });
		expect(state.saved).toEqual([]);
	});

	it("restores terminal mode and saves nothing after Ctrl+C at the secret prompt", async () => {
		const state = await fixture(["google", "key", "\u0003"]);
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(await state.credentials.list()).toEqual([]);
		expect(state.saved).toEqual([]);
		expect(state.raw.at(-1)).toBe(false);
	});

	it("refuses noninteractive input before asking for credentials", async () => {
		const state = await fixture([]);
		await expect(runSetup({ ...state.options, interactive: false }, state.controller.signal)).rejects.toThrow(
			/interactive terminal/,
		);
		expect(state.output()).toBe("");
	});

	it("reuses subscription login after releasing the setup reader", async () => {
		const state = await fixture(["openai", "subscription", "", ""]);
		const signIn = vi
			.spyOn(login, "runLogin")
			.mockImplementation(async (_models, provider, terminal, _signal, _platform, launch) => {
				expect(state.raw.at(-1)).toBe(false);
				expect(provider).toBe("openai");
				expect(terminal).toBe(state.options.terminal);
				expect(launch).toEqual({ kind: "managed", name: "bob" });
				await state.credentials.modify("openai", async () => ({
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: 1,
				}));
				return 0;
			});
		expect(await runSetup(state.options, state.controller.signal)).toEqual({
			kind: "completed",
			model: "openai/gpt-5",
		});
		expect(signIn).toHaveBeenCalledOnce();
		expect(state.raw.at(-1)).toBe(false);
	});

	it("does not report completion when saving settings fails", async () => {
		const state = await fixture(["google", "keep", "", ""], { google: { type: "api_key", key: "saved-key" } });
		await expect(
			runSetup(
				{
					...state.options,
					saveModel: async () => {
						throw new Error("disk full");
					},
				},
				state.controller.signal,
			),
		).rejects.toThrow("disk full");
		expect(state.output()).not.toContain("Setup complete");
		expect(state.raw.at(-1)).toBe(false);
	});

	it("reports a saved API key when the subsequent settings write fails", async () => {
		const state = await fixture(["google", "key", "new-private-key", "", ""]);
		await expect(
			runSetup(
				{
					...state.options,
					saveModel: async () => {
						throw new Error("disk full");
					},
				},
				state.controller.signal,
			),
		).rejects.toThrow("disk full");
		expect(await state.credentials.read("google")).toEqual({ type: "api_key", key: "new-private-key" });
		expect(state.output()).toContain("API key saved; default model was not saved");
		expect(state.output()).not.toContain("new-private-key");
		expect(state.output()).not.toContain("Setup complete");
	});

	it("reports a saved API key when aborted before settings can be written", async () => {
		const state = await fixture(["google", "key", "new-private-key", "", ""]);
		const modify = state.credentials.modify.bind(state.credentials);
		vi.spyOn(state.credentials, "modify").mockImplementation(async (...args) => {
			const result = await modify(...args);
			state.controller.abort();
			return result;
		});
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(state.saved).toEqual([]);
		expect(state.output()).toContain("API key saved; default model was not saved");
		expect(state.output()).not.toContain("new-private-key");
	});

	it("reports a saved model if interrupted immediately after the settings write", async () => {
		const state = await fixture(["google", "keep", "", ""], { google: { type: "api_key", key: "stored-key" } });
		expect(
			await runSetup(
				{
					...state.options,
					saveModel: async (model) => {
						state.saved.push(model);
						state.controller.abort();
					},
				},
				state.controller.signal,
			),
		).toEqual({ kind: "cancelled" });
		expect(state.saved).toEqual(["google/gemini-3.5-flash"]);
		expect(state.output()).toContain("Default model saved. Setup did not finish; the service was not started.");
		expect(state.output()).not.toContain("Setup complete");
	});

	it("does not save a model when input ends after completed subscription login", async () => {
		const state = await fixture(["openai", "subscription"]);
		vi.spyOn(login, "runLogin").mockResolvedValue(0);
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(state.saved).toEqual([]);
		expect(state.output()).not.toContain("Setup complete");
		expect(state.raw.at(-1)).toBe(false);
	});

	it("preserves existing configuration when subscription login fails", async () => {
		const state = await fixture(["openai", "subscription"], { openai: { type: "api_key", key: "old-key" } });
		vi.spyOn(login, "runLogin").mockRejectedValue(new Error("Login denied"));
		await expect(runSetup(state.options, state.controller.signal)).rejects.toThrow("Login denied");
		expect(await state.credentials.read("openai")).toEqual({ type: "api_key", key: "old-key" });
		expect(state.saved).toEqual([]);
		expect(state.raw.at(-1)).toBe(false);
	});
});
