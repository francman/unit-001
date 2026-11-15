// #15: Host completion evidence excludes unsafe, unbounded and unsupported file observations.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { supportedMissionCriteria, verifyMissionFiles } from "../../src/missions/verification.ts";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-proof-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const criterion = (file: string, content: string) =>
	`sha256:${createHash("sha256").update(content).digest("hex")}:${file}`;

it("observes exact content, a wrong digest and a missing file with observation times", async () => {
	await writeFile(join(directory, "proof.txt"), "proof");
	const evidence = await verifyMissionFiles(
		[criterion("proof.txt", "proof"), criterion("proof.txt", "wrong"), criterion("missing.txt", "proof")],
		directory,
		123,
	);
	expect(evidence.map((item) => item.accepted)).toEqual([true, false, false]);
	expect(evidence.every((item) => item.observedAt === 123)).toBe(true);
});

it.each([".", "dir/", "../outside", "/etc/passwd", "dir/../file"])(
	"rejects unsupported or escaping criterion %s",
	(path) => {
		expect(supportedMissionCriteria([criterion(path, "proof")])).toBe(false);
	},
);

it("rejects final-file symlinks and symlink parents even when their content matches", async () => {
	await mkdir(join(directory, "real"));
	await writeFile(join(directory, "real", "file"), "proof");
	await symlink(join(directory, "real", "file"), join(directory, "alias"));
	await symlink(join(directory, "real"), join(directory, "linked"));
	expect(
		(await verifyMissionFiles([criterion("alias", "proof"), criterion("linked/file", "proof")], directory, 1)).map(
			(item) => item.accepted,
		),
	).toEqual([false, false]);
});

it("rejects directories and files above the four MiB observation bound", async () => {
	await mkdir(join(directory, "folder"));
	await writeFile(join(directory, "large"), Buffer.alloc(4 * 1024 * 1024 + 1));
	expect(
		(await verifyMissionFiles([criterion("folder", ""), criterion("large", "")], directory, 1)).map(
			(item) => item.accepted,
		),
	).toEqual([false, false]);
});
