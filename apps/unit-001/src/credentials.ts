import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type Entries = Record<string, Credential>;

const LOCK_POLL_MS = 25;
/** Longer than a token refresh (15 s), which runs while the lock is held. */
const LOCK_WAIT_MS = 30_000;
const RENAME_RETRIES = 5;

function code(error: unknown): string | undefined {
	return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The file is a trust boundary (hand-edited, restored, or written by an older version), so every field the auth layer
// reads is checked here once; callers get typed credentials and never re-check them.
function isCredential(value: unknown): value is Credential {
	if (!isRecord(value)) return false;
	if (value.type === "api_key") {
		const { key, env } = value;
		return (
			(key === undefined || typeof key === "string") &&
			(env === undefined || (isRecord(env) && Object.values(env).every((entry) => typeof entry === "string")))
		);
	}
	return (
		value.type === "oauth" &&
		typeof value.refresh === "string" &&
		typeof value.access === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function isEntries(value: unknown): value is Entries {
	return isRecord(value) && Object.values(value).every(isCredential);
}

/**
 * Credentials in one JSON file, readable only by their owner (mode 0600 on POSIX; Windows uses the profile
 * directory's access rules). Every write is a locked read-modify-write, in this process and across processes, and
 * replaces the file atomically, so a crash never leaves a half-written file. A file that is not valid is an error,
 * never silently replaced.
 */
export class FileCredentialStore implements CredentialStore {
	readonly #path: string;
	readonly #lockPath: string;

	constructor(path: string) {
		this.#path = path;
		this.#lockPath = join(`${path}.lock.d`, "owner.sqlite");
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return (await this.#load())[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(await this.#load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#exclusive(async () => {
			const entries = await this.#load();
			const current = entries[providerId];
			const next = await fn(current);
			options?.signal?.throwIfAborted();
			if (next === undefined) return current;
			await this.#save({ ...entries, [providerId]: next });
			return next;
		}, options);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#exclusive(async () => {
			const { [providerId]: removed, ...rest } = await this.#load();
			if (removed !== undefined) await this.#save(rest);
		}, options);
	}

	async #load(): Promise<Entries> {
		let text: string;
		try {
			text = await readFile(this.#path, "utf8");
		} catch (error) {
			if (code(error) === "ENOENT") return {};
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.replace(/^﻿/, ""));
		} catch {
			parsed = undefined;
		}
		if (!isEntries(parsed)) {
			throw new Error(`${this.#path} is not a valid credentials file. Fix it or delete it, then sign in again.`);
		}
		return parsed;
	}

	async #save(entries: Entries): Promise<void> {
		const temporary = `${this.#path}.${randomUUID()}.tmp`;
		// Every failure from creating the temporary file to the final rename removes it; it can hold credentials.
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(entries, null, "\t")}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			// Windows can refuse to replace a file that a scanner or indexer has open for a moment.
			for (let attempt = 0; ; attempt++) {
				try {
					await rename(temporary, this.#path);
					return;
				} catch (error) {
					if (attempt >= RENAME_RETRIES || !["EPERM", "EBUSY", "EACCES"].includes(code(error) ?? "")) throw error;
					await sleep(LOCK_POLL_MS * (attempt + 1));
				}
			}
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
	}

	/** Hold a process-owned lock across the entire read-modify-write; never unlink its inode. */
	async #exclusive<T>(task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const signal = options?.signal;
		signal?.throwIfAborted();
		const deadline = performance.now() + LOCK_WAIT_MS;
		// The private directory lets SQLite create and open the inode itself: closing a separate
		// file descriptor could release this process's existing lock on POSIX.
		await mkdir(dirname(this.#lockPath), { recursive: true, mode: 0o700 });
		signal?.throwIfAborted();
		const database = new DatabaseSync(this.#lockPath, { timeout: 0 });
		try {
			for (;;) {
				signal?.throwIfAborted();
				if (performance.now() >= deadline) {
					throw new Error(`Timed out waiting for the credentials lock at ${this.#lockPath}.`);
				}
				try {
					// No data is written to SQLite; closing the connection or process releases ownership.
					database.exec("BEGIN EXCLUSIVE");
					break;
				} catch (error) {
					if (!(error instanceof Error && "errcode" in error && typeof error.errcode === "number")) throw error;
					const primary = error.errcode & 0xff;
					if (primary !== 5 && primary !== 6) throw error; // SQLITE_BUSY or SQLITE_LOCKED
					await sleep(Math.min(LOCK_POLL_MS, deadline - performance.now()), undefined, { signal });
				}
			}

			// Empty legacy markers carry no ownership information. Never reclaim them; upgrading
			// requires stopping old writers even when no marker is present.
			const legacy = `${this.#path}.lock`;
			const marker = await lstat(legacy).catch((error: unknown) => {
				if (code(error) !== "ENOENT") throw error;
			});
			if (marker !== undefined) {
				throw new Error(
					`Legacy credentials lock at ${legacy}. Stop all older unit-001 processes using this store before removing it.`,
				);
			}
			signal?.throwIfAborted();
			return await task();
		} finally {
			database.close();
		}
	}
}
