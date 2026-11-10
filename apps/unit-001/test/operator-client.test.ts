// Issue #33: an installed operator client must never enter private storage or configuration paths.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const scenarios = [
	{ name: "public help", args: ["--help"], result: "help" },
	{ name: "public version", args: ["--version"], result: "version" },
	{ name: "setup denial", args: ["setup"], result: "denied" },
	{ name: "login denial", args: ["login", "anthropic"], result: "denied" },
	{ name: "logout denial", args: ["logout", "anthropic"], result: "denied" },
	{ name: "owner startup denial", args: ["serve"], result: "denied" },
	{ name: "model override denial", args: ["--model", "faux/faux-1"], result: "denied" },
	{ name: "foreground prompt denial", args: ["-p", "do not submit"], result: "denied" },
	{ name: "private directory override denial", args: ["service-status", "--data-dir"], result: "denied" },
] as const;

// #33: separate cold processes so their aggregate startup cannot exhaust one shared 5 s deadline.
it.each(scenarios)(
	"operator client $name outside the private workspace",
	async (scenario) => {
		const cwd = await mkdtemp(join(tmpdir(), "unit-operator-client-"));
		const id = "11111111-1111-4111-8111-111111111111";
		const entry = fileURLToPath(new URL("../dist/named.js", import.meta.url));
		try {
			const args = scenario.name === "private directory override denial" ? [...scenario.args, cwd] : scenario.args;
			const result = spawnSync(
				process.execPath,
				[entry, id, "bob", `/var/lib/unit-001/agents/${id}`, "--operator", ...args],
				{
					cwd,
					encoding: "utf8",
					timeout: 10000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			if (scenario.result === "denied") {
				expect(result.status).not.toBe(0);
				expect(result.stderr).toMatch(/administrator command|cannot change their data directory/);
				expect(result.stderr).not.toMatch(/ENOENT|workspace|auth.json/);
			} else {
				expect(result.status).toBe(0);
				if (scenario.result === "help") expect(result.stdout).toContain("Usage: bob");
				else expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
	15000,
);
