// Verifies immutable model-data archive integrity without reaching a live provider or catalog endpoint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { addHistoricalModels, verifyModelDataSource, verifyPinnedArchive } from "../scripts/hydrate-model-data.mjs";

const directories = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// #35: changed cached/downloaded bytes must fail before extraction or provider-data replacement.
test("accepts exact pinned bytes and rejects drift or an invalid hash", async () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-model-data-test-"));
	directories.push(directory);
	const path = join(directory, "archive");
	const bytes = Buffer.from("reviewed archive");
	writeFileSync(path, bytes);
	const hash = createHash("sha256").update(bytes).digest("hex");
	await verifyPinnedArchive(path, hash);
	writeFileSync(path, "changed");
	await assert.rejects(verifyPinnedArchive(path, hash), /reviewed model-data pin/);
	await assert.rejects(verifyPinnedArchive(path, "../../live"), /Invalid reviewed/);
	await assert.rejects(verifyPinnedArchive(path, undefined), /Invalid reviewed/);
});

// #35: integrity verification does not authorize special files or unbounded archives.
test("rejects symlinks and archives over the bound", async () => {
	const directory = mkdtempSync(join(tmpdir(), "unit-model-data-test-"));
	directories.push(directory);
	const path = join(directory, "archive"),
		link = join(directory, "link");
	writeFileSync(path, "archive");
	symlinkSync(path, link);
	await assert.rejects(verifyPinnedArchive(link, "0".repeat(64)), /regular archive/);
	truncateSync(path, 128 * 1024 * 1024 + 1);
	await assert.rejects(verifyPinnedArchive(path, "0".repeat(64)), /regular archive/);
});

// #35: the correction must not reintroduce every model removed from historical catalogs.
test("adds only reviewed identities and preserves released model metadata", () => {
	const current = { type: "chat", id: "current", api: "current-api" };
	const needed = { type: "chat", id: "needed", api: "historical-api" };
	const released = { provider: [current] };
	const historical = { provider: [{ ...current, api: "old-api" }, needed, { ...needed, id: "unrequested" }] };
	const additions = [{ provider: "provider", type: "chat", id: "needed" }];
	const result = addHistoricalModels(released, historical, additions);
	assert.deepEqual(result.provider, [current, needed]);
	assert.equal(result.provider[0], current);
	assert.deepEqual(released.provider, [current]);
	assert.equal(JSON.stringify(result), JSON.stringify(addHistoricalModels(released, historical, additions)));
});

// #35: changed pins require review rather than silently retiring or widening the historical correction.
test("rejects stale, absent, duplicate and malformed historical additions", () => {
	const entry = { type: "chat", id: "needed", api: "api" };
	const item = { provider: "provider", type: "chat", id: "needed" };
	assert.throws(() => addHistoricalModels({ provider: [entry] }, { provider: [entry] }, [item]), /already released/);
	assert.throws(() => addHistoricalModels({ provider: [] }, { provider: [] }, [item]), /missing or duplicated/);
	assert.throws(
		() => addHistoricalModels({ provider: [] }, { provider: [entry, entry] }, [item]),
		/missing or duplicated/,
	);
	assert.throws(
		() => addHistoricalModels({ provider: [] }, { provider: [entry] }, [item, item]),
		/Duplicate historical/,
	);
	assert.throws(() => addHistoricalModels({ provider: [] }, { provider: {} }, [item]), /provider is unavailable/);
	assert.throws(
		() => addHistoricalModels({ provider: [] }, { provider: [entry] }, [{ ...item, type: "invalid" }]),
		/Invalid historical/,
	);
});

// #35: the archive's own declared source must match the reviewed clean-release provenance.
test("rejects dirty or mismatched source and version declarations", () => {
	const pin = { release: "0.0.7", sourceCommit: "a".repeat(40) };
	const release = { version: "0.0.7", source: { commit: pin.sourceCommit, dirty: false } };
	verifyModelDataSource(release, pin);
	assert.throws(() => verifyModelDataSource({ ...release, version: "0.0.8" }, pin), /archive source differs/);
	assert.throws(
		() => verifyModelDataSource({ ...release, source: { ...release.source, dirty: true } }, pin),
		/archive source differs/,
	);
	assert.throws(
		() => verifyModelDataSource({ ...release, source: { ...release.source, commit: "b".repeat(40) } }, pin),
		/archive source differs/,
	);
});
