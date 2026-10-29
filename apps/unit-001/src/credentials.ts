import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type Entries = Record<string, Credential>;

const LOCK_POLL_MS = 25;
/** Longer than a token refresh (15 s), which runs while the lock is held. */
const LOCK_WAIT_MS = 30_000;
/** A lock this old belongs to a process that died. */
const LOCK_STALE_MS = 60_000;
const RENAME_RETRIES = 5;

function code(error: unknown): string | undefined {
	return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function isEntries(value: unknown): value is Entries {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every(
		(entry) =>
			typeof entry === "object" && entry !== null && ["api_key", "oauth"].includes((entry as Credential).type),
	);
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
	#queue: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
		this.#lockPath = `${path}.lock`;
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
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(entries, null, "\t")}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
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

	/** One writer at a time: queued in this process, then locked against other processes. */
	#exclusive<T>(task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const run = async (): Promise<T> => {
			options?.signal?.throwIfAborted();
			const release = await this.#lock(options?.signal);
			try {
				return await task();
			} finally {
				await release();
			}
		};
		const result = this.#queue.then(run, run);
		this.#queue = result.catch(() => {});
		return result;
	}

	async #lock(signal: AbortSignal | undefined): Promise<() => Promise<void>> {
		await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				const handle = await open(this.#lockPath, "wx", 0o600);
				await handle.close();
				return () => unlink(this.#lockPath).catch(() => {});
			} catch (error) {
				if (code(error) !== "EEXIST") throw error;
			}
			const age = await stat(this.#lockPath).then(
				(info) => Date.now() - info.mtimeMs,
				() => 0,
			);
			if (age > LOCK_STALE_MS) {
				await unlink(this.#lockPath).catch(() => {});
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for the credentials lock at ${this.#lockPath}.`);
			signal?.throwIfAborted();
			await sleep(LOCK_POLL_MS);
		}
	}
}
