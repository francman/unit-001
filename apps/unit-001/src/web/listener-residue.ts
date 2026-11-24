// Clears this installation's dead launcher residue from the private web directory and refuses anything else at the managed socket path.
import type { BigIntStats } from "node:fs";
import { lstat, readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ConfigurationError } from "../errors.ts";

/**
 * Leaves `socket` free to bind, or refuses with the reason it is occupied. The caller holds the installation's web lock
 * and has verified `directory` as the operator's 0700 directory, so only this operator's own launchers write there:
 * an operator-owned socket at this reserved path that refuses connections is a dead launcher's socket.
 */
export async function clearListenerResidue(
	directory: string,
	socket: string,
	installationId: string,
	uid: number,
): Promise<void> {
	const published = await inspectSocket(socket, uid);
	if (published.kind === "occupied")
		throw new ConfigurationError(
			`Managed web socket path already exists: ${socket} (${published.reason}). Stop its launcher, or confirm the path is stale before removing it.`,
		);
	// Launchers up to bc723f302, including 0.0.17, bound `.listener-*/s` and published it by hard link; bc723f302 also
	// kept a record naming that staging directory. Other installations share this directory under their own locks, or
	// none on 0.0.17, so an unattributed staging directory may be one between mkdtemp and bind: it stays.
	const record = join(directory, `${installationId}.listener`);
	const stale = published.kind === "stale" ? published.entry : undefined;
	for (const staging of await ownedStaging(directory, stale, await readRecord(record))) await removeStaging(staging);
	if (published.kind === "stale") await unlink(socket);
	// The record goes last: until the staging it names is gone, it is what attributes that staging to this installation.
	await rm(record, { force: true });
	await rm(`${record}.tmp`, { force: true });
}

type SocketState =
	| { readonly kind: "absent" }
	| { readonly kind: "stale"; readonly entry: BigIntStats }
	| { readonly kind: "occupied"; readonly reason: string };

async function inspectSocket(path: string, uid: number): Promise<SocketState> {
	const entry = await lstatIfPresent(path);
	if (entry === undefined) return { kind: "absent" };
	if (!entry.isSocket() || entry.uid !== BigInt(uid))
		return { kind: "occupied", reason: "it is not a recognized listener socket" };
	const probe = await probeListener(path);
	if (probe === "refused") return { kind: "stale", entry };
	return { kind: "occupied", reason: probe === "accepted" ? "it accepts connections" : "its connection probe was not refused" };
}

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
	return lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw error;
	});
}

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

type Identity = Pick<BigIntStats, "dev" | "ino">;

interface RecordedStaging {
	readonly name: string;
	readonly socket: Identity;
}

// mkdtemp(".listener-") appends six characters.
const STAGING_NAME = /^\.listener-[A-Za-z0-9]{6}$/;

// A bc723f302 record is input from an older release: anything that does not name a staging socket attributes nothing.
async function readRecord(path: string): Promise<RecordedStaging | undefined> {
	const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (text === undefined) return undefined;
	try {
		const { staging, socketDev, socketIno } = JSON.parse(text) as Record<string, unknown>;
		if (typeof staging !== "string" || !STAGING_NAME.test(staging)) return undefined;
		if (typeof socketDev !== "string" || typeof socketIno !== "string") return undefined;
		return { name: staging, socket: { dev: BigInt(socketDev), ino: BigInt(socketIno) } };
	} catch {
		return undefined;
	}
}

// A staging socket is this installation's when it is the dead public socket's other link (that inode stays allocated
// while the public link exists), or the socket its record names in the directory it names.
async function ownedStaging(
	directory: string,
	published: Identity | undefined,
	record: RecordedStaging | undefined,
): Promise<string[]> {
	const owned: string[] = [];
	for (const name of await readdir(directory)) {
		if (!STAGING_NAME.test(name)) continue;
		const bound = await lstatIfPresent(join(directory, name, "s"));
		if (bound === undefined) continue;
		const isPublished = published !== undefined && sameInode(bound, published);
		if (isPublished || (name === record?.name && sameInode(bound, record.socket))) owned.push(join(directory, name));
	}
	return owned;
}

function sameInode(entry: Identity, identity: Identity): boolean {
	return entry.dev === identity.dev && entry.ino === identity.ino;
}

// Never recursive: only the recognized socket is removed, and a directory holding anything else is left in place.
async function removeStaging(staging: string): Promise<void> {
	await unlink(join(staging, "s"));
	await rmdir(staging).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
	});
}
