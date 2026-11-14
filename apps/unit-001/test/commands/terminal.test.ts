// #59: Exercises command suggestions in actual isolated terminals without credentials or network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalSession } from "../terminal-pty.ts";

const fixtures: TerminalSession[] = [];
afterEach(async () => {
	for (const app of fixtures.splice(0)) {
		await app.tmux("kill-server").catch(() => {});
		await rm(app.directory, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32")("command suggestions in a real terminal", { timeout: 30000 }, () => {
	it.each([
		[80, 24],
		[40, 12],
	])("preserves operands without execution at %ix%i", async (columns, rows) => {
		const app = new TerminalSession(
			await mkdtemp(join(tmpdir(), "unit-command-pty-")),
			[resolve(import.meta.dirname, "../fixtures/mission-terminal-entry.mjs")],
			"READY",
		);
		fixtures.push(app);
		await app.start(columns, rows);
		await app.text("/memroy private note");
		await app.key("Enter");
		await app.waitFor("Did you mean?");
		await app.key("Enter");
		const selected = await app.waitFor("/memory private note");
		expect(selected).not.toContain("Did you mean?");
		expect(selected).not.toContain("Memory statistics");
		await app.key("C-u");
		await app.key("C-d");
		await app.restored(0);
	});
});
