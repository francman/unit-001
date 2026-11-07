import { PassThrough } from "node:stream";
import type { AuthInteraction, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.ts";
import { describeStatus, runLogin, runLogout, subscriptionFor } from "../src/login.ts";
import type { Terminal } from "../src/repl.ts";

function memoryStore(initial: Record<string, Credential> = {}): CredentialStore {
	const entries = new Map(Object.entries(initial));
	return {
		read: async (id) => entries.get(id),
		list: async () => [...entries].map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: async (id, fn) => {
			const next = await fn(entries.get(id));
			if (next !== undefined) entries.set(id, next);
			return next ?? entries.get(id);
		},
		delete: async (id) => void entries.delete(id),
	};
}

function terminal() {
	const input = new PassThrough();
	input.end();
	const err: string[] = [];
	const value: Terminal = { input, out: () => {}, err: (text) => void err.push(text) };
	return { terminal: value, err: () => err.join("") };
}

const oauth: Credential = { type: "oauth", access: "a", refresh: "r", expires: 1 };

describe("subscriptionFor", () => {
	it("maps the names on the command line to providers", () => {
		expect(subscriptionFor("anthropic").provider).toBe("anthropic");
		expect(subscriptionFor("openai").provider).toBe("openai");
	});

	it.each(["google", "", "Anthropic", "constructor", "__proto__", "toString"])("rejects %j", (name) => {
		expect(() => subscriptionFor(name)).toThrow(UsageError);
	});
});

describe("runLogin", () => {
	it("runs the provider's oauth login with a terminal interaction and reports success", async () => {
		const calls: { provider: string; type: string; interaction: AuthInteraction; agentName?: string }[] = [];
		const models = {
			login: async (
				provider: string,
				type: string,
				interaction: AuthInteraction,
				options?: { agentName?: string },
			) => {
				calls.push({
					provider,
					type,
					interaction,
					...(options?.agentName === undefined ? {} : { agentName: options.agentName }),
				});
				interaction.notify({ type: "info", message: "Welcome" });
				return oauth;
			},
		};
		const io = terminal();
		expect(
			await runLogin(models as never, "anthropic", io.terminal, new AbortController().signal, "linux", "bob"),
		).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ provider: "anthropic", type: "oauth", agentName: "bob" });
		expect(io.err()).toContain("Run bob to start.");
		expect(io.err()).toContain("Welcome");
		expect(io.err()).toContain("Signed in with Claude Pro or Max");
	});

	it("does not report success when the login fails", async () => {
		const models = {
			login: async () => {
				throw new Error("denied");
			},
		};
		const io = terminal();
		await expect(
			runLogin(models as never, "openai", io.terminal, new AbortController().signal, "linux"),
		).rejects.toThrow("denied");
		expect(io.err()).not.toContain("Signed in");
	});

	it("rejects an unknown provider before starting anything", async () => {
		const models = { login: async () => oauth };
		await expect(
			runLogin(models as never, "nowhere", terminal().terminal, new AbortController().signal),
		).rejects.toThrow(UsageError);
	});
});

describe("runLogout", () => {
	it("removes a stored sign-in", async () => {
		const store = memoryStore({ anthropic: oauth, openai: oauth });
		const io = terminal();
		expect(await runLogout(store, "anthropic", io.terminal)).toBe(0);
		expect(io.err()).toBe("Signed out of anthropic.\n");
		expect((await store.list()).map((entry) => entry.providerId)).toEqual(["openai"]);
	});

	it("says so when there was nothing to remove", async () => {
		const io = terminal();
		await runLogout(memoryStore(), "openai", io.terminal);
		expect(io.err()).toBe("Not signed in to openai.\n");
	});
});

describe("describeStatus", () => {
	it("shows each provider's state without any secret", async () => {
		const store = memoryStore({ anthropic: oauth });
		const lines = await describeStatus(store, {
			OPENAI_API_KEY: "sk-very-secret",
			ANTHROPIC_API_KEY: "sk-other-secret",
		});
		expect(lines.join("\n")).toBe(
			[
				"anthropic   signed in with a subscription (ANTHROPIC_API_KEY is set but the stored sign-in wins)",
				"openai      API key from OPENAI_API_KEY",
				"google      not configured",
				"openrouter  not configured",
			].join("\n"),
		);
		expect(lines.join("")).not.toContain("secret");
	});

	it("reports a stored API key", async () => {
		const lines = await describeStatus(memoryStore({ google: { type: "api_key", key: "k" } }), {});
		expect(lines.find((line) => line.startsWith("google"))).toContain("stored API key");
	});
});
