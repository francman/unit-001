// Checks rendered attached-chat behavior through the actual terminal, editor and local socket transport.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TerminalSession } from "./terminal-pty.ts";

const execute = promisify(execFile);
const fixtures: TerminalSession[] = [];
beforeAll(async () => {
	if (process.platform !== "win32") await execute("tmux", ["-V"]);
});
afterEach(async () => {
	for (const app of fixtures.splice(0)) {
		await app.tmux("kill-server").catch(() => {});
		await rm(app.directory, { recursive: true, force: true });
	}
});

async function attached(busy = false, monochrome = false): Promise<TerminalSession> {
	const app = new TerminalSession(
		await mkdtemp("/tmp/unit-chat-"),
		[resolve(import.meta.dirname, "fixtures/attached-terminal-peer.mjs"), busy ? "busy" : "idle"],
		"Deployment review",
	);
	fixtures.push(app);
	await app.start(80, 24, monochrome);
	return app;
}

async function requests(app: TerminalSession): Promise<{ type: string; prompt?: string }[]> {
	return (await readFile(join(app.data, "requests.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

describe.skipIf(process.platform === "win32")("attached chat in a real terminal", { timeout: 20_000 }, () => {
	it("opens the rich owner client for a bare managed command without reading credentials", async () => {
		const app = new TerminalSession(
			await mkdtemp("/tmp/unit-bare-"),
			[resolve(import.meta.dirname, "fixtures/attached-terminal-peer.mjs"), "idle", "managed"],
			"Deployment review",
		);
		fixtures.push(app);
		await app.start();
		await app.text("bare command draft");
		await app.waitFor("bare command draft");
		await app.key("C-d");
		await app.restored(0);
		expect((await requests(app)).map((request) => request.type)).toEqual(["watch", "mission"]);
		expect(await readFile(join(app.data, "auth.json"), "utf8")).toContain("Invalid credential fixture");
	});

	it("keeps a stopped owner's recovery guidance visible without advertising an unavailable send action", async () => {
		const app = new TerminalSession(
			await mkdtemp("/tmp/unit-stopped-"),
			[resolve(import.meta.dirname, "fixtures/attached-terminal-peer.mjs"), "idle", "unavailable"],
			"Agent unavailable",
		);
		fixtures.push(app);
		await app.start();
		const unavailable = await app.screen();
		expect(unavailable).toContain("sudo agent setup");
		expect(unavailable).toContain("sudo agent start");
		expect(unavailable).not.toMatch(/Enter.*send/i);
		expect(unavailable).not.toContain("Ask agent");
		await app.key("C-d");
		await app.restored(1);
	});

	it("uses the rich foreground interface with one storage owner and explicit exit semantics", async () => {
		const fixture = resolve(import.meta.dirname, "fixtures/source-terminal-entry.mjs");
		const app = new TerminalSession(await mkdtemp("/tmp/unit-source-"), [fixture], "gpt-5");
		fixtures.push(app);
		await app.start();
		await app.text("foreground draft");
		const screen = await app.waitFor("foreground draft");
		expect(screen).toMatch(/Ctrl\+D.*exit/i);
		expect(screen).not.toMatch(/Ctrl\+D.*detach/i);
		await expect(
			execute(process.execPath, [fixture, "compete"], {
				env: { ...app.environment, UNIT_001_HOME: app.data },
				timeout: 5000,
			}),
		).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/already running/i) });
		await app.key("C-d");
		await app.restored(0);
	});
	it("shows typed drafts before Enter and preserves them through live updates and narrow resize", async () => {
		const app = await attached(true);
		await app.text("inspect this draft");
		await app.waitFor("inspect this draft");
		await app.waitFor("Live fixture update");
		expect(await app.screen()).toContain("inspect this draft");
		await app.tmux("resize-window", "-t", "setup", "-x", "40", "-y", "12");
		const narrow = await app.waitFor(/Ctrl\+C.*cancel/i);
		expect(narrow).toContain("inspect this draft");
		expect(narrow).toMatch(/Enter.*send/i);
		expect(narrow).toMatch(/Ctrl\+D.*detach/i);
		expect(narrow).toContain("agent");
		await app.key("C-d");
		await app.restored(0);
		expect((await requests(app)).map((request) => request.type)).toEqual(["watch", "mission"]);
	});

	// #36: Wide help says cancel/exit in both states; only owner activity proves cancellation completed.
	it.each([80, 40])("cancels busy work and detaches only after the owner is ready at %i columns", async (columns) => {
		const app = await attached(true);
		await app.tmux("resize-window", "-t", "setup", "-x", String(columns), "-y", "24");
		await app.waitFor(/^[^\n]*\bWORKING\b/m);
		await app.waitFor(/Ctrl\+C.*cancel/i);
		await app.key("C-c");
		await expect
			.poll(async () => (await requests(app)).filter((request) => request.type === "cancel"), { timeout: 8000 })
			.toHaveLength(1);
		await app.waitFor(/^[^\n]*\bREADY\b/m);
		if (columns < 64) await app.waitFor(/Ctrl\+C exit/);
		await app.key("C-c");
		await app.restored(0);
		expect((await requests(app)).filter((request) => request.type === "cancel")).toHaveLength(1);
	});

	it("keeps multiline pasted drafts editable and submits only after Enter", async () => {
		const app = await attached();
		await app.text("\x1b[200~first line\nsecond line\x1b[201~");
		await app.waitFor("first line");
		expect(await app.screen()).toContain("second line");
		expect((await requests(app)).filter((request) => request.type === "send")).toHaveLength(0);
		await app.key("Enter");
		await app.waitFor("Fixture answer received.");
		expect((await requests(app)).find((request) => request.type === "send")?.prompt).toBe("first line\nsecond line");
		await app.key("C-d");
		await app.restored(0);
	});

	it("renders actionable errors in monochrome without removing the composer or footer", async () => {
		const app = await attached(false, true);
		await app.text("fail");
		await app.key("Enter");
		const failed = await app.waitFor("Fixture provider unavailable");
		expect(failed).toMatch(/Error/);
		expect(failed).toMatch(/Enter.*send/i);
		expect(failed).toMatch(/Ctrl\+D.*detach/i);
		await app.text("recovery draft");
		await app.waitFor("recovery draft");
		await app.key("C-d");
		await app.restored(0);
		expect(await app.output()).not.toMatch(/\x1b\[(?:3[0-9]|9[0-7])m/);
	});
});
