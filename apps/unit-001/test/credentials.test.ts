import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(async () => {
	vi.restoreAllMocks();
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

	it.skipIf(process.platform === "win32")("keeps the credentials file and lock path private", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
		expect((await stat(`${file}.lock.d`)).mode & 0o777).toBe(0o700);
	});

	it("keeps the persistent lock but leaves no temporary files after a write", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		await store.delete("anthropic");
		expect((await readdir(join(directory, "nested"))).sort()).toEqual(["auth.json", "auth.json.lock.d"]);
		expect(await readdir(`${file}.lock.d`)).toEqual(["owner.sqlite"]);
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

	it("refuses entries missing the fields the auth layer reads, and never overwrites the file", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		const invalid = [
			{ anthropic: { type: "oauth" } },
			{ anthropic: { type: "oauth", access: "a", refresh: "r" } },
			{ anthropic: { type: "oauth", access: "a", refresh: 1, expires: 1 } },
			{ anthropic: { type: "oauth", access: "a", refresh: "r", expires: "soon" } },
			{ anthropic: { type: "api_key", key: 7 } },
			{ anthropic: { type: "api_key", key: "k", env: { ACCOUNT: 1 } } },
			{ anthropic: { type: "api_key", key: "k", env: ["x"] } },
		];
		for (const entries of invalid) {
			const content = JSON.stringify(entries);
			await writeFile(file, content);
			await expect(store.list()).rejects.toThrow(/not a valid credentials file/);
			await expect(store.modify("openai", async () => key("k"))).rejects.toThrow(/not a valid credentials file/);
			expect(await readFile(file, "utf8")).toBe(content);
		}
	});

	it("accepts an api key with provider environment, a keyless api_key entry and extra OAuth fields", async () => {
		const entries = {
			cloudflare: { type: "api_key", key: "k", env: { ACCOUNT: "a" } },
			local: { type: "api_key" },
			anthropic: { ...oauth("a"), accountId: "acct" },
		};
		await mkdir(join(directory, "nested"));
		await writeFile(file, JSON.stringify(entries));
		expect(await store.list()).toHaveLength(3);
		expect(await store.read("anthropic")).toEqual(entries.anthropic);
	});

	it("removes its temporary file when the write fails before the rename", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		const circular: Record<string, unknown> = { ...oauth("b") };
		circular.self = circular;
		await expect(store.modify("anthropic", async () => circular as unknown as Credential)).rejects.toThrow();
		expect((await readdir(join(directory, "nested"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(await store.read("anthropic")).toEqual(oauth("a"));
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

	it("serializes concurrent writes through different store instances in one process", async () => {
		const secondStore = new FileCredentialStore(file);
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				(index % 2 === 0 ? store : secondStore).modify("counter", async (current) =>
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

	it("refuses an old legacy marker until the operator removes it", async () => {
		await store.modify("anthropic", async () => oauth("a"));
		const original = await readFile(file, "utf8");
		const legacy = `${file}.lock`;
		await writeFile(legacy, "");
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(legacy, old, old);
		const mutate = vi.fn(async () => key("k"));
		await expect(store.modify("openai", mutate)).rejects.toThrow(/Stop all older unit-001 processes/);
		expect(mutate).not.toHaveBeenCalled();
		expect(await readFile(legacy, "utf8")).toBe("");
		expect(await readFile(file, "utf8")).toBe(original);
		await rm(legacy);
		await expect(store.modify("openai", mutate)).resolves.toEqual(key("k"));
	});

	it("bounds contention, honors cancellation, and recovers when the owning process dies", async () => {
		await store.modify("counter", async () => key("1"));
		const original = await readFile(file, "utf8");
		const child = fork(fixture, [file, "hold"], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
		const exited = once(child, "exit");
		try {
			const [message] = await Promise.race([once(child, "message"), exited]);
			expect(message).toBe("LOCKED");

			const mutate = vi.fn(async () => key("2"));
			await expect(store.modify("counter", mutate, { signal: AbortSignal.timeout(100) })).rejects.toThrow(
				/aborted|timeout/i,
			);
			await expect(store.modify("counter", mutate)).rejects.toThrow(/Timed out waiting for the credentials lock/);
			expect(mutate).not.toHaveBeenCalled();
			expect(await readFile(file, "utf8")).toBe(original);

			expect(child.kill("SIGKILL")).toBe(true);
			await exited;
			expect(await readFile(file, "utf8")).toBe(original);
			await expect(store.modify("counter", mutate)).resolves.toEqual(key("2"));
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		}
	}, 45_000);

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
