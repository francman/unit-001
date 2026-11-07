// Verifies runtime pinning and complete, path-safe release checksum inventories.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
	NODE_RELEASE,
	releaseFiles,
	verifyExternalResolutions,
	verifyNodeDownload,
	writeReleaseArchive,
	writeReleaseChecksums,
	writeReleaseLauncher,
} from "../scripts/build-release.mjs";

const temporary = [];
afterEach(() => {
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("#16 Linux archives exclude macOS extended attributes and AppleDouble companions", () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-release-"));
	temporary.push(directory);
	const payload = join(directory, "payload");
	mkdirSync(payload);
	writeFileSync(join(payload, "VERSION"), "0.0.1\n");
	if (process.platform === "darwin")
		execFileSync("xattr", [
			"-w",
			"com.unit001.release-test",
			"unit001-metadata-must-not-ship",
			join(payload, "VERSION"),
		]);
	const archive = join(directory, "release.tar.gz");
	writeReleaseArchive(directory, "payload", archive);
	assert.deepEqual(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n").sort(), [
		"payload/",
		"payload/VERSION",
	]);
	assert.doesNotMatch(
		gunzipSync(readFileSync(archive)).toString("utf8"),
		/unit001-metadata-must-not-ship|LIBARCHIVE\.xattr|\._VERSION/,
	);
});

test("#19 packages only the generic internal launcher, without a public installation identity", () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-release-"));
	temporary.push(directory);
	writeReleaseLauncher(directory);
	assert.deepEqual(releaseFiles(directory), ["bin/agent"]);
	assert.equal(statSync(join(directory, "bin/agent")).mode & 0o777, 0o755);
	const launcher = readFileSync(join(directory, "bin/agent"), "utf8");
	assert.match(launcher, /runtime\/bin\/node/);
	assert.match(launcher, /app\/dist\/bin\.js" "\$@"/);
	assert.doesNotMatch(launcher, /u1|--installation|bob/);
});

test("rejects a downloaded runtime when the official checksum or payload differs from the reviewed pin", () => {
	assert.throws(() => verifyNodeDownload(Buffer.from("untrusted"), ""), /official Node checksum/);
	assert.throws(
		() => verifyNodeDownload(Buffer.from("untrusted"), `${NODE_RELEASE.sha256}  ${NODE_RELEASE.filename}\n`),
		/failed SHA256/,
	);
});

test("hashes every payload file once and excludes its own checksum manifest", () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-release-"));
	temporary.push(directory);
	mkdirSync(join(directory, "runtime"));
	writeFileSync(join(directory, "runtime/node"), "runtime");
	writeFileSync(join(directory, "VERSION"), "0.0.1\n");
	writeReleaseChecksums(directory);
	const initial = readFileSync(join(directory, "SHA256SUMS"), "utf8");
	writeReleaseChecksums(directory);
	assert.equal(readFileSync(join(directory, "SHA256SUMS"), "utf8"), initial);
	const entries = initial.trim().split("\n");
	assert.equal(entries.length, 2);
	for (const entry of entries) {
		const [hash, path] = entry.split("  ");
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(directory, path)))
				.digest("hex"),
			hash,
		);
	}
});

test("rejects symlinks that could escape the verified payload", () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-release-"));
	temporary.push(directory);
	symlinkSync("/etc/passwd", join(directory, "escape"));
	assert.throws(() => releaseFiles(directory), /symlinks or special files/);
});

test("rejects external dependency drift while allowing packed local checkout packages", () => {
	const source = { packages: { "node_modules/known": { version: "1.0.0", integrity: "sha512-reviewed" } } };
	const local = new Set(["@earendil-works/pi-durable"]);
	assert.doesNotThrow(() =>
		verifyExternalResolutions(
			source,
			{
				packages: {
					"": {},
					"node_modules/known": { version: "1.0.0", integrity: "sha512-reviewed" },
					"node_modules/@earendil-works/pi-durable": { version: "1.4.0", integrity: "sha512-current-checkout" },
				},
			},
			local,
		),
	);
	assert.throws(
		() =>
			verifyExternalResolutions(
				source,
				{ packages: { "node_modules/known": { version: "1.0.1", integrity: "sha512-new" } } },
				local,
			),
		/Unreviewed release dependency/,
	);
});
