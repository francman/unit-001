// Exercises anonymous post-publication verification against real signed fixture metadata.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateRepositoryKeys, prepareRepository } from "../scripts/update-repository.mjs";
import { verifyPublicMetadata } from "../scripts/verify-public-metadata.mjs";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "unit-public-metadata-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const keys = join(directory, "keys"),
		rootBytes = generateRepositoryKeys(keys);
	const archive = join(directory, "unit-001-0.0.1-linux-x64.tar.gz");
	writeFileSync(archive, "fixture archive");
	const publication = prepareRepository({
		archive,
		rootBytes,
		keys,
		out: join(directory, "publication"),
		release: {
			version: "0.0.1",
			platform: "linux-x64",
			source: { commit: "a".repeat(40), dirty: false },
			compatibility: { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 },
		},
	});
	return {
		...publication,
		rootBytes,
		readAsset: async (name) => {
			const bytes = publication.files[name];
			assert.ok(bytes, `Unexpected metadata request: ${name}`);
			return bytes;
		},
	};
}

// #18: a successful receipt means verified public metadata, not an unperformed archive install or model request.
test("verifies the exact fresh signed chain and source descriptor without requesting the archive", async (t) => {
	const f = fixture(t);
	const receipt = await verifyPublicMetadata(f.rootBytes, f.readAsset);
	assert.equal(receipt.metadataOnly, true);
	assert.equal(receipt.rootVersion, 1);
	assert.equal(receipt.timestampVersion, 1);
	assert.equal(receipt.release, "0.0.1");
	assert.equal(receipt.sourceCommit, "a".repeat(40));
	assert.match(receipt.archiveSha256, /^[a-f0-9]{64}$/);
	assert.ok(Date.parse(receipt.expires) > Date.now());
});

// #18: unauthenticated transport success cannot turn tampering or expiry into a successful renewal.
test("rejects a modified snapshot, descriptor and expired freshness", async (t) => {
	const f = fixture(t);
	await assert.rejects(
		verifyPublicMetadata(f.rootBytes, async (name) =>
			name.endsWith(".snapshot.json") ? Buffer.from("tampered") : f.readAsset(name),
		),
		/length|hash/i,
	);
	await assert.rejects(
		verifyPublicMetadata(f.rootBytes, async (name) =>
			name.endsWith(".stable.json") ? Buffer.from("tampered") : f.readAsset(name),
		),
		/length|hash/i,
	);
	await assert.rejects(
		verifyPublicMetadata(f.rootBytes, f.readAsset, new Date(Date.now() + 3 * 86400000)),
		/freshness metadata has expired/,
	);
});

// #18: an unrelated bootstrap key cannot authenticate the same public metadata.
test("rejects a different root and unavailable public assets", async (t) => {
	const f = fixture(t);
	const directory = mkdtempSync(join(tmpdir(), "unit-other-root-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	generateRepositoryKeys(join(directory, "keys"));
	await assert.rejects(verifyPublicMetadata(readFileSync(join(directory, "keys/root.json")), f.readAsset));
	await assert.rejects(
		verifyPublicMetadata(f.rootBytes, async () => {
			throw new Error("HTTP unavailable");
		}),
		/HTTP unavailable/,
	);
});
