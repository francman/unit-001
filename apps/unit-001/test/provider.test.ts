import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/errors.ts";
import { createConfiguredModels, detectModel, PROVIDERS, parseModelSpec } from "../src/provider.ts";

describe("parseModelSpec", () => {
	it("splits at the first slash, so model ids may contain slashes", () => {
		expect(parseModelSpec("anthropic/claude-sonnet-5-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-5-5",
		});
		expect(parseModelSpec("openrouter/anthropic/claude-sonnet-5.5")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-5.5",
		});
	});

	it.each(["", "anthropic", "/model", "anthropic/"])("rejects %j", (spec) => {
		expect(() => parseModelSpec(spec)).toThrow(ConfigurationError);
	});
});

describe("detectModel", () => {
	it("returns nothing without credentials, treating empty values as unset", () => {
		expect(detectModel({})).toBeUndefined();
		expect(detectModel({ ANTHROPIC_API_KEY: "" })).toBeUndefined();
	});

	it("picks the first configured provider in order", () => {
		expect(detectModel({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "k" })?.provider).toBe("openai");
		expect(detectModel({ OPENAI_API_KEY: "k", ANTHROPIC_OAUTH_TOKEN: "t" })?.provider).toBe("anthropic");
		expect(detectModel({ OPENROUTER_API_KEY: "k" })?.provider).toBe("openrouter");
	});
});

describe("createConfiguredModels", () => {
	it("explains how to configure a provider when there is none", async () => {
		await expect(createConfiguredModels({})).rejects.toThrow(/No model provider is configured.*ANTHROPIC_API_KEY/);
	});

	it("rejects a provider it cannot start", async () => {
		await expect(createConfiguredModels({}, "nowhere/model")).rejects.toThrow(/not supported.*anthropic/);
	});

	it("rejects an unknown model and lists known ones", async () => {
		await expect(createConfiguredModels({}, "anthropic/not-a-model")).rejects.toThrow(
			/not in the anthropic catalog.*claude/,
		);
	});

	it("prefers an explicit spec over UNIT_001_MODEL over detection", async () => {
		const env = { ANTHROPIC_API_KEY: "k", UNIT_001_MODEL: "openai/gpt-5" };
		expect((await createConfiguredModels(env, "anthropic/claude-sonnet-5-5")).choice.provider).toBe("anthropic");
		expect((await createConfiguredModels(env)).choice).toEqual({ provider: "openai", modelId: "gpt-5" });
		expect((await createConfiguredModels({ ANTHROPIC_API_KEY: "k" })).choice.provider).toBe("anthropic");
	});

	// Guards against the bundled catalog dropping or renaming a default model.
	it.each(PROVIDERS.map((entry) => [entry.id, entry.defaultModelId]))(
		"%s default model %s is in the catalog",
		async (id, modelId) => {
			const { models } = await createConfiguredModels({}, `${id}/${modelId}`);
			expect(models.getModel(id, modelId)).toBeDefined();
		},
	);
});
