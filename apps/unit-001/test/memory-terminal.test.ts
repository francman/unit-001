// Issues #6–#9: real owner memory controls remain usable in a real terminal without provider calls.
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalSession } from "./terminal-pty.ts";

const fixtures: TerminalSession[] = [];
afterEach(async () => {
	for (const app of fixtures.splice(0)) {
		await app.tmux("kill-server").catch(() => {});
		await rm(app.directory, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32")("memory controls in a real terminal", { timeout: 30000 }, () => {
	it("stores, recalls, confirms forgetting and restores the actual foreground terminal", async () => {
		const app = new TerminalSession(
			await mkdtemp("/tmp/unit-memory-pty-"),
			[resolve(import.meta.dirname, "fixtures/source-terminal-entry.mjs")],
			"gpt-5",
		);
		fixtures.push(app);
		await app.start();
		await app.text("/status");
		await app.key("Enter");
		const status = await app.waitFor("observed");
		expect(status).toMatch(/PID \d+/);
		expect(status).toContain("started");
		expect(status).toMatch(/uptime \d+s/);
		await app.text("/memory stats");
		await app.key("Enter");
		await app.waitFor("0 working");
		await app.text("/memory remember redis terminal preference");
		await app.key("Enter");
		const remembered = await app.waitFor("Remembered memory:operator:");
		const id = remembered.match(/memory:operator:[a-f0-9-]+/u)?.[0];
		expect(id).toBeDefined();
		await app.text("/memory recall redis");
		await app.key("Enter");
		await app.waitFor("[user/working]");
		await app.text(`/memory forget ${id}`);
		await app.key("Enter");
		await app.waitFor(/confirm|yes|y\/N/i);
		await app.text("yes");
		await app.key("Enter");
		await app.waitFor("dependent summaries are invalidated");
		await app.text("/memory recall redis");
		await app.key("Enter");
		await app.waitFor("No matching session memories");
		await app.key("C-d");
		await app.restored(0);
	});
});
