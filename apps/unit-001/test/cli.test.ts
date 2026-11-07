import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Runtime } from "../src/cli.ts";
import { serviceEndpoint } from "../src/service.ts";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "unit-001-cli-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

function sink() {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk.toString());
			callback();
		},
	});
	return { stream, text: () => chunks.join("") };
}

function runtime(env: Record<string, string>, stdin = ""): { runtime: Runtime; out: () => string; err: () => string } {
	const out = sink();
	const err = sink();
	const input = new PassThrough();
	input.end(stdin);
	return {
		runtime: {
			env: { UNIT_001_HOME: join(home, "data"), ...env },
			platform: process.platform,
			home,
			cwd: home,
			stdin: input,
			stdout: out.stream,
			stderr: err.stream,
			interactive: false,
		},
		out: out.text,
		err: err.text,
	};
}

const signal = new AbortController().signal;

describe("main", () => {
	it("prints help and exits 0", async () => {
		const run = runtime({});
		expect(await main(["--help"], run.runtime, signal)).toBe(0);
		expect(run.out()).toContain("Usage: agent");
		expect(run.out()).toContain("agent attach");
	});

	it("rejects attach in scripts before opening a service, credentials, or storage", async () => {
		// #21: socket chat is explicitly interactive; automation retains send's final-answer contract.
		const run = runtime({});
		expect(await main(["attach"], run.runtime, signal)).toBe(2);
		expect(run.err()).toContain("Use agent send");
		const custom = runtime({});
		expect(
			await main(["attach"], { ...custom.runtime, managed: { id: "test", name: "bob", state: home } }, signal),
		).toBe(2);
		expect(custom.err()).toContain("Use bob send");
	});

	it.skipIf(process.platform === "win32")(
		"attaches without loading credentials or opening the owner's SQLite file",
		async () => {
			// #21: interactive clients must remain usable while the service owns storage and provider credentials.
			const directory = join(home, "data");
			await mkdir(join(directory, "control"), { recursive: true });
			await writeFile(join(directory, "auth.json"), "invalid credentials that the client must never read");
			await writeFile(join(directory, "work.sqlite"), "owner-only database");
			const input = new PassThrough();
			const run = runtime({});
			const controller = new AbortController();
			const server = createServer((socket) => {
				socket.once("data", (wire) => {
					expect(JSON.parse(String(wire))).toEqual({ type: "watch" });
					socket.write(
						`${JSON.stringify({
							type: "view",
							view: {
								pid: process.pid,
								version: "fixture",
								name: "bob",
								installationId: "test-id",
								entries: [],
						model: null,
						usage: null,
								busy: false,
								text: "",
								textTruncated: false,
								tools: [],
								historyTruncated: false,
							},
						})}\n`,
					);
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(serviceEndpoint(directory, "work", process.platform), resolve),
			);
			try {
				const running = main(
					["attach", "--session", "work"],
					{ ...run.runtime, stdin: input, interactive: true },
					controller.signal,
				);
				await expect.poll(run.err).toContain("Attached to bob");
				input.end("/status\n/exit\n");
				expect(await running).toBe(0);
				expect(run.err()).toContain("session work");
				expect(await readFile(join(directory, "work.sqlite"), "utf8")).toBe("owner-only database");
				expect((await readdir(directory)).sort()).toEqual(["auth.json", "control", "work.sqlite"]);
			} finally {
				controller.abort();
				input.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);

	it("prints the package version", async () => {
		const run = runtime({});
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			version: string;
		};
		expect(await main(["--version"], run.runtime, signal)).toBe(0);
		expect(run.out().trim()).toBe(manifest.version);
	});

	it("exits 2 with a hint on a usage error", async () => {
		const run = runtime({});
		expect(await main(["--bogus"], run.runtime, signal)).toBe(2);
		expect(run.err()).toContain("Unknown option: --bogus");
		expect(run.err()).toContain("agent --help");
	});

	it("exits 1 and says how to configure a provider when none is set", async () => {
		const run = runtime({});
		expect(await main(["-p", "hi"], run.runtime, signal)).toBe(1);
		expect(run.err()).toContain("No model provider is configured");
	});

	it("lists how each provider is configured, without printing secrets", async () => {
		const run = runtime({ OPENAI_API_KEY: "sk-secret-value" });
		expect(await main(["status"], run.runtime, signal)).toBe(0);
		expect(run.out()).toContain("openai      API key from OPENAI_API_KEY");
		expect(run.out()).toContain("anthropic   not configured");
		expect(run.out()).not.toContain("secret");
	});

	it("rejects an unknown provider for login with a usage error", async () => {
		const run = runtime({});
		expect(await main(["login", "nowhere"], run.runtime, signal)).toBe(2);
		expect(run.err()).toContain('Unknown provider "nowhere". Choose one of: anthropic, openai.');
	});

	it("logout says when there is nothing to remove, and leaves no credentials file", async () => {
		const run = runtime({});
		expect(await main(["logout", "anthropic"], run.runtime, signal)).toBe(0);
		expect(run.err()).toContain("Not signed in to anthropic.");
	});

	it("exits 1 for an unknown model", async () => {
		const run = runtime({ ANTHROPIC_API_KEY: "k" });
		expect(await main(["--model", "anthropic/nope", "-p", "hi"], run.runtime, signal)).toBe(1);
		expect(run.err()).toContain("not in the anthropic catalog");
	});

	it("exits 2 for an invalid session name before touching the disk", async () => {
		const run = runtime({ ANTHROPIC_API_KEY: "k" });
		expect(await main(["--session", "../x", "-p", "hi"], run.runtime, signal)).toBe(2);
		expect(run.err()).toContain("Invalid session name");
	});

	it("exits 2 when the prompt read from standard input is empty", async () => {
		const run = runtime({ ANTHROPIC_API_KEY: "k" }, "  \n");
		expect(await main(["-p", "-"], run.runtime, signal)).toBe(2);
		expect(run.err()).toContain("The prompt is empty");
	});

	it("exits 130 when stopped by a signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const run = runtime({});
		expect(await main(["-p", "hi"], run.runtime, controller.signal)).toBe(130);
	});

	it.skipIf(process.platform === "win32")(
		"serves after stdin EOF, accepts local controls, and shuts down successfully",
		async () => {
			const owner = runtime({ OPENAI_API_KEY: "not-used-by-this-test" });
			const controller = new AbortController();
			const running = main(["serve"], owner.runtime, controller.signal);
			try {
				await expect.poll(owner.err).toContain("service ready");
				const control = runtime({});
				expect(await main(["service-status"], control.runtime, signal)).toBe(0);
				const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
					version: string;
				};
				expect(JSON.parse(control.out())).toMatchObject({
					type: "status",
					version: manifest.version,
					pid: process.pid,
					busy: false,
				});
				const competing = runtime({ OPENAI_API_KEY: "not-used-by-this-test" });
				expect(await main(["serve"], competing.runtime, signal)).toBe(1);
				expect(competing.err()).toContain("already running");
				const cancel = runtime({});
				expect(await main(["cancel"], cancel.runtime, signal)).toBe(0);
				expect(JSON.parse(cancel.out())).toEqual({ type: "cancelled" });
			} finally {
				controller.abort();
				expect(await running).toBe(0);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"sends leading-hyphen prompts and literal help through the CLI",
		async () => {
			const directory = join(home, "data");
			await mkdir(join(directory, "control"), { recursive: true });
			const received: unknown[] = [];
			const server = createServer((socket) => {
				let buffer = "";
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => {
					buffer += chunk;
					const newline = buffer.indexOf("\n");
					if (newline === -1) return;
					received.push(JSON.parse(buffer.slice(0, newline)));
					socket.end(`${JSON.stringify({ type: "reply", reply: { status: "answered", text: "received" } })}\n`);
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(serviceEndpoint(directory, "work", process.platform), resolve);
			});
			try {
				for (const prompt of ["- explain this failure", "--help"]) {
					const run = runtime({});
					expect(
						await main(["send", "--session", "work", "--request-id", "retry", "--", prompt], run.runtime, signal),
					).toBe(0);
					expect(run.out()).toBe("received\n");
					expect(received.at(-1)).toEqual({ type: "send", prompt, requestId: "retry" });
				}
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error === undefined ? resolve() : reject(error))),
				);
			}
		},
	);
});

describe("built binary", () => {
	const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

	it("starts through node and reports its version", () => {
		const result = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("exits 2 on a usage error", () => {
		const result = spawnSync(process.execPath, [bin, "--bogus"], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Unknown option");
	});
});

describe("named runtime", () => {
	it("uses the installed name in help and rejects conflicting state paths", async () => {
		// #19: named commands bind runtime identity and state rather than the caller environment.
		const run = runtime({});
		const managed = { id: "11111111-1111-1111-1111-111111111111", name: "bob", state: join(home, "bob") };
		const named = { ...run.runtime, managed };
		expect(await main(["--help"], named, signal)).toBe(0);
		expect(run.out()).toContain("Usage: bob");
		expect(await main(["status", "--data-dir", join(home, "other")], named, signal)).toBe(1);
		expect(run.err()).toContain("cannot change its data directory");
	});
	it("fails source lifecycle commands without touching a service", async () => {
		// #20: source commands must not guess installation ownership.
		const run = runtime({});
		expect(await main(["uninstall", "--yes"], run.runtime, signal)).toBe(1);
		expect(run.err()).toContain("require an installed named agent");
	});
});
