import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/credentials.ts";

const fixture = fileURLToPath(new URL("./fixtures/increment.ts", import.meta.url));
let directory: string;
let file: string;
let store: FileCredentialStore;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-credentials-"));
	file = join(directory, "nested", "auth.json");
	store = new FileCredentialStore(file);
});
afterEach(() => rm(directory, { recursive: true, force: true }));

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
});
