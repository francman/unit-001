import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/errors.ts";
import { acquireSessionLock } from "../src/lock.ts";

let directory: string;
let path: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-lock-"));
	path = join(directory, "sessions", "default.sqlite.lock");
});
afterEach(() => rm(directory, { recursive: true, force: true }));

/** The pid of a process that has already exited. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", ""]);
	if (child.pid === undefined) throw new Error("could not spawn a process");
	return child.pid;
}

describe("acquireSessionLock", () => {
	it("creates the lock with this process's pid and removes it on release", async () => {
		const release = await acquireSessionLock(path);
		expect((await readFile(path, "utf8")).trim()).toBe(String(process.pid));
		await release();
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a second holder while the first is alive", async () => {
		const release = await acquireSessionLock(path);
		await expect(acquireSessionLock(path)).rejects.toThrow(ConfigurationError);
		await expect(acquireSessionLock(path)).rejects.toThrow(/already running/);
		await release();
	});

	it("can be taken again after release", async () => {
		await (await acquireSessionLock(path))();
		await (await acquireSessionLock(path))();
	});

	it("takes over a lock whose process is gone", async () => {
		await (await acquireSessionLock(path))();
		await writeFile(path, `${deadPid()}\n`);
		const release = await acquireSessionLock(path);
		expect((await readFile(path, "utf8")).trim()).toBe(String(process.pid));
		await release();
	});

	it("takes over an unreadable or garbage lock", async () => {
		await (await acquireSessionLock(path))();
		await writeFile(path, "not a pid");
		await (await acquireSessionLock(path))();
	});

	it("does not remove the lock of a live owner it cannot take", async () => {
		await (await acquireSessionLock(path))();
		await writeFile(path, `${process.ppid}\n`);
		await expect(acquireSessionLock(path)).rejects.toThrow(/already running/);
		expect((await readFile(path, "utf8")).trim()).toBe(String(process.ppid));
	});
});
