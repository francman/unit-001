import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Runtime } from "../src/cli.ts";

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
		expect(run.out()).toContain("Usage: u1");
	});

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
		expect(run.err()).toContain("u1 --help");
	});

	it("exits 1 and says how to configure a provider when none is set", async () => {
		const run = runtime({});
		expect(await main(["-p", "hi"], run.runtime, signal)).toBe(1);
		expect(run.err()).toContain("No model provider is configured");
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

describe("package", () => {
	it("installs the command as u1, with unit-001 as an alias", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			bin: Record<string, string>;
		};
		expect(manifest.bin).toEqual({ u1: "./dist/bin.js", "unit-001": "./dist/bin.js" });
	});
});
