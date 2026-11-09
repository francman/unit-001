// Exercises the built setup command in a real tmux PTY, including rendered input and terminal restoration.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TerminalSession } from "./terminal-pty.ts";

const execute = promisify(execFile);
const fixtures: TerminalSession[] = [];

beforeAll(async () => {
	if (process.platform === "win32") return;
	// Missing tmux is a failed Unix visual gate, never a silently skipped test.
	await execute("tmux", ["-V"]);
});

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.tmux("kill-server").catch(() => {});
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

async function terminal(columns = 80, rows = 24, monochrome = false): Promise<TerminalSession> {
	const fixture = new TerminalSession(await mkdtemp(join(tmpdir(), "unit-setup-pty-")));
	fixtures.push(fixture);
	await fixture.start(columns, rows, monochrome);
	return fixture;
}

describe.skipIf(process.platform === "win32")("setup in a real terminal", { timeout: 20_000 }, () => {
	it("shows each typed filter character immediately and edits it without submitting", async () => {
		const app = await terminal();
		let typed = "";
		for (const character of "openrouterx") {
			await app.text(character);
			typed += character;
			await app.waitFor(new RegExp(`\\n│ ${typed}\\s*│`));
		}
		expect(await app.waitFor("openrouterx")).toContain("Choose a provider");
		await app.key("BSpace");
		const edited = await app.waitFor("OpenRouter");
		expect(edited).not.toContain("openrouterx");
		expect(edited).toContain("OpenRouter");
		const cursor = (await app.tmux("display-message", "-t", "setup", "-p", "#{cursor_x} #{cursor_y} #{cursor_flag}"))
			.trim()
			.split(" ")
			.map(Number);
		expect(cursor[0]).toBeGreaterThan(0);
		expect(cursor[1]).toBeLessThan(24);
		expect(cursor[2]).toBe(1);
		await app.key("C-c");
		await app.restored(130);
	});

	it("masks key typing, updates its count, supports backspace, and restores on cancellation", async () => {
		const app = await terminal();
		await app.secret();
		await app.text("dummy");
		const secret = await app.waitFor("5 characters");
		expect(secret).toMatch(/[•*]{3}/);
		expect(secret).not.toContain("dummy");
		await app.key("BSpace");
		await app.waitFor("4 characters");
		const cursor = Number((await app.tmux("display-message", "-t", "setup", "-p", "#{cursor_x}")).trim());
		await app.key("Left");
		await expect
			.poll(async () => Number((await app.tmux("display-message", "-t", "setup", "-p", "#{cursor_x}")).trim()))
			.toBe(cursor - 1);
		await app.key("BSpace");
		await app.waitFor("3 characters");
		await app.text("X");
		await app.waitFor("4 characters");
		await app.key("C-d");
		await app.waitFor("3 characters");
		await app.key("C-c");
		await app.restored(130);
		expect(await app.output()).not.toContain("dummy");
	});

	it("keeps a multiline bracketed paste within the current field and never advances setup", async () => {
		const app = await terminal();
		await app.text("\x1b[200~openrouter\nkey\npasted-private-key\n\n\x1b[201~");
		const provider = await app.waitFor(/paste|line/i);
		expect(provider).toContain("Choose a provider");
		expect(provider).not.toContain("pasted-private-key");
		await app.secret();
		await app.text("\x1b[200~private-first\nprivate-second\x1b[201~");
		const key = await app.waitFor(/line|whitespace/i);
		expect(key).toContain("Enter an API key");
		expect(key).not.toContain("private-first");
		expect(key).not.toContain("private-second");
		await app.key("C-c");
		await app.restored(130);
		const output = await app.output();
		for (const value of ["pasted-private-key", "private-first", "private-second"]) expect(output).not.toContain(value);
	});

	it("buffers split bracketed paste and never advances to another screen", async () => {
		const app = await terminal();
		await app.text("\x1b[200~openrouter\n");
		expect(await app.screen()).toContain("Choose a provider");
		await app.text("key\nfragment-private-key\x1b[201~");
		const screen = await app.waitFor("Nothing was entered");
		expect(screen).toContain("Choose a provider");
		expect(screen).not.toContain("fragment-private-key");
		await app.key("C-c");
		await app.restored(130);
		expect(await app.output()).not.toContain("fragment-private-key");
	});

	it("retains visible input and usable footer after a 40 by 12 resize", async () => {
		const app = await terminal(80, 24, true);
		await app.text("openrouter");
		await app.waitFor("openrouter");
		await app.tmux("resize-window", "-t", "setup", "-x", "40", "-y", "12");
		const screen = await app.waitFor(/Ctrl\+C.*cancel/);
		expect(screen).toContain("openrouter");
		expect(screen).toContain("setup");
		expect(screen).toMatch(/Enter|confirm/);
		expect(screen).toContain("Esc");
		expect(screen).toContain("Ctrl+C");
		expect(screen).toContain("cancel");
		expect(screen.trimEnd().split("\n").length).toBeLessThanOrEqual(12);
		await app.key("C-d");
		await app.key("C-c");
		await app.restored(130);
	});

	it("returns to the provider picker with Escape and cancels empty input with Ctrl+D", async () => {
		const app = await terminal();
		await app.key("Down");
		await app.key("Enter");
		await app.waitFor("Sign in to");
		await app.key("Escape");
		await app.waitFor("Choose a provider");
		await app.key("C-d");
		await app.restored(130);
	});

	it("keeps key, model and complete review details readable at 40 columns", async () => {
		const app = await terminal(40, 12, true);
		await app.secret();
		expect(await app.waitFor("Ctrl+C")).toContain("Enter");
		await app.text("dummy-narrow-key");
		await app.waitFor("16 characters");
		await app.key("Enter");
		await app.waitFor("Choose a model");
		expect(await app.waitFor("Ctrl+C")).toContain("Enter");
		await app.key("Enter");
		const review = await app.waitFor("Review setup");
		const details = review
			.split("\n")
			.map((line) => line.replace(/^│ /, "").replace(/ │$/, "").trim())
			.join("");
		expect(details).toContain("OpenRouter");
		expect(details).toContain("anthropic/claude-sonnet-5.5");
		expect(review).toContain("claude-sonnet-5.5");
		expect(review).toContain("Save configuration");
		expect(review).toContain("Ctrl+C");
		await app.key("C-c");
		await app.restored(130);
		expect(await app.output()).not.toContain("dummy-narrow-key");
		expect(await app.output()).not.toMatch(/\x1b\[(?:3[0-9]|9[0-7])m/);
	});

	it("does not save a staged key when navigating back or bind it to a different provider", async () => {
		const app = await terminal();
		await app.secret();
		await app.text("discarded-openrouter-key");
		await app.key("Enter");
		await app.waitFor("Choose a model");
		await expect(readFile(join(app.data, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
		await app.key("Escape");
		await app.waitFor("Sign in to");
		await app.key("Escape");
		await app.waitFor("Choose a provider");
		await app.text("google");
		await app.key("Enter");
		await app.waitFor("Sign in to Google");
		await app.key("Enter");
		await app.waitFor("Enter an API key");
		await app.waitFor("0 characters");
		await app.text("retained-google-key");
		await app.key("Enter");
		await app.waitFor("Choose a model");
		await app.key("Enter");
		await app.waitFor("Review setup");
		await app.key("Enter");
		await app.restored(0);
		const credentials = JSON.parse(await readFile(join(app.data, "auth.json"), "utf8")) as Record<string, unknown>;
		expect(Object.keys(credentials)).toEqual(["google"]);
		expect(credentials.google).toEqual({ type: "api_key", key: "retained-google-key" });
		const output = await app.output();
		expect(output).not.toContain("discarded-openrouter-key");
		expect(output).not.toContain("retained-google-key");
	});

	it("shows connected credentials and keeps them by default on a rerun", async () => {
		const app = new TerminalSession(await mkdtemp("/tmp/unit-rerun-"));
		fixtures.push(app);
		await mkdir(app.data, { mode: 0o700 });
		const credentials = JSON.stringify({ openrouter: { type: "api_key", key: "existing-fixture-key" } });
		await writeFile(join(app.data, "auth.json"), credentials, { mode: 0o600 });
		await writeFile(
			join(app.data, "settings.json"),
			JSON.stringify({ schemaVersion: 1, model: "openrouter/anthropic/claude-sonnet-5.5" }),
		);
		await app.start();
		expect(await app.waitFor("Connected")).toContain("OpenRouter");
		await app.key("Enter");
		await app.waitFor("Keep existing credentials");
		await app.key("Enter");
		await app.waitFor("Choose a model");
		await app.key("Enter");
		await app.waitFor("Review setup");
		await app.key("Enter");
		await app.restored(0);
		expect(await readFile(join(app.data, "auth.json"), "utf8")).toBe(credentials);
		expect(await app.output()).not.toContain("existing-fixture-key");
	});

	it("completes provider, masked key, model and review screens without a model request", async () => {
		const app = await terminal();
		await app.secret();
		await app.text("dummy-terminal-test-key");
		await app.key("Enter");
		await app.waitFor("Choose a model");
		await app.text("anthropic/claude-sonnet-5.5");
		await app.waitFor("anthropic/claude-sonnet-5.5");
		await app.key("Enter");
		await app.waitFor("Review setup");
		await app.key("Enter");
		await app.restored(0);
		expect(JSON.parse(await readFile(join(app.data, "settings.json"), "utf8"))).toMatchObject({
			model: "openrouter/anthropic/claude-sonnet-5.5",
		});
		expect(JSON.parse(await readFile(join(app.data, "auth.json"), "utf8"))).toMatchObject({
			openrouter: { type: "api_key", key: "dummy-terminal-test-key" },
		});
		expect(await app.output()).not.toContain("dummy-terminal-test-key");
	}, 20_000);

	it("hands the actual terminal to login and resumes setup with a single input owner", async () => {
		const app = new TerminalSession(await mkdtemp("/tmp/unit-handoff-"), [
			resolve(import.meta.dirname, "fixtures/setup-terminal-handoff.mjs"),
		]);
		fixtures.push(app);
		await app.start();
		await app.key("Enter");
		await app.waitFor("Fixture authorization code:");
		await app.text("fixture-auth-code");
		expect(await app.waitFor("fixture-auth-code")).not.toContain("Login input received once");
		await app.key("Enter");
		await app.waitFor("Login input received once");
		await app.key("Enter");
		await app.restored(0);
	});

	it.each(["C-c", "C-d"])(
		"cancels provider polling with %s without an active input prompt and restores the terminal",
		async (key) => {
			const app = new TerminalSession(await mkdtemp("/tmp/unit-handoff-"), [
				resolve(import.meta.dirname, "fixtures/setup-terminal-handoff.mjs"),
				"poll",
			]);
			fixtures.push(app);
			await app.start();
			await app.key("Enter");
			await app.waitFor("Waiting for fixture authorization");
			await app.key(key);
			await app.restored(130);
		},
	);
});
