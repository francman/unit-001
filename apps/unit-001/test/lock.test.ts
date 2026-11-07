import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/errors.ts";
import { acquireSessionLock } from "../src/lock.ts";

let directory: string;
let path: string;
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-lock-"));
	path = join(directory, "default.sqlite.lock");
});
afterEach(async () => {
	await Promise.all(
		children.splice(0).map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
					child.kill("SIGKILL");
				}),
		),
	);
	await rm(directory, { recursive: true, force: true });
});

function contender() {
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/lock-holder.ts", import.meta.url)), path]);
	children.push(child);
	let output = "";
	let errors = "";
	child.stderr.on("data", (chunk) => {
		errors += String(chunk);
	});
	const outcome = new Promise<string>((resolve, reject) => {
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			if (output.includes("LOCKED")) resolve("LOCKED");
			else if (output.includes("BUSY")) resolve("BUSY");
		});
		child.once("exit", () => {
			if (!output.includes("LOCKED") && !output.includes("BUSY")) reject(new Error(errors));
		});
	});
	return { child, outcome };
}

describe("acquireSessionLock", () => {
	it("refuses a second holder and can be taken after idempotent release", async () => {
		const release = await acquireSessionLock(path);
		await expect(acquireSessionLock(path)).rejects.toThrow(ConfigurationError);
		await expect(acquireSessionLock(path)).rejects.toThrow(/already running/);
		await release();
		await release();
		await (await acquireSessionLock(path))();
	});

	it("grants exactly one simultaneous process ownership and recovers after its crash", async () => {
		const contenders = Array.from({ length: 6 }, () => contender());
		for (const { child } of contenders) child.stdin.write("go\n");
		const results = await Promise.all(contenders.map(({ outcome }) => outcome));
		expect(results.filter((result) => result === "LOCKED")).toHaveLength(1);
		await expect(acquireSessionLock(path)).rejects.toThrow(/already running/);
		const winner = contenders[results.indexOf("LOCKED")].child;
		const exited = new Promise<void>((resolve) => winner.once("exit", () => resolve()));
		winner.kill("SIGKILL");
		await exited;
		await (await acquireSessionLock(path))();
	});

	it.each(["not a database", `${process.pid}\n`])(
		"preserves an old or malformed lock and explains how to recover",
		async (contents) => {
			await writeFile(path, contents);
			await expect(acquireSessionLock(path)).rejects.toThrow(/Stop all unit-001 processes/);
			expect(await readFile(path, "utf8")).toBe(contents);
		},
	);
});
