import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDefaultModel, saveDefaultModel } from "../src/settings.ts";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-settings-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

describe("saved default model", () => {
	it("leaves an unconfigured agent unchanged", async () => {
		expect(await readDefaultModel(directory)).toBeUndefined();
		expect(await readdir(directory)).toEqual([]);
	});

	it("replaces the selection atomically without changing credentials", async () => {
		await writeFile(join(directory, "auth.json"), "credential fixture", { mode: 0o600 });
		await saveDefaultModel(directory, "openai/gpt-5");
		await saveDefaultModel(directory, "openrouter/anthropic/claude-sonnet-5.5");
		expect(await readDefaultModel(directory)).toBe("openrouter/anthropic/claude-sonnet-5.5");
		expect(await readFile(join(directory, "auth.json"), "utf8")).toBe("credential fixture");
		expect((await readdir(directory)).sort()).toEqual(["auth.json", "settings.json"]);
		if (process.platform !== "win32") expect((await stat(join(directory, "settings.json"))).mode & 0o777).toBe(0o600);
	});

	it.each([
		"broken",
		"null",
		"[]",
		'{"schemaVersion":2,"model":"openai/gpt-5"}',
		'{"schemaVersion":1,"model":"invalid"}',
	])("rejects malformed disk input without exposing its contents: %s", async (text) => {
		await writeFile(join(directory, "settings.json"), text);
		await expect(readDefaultModel(directory)).rejects.toThrow("Invalid agent settings.json");
		await saveDefaultModel(directory, "openai/gpt-5");
		expect(await readDefaultModel(directory)).toBe("openai/gpt-5");
	});

	it("rejects an invalid selection before creating directories", async () => {
		await expect(saveDefaultModel(join(directory, "absent"), "invalid")).rejects.toThrow();
		expect(await readdir(directory)).toEqual([]);
	});
});
