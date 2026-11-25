// Persists one unsent terminal draft per installation and session so it survives client exit.
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { sanitizeTerminalText } from "./render.ts";
import { isSendDigest } from "./send-receipt.ts";

/** Same bound as the editor, so a stored draft can always be restored. */
export const MAX_DRAFT_BYTES = 16_384;

/** Drafts older than this are discarded on load. */
export const DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Edits reach disk at most this often; exit paths flush immediately.
const SAVE_INTERVAL_MS = 750;
const MAX_REQUEST_ID_LENGTH = 64;
// Two sanitized 16 KiB texts escape to at most about 70 KiB of JSON; anything larger was not written by this store.
const MAX_FILE_BYTES = 131_072;
// A saved time further ahead than this is clock skew at most; beyond it the file is planted or corrupt.
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const DRAFT_NAME = /^[0-9a-f]{32}\.json$/;
const TEMPORARY_NAME = /^\.draft-[0-9a-f-]{36}\.tmp$/;

/** Text that was submitted but whose outcome the client never saw, with the request ID to check it by. */
export interface UnconfirmedSend {
	readonly text: string;
	readonly requestId: string;
	/** Digest of the prompt as sent; the saved text is sanitized, so only this checks the owner's receipt exactly. */
	readonly digest?: string;
}

/** The editor text plus, when a send is unconfirmed, that send's own text; both survive typing a new message. */
export interface StoredDraft {
	readonly text: string;
	readonly unconfirmed?: UnconfirmedSend;
}

export type DraftFlush = { readonly status: "saved" } | { readonly status: "failed"; readonly reason: string };

/** `refused` means a file or directory failed the trust checks; nothing was read from it. */
export type DraftLoad =
	| { readonly status: "none" }
	| { readonly status: "restored"; readonly draft: StoredDraft }
	| { readonly status: "refused"; readonly reason: string };

export interface DraftStore {
	/** Returns the stored draft; absent, stale, oversized, foreign or untrusted files restore nothing. */
	load(): Promise<DraftLoad>;
	/** Replaces the stored draft (undefined removes it); the write is deferred and coalesced. */
	save(draft: StoredDraft | undefined): void;
	/** Writes any pending change now; it never throws, so exit paths can always call it. */
	flush(): Promise<DraftFlush>;
}

export interface DraftStoreOptions {
	/** Client-side state directory for drafts (per OS user). */
	readonly directory: string;
	/** Identity of the installation the draft was typed for; a file recording another identity is ignored. */
	readonly installationId: string;
	readonly session: string;
	readonly now?: () => number;
}

interface DraftFile {
	readonly schemaVersion: 1;
	readonly installationId: string;
	readonly session: string;
	readonly savedAt: number;
	readonly text: string;
	readonly unconfirmed?: UnconfirmedSend;
}

/** Creates the store for one installation and session; nothing touches disk until load, save or flush. */
export function createDraftStore(options: DraftStoreOptions): DraftStore {
	return new FileDraftStore(options);
}

class FileDraftStore implements DraftStore {
	readonly #directory: string;
	readonly #path: string;
	readonly #installationId: string;
	readonly #session: string;
	readonly #now: () => number;
	#pending: { readonly draft: StoredDraft | undefined } | undefined;
	#timer: NodeJS.Timeout | undefined;
	#writes: Promise<unknown> = Promise.resolve();
	#failure: string | undefined;

	constructor(options: DraftStoreOptions) {
		this.#directory = options.directory;
		this.#installationId = options.installationId;
		this.#session = options.session;
		this.#now = options.now ?? Date.now;
		// A hash keeps the name safe on every platform whatever the identity or session contains.
		const key = createHash("sha256").update(JSON.stringify([options.installationId, options.session])).digest("hex");
		this.#path = join(options.directory, `${key.slice(0, 32)}.json`);
	}

	async load(): Promise<DraftLoad> {
		try {
			if ((await this.#trustDirectory()) === "missing") return { status: "none" };
			await this.#sweep();
			const source = await this.#read();
			if (source === undefined) return { status: "none" };
			// The file is a trust boundary: another process or a crash can leave anything here.
			const file = this.#parse(source);
			if (file === undefined) return { status: "none" };
			const age = this.#now() - file.savedAt;
			if (age > DRAFT_RETENTION_MS || age < -FUTURE_SLACK_MS) {
				await unlink(this.#path).catch(() => {});
				return { status: "none" };
			}
			return {
				status: "restored",
				draft: file.unconfirmed === undefined ? { text: file.text } : { text: file.text, unconfirmed: file.unconfirmed },
			};
		} catch (error) {
			return { status: "refused", reason: describe(error) };
		}
	}

	save(draft: StoredDraft | undefined): void {
		this.#pending = { draft };
		this.#timer ??= setTimeout(() => {
			this.#timer = undefined;
			void this.#write();
		}, SAVE_INTERVAL_MS);
		this.#timer.unref();
	}

	async flush(): Promise<DraftFlush> {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		await this.#write();
		return this.#failure === undefined ? { status: "saved" } : { status: "failed", reason: this.#failure };
	}

	#write(): Promise<unknown> {
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending !== undefined) this.#writes = this.#writes.then(() => this.#persist(pending.draft));
		return this.#writes;
	}

	async #persist(draft: StoredDraft | undefined): Promise<void> {
		try {
			const file = draft === undefined ? undefined : this.#fileFor(draft);
			if (file === undefined) {
				// Clearing must never create the directory just to find nothing to remove.
				if ((await this.#trustDirectory()) === "missing") {
					this.#failure = undefined;
					return;
				}
				await unlink(this.#path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			} else {
				await this.#ensureDirectory();
				await this.#replace(`${JSON.stringify(file)}\n`);
			}
			this.#failure = undefined;
		} catch (error) {
			this.#failure = describe(error);
		}
	}

	// Sanitized so the file never holds terminal escapes; an empty or oversized draft is not stored. An unconfirmed send
	// is never dropped silently: its ID is what the next attach checks, so an oversized one fails the write instead.
	#fileFor(draft: StoredDraft): DraftFile | undefined {
		const sanitized = sanitizeTerminalText(draft.text);
		const text = Buffer.byteLength(sanitized) > MAX_DRAFT_BYTES ? "" : sanitized;
		const unconfirmed =
			draft.unconfirmed === undefined
				? undefined
				: {
						text: sanitizeTerminalText(draft.unconfirmed.text),
						requestId: draft.unconfirmed.requestId,
						...(draft.unconfirmed.digest === undefined ? {} : { digest: draft.unconfirmed.digest }),
					};
		if (text === "" && unconfirmed === undefined) return undefined;
		if (unconfirmed !== undefined && Buffer.byteLength(unconfirmed.text) > MAX_DRAFT_BYTES)
			throw new Error(`the unconfirmed send is larger than ${MAX_DRAFT_BYTES} bytes`);
		return {
			schemaVersion: 1,
			installationId: this.#installationId,
			session: this.#session,
			savedAt: this.#now(),
			text,
			...(unconfirmed === undefined ? {} : { unconfirmed }),
		};
	}

	// A directory is trusted only when it is a real directory of this user that nobody else can enter, below ancestors
	// nobody else can change.
	async #trustDirectory(): Promise<"missing" | "ready"> {
		const status = await lstat(this.#directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (status === undefined) return "missing";
		if (status.isSymbolicLink()) throw new Error(`drafts directory ${this.#directory} is a symbolic link`);
		if (!status.isDirectory()) throw new Error(`drafts path ${this.#directory} is not a directory`);
		if (process.getuid !== undefined && status.uid !== process.getuid())
			throw new Error(`drafts directory ${this.#directory} is owned by another user`);
		if (process.platform !== "win32" && (status.mode & 0o077) !== 0)
			throw new Error(
				`drafts directory ${this.#directory} must not be accessible by others (mode ${(status.mode & 0o777).toString(8)})`,
			);
		await trustAncestors(dirname(this.#directory));
		return "ready";
	}

	// Only a directory this call created is chmodded, through its descriptor; an existing one is checked, never changed.
	async #ensureDirectory(): Promise<void> {
		if ((await this.#trustDirectory()) === "ready") return;
		const parent = dirname(this.#directory);
		await mkdir(parent, { recursive: true, mode: 0o700 });
		await trustAncestors(parent);
		// Not recursive: a recursive mkdir also succeeds when someone else made the directory first.
		const created = await mkdir(this.#directory, { mode: 0o700 }).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "EEXIST") return false;
				throw error;
			},
		);
		if (created) await repairMode(this.#directory);
		await this.#trustDirectory();
	}

	// Opens without following a final symlink or blocking on a FIFO, then checks the descriptor, not the name.
	async #read(): Promise<string | undefined> {
		const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
		const handle = await open(this.#path, flags).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			if (error.code === "ELOOP") throw new Error(`draft file ${this.#path} is a symbolic link`);
			throw error;
		});
		if (handle === undefined) return undefined;
		try {
			const status = await handle.stat();
			if (!status.isFile()) throw new Error(`draft file ${this.#path} is not a regular file`);
			if (process.getuid !== undefined && status.uid !== process.getuid())
				throw new Error(`draft file ${this.#path} is owned by another user`);
			if (status.size > MAX_FILE_BYTES) throw new Error(`draft file ${this.#path} is larger than ${MAX_FILE_BYTES} bytes`);
			const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_FILE_BYTES) throw new Error(`draft file ${this.#path} is larger than ${MAX_FILE_BYTES} bytes`);
			return buffer.toString("utf8", 0, bytesRead);
		} finally {
			await handle.close();
		}
	}

	// Drafts of abandoned sessions and temp files left by a hard kill hold plaintext; drop them once past retention.
	async #sweep(): Promise<void> {
		const names = await readdir(this.#directory).catch(() => []);
		for (const name of names) {
			if (!DRAFT_NAME.test(name) && !TEMPORARY_NAME.test(name)) continue;
			const path = join(this.#directory, name);
			try {
				const status = await lstat(path);
				const ours = process.getuid === undefined || status.uid === process.getuid();
				if (status.isFile() && ours && this.#now() - status.mtimeMs > DRAFT_RETENTION_MS) await unlink(path);
			} catch {
				// Best effort: a file that vanished or cannot be removed is not a reason to refuse the load.
			}
		}
	}

	async #replace(contents: string): Promise<void> {
		const temporary = join(this.#directory, `.draft-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(contents);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.#path);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	#parse(source: string): DraftFile | undefined {
		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch {
			return undefined;
		}
		if (typeof value !== "object" || value === null) return undefined;
		const file = value as Partial<Record<keyof DraftFile, unknown>>;
		if (
			file.schemaVersion !== 1 ||
			file.installationId !== this.#installationId ||
			file.session !== this.#session ||
			typeof file.savedAt !== "number" ||
			!Number.isFinite(file.savedAt) ||
			typeof file.text !== "string"
		)
			return undefined;
		const text = sanitizeTerminalText(file.text);
		if (Buffer.byteLength(text) > MAX_DRAFT_BYTES) return undefined;
		if (file.unconfirmed === undefined) {
			if (text === "") return undefined;
			return { schemaVersion: 1, installationId: file.installationId, session: file.session, savedAt: file.savedAt, text };
		}
		const unconfirmed = this.#parseUnconfirmed(file.unconfirmed);
		if (unconfirmed === undefined) return undefined;
		return {
			schemaVersion: 1,
			installationId: file.installationId,
			session: file.session,
			savedAt: file.savedAt,
			text,
			unconfirmed,
		};
	}

	#parseUnconfirmed(value: unknown): UnconfirmedSend | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		const send = value as Partial<Record<keyof UnconfirmedSend, unknown>>;
		if (typeof send.text !== "string" || typeof send.requestId !== "string") return undefined;
		if (send.requestId === "" || send.requestId.length > MAX_REQUEST_ID_LENGTH) return undefined;
		if (send.digest !== undefined && !isSendDigest(send.digest)) return undefined;
		// Text that sanitizes to nothing (a prompt of format characters only) still carries the ID that must be checked.
		const text = sanitizeTerminalText(send.text);
		if (Buffer.byteLength(text) > MAX_DRAFT_BYTES) return undefined;
		return { text, requestId: send.requestId, ...(send.digest === undefined ? {} : { digest: send.digest }) };
	}
}

// The umask can only clear bits, so a new directory never has group or other access; it can lack owner bits, which are
// restored on the opened directory, never through a path that may have been swapped for someone else's file.
async function repairMode(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(directory, flags);
	try {
		const status = await handle.stat();
		if (!status.isDirectory() || (process.getuid !== undefined && status.uid !== process.getuid()))
			throw new Error(`drafts directory ${directory} was replaced while it was created`);
		await handle.chmod(0o700);
	} finally {
		await handle.close();
	}
}

// The kernel gives up after this many links in one lookup (ELOOP); a longer chain is not a path to trust.
const MAX_LINKS = 40;

/**
 * Walks the path to the drafts directory the way the kernel resolves it, entry by entry, following every symbolic link
 * wherever it sits. Each entry traversed, links included, must be owned by root or this user, and each directory must
 * be writable by nobody else unless sticky. Otherwise another user could rename or replace an entry on the path between
 * these checks and the opens, renames and unlinks that follow, which Node cannot anchor to a directory descriptor. A
 * link is checked as an entry because, in a sticky directory, its owner can still replace it.
 */
async function trustAncestors(directory: string): Promise<void> {
	const uid = process.getuid?.();
	if (uid === undefined || process.platform === "win32") return;
	let current = parse(resolve(directory)).root;
	await trustEntry(current, uid);
	const pending = components(resolve(directory));
	for (let links = 0; pending.length > 0; ) {
		const name = pending.shift() as string;
		// `current` is always a physical directory, so `..` in a link target leaves it as the kernel would.
		if (name === "..") {
			current = dirname(current);
			continue;
		}
		const path = join(current, name);
		const status = await trustEntry(path, uid);
		if (status.isSymbolicLink()) {
			if (++links > MAX_LINKS) throw new Error(`drafts path ${directory} has too many symbolic links`);
			const target = await readlink(path);
			if (isAbsolute(target)) current = parse(target).root;
			pending.unshift(...components(target));
		} else if (status.isDirectory()) current = path;
		else throw new Error(`drafts path ${path} is not a directory`);
	}
}

async function trustEntry(path: string, uid: number): Promise<Stats> {
	const status = await lstat(path);
	const owned = status.uid === 0 || status.uid === uid;
	const shielded = status.isSymbolicLink() || (status.mode & 0o022) === 0 || (status.mode & 0o1000) !== 0;
	// A group-writable entry (mode 775, what umask 002 gives its creator) is refused as well: group membership is not
	// checked, so the entry is treated as writable by others. Recovery is unavailable until the entry is fixed; nothing
	// is moved to another location.
	if (!owned || !shielded)
		throw new Error(
			`drafts path ${path} can be changed by other users (mode ${(status.mode & 0o777).toString(8)}); draft recovery is unavailable until it is owned by you or root and not writable by group or others`,
		);
	return status;
}

function components(path: string): string[] {
	return path.split(sep).filter((part) => part !== "" && part !== ".");
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
