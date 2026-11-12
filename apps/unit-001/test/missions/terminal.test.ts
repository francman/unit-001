// #14: Mission formation uses the real terminal editor without an account, model call or competing input owner.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe.skipIf(process.platform === "win32")("mission formation in an actual terminal", { timeout: 30000 }, () => {
	it.each([
		[80, 24],
		[40, 12],
	])("saves a goal and returns to the owner at %s×%s", async (columns, rows) => {
		const app = new TerminalSession(
			await mkdtemp(join(tmpdir(), "unit-mission-pty-")),
			[resolve(import.meta.dirname, "../fixtures/mission-terminal-entry.mjs")],
			"READY",
		);
		fixtures.push(app);
		await app.start(columns, rows);
		await app.text("/mission setup");
		await app.key("Enter");
		await app.waitFor("Form your mission");
		const menu = await app.waitFor("Ctrl+C cancel");
		expect(menu).toContain("Search mission fields");
		expect(menu).toContain("Execution: not implemented");
		await app.text("Goal");
		await app.key("Enter");
		await app.waitFor("Enter continue");
		await app.text("Inspect the local fixture");
		const edited = await app.waitFor("Inspect the local fixture");
		await writeFile(join(app.directory, `edited-${columns}.txt`), edited);
		expect(edited.split("\n").length).toBeLessThanOrEqual(rows + 1);
		await app.key("Enter");
		await app.waitFor("Form your mission");
		await app.key("C-c");
		await app.waitFor("Ask agent");
		await app.text("/mission setup");
		await app.key("Enter");
		await app.waitFor("Form your mission");
		await app.text("Goal");
		await app.key("Enter");
		await app.waitFor("Inspect the local fixture");
		await app.key("C-c");
		await app.waitFor("Ask agent");
		await app.key("C-d");
		await app.restored(0);
	});
});
