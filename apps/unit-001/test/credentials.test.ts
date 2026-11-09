import { spawn } from "node:child_process";
import fs, { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "../src/credentials.ts";

const fixture = fileURLToPath(new URL("./fixtures/increment.ts", import.meta.url));
let directory: string;
let file: string;
let store: FileCredentialStore;
const platform = process.platform;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-credentials-"));
	file = join(directory, "nested", "auth.json");
	store = new FileCredentialStore(file);
});
afterEach(async () => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	Object.defineProperty(process, "platform", { value: platform });
	await rm(directory, { recursive: true, force: true });
});

const oauth = (access: string) => ({ type: "oauth", access, refresh: "r", expires: 1 }) as const;
const key = (value: string) => ({ type: "api_key", key: value }) as const;

describe("FileCredentialStore", () => {
	it("reads nothing from a missing file", async () => {
		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	it("stores, reads, lists, and deletes credentials", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		await store.modify("openai", async () => key("k"));
		expect(await store.read("anthropic")).toEqual(oauth("a"));
		expect(await store.list()).toEqual([
			{ providerId: "anthropic", type: "oauth" },
			{ providerId: "openai", type: "api_key" },
		]);
		await store.delete("anthropic");
		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.read("openai")).toEqual(key("k"));
	});

	it("hands the current credential to modify and keeps it when modify returns nothing", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		const seen: unknown[] = [];
		const result = await store.modify("anthropic", async (current) => {
			seen.push(current);
			return undefined;
		});
		expect(seen).toEqual([oauth("a")]);
		expect(result).toEqual(oauth("a"));
		expect(await store.read("anthropic")).toEqual(oauth("a"));
	});

	it("deleting an absent credential is a no-op and writes nothing", async () => {
		await store.delete("anthropic");
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.platform === "win32")("creates the file readable only by its owner", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
	});

	it("leaves no temporary or lock files behind", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		await store.delete("anthropic");
		expect(await readdir(join(directory, "nested"))).toEqual(["auth.json"]);
	});

	it("refuses a corrupt file and never overwrites it", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		await writeFile(file, "{ not json");
		await expect(store.read("anthropic")).rejects.toThrow(/not a valid credentials file/);
		await expect(store.modify("openai", async () => key("k"))).rejects.toThrow(/not a valid credentials file/);
		expect(await readFile(file, "utf8")).toBe("{ not json");
	});

	it("refuses a file of the wrong shape", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		for (const content of ["[]", '"text"', '{"anthropic": {"type": "token"}}', '{"anthropic": 1}']) {
			await writeFile(file, content);
			await expect(store.read("anthropic")).rejects.toThrow(/not a valid credentials file/);
		}
	});

	it("reads a file saved with a byte order mark", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		await writeFile(file, `﻿${JSON.stringify({ anthropic: oauth("b") })}`);
		expect(await store.read("anthropic")).toEqual(oauth("b"));
	});

	it("does not write when the operation is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(store.modify("anthropic", async () => oauth("a"), { signal: controller.signal })).rejects.toThrow();
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not save a result when the operation aborts while it runs", async () => {
		const controller = new AbortController();
		await expect(
			store.modify(
				"anthropic",
				async () => {
					controller.abort();
					return oauth("a");
				},
				{ signal: controller.signal },
			),
		).rejects.toThrow();
		expect(await store.read("anthropic")).toBeUndefined();
	});

	it("serializes concurrent writes in one process", async () => {
		await Promise.all(
			Array.from({ length: 20 }, () =>
				store.modify("counter", async (current) =>
					key(String(Number(current?.type === "api_key" ? current.key : 0) + 1)),
				),
			),
		);
		expect(await store.read("counter")).toEqual(key("20"));
	});

	it("keeps working after an operation fails", async () => {
		await expect(
			store.modify("anthropic", async () => {
				throw new Error("refresh failed");
			}),
		).rejects.toThrow("refresh failed");
		await store.modify("anthropic", async () => oauth("a"));
		expect(await store.read("anthropic")).toEqual(oauth("a"));
	});

	it("takes over a lock left by a process that died", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		const lock = `${file}.lock`;
		await writeFile(lock, "");
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(lock, old, old);
		await store.modify("openai", async () => key("k"));
		expect(await store.read("openai")).toEqual(key("k"));
	});

	it("serializes writes across processes", async () => {
		const processes = 4;
		const each = 15;
		await Promise.all(
			Array.from(
				{ length: processes },
				() =>
					new Promise<void>((resolve, reject) => {
						const child = spawn(process.execPath, [fixture, file, String(each)], {
							stdio: ["ignore", "ignore", "pipe"],
						});
						let stderr = "";
						child.stderr.on("data", (chunk) => {
							stderr += chunk;
						});
						child.once("exit", (status) =>
							status === 0 ? resolve() : reject(new Error(`child failed: ${stderr}`)),
						);
					}),
			),
		);
		// A lost update would leave the total below 60.
		expect(await store.read("counter")).toEqual(key(String(processes * each)));
	}, 60_000);

	// Regression observed in PR #38's Windows cross-process credentials gate.
	it.each(["EPERM", "EBUSY"])(
		"retries transient Windows lock creation %s without entering early",
		async (errorCode) => {
			Object.defineProperty(process, "platform", { value: "win32" });
			const original = fs.open;
			let attempts = 0;
			let entered = false;
			vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				if (args[0] === `${file}.lock` && ++attempts <= 2) {
					expect(entered).toBe(false);
					throw Object.assign(new Error("lock temporarily unavailable"), { code: errorCode });
				}
				return original(...args);
			});
			syncBuiltinESMExports();
			await store.modify("counter", async () => {
				entered = true;
				return key("1");
			});
			expect(attempts).toBe(3);
			expect(await store.read("counter")).toEqual(key("1"));
		},
	);

	it("bounds Windows permission retries and preserves the first denial", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		const denied = Object.assign(new Error("permanent permission denial"), { code: "EPERM" });
		const opened = vi
			.spyOn(fs, "open")
			.mockRejectedValueOnce(denied)
			.mockRejectedValue(Object.assign(new Error("later denial"), { code: "EPERM" }));
		const unlink = vi.spyOn(fs, "unlink");
		syncBuiltinESMExports();
		const mutate = vi.fn(async () => key("1"));
		await expect(store.modify("counter", mutate)).rejects.toBe(denied);
		expect(opened).toHaveBeenCalledTimes(6);
		expect(mutate).not.toHaveBeenCalled();
		expect(unlink).not.toHaveBeenCalled();
	});

	it("retains the lock deadline during Windows create retries", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_000);
		const denied = Object.assign(new Error("permission denied at deadline"), { code: "EPERM" });
		const opened = vi.spyOn(fs, "open").mockRejectedValue(denied);
		syncBuiltinESMExports();
		await expect(store.modify("counter", async () => key("1"))).rejects.toBe(denied);
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it("does not retry unrelated Windows access errors", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
		const opened = vi.spyOn(fs, "open").mockRejectedValue(denied);
		syncBuiltinESMExports();
		await expect(store.modify("counter", async () => key("1"))).rejects.toBe(denied);
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it("does not retry POSIX permission denial", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
		const opened = vi.spyOn(fs, "open").mockRejectedValue(denied);
		syncBuiltinESMExports();
		await expect(store.modify("counter", async () => key("1"))).rejects.toBe(denied);
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it("aborts a Windows lock retry without admitting the mutation", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		const controller = new AbortController();
		const aborted = new Error("cancel lock wait");
		const opened = vi.spyOn(fs, "open").mockImplementation(async () => {
			controller.abort(aborted);
			throw Object.assign(new Error("pending deletion"), { code: "EPERM" });
		});
		syncBuiltinESMExports();
		const mutate = vi.fn(async () => key("1"));
		await expect(store.modify("counter", mutate, { signal: controller.signal })).rejects.toThrow(
			/cancel lock wait|aborted/,
		);
		expect(opened).toHaveBeenCalledTimes(1);
		expect(mutate).not.toHaveBeenCalled();
	});
});
