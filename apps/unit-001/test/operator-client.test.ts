// Issue #33: an installed operator client must never enter private storage or configuration paths.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs public help/version outside the private workspace and denies owner-only entry points", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "unit-operator-client-"));
	const id = "11111111-1111-4111-8111-111111111111";
	const entry = fileURLToPath(new URL("../dist/named.js", import.meta.url));
	const run = (args: string[]) =>
		spawnSync(process.execPath, [entry, id, "bob", `/var/lib/unit-001/agents/${id}`, "--operator", ...args], {
			cwd,
			encoding: "utf8",
			timeout: 10000,
		});
	try {
		const help = run(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage: bob");
		expect(run(["--version"]).status).toBe(0);
		for (const args of [
			["setup"],
			["login", "anthropic"],
			["logout", "anthropic"],
			["serve"],
			["--model", "faux/faux-1"],
			["-p", "do not submit"],
			["service-status", "--data-dir", cwd],
		]) {
			const result = run(args);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toMatch(/administrator command|cannot change their data directory/);
			expect(result.stderr).not.toMatch(/ENOENT|workspace|auth.json/);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
