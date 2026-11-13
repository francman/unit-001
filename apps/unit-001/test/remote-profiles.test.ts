import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addRemoteProfile,
	listRemoteProfiles,
	type RemoteProfile,
	readRemoteProfile,
	removeRemoteProfile,
} from "../src/remote/profiles.ts";

const directories: string[] = [];
const profile: RemoteProfile = {
	schema: 1,
	name: "unit-01",
	host: "unit-01",
	installationId: "aa49e3de-4cb1-4caf-9b98-26e4c399c12d",
	session: "default",
	agentName: "agent",
};

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("private remote profiles", () => {
	it.skipIf(process.platform === "win32")(
		"#55 rejects a FIFO profile without waiting for a writer",
		async () => {
			const directory = await temporaryDirectory();
			execFileSync("mkfifo", [join(directory, "blocked.json")]);
			await expect(readRemoteProfile(directory, "blocked")).rejects.toThrow(/regular file/);
		},
		1000,
	);
	it("#55 persists an identity pin without keys and removes only the local bookmark", async () => {
		const directory = await temporaryDirectory();
		expect(await listRemoteProfiles(join(directory, "absent"))).toEqual([]);
		await addRemoteProfile(directory, profile);
		expect(await readRemoteProfile(directory, profile.name)).toEqual(profile);
		expect(await listRemoteProfiles(directory)).toEqual([profile]);
		expect(JSON.parse(await readFile(join(directory, "unit-01.json"), "utf8"))).toEqual(profile);
		await removeRemoteProfile(directory, profile.name);
		expect(await listRemoteProfiles(directory)).toEqual([]);
	});

	it("#55 concurrent creation cannot replace a pinned identity", async () => {
		const directory = await temporaryDirectory();
		const results = await Promise.allSettled([
			addRemoteProfile(directory, profile),
			addRemoteProfile(directory, { ...profile, installationId: "bb49e3de-4cb1-4caf-9b98-26e4c399c12d" }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect((await listRemoteProfiles(directory)).length).toBe(1);
	});

	it("#55 rejects public files and directories, symbolic links and renamed profiles", async () => {
		const directory = await temporaryDirectory();
		await addRemoteProfile(directory, profile);
		const path = join(directory, "unit-01.json");
		await chmod(path, 0o644);
		await expect(readRemoteProfile(directory, profile.name)).rejects.toThrow(/private/);
		await chmod(path, 0o600);
		await chmod(directory, 0o755);
		await expect(readRemoteProfile(directory, profile.name)).rejects.toThrow(/0700/);
		await chmod(directory, 0o700);
		await symlink(path, join(directory, "other.json"));
		await expect(readRemoteProfile(directory, "other")).rejects.toThrow();
		await writeFile(path, JSON.stringify({ ...profile, name: "other" }));
		await expect(readRemoteProfile(directory, profile.name)).rejects.toThrow(/filename/);
		const linked = join(directory, "linked");
		await symlink(directory, linked);
		await expect(listRemoteProfiles(linked)).rejects.toThrow(/0700/);
	});

	it("#55 rejects shell syntax, option injection, arbitrary paths and invalid installation identities", async () => {
		const directory = await temporaryDirectory();
		for (const change of [
			{ name: "../other" },
			{ host: "-oProxyCommand=evil" },
			{ host: "host;id" },
			{ agentName: "agent && id" },
			{ installationId: "/tmp/other.sock" },
			{ session: "../session" },
		])
			await expect(addRemoteProfile(directory, { ...profile, ...change })).rejects.toThrow();
		expect(await listRemoteProfiles(directory)).toEqual([]);
	});

	it("#55 reports malformed and oversized profiles instead of hiding them", async () => {
		const directory = await temporaryDirectory();
		await writeFile(join(directory, "bad.json"), "x".repeat(65_537), { mode: 0o600 });
		await expect(listRemoteProfiles(directory)).rejects.toThrow(/64 KiB/);
		await writeFile(join(directory, "bad.json"), "null");
		await expect(listRemoteProfiles(directory)).rejects.toThrow(/Invalid remote profile/);
	});
});

async function temporaryDirectory(): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), "unit-remote-profile-"));
	directories.push(parent);
	const directory = join(parent, "profiles");
	await mkdir(directory, { mode: 0o700 });
	return directory;
}
