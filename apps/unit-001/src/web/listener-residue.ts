// Records the managed web listener's identity and removes only crash residue that matches it or the 0.0.17 layout.
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { ConfigurationError } from "../errors.ts";

/** Where one installation's managed listener lives inside the verified private web directory. */
export interface ListenerPaths {
	readonly directory: string;
	readonly socket: string;
	readonly record: string;
}

/** A path recovery left in place, with the reason it was not recognized as residue. */
export interface PreservedPath {
	readonly path: string;
	readonly reason: string;
}

interface Identity {
	readonly dev: bigint;
	readonly ino: bigint;
}

interface ListenerRecord {
	readonly staging: string;
	readonly stagingIdentity: Identity;
	readonly socketIdentity: Identity;
}

/**
 * Removes a previous launcher's residue under the held web lock and returns what it preserved.
 * A record written by a lock-aware launcher authorizes removal of exactly the inodes it names.
 * Without a record, only the narrow 0.0.17 layout with a refused connection is adopted and removed.
 */
export async function recoverListener(paths: ListenerPaths, uid: number): Promise<readonly PreservedPath[]> {
	const record = await readRecord(paths.record, uid);
	if (record !== undefined) return removeRecorded(paths, record, uid);
	const legacy = await matchLegacyListener(paths, uid);
	if (legacy.kind === "absent") return [];
	if (legacy.kind === "preserved") return [{ path: paths.socket, reason: legacy.reason }];
	// Record the adopted pair first, so a cut between the unlinks below is finished by the next start.
	await writeRecord(paths, legacy.record, uid);
	return removeRecorded(paths, legacy.record, uid);
}

/** Durably records a bound listener before its public link exists, so a crash leaves residue the next start can match. */
export async function recordListener(paths: ListenerPaths, staging: string, socket: BigIntStats, uid: number): Promise<void> {
	// Recovery trusts the public link only while the staging link corroborates it, so that link must survive a reboot too.
	await syncDirectory(staging);
	const directory = await lstat(staging, { bigint: true });
	await writeRecord(
		paths,
		{
			staging: basename(staging),
			stagingIdentity: { dev: directory.dev, ino: directory.ino },
			socketIdentity: { dev: socket.dev, ino: socket.ino },
		},
		uid,
	);
}

/** Forgets the listener record once its links and staging directory are gone. */
export async function forgetListener(paths: ListenerPaths): Promise<void> {
	await unlinkIfPresent(paths.record);
}

async function removeRecorded(paths: ListenerPaths, record: ListenerRecord, uid: number): Promise<readonly PreservedPath[]> {
	const preserved: PreservedPath[] = [];
	const stagingPath = join(paths.directory, record.staging);
	const bound = join(stagingPath, "s");
	const staging = await lstatIfPresent(stagingPath);
	const stagingMatches =
		staging !== undefined && isPrivateDirectory(staging, uid) && sameInode(staging, record.stagingIdentity);
	// Only a real staging directory is traversed: lstat below a substituted link would follow it.
	const socket = stagingMatches ? await lstatIfPresent(bound) : undefined;
	const socketMatches = socket !== undefined && isOwnedSocket(socket, uid) && sameInode(socket, record.socketIdentity);
	// The public path goes first: it is the only residue that blocks the next launcher. Device and inode alone can be
	// reused once both original links are gone, so the recorded staging link must still name the same inode.
	const published = await lstatIfPresent(paths.socket);
	if (published !== undefined) {
		if (!isOwnedSocket(published, uid) || !sameInode(published, record.socketIdentity))
			preserved.push({ path: paths.socket, reason: "it does not match the recorded listener" });
		else if (!socketMatches)
			preserved.push({ path: paths.socket, reason: "its recorded staging link no longer corroborates it" });
		else await unlinkIfPresent(paths.socket);
	}
	if (staging !== undefined && !stagingMatches)
		preserved.push({ path: stagingPath, reason: "it does not match the recorded staging directory" });
	else if (stagingMatches) {
		// A cut between the two unlinks leaves only this link; it is removed on its own record identity.
		if (socketMatches) await unlinkIfPresent(bound);
		else if (socket !== undefined) preserved.push({ path: bound, reason: "it does not match the recorded listener" });
		await rmdir(stagingPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return;
			if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
			preserved.push({ path: stagingPath, reason: "it holds files this launcher did not create" });
		});
	}
	// Anything preserved can never match this record later, so the record has served its purpose.
	await forgetListener(paths);
	return preserved;
}

type LegacyMatch =
	| { readonly kind: "absent" }
	| { readonly kind: "preserved"; readonly reason: string }
	| { readonly kind: "eligible"; readonly record: ListenerRecord };

// 0.0.17 binds `.listener-*/s`, publishes a hard link only after listen(), and unlinks that link before closing.
// A published pair that refuses connections is therefore a dead 0.0.17 listener.
async function matchLegacyListener(paths: ListenerPaths, uid: number): Promise<LegacyMatch> {
	const published = await lstatIfPresent(paths.socket);
	if (published === undefined) return { kind: "absent" };
	if (!isOwnedSocket(published, uid) || (published.mode & 0o7777n) !== 0o600n || published.nlink !== 2n)
		return { kind: "preserved", reason: "it is not a recognized listener socket" };
	const matches: { name: string; directory: BigIntStats; socket: BigIntStats }[] = [];
	for (const name of await readdir(paths.directory)) {
		if (!STAGING_NAME.test(name)) continue;
		const directory = await lstatIfPresent(join(paths.directory, name));
		// Never traverse a link: lstat of a child below a symlinked directory would follow it.
		if (directory === undefined || !directory.isDirectory()) continue;
		const socket = await lstatIfPresent(join(paths.directory, name, "s"));
		if (socket !== undefined && sameInode(socket, published)) matches.push({ name, directory, socket });
	}
	const [match] = matches;
	if (match === undefined || matches.length !== 1)
		return { kind: "preserved", reason: "it has no single matching staging link" };
	if (!isPrivateDirectory(match.directory, uid))
		return { kind: "preserved", reason: "its staging directory is not operator-owned with mode 0700" };
	const probe = await probeListener(paths.socket);
	if (probe !== "refused")
		return {
			kind: "preserved",
			reason: probe === "accepted" ? "it accepts connections" : "its connection probe was not refused",
		};
	const stagingPath = join(paths.directory, match.name);
	const [publishedNow, directoryNow, socketNow] = await Promise.all([
		lstatIfPresent(paths.socket),
		lstatIfPresent(stagingPath),
		lstatIfPresent(join(stagingPath, "s")),
	]);
	if (
		!unchanged(publishedNow, published) ||
		!unchanged(directoryNow, match.directory) ||
		!unchanged(socketNow, match.socket)
	)
		return { kind: "preserved", reason: "it changed while it was checked" };
	return {
		kind: "eligible",
		record: {
			staging: match.name,
			stagingIdentity: { dev: match.directory.dev, ino: match.directory.ino },
			socketIdentity: { dev: published.dev, ino: published.ino },
		},
	};
}

// mkdtemp(".listener-") appends six characters.
const STAGING_NAME = /^\.listener-[A-Za-z0-9]{6}$/;

const PROBE_TIMEOUT_MS = 1_000;

// Only a refusal proves no listener: success means live, and a timeout or other error is ambiguous.
function probeListener(path: string): Promise<"refused" | "accepted" | "unknown"> {
	return new Promise((resolve) => {
		const socket = createConnection({ path });
		const finish = (result: "refused" | "accepted" | "unknown") => {
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish("unknown"), PROBE_TIMEOUT_MS);
		socket.once("connect", () => finish("accepted"));
		socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? "refused" : "unknown"));
	});
}

const RECORD_LIMIT = 4096;

// The record sits in the verified 0700 directory and is only ever replaced by rename, so it is never torn.
async function readRecord(path: string, uid: number): Promise<ListenerRecord | undefined> {
	const file = await openRecordFile(path, constants.O_RDONLY).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (file === undefined) return undefined;
	let text: string;
	try {
		const entry = await file.stat();
		if (!entry.isFile() || entry.uid !== uid || (entry.mode & 0o077) !== 0 || entry.size > RECORD_LIMIT)
			throw invalidRecord(path);
		text = await file.readFile("utf8");
	} finally {
		await file.close();
	}
	const record = parseRecord(text);
	if (record === undefined) throw invalidRecord(path);
	return record;
}

function parseRecord(text: string): ListenerRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { version, staging, stagingDev, stagingIno, socketDev, socketIno } = value as Record<string, unknown>;
	const numbers = [stagingDev, stagingIno, socketDev, socketIno];
	if (version !== 1 || typeof staging !== "string" || !STAGING_NAME.test(staging)) return undefined;
	if (!numbers.every((number) => typeof number === "string" && /^[0-9]{1,20}$/.test(number))) return undefined;
	const [sd, si, kd, ki] = numbers.map((number) => BigInt(number as string));
	return { staging, stagingIdentity: { dev: sd!, ino: si! }, socketIdentity: { dev: kd!, ino: ki! } };
}

function invalidRecord(path: string): ConfigurationError {
	return new ConfigurationError(
		`The managed web listener record is not valid: ${path}. Stop every bob web launcher for this installation before removing it.`,
	);
}

async function writeRecord(paths: ListenerPaths, record: ListenerRecord, uid: number): Promise<void> {
	const temporary = `${paths.record}.tmp`;
	const file = await openRecordFile(temporary, constants.O_WRONLY | constants.O_CREAT);
	try {
		// Check before truncating: a leftover from a crash is reused only if it is a private regular file of its own,
		// so the renamed record passes readRecord's checks on the next start.
		const entry = await file.stat();
		if (!entry.isFile() || entry.uid !== uid || entry.nlink !== 1 || (entry.mode & 0o077) !== 0)
			throw invalidRecord(temporary);
		await file.truncate(0);
		await file.writeFile(
			JSON.stringify({
				version: 1,
				staging: record.staging,
				stagingDev: String(record.stagingIdentity.dev),
				stagingIno: String(record.stagingIdentity.ino),
				socketDev: String(record.socketIdentity.dev),
				socketIno: String(record.socketIdentity.ino),
			}),
		);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, paths.record);
	// The record must survive the reboot that leaves the public link behind.
	await syncDirectory(paths.directory);
}

// O_NONBLOCK keeps a FIFO or device planted at a record name from blocking open, and the held lock with it.
async function openRecordFile(path: string, flags: number): Promise<FileHandle> {
	return open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600).catch((error: NodeJS.ErrnoException) => {
		// A symlink, a FIFO without a reader, or a directory: preserve it and refuse with its path.
		if (error.code === "ELOOP" || error.code === "ENXIO" || error.code === "EISDIR") throw invalidRecord(path);
		throw error;
	});
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function isOwnedSocket(entry: BigIntStats, uid: number): boolean {
	return entry.isSocket() && entry.uid === BigInt(uid);
}

function isPrivateDirectory(entry: BigIntStats, uid: number): boolean {
	return entry.isDirectory() && entry.uid === BigInt(uid) && (entry.mode & 0o7777n) === 0o700n;
}

function sameInode(entry: BigIntStats, identity: Identity): boolean {
	return entry.dev === identity.dev && entry.ino === identity.ino;
}

function unchanged(now: BigIntStats | undefined, before: BigIntStats): boolean {
	return (
		now !== undefined &&
		sameInode(now, before) &&
		now.uid === before.uid &&
		now.mode === before.mode &&
		now.nlink === before.nlink
	);
}

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
	return lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw error;
	});
}

async function unlinkIfPresent(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}
