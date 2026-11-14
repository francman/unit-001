// #55: Explicit acceptance test; requires the disposable SSH fixture, never a production installation.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { TerminalSession } from "./terminal-pty.ts";

it("#55 keeps the actual remote editor through disconnect and resize, then restores the terminal on detach", async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-remote-pty-"));
	const launch = fileURLToPath(new URL("./fixtures/remote-terminal-launch.mjs", import.meta.url));
	const terminal = new TerminalSession(directory, [launch], "default@fixture");
	const docker = (...args: string[]) =>
		execFileSync("docker", ["exec", "unit-remote-ssh-20261111", ...args], { encoding: "utf8", timeout: 5_000 });
	try {
		docker("node", "-e", 'require("fs").writeFileSync("/home/owner/state/release", "ready")');
		await terminal.start();
		await terminal.text("preserved remote draft");
		await terminal.waitFor("preserved remote draft");
		docker(
			"node",
			"-e",
			'const f=require("fs");process.kill(Number(f.readFileSync("/tmp/remote-sshd.pid")),"SIGSTOP")',
		);
		docker("pkill", "-u", "0", "-x", "ssh");
		await terminal.waitFor("CONNECTING");
		expect(await terminal.screen()).toContain("preserved remote draft");
		await terminal.tmux("resize-window", "-t", "setup", "-x", "40", "-y", "12");
		expect(await terminal.screen()).toContain("preserved remote draft");
		docker(
			"node",
			"-e",
			'const f=require("fs");process.kill(Number(f.readFileSync("/tmp/remote-sshd.pid")),"SIGCONT")',
		);
		await terminal.waitFor("READY");
		expect(await terminal.screen()).toContain("preserved remote draft");
		await terminal.key("Enter");
		await terminal.waitFor("Remote faux answer received.");
		await terminal.key("C-d");
		await terminal.restored(0);
		const status = docker("node", "/repo/apps/unit-001/dist/bin.js", "remote", "status", "fixture");
		expect(JSON.parse(status)).toMatchObject({ type: "status", busy: false });
	} finally {
		docker(
			"node",
			"-e",
			'const f=require("fs");process.kill(Number(f.readFileSync("/tmp/remote-sshd.pid")),"SIGCONT")',
		);
		await terminal.tmux("kill-server").catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

it("#55 prints a pending retry ID after detaching while the actual remote owner continues", async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-remote-pending-pty-"));
	const launch = fileURLToPath(new URL("./fixtures/remote-terminal-launch.mjs", import.meta.url));
	const terminal = new TerminalSession(directory, [launch], "default@fixture");
	const docker = (...args: string[]) =>
		execFileSync("docker", ["exec", "unit-remote-ssh-20261111", ...args], { encoding: "utf8", timeout: 5_000 });
	try {
		docker("node", "-e", 'require("fs").rmSync("/home/owner/state/release", {force:true})');
		await terminal.start();
		await terminal.text("hold-until-released after pending detach");
		await terminal.key("Enter");
		await terminal.waitFor("WORKING");
		await terminal.key("C-d");
		await terminal.restored(0);
		expect(await terminal.screen()).toMatch(/Unconfirmed request ID [0-9a-f-]{36}/);
		const status = docker("node", "/repo/apps/unit-001/dist/bin.js", "remote", "status", "fixture");
		expect(JSON.parse(status)).toMatchObject({ type: "status", busy: true });
	} finally {
		docker("node", "-e", 'require("fs").writeFileSync("/home/owner/state/release", "ready")');
		await terminal.tmux("kill-server").catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
