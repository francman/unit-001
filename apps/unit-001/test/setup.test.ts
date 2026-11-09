import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "../src/credentials.ts";
import * as login from "../src/login.ts";
import { runSetup, type SetupOptions } from "../src/setup.ts";
import { SetupBack, SetupCancelled, SetupUI } from "../src/setup-ui.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(answers: readonly (string | Error)[], initial: Record<string, Credential> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "unit-setup-"));
	directories.push(directory);
	const file = join(directory, "auth.json");
	const credentials = new FileCredentialStore(file);
	for (const [provider, credential] of Object.entries(initial))
		await credentials.modify(provider, async () => credential);
	const pending = [...answers];
	let output = "";
	const saved: string[] = [];
	const controller = new AbortController();
	const options: SetupOptions = {
		terminal: {
			input: new PassThrough(),
			output: new PassThrough(),
			out: (text) => {
				output += text;
			},
			err: (text) => {
				output += text;
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
	const next = () => {
		const answer = pending.shift();
		if (answer instanceof Error) throw answer;
		if (answer === undefined) throw new SetupCancelled();
		return answer;
	};
	const choose = vi.spyOn(SetupUI.prototype, "choose").mockImplementation(async (_screen, choices, preferred) => {
		const answer = next();
		return answer || preferred || choices[0].id;
	});
	vi.spyOn(SetupUI.prototype, "secret").mockImplementation(async () => next());
	vi.spyOn(SetupUI.prototype, "close").mockResolvedValue();
	vi.spyOn(SetupUI.prototype, "suspend").mockResolvedValue();
	vi.spyOn(SetupUI.prototype, "busy").mockImplementation(() => {});
	return { options, credentials, file, saved, controller, choose, output: () => output };
}

describe("guided setup configuration", () => {
	it("stores a key and validated selected model only after review", async () => {
		// #36: UI editing/echo is exercised separately by setup-ui and real-terminal acceptance.
		const state = await fixture(["openrouter", "key", "fixture-private-key", "", "save"]);
		expect(await runSetup(state.options, state.controller.signal)).toEqual({
			kind: "completed",
			model: "openrouter/anthropic/claude-sonnet-5.5",
		});
		expect(await state.credentials.read("openrouter")).toEqual({ type: "api_key", key: "fixture-private-key" });
		expect(state.saved).toEqual(["openrouter/anthropic/claude-sonnet-5.5"]);
		expect(state.output()).not.toContain("fixture-private-key");
		if (process.platform !== "win32") expect((await stat(state.file)).mode & 0o777).toBe(0o600);
	});

	it("keeps existing credentials and current model on rerun", async () => {
		const credential: Credential = { type: "oauth", access: "access", refresh: "refresh", expires: 1 };
		const state = await fixture(["", "keep", "", "save"], {
			openai: credential,
			anthropic: { type: "api_key", key: "other" },
		});
		const before = await readFile(state.file, "utf8");
		expect(await runSetup({ ...state.options, currentModel: "openai/gpt-5" }, state.controller.signal)).toEqual({
			kind: "completed",
			model: "openai/gpt-5",
		});
		expect(await readFile(state.file, "utf8")).toBe(before);
	});

	it("keeps an environment key without copying it into the credential store", async () => {
		const state = await fixture(["google", "keep", "", "save"]);
		await runSetup({ ...state.options, env: { GEMINI_API_KEY: "env-secret" } }, state.controller.signal);
		expect(await state.credentials.list()).toEqual([]);
		expect(state.saved).toEqual(["google/gemini-3.5-flash"]);
		expect(state.output()).not.toContain("env-secret");
	});

	it("cancels without writes when the key field or review is cancelled", async () => {
		const state = await fixture(["google", "key", "new-key", "", new SetupCancelled()], {
			google: { type: "api_key", key: "old-key" },
		});
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(await state.credentials.read("google")).toEqual({ type: "api_key", key: "old-key" });
		expect(state.saved).toEqual([]);
	});

	it("discards a staged key when going back and choosing keep existing", async () => {
		// #36: Back navigation must not silently replace credentials after choosing Keep.
		const state = await fixture(["google", "key", "new-key", new SetupBack(), "keep", "", "save"], {
			google: { type: "api_key", key: "old-key" },
		});
		await runSetup(state.options, state.controller.signal);
		expect(await state.credentials.read("google")).toEqual({ type: "api_key", key: "old-key" });
	});

	it("changes the model from review without repeating authentication", async () => {
		const state = await fixture(["openai", "keep", "gpt-5", "model", "gpt-5", "save"], {
			openai: { type: "api_key", key: "stored" },
		});
		await runSetup(state.options, state.controller.signal);
		expect(state.choose.mock.calls.map((call) => call[0].step)).toEqual([1, 2, 3, 4, 3, 4]);
	});

	it("backs out of provider selection without writes", async () => {
		const state = await fixture([new SetupBack()]);
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(state.saved).toEqual([]);
	});

	it("suspends the setup terminal around subscription sign-in", async () => {
		const state = await fixture(["openai", "subscription", "", "save"]);
		const signIn = vi
			.spyOn(login, "runLogin")
			.mockImplementation(async (_models, provider, terminal, _signal, _platform, launch) => {
				expect(SetupUI.prototype.suspend).toHaveBeenCalledOnce();
				expect(provider).toBe("openai");
				expect(terminal).toBe(state.options.terminal);
				expect(launch).toEqual({ kind: "managed", name: "bob" });
				return 0;
			});
		expect(await runSetup(state.options, state.controller.signal)).toEqual({
			kind: "completed",
			model: "openai/gpt-5",
		});
		expect(signIn).toHaveBeenCalledOnce();
	});

	it("returns to authentication after failed sign-in and preserves existing credentials", async () => {
		const state = await fixture(["openai", "subscription", "keep", "", "save"], {
			openai: { type: "api_key", key: "old-key" },
		});
		vi.spyOn(login, "runLogin").mockRejectedValue(new Error("provider failure"));
		await runSetup(state.options, state.controller.signal);
		expect(state.choose.mock.calls[2][0].description).toContain("sign-in failed");
		expect(await state.credentials.read("openai")).toEqual({ type: "api_key", key: "old-key" });
	});

	it("reports saved subscription sign-in if the remaining setup is cancelled", async () => {
		const state = await fixture(["openai", "subscription", new SetupCancelled()]);
		vi.spyOn(login, "runLogin").mockResolvedValue(0);
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(state.output()).toContain("Subscription sign-in saved; default model was not saved");
	});

	it("cancels the wizard after subscription login reports interruption", async () => {
		const state = await fixture(["openai", "subscription"]);
		vi.spyOn(login, "runLogin").mockResolvedValue(130);
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(state.saved).toEqual([]);
		expect(state.choose).toHaveBeenCalledTimes(2);
	});

	it("refreshes provider connection status when returning after subscription sign-in", async () => {
		const state = await fixture(["openai", "subscription", "", "provider", "openai", "keep", "", "save"]);
		vi.spyOn(login, "runLogin").mockImplementation(async () => {
			await state.credentials.modify("openai", async () => ({
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: 1,
			}));
			return 0;
		});
		await runSetup(state.options, state.controller.signal);
		expect(state.choose.mock.calls[4][1].find((choice) => choice.id === "openai")?.description).toBe("Connected");
	});

	it("reports a saved key if settings fail", async () => {
		const state = await fixture(["google", "key", "new-key", "", "save"]);
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
		expect(await state.credentials.read("google")).toEqual({ type: "api_key", key: "new-key" });
		expect(state.output()).toContain("API key saved; default model was not saved");
	});

	it("reports an API key saved immediately before cancellation", async () => {
		const state = await fixture(["google", "key", "new-key", "", "save"]);
		const modify = state.credentials.modify.bind(state.credentials);
		vi.spyOn(state.credentials, "modify").mockImplementation(async (...args) => {
			const result = await modify(...args);
			state.controller.abort();
			return result;
		});
		expect(await runSetup(state.options, state.controller.signal)).toEqual({ kind: "cancelled" });
		expect(state.saved).toEqual([]);
		expect(state.output()).toContain("API key saved; default model was not saved");
	});

	it("reports a model saved immediately before cancellation", async () => {
		const state = await fixture(["google", "keep", "", "save"], { google: { type: "api_key", key: "old-key" } });
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
		expect(state.output()).toContain("Default model saved. Setup did not finish");
	});

	it("shows environment-model precedence in the final review", async () => {
		const state = await fixture(["openai", "keep", "gpt-5", "save"], { openai: { type: "api_key", key: "stored" } });
		await runSetup({ ...state.options, env: { UNIT_001_MODEL: "google/other" } }, state.controller.signal);
		expect(state.choose.mock.calls.at(-1)?.[0].detail).toContain("UNIT_001_MODEL overrides this saved model.");
	});

	it("refuses noninteractive input before opening the UI", async () => {
		const state = await fixture([]);
		await expect(runSetup({ ...state.options, interactive: false }, state.controller.signal)).rejects.toThrow(
			"interactive terminal",
		);
		expect(state.choose).not.toHaveBeenCalled();
	});
});
