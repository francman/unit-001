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
	writeReleaseDocumentation,
	writeReleaseLauncher,
	writeUpdateBootstrap,
} from "../scripts/build-release.mjs";
import { generateRepositoryKeys } from "../scripts/update-repository.mjs";

const temporary = [];
afterEach(() => {
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("#36 bundled terminal design resolves its setup guide inside the signed documentation inventory", () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-release-docs-"));
	temporary.push(directory);
	writeReleaseDocumentation(directory);
	const design = readFileSync(join(directory, "docs/terminal-design.md"), "utf8");
	assert.match(design, /\]\(setup-experience\.md\)/);
	const setup = readFileSync(join(directory, "docs/setup-experience.md"));
	assert.deepEqual(setup, readFileSync(new URL("../docs/setup-experience.md", import.meta.url)));
	writeReleaseChecksums(directory);
	assert.match(readFileSync(join(directory, "SHA256SUMS"), "utf8"), /\.\/docs\/setup-experience\.md/);
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

test("#18 production bootstrap bundles public trust and a credential-free feed inside the release inventory", () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-release-"));
	temporary.push(directory);
	const stage = join(directory, "release"),
		keys = join(directory, "keys");
	mkdirSync(stage);
	const root = generateRepositoryKeys(keys);
	writeUpdateBootstrap(stage, join(keys, "root.json"));
	assert.deepEqual(releaseFiles(stage), ["deploy/update-feed.json", "deploy/update-root.json"]);
	assert.deepEqual(readFileSync(join(stage, "deploy/update-root.json")), root);
	assert.deepEqual(JSON.parse(readFileSync(join(stage, "deploy/update-feed.json"))), {
		schemaVersion: 1,
		repository: "francman/unit-001-releases",
		channel: "stable",
	});
	writeReleaseChecksums(stage);
	assert.match(readFileSync(join(stage, "SHA256SUMS"), "utf8"), /\.\/deploy\/update-root\.json/);
	assert(!releaseFiles(stage).some((name) => name.endsWith(".pem")));
});

test("#18 release bootstrap rejects private keys, expired trust, and tampered signatures; ordinary CI stays unconfigured", () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-release-"));
	temporary.push(directory);
	const stage = join(directory, "release"),
		keys = join(directory, "keys");
	mkdirSync(stage);
	writeUpdateBootstrap(stage);
	assert.deepEqual(releaseFiles(stage), []);
	generateRepositoryKeys(keys);
	assert.throws(() => writeUpdateBootstrap(stage, join(keys, "root.pem")), /Private signing keys/);
	const value = JSON.parse(readFileSync(join(keys, "root.json")));
	Object.values(value.signed.keys)[0].keyval.private = "must-not-ship";
	const unsafe = join(directory, "unsafe.json");
	writeFileSync(unsafe, JSON.stringify(value));
	assert.throws(() => writeUpdateBootstrap(stage, unsafe), /public Ed25519/);
	delete Object.values(value.signed.keys)[0].keyval.private;
	value.signed.version++;
	writeFileSync(unsafe, JSON.stringify(value));
	assert.throws(() => writeUpdateBootstrap(stage, unsafe));
	const expired = join(directory, "expired");
	generateRepositoryKeys(expired, new Date("2020-01-01T00:00:00Z"));
	assert.throws(() => writeUpdateBootstrap(stage, join(expired, "root.json")), /unexpired/);
	assert.deepEqual(releaseFiles(stage), []);
});
