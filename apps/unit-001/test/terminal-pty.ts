// Drives a built command through a real isolated tmux terminal for UI acceptance tests.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

const execute = promisify(execFile);
const binary = resolve(import.meta.dirname, "../dist/bin.js");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export class TerminalSession {
	readonly directory: string;
	readonly socket: string;
	readonly data: string;
	readonly raw: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly command: readonly string[];
	readonly ready: string;

	constructor(directory: string, command: readonly string[] = [binary, "setup"], ready = "Choose a provider") {
		this.directory = directory;
		this.command = command;
		this.ready = ready;
		this.socket = `unit-terminal-${process.pid}-${randomUUID().slice(0, 8)}`;
		this.data = join(directory, "state");
		this.raw = join(directory, "terminal-output.log");
		// The child must never inherit a developer's provider credentials or OAuth configuration.
		this.environment = {
			PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
			HOME: directory,
			TERM: "xterm-256color",
			TMUX_TMPDIR: "/tmp",
			LANG: "en_US.UTF-8",
		};
	}

	async tmux(...args: string[]): Promise<string> {
		const result = await execute("tmux", ["-L", this.socket, "-f", "/dev/null", ...args], {
			env: this.environment,
			timeout: 5000,
			maxBuffer: 1024 * 1024,
		});
		return result.stdout;
	}

	async start(columns = 80, rows = 24, monochrome = false): Promise<void> {
		const command = [
			"before=$(stty -g)",
			`env -i PATH=${quote(this.environment.PATH ?? "")} HOME=${quote(this.directory)} TERM=xterm-256color LANG=en_US.UTF-8 UNIT_001_HOME=${quote(this.data)}${monochrome ? " NO_COLOR=1" : ""} ${quote(process.execPath)} ${this.command.map(quote).join(" ")}`,
			"result=$?",
			"after=$(stty -g)",
			'if [ "$before" = "$after" ]; then restored=yes; else restored=no; fi',
			'printf "\\n__PTY_EXIT:%s__ __TTY_RESTORED:%s__\\n" "$result" "$restored"',
			"sleep 300",
		].join("; ");
		await this.tmux(
			"new-session",
			"-d",
			"-s",
			"setup",
			"-x",
			String(columns),
			"-y",
			String(rows),
			"-c",
			this.directory,
			command,
		);
		await this.waitFor(this.ready);
		await this.tmux("pipe-pane", "-t", "setup", `cat > ${quote(this.raw)}`);
	}

	async screen(): Promise<string> {
		return this.tmux("capture-pane", "-t", "setup", "-p");
	}

	async waitFor(expected: string | RegExp): Promise<string> {
		let latest = "";
		const assertion = expect.poll(
			async () => {
				latest = await this.screen();
				return latest;
			},
			{ timeout: 8000, interval: 40, message: `Expected terminal screen to contain ${String(expected)}` },
		);
		if (typeof expected === "string") await assertion.toContain(expected);
		else await assertion.toMatch(expected);
		return latest;
	}

	async text(value: string): Promise<void> {
		await this.tmux("send-keys", "-t", "setup", "-l", "--", value);
	}

	async key(value: string): Promise<void> {
		await this.tmux("send-keys", "-t", "setup", value);
	}

	async secret(): Promise<void> {
		await this.text("openrouter");
		await this.waitFor("openrouter");
		await this.key("Enter");
		await this.waitFor("Sign in to");
		await this.key("Enter");
		await this.waitFor("Enter an API key");
	}

	async output(): Promise<string> {
		return readFile(this.raw, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
	}

	async restored(code: number): Promise<void> {
		await this.waitFor(`__PTY_EXIT:${code}__ __TTY_RESTORED:yes__`);
		expect((await this.tmux("display-message", "-t", "setup", "-p", "#{alternate_on} #{cursor_flag}")).trim()).toBe(
			"0 1",
		);
	}
}
