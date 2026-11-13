// Stores explicit per-user remote bookmarks without credentials or remote filesystem paths.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { validateSessionName } from "../paths.ts";

export interface RemoteProfile {
	readonly schema: 1;
	readonly name: string;
	readonly host: string;
	readonly installationId: string;
	readonly session: string;
	readonly agentName: string;
}

/** Rejects option-like names, path syntax and shell metacharacters at the SSH argument boundary. */
export function validateRemoteName(name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || name.endsWith("."))
		throw new Error("Remote names and SSH aliases must be 1–64 letters, numbers, dots, underscores or hyphens.");
	return name;
}

/** Checks the persisted profile schema before using any value to select a remote endpoint. */
export function parseRemoteProfile(value: unknown): RemoteProfile {
	if (typeof value !== "object" || value === null) throw new Error("Invalid remote profile.");
	const profile = value as Record<string, unknown>;
	if (
		profile.schema !== 1 ||
		typeof profile.name !== "string" ||
		typeof profile.host !== "string" ||
		typeof profile.installationId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.installationId) ||
		typeof profile.session !== "string" ||
		typeof profile.agentName !== "string"
	)
		throw new Error("Invalid remote profile.");
	validateRemoteName(profile.name);
	validateRemoteName(profile.host);
	validateRemoteName(profile.agentName);
	validateSessionName(profile.session);
	return {
		schema: 1,
		name: profile.name,
		host: profile.host,
		installationId: profile.installationId,
		session: profile.session,
		agentName: profile.agentName,
	};
}

/** Creates a private bookmark atomically and never replaces an existing pinned identity. */
export async function addRemoteProfile(directory: string, input: RemoteProfile): Promise<void> {
	const profile = parseRemoteProfile(input);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await checkDirectory(directory);
	const temporary = join(directory, `.profile-${randomUUID()}`);
	const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await file.writeFile(`${JSON.stringify(profile)}\n`);
		await file.sync();
		await file.close();
		await link(temporary, join(directory, `${profile.name}.json`));
	} finally {
		await file.close();
		await unlink(temporary);
	}
}

/** Reads a bounded, user-owned regular profile without following a symbolic link. */
export async function readRemoteProfile(directory: string, name: string): Promise<RemoteProfile> {
	validateRemoteName(name);
	await checkDirectory(directory);
	const file = await open(
		join(directory, `${name}.json`),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const metadata = await file.stat();
		if (
			!metadata.isFile() ||
			metadata.size > 65_536 ||
			metadata.uid !== process.getuid?.() ||
			(metadata.mode & 0o077) !== 0
		)
			throw new Error("Remote profile must be a private, user-owned regular file no larger than 64 KiB.");
		const profile = parseRemoteProfile(JSON.parse(await file.readFile("utf8")));
		if (profile.name !== name) throw new Error("Remote profile name does not match its filename.");
		return profile;
	} finally {
		await file.close();
	}
}

/** Lists only explicit profiles, reporting invalid profiles rather than silently skipping them. */
export async function listRemoteProfiles(directory: string): Promise<readonly RemoteProfile[]> {
	try {
		await checkDirectory(directory);
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
	return Promise.all(names.map((name) => readRemoteProfile(directory, name.slice(0, -5))));
}

/** Removes a local bookmark without contacting or stopping its remote owner. */
export async function removeRemoteProfile(directory: string, name: string): Promise<void> {
	await readRemoteProfile(directory, name);
	await unlink(join(directory, `${name}.json`));
}

async function checkDirectory(directory: string): Promise<void> {
	const metadata = await lstat(directory);
	if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
		throw new Error("Remote profile directory must be private and owned by the current user (mode 0700).");
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
