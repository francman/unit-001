// Exercises signed publisher output through the real TUF client and a fake GitHub asset store.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { once } from "node:events";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Metadata, MetaFile, Signature, TargetFile } from "@tufjs/models";
import { Updater } from "tuf-js";
import { fetchUpdate } from "../deploy/update-trust.mjs";
import {
	DOWNLOAD_ASSET,
	DOWNLOAD_URL,
	fetchRepository,
	generateRepositoryKeys,
	METADATA_RELEASE,
	prepareRepository,
	pruneRepository,
	publishRepository,
	renewRepository,
	rotateRepositoryRoot,
	UPDATE_REPOSITORY,
} from "../scripts/update-repository.mjs";
import { verifyPublicMetadata } from "../scripts/verify-public-metadata.mjs";

function fixture(t) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "unit-publisher-")));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const keys = join(directory, "keys");
	const rootBytes = generateRepositoryKeys(keys);
	const archive = join(directory, "unit-001-0.0.1-linux-x64.tar.gz");
	writeFileSync(archive, "fixture archive bytes");
	const release = {
		version: "0.0.1",
		platform: "linux-x64",
		source: { commit: "a".repeat(40), dirty: false },
		compatibility: { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 },
	};
	const prepare = (name, extra = {}) => {
		const out = join(directory, name);
		const result = prepareRepository({ archive, release, rootBytes, keys, out, ...extra });
		return { ...result, out };
	};
	return { directory, keys, rootBytes, archive, release, prepare };
}

function fakeGithub() {
	const releases = new Map();
	const operations = [];
	let id = 0;
	return {
		releases,
		operations,
		assets(tag) {
			return releases.has(tag) ? [...releases.get(tag).values()] : null;
		},
		read(asset) {
			return asset.bytes;
		},
		create(tag, ...argumentsAfterTag) {
			assert.equal(argumentsAfterTag.length, 0, "Public release creation must never receive private source SHAs");
			assert(!releases.has(tag));
			releases.set(tag, new Map());
			operations.push(`create:${tag}`);
		},
		markLatest(tag) {
			assert.equal(tag.startsWith("unit-v"), true);
			assert(releases.get(tag).has(DOWNLOAD_ASSET));
			operations.push(`latest:${tag}`);
		},
		upload(tag, path, replace = false) {
			const name = path.split("/").at(-1);
			const entries = releases.get(tag);
			assert(replace || !entries.has(name));
			entries.set(name, { id: ++id, name, bytes: readFileSync(path) });
			operations.push(`${tag}:${name}`);
		},
		remove(tag, asset) {
			assert.equal(releases.get(tag).get(asset.name).id, asset.id);
			releases.get(tag).delete(asset.name);
			operations.push(`remove:${tag}:${asset.name}`);
		},
	};
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A passed qualify.mjs record for `candidate` against `reader`, both given as [version, archive path]. */
function qualification([candidate, candidateArchive], [reader, readerArchive]) {
	return {
		schemaVersion: 1,
		kind: "unit.full-owner-rollback",
		candidate: { version: candidate, archiveSha256: sha256(readFileSync(candidateArchive)) },
		reader: { version: reader, archiveSha256: sha256(readFileSync(readerArchive)) },
		scenarios: ["fresh", "version-2"],
		result: "passed",
	};
}

/**
 * Re-signs the targets, snapshot and timestamp that `directory`'s `timestamp.json` names after `edit` changes the
 * targets, as anyone holding the online keys could.
 */
function resign(directory, keys, edit) {
	const read = (role, name) => Metadata.fromJSON(role, JSON.parse(readFileSync(join(directory, name))));
	const write = (name, metadata, role) => {
		const key = createPrivateKey(readFileSync(join(keys, `${role}.pem`)));
		const [keyID] = Object.keys(metadata.signatures);
		metadata.sign((data) => new Signature({ keyID, sig: sign(null, data, key).toString("hex") }), false);
		const bytes = Buffer.from(`${JSON.stringify(metadata.toJSON(), null, 2)}\n`);
		writeFileSync(join(directory, name), bytes);
		return bytes;
	};
	const meta = (bytes, version) => new MetaFile({ version, length: bytes.length, hashes: { sha256: sha256(bytes) } });
	const timestamp = read("timestamp", "timestamp.json");
	const snapshotName = `${timestamp.signed.snapshotMeta.version}.snapshot.json`;
	const snapshot = read("snapshot", snapshotName);
	const targetsName = `${snapshot.signed.meta["targets.json"].version}.targets.json`;
	const targets = read("targets", targetsName);
	edit(targets.signed);
	snapshot.signed.meta["targets.json"] = meta(write(targetsName, targets, "targets"), targets.signed.version);
	timestamp.signed.snapshotMeta = meta(write(snapshotName, snapshot, "snapshot"), snapshot.signed.version);
	const bytes = write("timestamp.json", timestamp, "timestamp");
	writeFileSync(join(directory, `${timestamp.signed.version}.timestamp.json`), bytes);
}

async function client(t, f, publications, rootBytes = f.rootBytes, existingCache) {
	const server = createServer((request, response) => {
		const path = decodeURIComponent(request.url.slice(1));
		let bytes;
		if (path.startsWith("metadata/")) {
			for (const publication of publications) bytes = publication.files[path.slice(9)] ?? bytes;
		} else if (path.startsWith("targets/linux-x64/") && path.endsWith(".stable.json")) {
			const name = `linux-x64-${path.split("/").at(-1)}`;
			for (const publication of publications) bytes = publication.files[name] ?? bytes;
		} else if (path.startsWith("targets/linux-x64/releases/")) bytes = readFileSync(f.archive);
		if (bytes === undefined) {
			response.writeHead(404);
			response.end();
		} else response.end(bytes);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const cache = existingCache ?? join(f.directory, `cache-${Math.random()}`);
	if (!existsSync(cache)) {
		mkdirSync(cache);
		writeFileSync(join(cache, "root.json"), rootBytes);
	}
	const url = `http://127.0.0.1:${server.address().port}`;
	return new Updater({
		metadataDir: cache,
		targetDir: cache,
		metadataBaseUrl: `${url}/metadata`,
		targetBaseUrl: `${url}/targets`,
		config: { fetchRetries: 0 },
	});
}

// #18: bootstrap must never silently overwrite signing material.
test("explicit key generation protects keys and refuses overwrite", (t) => {
	const f = fixture(t);
	assert.equal(statSync(f.keys).mode & 0o777, 0o700);
	assert.equal(statSync(join(f.keys, "root.pem")).mode & 0o777, 0o600);
	assert.throws(() => generateRepositoryKeys(f.keys), /EEXIST/);
});

// #18: exercise standard TUF signature, hash, expiry, and root rotation verification.
test("real TUF client downloads authenticated descriptor and archive", async (t) => {
	const f = fixture(t);
	const publication = f.prepare("first");
	const updater = await client(t, f, [publication]);
	await updater.refresh();
	const info = await updater.getTargetInfo("linux-x64/stable.json");
	const descriptor = JSON.parse(readFileSync(await updater.downloadTarget(info)));
	assert.deepEqual(descriptor, publication.descriptor);
	const archive = await updater.getTargetInfo(descriptor.archiveTarget);
	assert.equal(archive.custom.releaseTag, "unit-v0.0.1");
	assert.deepEqual(readFileSync(await updater.downloadTarget(archive)), readFileSync(f.archive));
});

test("real TUF client refuses expired publication", async (t) => {
	const f = fixture(t);
	const old = new Date(Date.now() - 3 * 86400000);
	const updater = await client(t, f, [f.prepare("expired", { now: old })]);
	await assert.rejects(updater.refresh(), /expired/i);
});

test("real TUF client rejects metadata tampering and rollback after an accepted renewal", async (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const second = f.prepare("second", { previous: first.out });
	const publications = [first];
	const cache = join(f.directory, "reopen-cache");
	const updater = await client(t, f, publications, f.rootBytes, cache);
	await updater.refresh();
	publications.push(second);
	await (await client(t, f, publications, f.rootBytes, cache)).refresh();
	publications.pop();
	await assert.rejects((await client(t, f, publications, f.rootBytes, cache)).refresh(), /version|rollback/i);
	const corrupted = { ...first, files: { ...first.files, "1.targets.json": Buffer.from("tampered") } };
	const refused = await client(t, f, [corrupted]);
	await assert.rejects(refused.refresh(), /hash|length/i);
});

test("real TUF client accepts cross-signed root rotation and rejects missing old signature", async (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const newKeys = join(f.directory, "new-keys");
	generateRepositoryKeys(newKeys);
	const rootBytes = rotateRepositoryRoot(f.rootBytes, f.keys, newKeys);
	const second = f.prepare("second", {
		rootBytes,
		keys: newKeys,
		previous: first.out,
		previousRootBytes: f.rootBytes,
	});
	const updater = await client(t, f, [first, second]);
	await updater.refresh();
	assert(await updater.getTargetInfo("linux-x64/stable.json"));
	const broken = JSON.parse(rootBytes);
	broken.signatures = broken.signatures.slice(1);
	second.files["2.root.json"] = Buffer.from(JSON.stringify(broken));
	const refused = await client(t, f, [first, second]);
	await assert.rejects(refused.refresh(), /signed|signature/i);
});

// #18: interrupted publication is retryable without rewriting immutable assets.
test("publishes archive and immutable metadata before freshness; repeat is idempotent", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const remote = fakeGithub();
	publishRepository(first.out, f.rootBytes, remote);
	assert.equal(remote.operations.at(-1), "latest:unit-v0.0.1");
	assert(
		remote.operations.indexOf(`${METADATA_RELEASE}:timestamp.json`) < remote.operations.indexOf("latest:unit-v0.0.1"),
	);
	assert(
		remote.operations.indexOf("unit-v0.0.1:unit-001-0.0.1-linux-x64.tar.gz") <
			remote.operations.indexOf(`${METADATA_RELEASE}:timestamp.json`),
	);
	publishRepository(first.out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const second = f.prepare("second", { previous });
	publishRepository(second.out, f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 2);
});

// #18: users receive one stable URL; promotion must wait for the signed release to be complete.
test("stable download is the exact signed archive and never becomes latest before freshness", (t) => {
	const f = fixture(t);
	assert.equal(UPDATE_REPOSITORY, "francman/unit-001-releases");
	assert.equal(
		DOWNLOAD_URL,
		"https://github.com/francman/unit-001-releases/releases/latest/download/unit-001-linux-x64.tar.gz",
	);
	const first = f.prepare("direct-download");
	assert.deepEqual(readFileSync(join(first.out, DOWNLOAD_ASSET)), readFileSync(f.archive));
	const remote = fakeGithub();
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith(`/${DOWNLOAD_ASSET}`)) throw new Error("download alias interrupted");
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(first.out, f.rootBytes, remote), /alias interrupted/);
	assert(!remote.operations.some((entry) => entry.startsWith("latest:")));
	assert.equal(remote.assets(METADATA_RELEASE), null);
	remote.upload = upload;
	publishRepository(first.out, f.rootBytes, remote);
	assert.deepEqual(remote.releases.get("unit-v0.0.1").get(DOWNLOAD_ASSET).bytes, readFileSync(f.archive));
	assert(
		remote.operations.indexOf(`unit-v0.0.1:${DOWNLOAD_ASSET}`) <
			remote.operations.indexOf(`${METADATA_RELEASE}:timestamp.json`),
	);
	assert(
		remote.operations.indexOf(`${METADATA_RELEASE}:timestamp.json`) < remote.operations.indexOf("latest:unit-v0.0.1"),
	);
	writeFileSync(join(first.out, DOWNLOAD_ASSET), "substituted alias");
	assert.throws(() => publishRepository(first.out, f.rootBytes, remote), /alias differs/);
	assert.throws(() => f.prepare("wrong-source", { expectedSourceCommit: "b".repeat(40) }), /trusted build checkout/);
});

// #18: public releases bundle trust automatically and remain bound to the private trusted build without leaking git objects.
test("production prepare requires the trusted checkout and exact bundled public bootstrap", (t) => {
	const f = fixture(t);
	const name = "unit-001-0.0.1-linux-x64";
	const payload = join(f.directory, "payload");
	const deploy = join(payload, name, "deploy");
	mkdirSync(deploy, { recursive: true });
	writeFileSync(join(payload, name, "release.json"), JSON.stringify(f.release));
	writeFileSync(join(deploy, "update-root.json"), f.rootBytes);
	writeFileSync(
		join(deploy, "update-feed.json"),
		JSON.stringify({ schemaVersion: 1, repository: UPDATE_REPOSITORY, channel: "stable" }),
	);
	const archive = () =>
		execFileSync("tar", ["-czf", f.archive, "-C", payload, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
	archive();
	const tool = fileURLToPath(new URL("../scripts/update-repository.mjs", import.meta.url));
	const args = [tool, "prepare", "--archive", f.archive, "--root", join(f.keys, "root.json"), "--keys", f.keys];
	const run = (out, extra = []) =>
		execFileSync(process.execPath, [...args, "--out", join(f.directory, out), ...extra], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	assert.throws(() => run("missing-source"), /requires --source-commit/);
	assert.throws(() => run("wrong-checkout", ["--source-commit", "b".repeat(40)]), /trusted build checkout/);
	run("valid-public", ["--source-commit", f.release.source.commit]);
	const plan = JSON.parse(readFileSync(join(f.directory, "valid-public/publication.json")));
	assert.equal(plan.sourceCommit, f.release.source.commit);
	assert.equal(plan.repository, UPDATE_REPOSITORY);
	writeFileSync(join(deploy, "update-root.json"), Buffer.from("different approved root"));
	archive();
	assert.throws(() => run("wrong-root", ["--source-commit", f.release.source.commit]), /approved verification root/);
});

test("stale publisher and changed immutable release cannot advance timestamp", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const stale = f.prepare("stale");
	const remote = fakeGithub();
	publishRepository(first.out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	publishRepository(f.prepare("second", { previous }).out, f.rootBytes, remote);
	assert.throws(() => publishRepository(stale.out, f.rootBytes, remote), /state changed/);
	writeFileSync(f.archive, "changed archive");
	assert.throws(() => f.prepare("changed", { previous }), /different archive/);
});

test("interruption before timestamp leaves old freshness and can retry the same plan", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const remote = fakeGithub();
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("timestamp.json")) throw new Error("interrupted");
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(first.out, f.rootBytes, remote), /interrupted/);
	assert(!remote.releases.get(METADATA_RELEASE).has("timestamp.json"));
	remote.upload = upload;
	publishRepository(first.out, f.rootBytes, remote);
	assert(remote.releases.get(METADATA_RELEASE).has("timestamp.json"));
});

test("rejects unsupported compatibility, dirty source, and stable downgrade", (t) => {
	const f = fixture(t);
	assert.throws(
		() => f.prepare("dirty", { release: { ...f.release, source: { ...f.release.source, dirty: true } } }),
		/clean/,
	);
	assert.throws(
		() =>
			f.prepare("compatibility", {
				release: { ...f.release, compatibility: { ...f.release.compatibility, stateVersion: 2 } },
			}),
		/reviewed/,
	);
	assert.throws(
		() =>
			f.prepare("malformed-features", {
				release: { ...f.release, compatibility: { ...f.release.compatibility, features: "mission-loop" } },
			}),
		/Invalid signed compatibility contract/,
	);
	assert.throws(
		() =>
			f.prepare("oversized", {
				release: { ...f.release, compatibility: { ...f.release.compatibility, extra: "x".repeat(16384) } },
			}),
		/descriptor exceeds/,
	);
	const first = f.prepare("first");
	const archive = join(f.directory, "unit-001-0.0.0-linux-x64.tar.gz");
	copyFileSync(f.archive, archive);
	assert.throws(
		() => f.prepare("downgrade", { previous: first.out, archive, release: { ...f.release, version: "0.0.0" } }),
		/downgrade/,
	);
});

// #18: a valid signature does not make an unsupported descriptor or archive usable by the updater.
test("checks signed descriptor and archive contracts before applying publisher compatibility policy", async (t) => {
	const f = fixture(t);
	for (const { name, changes, archiveChanges, publisherError } of [
		{
			name: "malformed",
			changes: { features: "mission-loop" },
			publisherError: /Invalid signed compatibility contract/,
		},
		{
			name: "newer-policy",
			changes: { stateVersion: 2, maintenanceProtocol: 2, features: ["mission-loop"] },
			publisherError: /explicitly reviewed supported policy/,
		},
		{
			name: "oversized-descriptor",
			changes: { padding: "x".repeat(16_384) },
			publisherError: /descriptor exceeds/,
		},
		{
			name: "oversized-archive-target",
			archiveChanges: { length: 512 * 1024 * 1024 + 1 },
			publisherError: /oversized signed archive target/,
		},
		{
			name: "wrong-archive-location",
			archiveChanges: { custom: { releaseTag: "other", assetName: "other.tar.gz" } },
			publisherError: /Signed archive location does not match/,
		},
	]) {
		const stage = f.prepare(name);
		const descriptor = {
			...stage.descriptor,
			compatibility: { ...stage.descriptor.compatibility, ...changes },
		};
		const bytes = Buffer.from(JSON.stringify(descriptor));
		const hash = sha256(bytes);
		const descriptorName = `linux-x64-${hash}.stable.json`;
		writeFileSync(join(stage.out, descriptorName), bytes);
		resign(stage.out, f.keys, (targets) => {
			targets.addTarget(new TargetFile({ path: "linux-x64/stable.json", length: bytes.length, hashes: { sha256: hash } }));
			if (archiveChanges) {
				const target = targets.targets[descriptor.archiveTarget];
				targets.addTarget(TargetFile.fromJSON(descriptor.archiveTarget, { ...target.toJSON(), ...archiveChanges }));
			}
		});
		const receipt = verifyPublicMetadata(f.rootBytes, async (asset) => readFileSync(join(stage.out, asset)));
		if (name === "newer-policy") assert.equal((await receipt).release, descriptor.version);
		else await assert.rejects(receipt, publisherError);
		const remote = fakeGithub();
		assert.throws(() => publishRepository(stage.out, f.rootBytes, remote), publisherError);
		assert.deepEqual(remote.operations, []);

		// Simulate an existing feed signed by an older publisher.
		remote.create(METADATA_RELEASE);
		for (const asset of [...Object.keys(stage.files).filter((asset) => !asset.endsWith(".stable.json")), descriptorName])
			remote.upload(METADATA_RELEASE, join(stage.out, asset));
		remote.create("unit-v0.0.1");
		remote.upload("unit-v0.0.1", f.archive);
		assert.throws(
			() => renewRepository({ out: join(f.directory, `${name}-renewal`), rootBytes: f.rootBytes, keys: f.keys }, remote),
			publisherError,
		);
	}
});

// #72: automatic rollout must not promise a rollback that was never qualified with the exact artifacts.
test("a new stable version needs a passed rollback qualification of its archive against every earlier release", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const archive = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archive, "second archive bytes");
	const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const qualified = {
		schemaVersion: 1,
		kind: "unit.full-owner-rollback",
		candidate: { version: "0.0.2", archiveSha256: sha256(archive) },
		reader: { version: "0.0.1", archiveSha256: sha256(f.archive) },
		scenarios: ["fresh", "version-2"],
		result: "passed",
	};
	const second = (name, rollbackQualification) =>
		f.prepare(name, {
			previous: first.out,
			archive,
			release: { ...f.release, version: "0.0.2" },
			...(rollbackQualification === undefined ? {} : { rollbackQualification }),
		});
	assert.throws(() => second("missing"), /requires a passed full-owner rollback qualification/);
	assert.throws(() => second("failed", [{ ...qualified, result: "failed" }]), /requires a passed/);
	assert.throws(() => second("one-scenario", [{ ...qualified, scenarios: ["fresh"] }]), /requires a passed/);
	// A string would satisfy `.includes` for both names; only the array qualify.mjs writes is accepted.
	assert.throws(() => second("string-scenarios", [{ ...qualified, scenarios: "fresh version-2" }]), /requires a passed/);
	assert.throws(
		() => second("checkout", [{ ...qualified, candidate: { version: "0.0.2", archiveSha256: null } }]),
		/exact release archive/,
	);
	assert.throws(
		() => second("other-reader", [{ ...qualified, reader: { version: "0.0.1", archiveSha256: "0".repeat(64) } }]),
		/published 0\.0\.1 archive/,
	);
	assert.equal(second("qualified", [qualified]).descriptor.version, "0.0.2");
	// Renewing an already published version re-signs it; it is not a new rollout.
	assert.equal(f.prepare("renewed", { previous: first.out }).descriptor.version, "0.0.1");
});

// The updater accepts every installed release with the supported compatibility numbers as a source, so an
// installation can skip versions; every earlier release must be qualified, not only the newest one.
test("a new stable version needs a qualification for every earlier published release", (t) => {
	const f = fixture(t);
	const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const remote = fakeGithub();
	const archives = { "0.0.1": f.archive };
	const publish = (version, name, records) => {
		if (version !== "0.0.1") {
			archives[version] = join(f.directory, `unit-001-${version}-linux-x64.tar.gz`);
			writeFileSync(archives[version], `archive bytes ${version}`);
		}
		const previous = join(f.directory, `previous-${name}`);
		fetchRepository(previous, remote);
		const staged = f.prepare(name, {
			previous,
			archive: archives[version],
			release: { ...f.release, version },
			...(records === undefined ? {} : { rollbackQualification: records }),
		});
		publishRepository(staged.out, f.rootBytes, remote);
	};
	const record = (candidate, reader) => ({
		schemaVersion: 1,
		kind: "unit.full-owner-rollback",
		candidate: { version: candidate, archiveSha256: sha256(archives[candidate]) },
		reader: { version: reader, archiveSha256: sha256(archives[reader]) },
		scenarios: ["fresh", "version-2"],
		result: "passed",
	});
	publish("0.0.1", "one");
	archives["0.0.2"] = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archives["0.0.2"], "archive bytes 0.0.2");
	publish("0.0.2", "two", [record("0.0.2", "0.0.1")]);
	archives["0.0.3"] = join(f.directory, "unit-001-0.0.3-linux-x64.tar.gz");
	writeFileSync(archives["0.0.3"], "archive bytes 0.0.3");
	// Qualifying only the immediate predecessor leaves a 0.0.1 installation's skip-version rollback unproven.
	assert.throws(() => publish("0.0.3", "newest-only", [record("0.0.3", "0.0.2")]), /missing for earlier release 0\.0\.1/);
	assert.throws(() => publish("0.0.3", "oldest-only", [record("0.0.3", "0.0.1")]), /missing for earlier release 0\.0\.2/);
	assert.throws(
		() => publish("0.0.3", "duplicate", [record("0.0.3", "0.0.1"), record("0.0.3", "0.0.2"), record("0.0.3", "0.0.2")]),
		/must use the published 0\.0\.2 archive/,
	);
	assert.throws(
		() =>
			publish("0.0.3", "stranger", [
				record("0.0.3", "0.0.1"),
				record("0.0.3", "0.0.2"),
				{ ...record("0.0.3", "0.0.2"), reader: { version: "0.0.9", archiveSha256: "0".repeat(64) } },
			]),
		/not an earlier published release/,
	);
	assert(!remote.releases.has("unit-v0.0.3"));
	publish("0.0.3", "all", [record("0.0.3", "0.0.1"), record("0.0.3", "0.0.2")]);
	assert(remote.releases.get("unit-v0.0.3").has("unit-001-0.0.3-linux-x64.tar.gz"));
});

// Publication, not only preparation, is the release gate: a stage signed without the gate must not go out.
test("publish refuses a new stable version whose staged qualification is missing or does not match", (t) => {
	const f = fixture(t);
	const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const archive = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archive, "second archive bytes");
	const qualified = {
		schemaVersion: 1,
		kind: "unit.full-owner-rollback",
		candidate: { version: "0.0.2", archiveSha256: sha256(archive) },
		reader: { version: "0.0.1", archiveSha256: sha256(f.archive) },
		scenarios: ["fresh", "version-2"],
		result: "passed",
	};
	const stage = (name) =>
		f.prepare(name, {
			previous,
			archive,
			release: { ...f.release, version: "0.0.2" },
			rollbackQualification: [qualified],
		}).out;
	const receipt = (out) => join(out, "rollback-qualification.json");
	const edit = (out, change) => writeFileSync(receipt(out), `${JSON.stringify(change(JSON.parse(readFileSync(receipt(out)))))}\n`);
	const before = JSON.stringify([...remote.releases.keys()]);
	// A stage signed by a publisher that predates the gate has no receipt.
	const missing = stage("missing");
	rmSync(receipt(missing));
	assert.throws(() => publishRepository(missing, f.rootBytes, remote), /no rollback qualification receipt/);
	// A receipt that no longer names the signed archive's reader.
	const wrongReader = stage("wrong-reader");
	edit(wrongReader, (value) => ({
		...value,
		records: [{ ...value.records[0], reader: { version: "0.0.1", archiveSha256: "0".repeat(64) } }],
	}));
	assert.throws(() => publishRepository(wrongReader, f.rootBytes, remote), /published 0\.0\.1 archive/);
	// A receipt emptied of its records.
	const emptied = stage("emptied");
	edit(emptied, (value) => ({ ...value, records: [] }));
	assert.throws(() => publishRepository(emptied, f.rootBytes, remote), /requires a passed full-owner rollback/);
	// A receipt qualified for different candidate bytes.
	const otherCandidate = stage("other-candidate");
	edit(otherCandidate, (value) => ({
		...value,
		records: [{ ...value.records[0], candidate: { version: "0.0.2", archiveSha256: "1".repeat(64) } }],
	}));
	assert.throws(() => publishRepository(otherCandidate, f.rootBytes, remote), /exact release archive/);
	// A receipt for another archive.
	const otherArchive = stage("other-archive");
	edit(otherArchive, (value) => ({ ...value, archiveSha256: "2".repeat(64) }));
	assert.throws(() => publishRepository(otherArchive, f.rootBytes, remote), /does not match the signed archive/);
	// A new version cannot pose as a renewal: its archive is not on the feed.
	const posing = stage("posing");
	edit(posing, (value) => ({ ...value, renewal: true, records: [] }));
	assert.throws(() => publishRepository(posing, f.rootBytes, remote), /claims a renewal/);
	assert.equal(JSON.stringify([...remote.releases.keys()]), before);
	assert(!remote.operations.some((entry) => entry.includes("0.0.2")));
	publishRepository(stage("valid"), f.rootBytes, remote);
	assert(remote.releases.get("unit-v0.0.2").has("unit-001-0.0.2-linux-x64.tar.gz"));
});

// Bootstrap and renewal are derived from what the feed authenticates, not from the stage's own claims.
test("publish refuses a stage that drops a served release or poses as a renewal of an orphaned upload", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const archive = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archive, "second archive bytes");
	const second = { archive, release: { ...f.release, version: "0.0.2" } };
	const touched = () => remote.operations.filter((entry) => entry.includes("0.0.2"));
	// An interrupted freshness replacement deleted timestamp.json. A stage prepared without `previous` looks like a
	// first publication (no earlier release, so no record), but the feed still serves 0.0.1 through its newest receipt.
	const live = remote.releases.get(METADATA_RELEASE).get("timestamp.json");
	remote.releases.get(METADATA_RELEASE).delete("timestamp.json");
	const bootstrap = f.prepare("bootstrap", second);
	assert.throws(() => publishRepository(bootstrap.out, f.rootBytes, remote), /drops or changes linux-x64\/releases\/0\.0\.1/);
	assert.deepEqual(touched(), []);
	assert(!remote.releases.has("unit-v0.0.2"));
	remote.releases.get(METADATA_RELEASE).set("timestamp.json", live);
	// An archive uploaded outside the gate is not a renewal: the live metadata does not pin it.
	remote.create("unit-v0.0.2");
	remote.releases.get("unit-v0.0.2").set("unit-001-0.0.2-linux-x64.tar.gz", {
		id: 900,
		name: "unit-001-0.0.2-linux-x64.tar.gz",
		bytes: readFileSync(archive),
	});
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const qualified = {
		schemaVersion: 1,
		kind: "unit.full-owner-rollback",
		candidate: { version: "0.0.2", archiveSha256: sha256(archive) },
		reader: { version: "0.0.1", archiveSha256: sha256(f.archive) },
		scenarios: ["fresh", "version-2"],
		result: "passed",
	};
	const posing = f.prepare("posing", { ...second, previous, rollbackQualification: [qualified] });
	const receipt = join(posing.out, "rollback-qualification.json");
	writeFileSync(receipt, `${JSON.stringify({ ...JSON.parse(readFileSync(receipt)), renewal: true, records: [] })}\n`);
	assert.throws(() => publishRepository(posing.out, f.rootBytes, remote), /does not serve this archive/);
	assert(!remote.operations.some((entry) => entry.startsWith("latest:unit-v0.0.2")));
});

// What publish validates must be what it uploads: a stage file swapped after validation must not ship.
test("publish uploads the bytes it validated even if the stage changes afterwards", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const remote = fakeGithub();
	const original = {
		archive: readFileSync(f.archive),
		targets: readFileSync(join(first.out, "1.targets.json")),
	};
	const assets = remote.assets.bind(remote);
	let swapped = false;
	remote.assets = (tag) => {
		if (!swapped) {
			swapped = true;
			for (const path of [f.archive, join(first.out, DOWNLOAD_ASSET)]) writeFileSync(path, "swapped archive");
			writeFileSync(join(first.out, "1.targets.json"), "swapped targets");
		}
		return assets(tag);
	};
	publishRepository(first.out, f.rootBytes, remote);
	assert(swapped);
	assert.deepEqual(remote.releases.get("unit-v0.0.1").get("unit-001-0.0.1-linux-x64.tar.gz").bytes, original.archive);
	assert.deepEqual(remote.releases.get("unit-v0.0.1").get(DOWNLOAD_ASSET).bytes, original.archive);
	assert.deepEqual(remote.releases.get(METADATA_RELEASE).get("1.targets.json").bytes, original.targets);
});

// qualify.mjs hashes the archive it qualifies; a swap between hashing and extraction must not split the two.
test("qualify.mjs extracts the same bytes it hashes", (t) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "unit-qualify-")));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const release = (version, name) => {
		const top = `unit-001-${version}-linux-x64`;
		mkdirSync(join(directory, name, top), { recursive: true });
		writeFileSync(join(directory, name, top, "release.json"), JSON.stringify({ version, platform: "linux-x64" }));
		const path = join(directory, `${name}.tar.gz`);
		execFileSync("tar", ["-czf", path, "-C", join(directory, name), top], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		return path;
	};
	const reader = release("0.0.1", "reader");
	const candidate = release("0.0.2", "candidate");
	const swap = release("9.9.9", "swap");
	// Shims on PATH: docker runs nothing, except that copying state out leaves a transcript-only reader's record; the
	// first tar replaces the reader archive just as the race would.
	const shims = join(directory, "shims");
	mkdirSync(shims);
	const realTar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
	const readerRecord = `'{"coverage":["transcript"]}'`;
	writeFileSync(
		join(shims, "docker"),
		`#!/bin/sh\nif [ "$1" = cp ] && [ "\${2#*:}" = /fixture/state ]; then mkdir -p "$3" && printf %s ${readerRecord} > "$3/session.sqlite.reader.json"; fi\nexit 0\n`,
		{ mode: 0o755 },
	);
	writeFileSync(join(shims, "tar"), `#!/bin/sh\ncp "${swap}" "${reader}"\nexec "${realTar}" "$@"\n`, { mode: 0o755 });
	const readerDigest = sha256(reader);
	const record = join(directory, "record.json");
	const script = fileURLToPath(new URL("./rollback/qualify.mjs", import.meta.url));
	execFileSync(
		process.execPath,
		[script, "--reader", reader, "--candidate", candidate, "--image", "fixture", "--work", join(directory, "work"), "--record", record],
		{ env: { ...process.env, PATH: `${shims}:${process.env.PATH}` }, stdio: "pipe" },
	);
	const written = JSON.parse(readFileSync(record));
	assert.equal(written.reader.archiveSha256, readerDigest);
	assert.equal(written.reader.version, "0.0.1");
	assert.equal(written.candidate.archiveSha256, sha256(candidate));
});

// prepare reads the archive once: a swap at the path between member extraction, hashing and the download alias must not
// bind one build's archive to another build's descriptor.
test("production prepare signs and aliases the same archive bytes it checked", (t) => {
	const f = fixture(t);
	const name = "unit-001-0.0.1-linux-x64";
	const build = (label, extra) => {
		const payload = join(f.directory, label);
		mkdirSync(join(payload, name, "deploy"), { recursive: true });
		writeFileSync(join(payload, name, "release.json"), JSON.stringify(f.release));
		writeFileSync(join(payload, name, "deploy/update-root.json"), f.rootBytes);
		writeFileSync(
			join(payload, name, "deploy/update-feed.json"),
			JSON.stringify({ schemaVersion: 1, repository: UPDATE_REPOSITORY, channel: "stable" }),
		);
		if (extra !== undefined) writeFileSync(join(payload, name, "extra.txt"), extra);
		const path = join(f.directory, `${label}.tar.gz`);
		execFileSync("tar", ["-czf", path, "-C", payload, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		return path;
	};
	copyFileSync(build("build-a"), f.archive);
	const other = build("build-b", "a different build");
	const checked = readFileSync(f.archive);
	// Every tar run is followed by a swap of the archive at its path, as a concurrent writer could do.
	const shims = join(f.directory, "shims");
	mkdirSync(shims);
	const realTar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
	writeFileSync(join(shims, "tar"), `#!/bin/sh\n"${realTar}" "$@"\nstatus=$?\ncp "${other}" "${f.archive}"\nexit $status\n`, {
		mode: 0o755,
	});
	const tool = fileURLToPath(new URL("../scripts/update-repository.mjs", import.meta.url));
	const out = join(f.directory, "stage");
	execFileSync(
		process.execPath,
		[tool, "prepare", "--archive", f.archive, "--root", join(f.keys, "root.json"), "--keys", f.keys]
			.concat(["--out", out, "--source-commit", f.release.source.commit]),
		{ env: { ...process.env, PATH: `${shims}:${process.env.PATH}` }, stdio: "pipe" },
	);
	assert.notDeepEqual(readFileSync(f.archive), checked, "the swap happened");
	const targets = JSON.parse(readFileSync(join(out, "1.targets.json"))).signed.targets;
	assert.equal(targets["linux-x64/releases/0.0.1.tar.gz"].hashes.sha256, sha256(checked));
	assert.deepEqual(readFileSync(join(out, DOWNLOAD_ASSET)), checked);
	// The swapped path now fails publication's signed-hash check instead of shipping.
	assert.throws(() => publishRepository(out, f.rootBytes, fakeGithub()), /Archive publication plan mismatch/);
});

// A rotation interrupted after its root went out but before freshness leaves the old timestamp live, signed under the
// previous root. Retrying must finish the rotation, and a stage under the old root must not roll the feed back.
test("a retry after the rotated root went out completes the rotation and refuses the old root", (t) => {
	for (const retry of ["same stage", "prepared again"]) {
		const f = fixture(t);
		const remote = fakeGithub();
		publishRepository(f.prepare("first").out, f.rootBytes, remote);
		const newKeys = join(f.directory, "rotated-keys");
		generateRepositoryKeys(newKeys);
		const rootBytes = rotateRepositoryRoot(f.rootBytes, f.keys, newKeys);
		const previous = join(f.directory, "previous");
		fetchRepository(previous, remote);
		const rotation = { rootBytes, keys: newKeys, previousRootBytes: f.rootBytes };
		const rotated = f.prepare("rotated", { ...rotation, previous });
		const entries = remote.releases.get(METADATA_RELEASE);
		const live = entries.get("timestamp.json").bytes;
		const upload = remote.upload.bind(remote);
		remote.upload = (tag, path, replace) => {
			if (path.endsWith("/timestamp.json")) throw new Error("interrupted before freshness");
			upload(tag, path, replace);
		};
		assert.throws(() => publishRepository(rotated.out, rootBytes, remote), /interrupted before freshness/);
		remote.upload = upload;
		assert(entries.has("2.root.json"), retry);
		assert.deepEqual(entries.get("timestamp.json").bytes, live);
		// The root is the last immutable upload, so the fail-closed window before freshness is one upload long.
		const uploaded = remote.operations.filter((entry) => entry.startsWith(`${METADATA_RELEASE}:`));
		assert.equal(uploaded.at(-1), `${METADATA_RELEASE}:2.root.json`);
		// A stage signed under the old root cannot publish once the rotated root is out.
		const stale = f.prepare("stale", { previous });
		assert.throws(() => publishRepository(stale.out, f.rootBytes, remote), /newer root is already published/);
		let stage = rotated.out;
		if (retry === "prepared again") {
			const recovered = join(f.directory, "recovered");
			fetchRepository(recovered, remote);
			stage = f.prepare("again", { ...rotation, previous: recovered }).out;
		}
		publishRepository(stage, rootBytes, remote);
		const timestamp = Metadata.fromJSON("timestamp", JSON.parse(entries.get("timestamp.json").bytes));
		Metadata.fromJSON("root", JSON.parse(rootBytes)).verifyDelegate("timestamp", timestamp);
		assert.equal(timestamp.signed.version, retry === "same stage" ? 2 : 3, retry);
	}
});

// The numbered receipt goes out before the live pointer, so after a lost pointer the newest receipt may belong to a
// publication that never went live, possibly from a publisher that predates the gate. Only `timestamp.json` proves
// promotion, so only it can waive a renewal's qualification.
test("a renewal is waived only by the live timestamp, never by a numbered receipt", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const archive = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archive, "second archive bytes");
	const second = { archive, release: { ...f.release, version: "0.0.2" } };
	const records = [qualification(["0.0.2", archive], ["0.0.1", f.archive])];
	const fetched = (name) => {
		const previous = join(f.directory, name);
		fetchRepository(previous, remote);
		return previous;
	};
	// A pre-gate publisher uploaded 0.0.2 and its metadata; its freshness replacement deleted the live pointer and failed.
	const pregate = f.prepare("pre-gate", { ...second, previous: fetched("before"), rollbackQualification: records });
	remote.create("unit-v0.0.2");
	remote.upload("unit-v0.0.2", archive);
	const entries = remote.releases.get(METADATA_RELEASE);
	for (const name of Object.keys(pregate.files))
		if (name !== "timestamp.json" && !entries.has(name)) remote.upload(METADATA_RELEASE, join(pregate.out, name));
	entries.delete("timestamp.json");
	// Recovery fetches the newest receipt, which pins 0.0.2, so prepare marks a 0.0.2 stage as a renewal.
	const recovered = fetched("recovered");
	const renewal = f.prepare("renewal", { ...second, previous: recovered });
	assert.throws(
		() => publishRepository(renewal.out, f.rootBytes, remote),
		/no live timestamp\.json to prove 0\.0\.2 was promoted/,
	);
	assert(!entries.has("timestamp.json"));
	// With a record for every earlier release, the same renewal publishes.
	const qualified = f.prepare("qualified", { ...second, previous: recovered, rollbackQualification: records });
	publishRepository(qualified.out, f.rootBytes, remote);
	assert.equal(JSON.parse(entries.get("timestamp.json").bytes).signed.version, 3);
	// Now the live pointer pins 0.0.2, and a scheduled renewal needs no record again.
	const out = join(f.directory, "scheduled");
	renewRepository({ out, rootBytes: f.rootBytes, keys: f.keys }, remote);
	publishRepository(join(out, "publication"), f.rootBytes, remote);
	assert.equal(JSON.parse(entries.get("timestamp.json").bytes).signed.version, 4);
});

// A stage's releases are exactly the served ones plus the candidate, each pinned by a real SHA-256.
test("the gate requires real SHA-256 digests and refuses releases the feed does not serve", (t) => {
	const f = fixture(t);
	const archive = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archive, "second archive bytes");
	const second = { archive, release: { ...f.release, version: "0.0.2" } };
	const record = qualification(["0.0.2", archive], ["0.0.1", f.archive]);
	const noDigest = { ...record, reader: { version: "0.0.1" } };
	// A signed earlier target without SHA-256 must not match a record without one.
	const forged = f.prepare("forged");
	resign(forged.out, f.keys, (targets) => {
		targets.targets["linux-x64/releases/0.0.1.tar.gz"].hashes = { sha512: "ab".repeat(64) };
	});
	assert.throws(
		() => f.prepare("no-digest", { ...second, previous: forged.out, rollbackQualification: [noDigest] }),
		/linux-x64\/releases\/0\.0\.1\.tar\.gz has no SHA-256 digest/,
	);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	assert.throws(
		() => f.prepare("record-digest", { ...second, previous, rollbackQualification: [noDigest] }),
		/requires a passed/,
	);
	// A stage re-signed with an extra historical release, and a record for it, is refused: the feed never served it.
	const extra = f.prepare("extra", { ...second, previous, rollbackQualification: [record] });
	resign(extra.out, f.keys, (targets) =>
		targets.addTarget(
			new TargetFile({
				path: "linux-x64/releases/0.0.0.tar.gz",
				length: 1,
				hashes: { sha256: "0".repeat(64) },
				unrecognizedFields: { custom: { releaseTag: "unit-v0.0.0", assetName: "unit-001-0.0.0-linux-x64.tar.gz" } },
			}),
		),
	);
	const receipt = join(extra.out, "rollback-qualification.json");
	const value = JSON.parse(readFileSync(receipt));
	value.records.push({ ...record, reader: { version: "0.0.0", archiveSha256: "0".repeat(64) } });
	writeFileSync(receipt, `${JSON.stringify(value)}\n`);
	assert.throws(() => publishRepository(extra.out, f.rootBytes, remote), /adds linux-x64\/releases\/0\.0\.0\.tar\.gz/);
	assert(!remote.releases.has("unit-v0.0.2"));
	// A metadata release without any timestamp never served anything, so it accepts only a first publication.
	const entries = remote.releases.get(METADATA_RELEASE);
	for (const name of [...entries.keys()]) if (name.endsWith("timestamp.json")) entries.delete(name);
	const later = f.prepare("later", { ...second, previous, rollbackQualification: [record] });
	assert.throws(() => publishRepository(later.out, f.rootBytes, remote), /adds linux-x64\/releases\/0\.0\.1\.tar\.gz/);
	assert(!remote.releases.has("unit-v0.0.2"));
});

// Without a live timestamp, the newest receipt's own release was never proven promoted; a later version must not
// carry it into served history on the strength of its own qualification.
test("a later version never promotes a receipt's unproven release; that release goes out first with its records", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const entries = remote.releases.get(METADATA_RELEASE);
	const fetched = (name) => {
		const previous = join(f.directory, name);
		fetchRepository(previous, remote);
		return previous;
	};
	const archives = { "0.0.1": f.archive };
	for (const version of ["0.0.2", "0.0.3"]) {
		archives[version] = join(f.directory, `unit-001-${version}-linux-x64.tar.gz`);
		writeFileSync(archives[version], `archive bytes ${version}`);
	}
	const release = (version) => ({ archive: archives[version], release: { ...f.release, version } });
	const records = (version, ...readers) =>
		readers.map((reader) => qualification([version, archives[version]], [reader, archives[reader]]));
	// A pre-gate publisher uploaded 0.0.2 and its numbered metadata, then lost the live pointer: 0.0.2 never went live.
	const pregate = f.prepare("pre-gate", {
		...release("0.0.2"),
		previous: fetched("before"),
		rollbackQualification: records("0.0.2", "0.0.1"),
	});
	remote.create("unit-v0.0.2");
	remote.upload("unit-v0.0.2", archives["0.0.2"]);
	for (const name of Object.keys(pregate.files))
		if (name !== "timestamp.json" && !entries.has(name)) remote.upload(METADATA_RELEASE, join(pregate.out, name));
	entries.delete("timestamp.json");
	// 0.0.3 qualified against both earlier readers is still refused: it would make 0.0.2 a served release unqualified.
	const later = f.prepare("later", {
		...release("0.0.3"),
		previous: fetched("receipt"),
		rollbackQualification: records("0.0.3", "0.0.1", "0.0.2"),
	});
	assert.throws(() => publishRepository(later.out, f.rootBytes, remote), /never proven promoted/);
	assert(!remote.releases.has("unit-v0.0.3"));
	assert(!entries.has("timestamp.json"));
	// 0.0.2 goes out first with its own record; then 0.0.3 advances from the live feed.
	const recovered = f.prepare("recovered", {
		...release("0.0.2"),
		previous: fetched("receipt-again"),
		rollbackQualification: records("0.0.2", "0.0.1"),
	});
	publishRepository(recovered.out, f.rootBytes, remote);
	assert(entries.has("timestamp.json"));
	const advanced = f.prepare("advanced", {
		...release("0.0.3"),
		previous: fetched("live"),
		rollbackQualification: records("0.0.3", "0.0.1", "0.0.2"),
	});
	publishRepository(advanced.out, f.rootBytes, remote);
	assert(remote.releases.get("unit-v0.0.3").has("unit-001-0.0.3-linux-x64.tar.gz"));
	// The same stage retried after an interrupted pointer replacement is that receipt's own release, so it goes out.
	const archive4 = join(f.directory, "unit-001-0.0.4-linux-x64.tar.gz");
	writeFileSync(archive4, "archive bytes 0.0.4");
	archives["0.0.4"] = archive4;
	const fourth = f.prepare("fourth", {
		...release("0.0.4"),
		previous: fetched("before-fourth"),
		rollbackQualification: records("0.0.4", "0.0.1", "0.0.2", "0.0.3"),
	});
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("/timestamp.json")) {
			entries.delete("timestamp.json");
			throw new Error("upload failed after delete");
		}
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(fourth.out, f.rootBytes, remote), /after delete/);
	remote.upload = upload;
	publishRepository(fourth.out, f.rootBytes, remote);
	assert.equal(JSON.parse(entries.get("timestamp.json").bytes).signed.version, 5);
});

// The publisher and the installed updater share one version grammar and order (deploy/release-version.mjs).
test("the gate refuses non-canonical release targets and orders versions at full precision", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const archive = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archive, "second archive bytes");
	const second = { archive, release: { ...f.release, version: "0.0.2" } };
	const records = [qualification(["0.0.2", archive], ["0.0.1", f.archive])];
	assert.throws(() => f.prepare("leading-zero", { ...second, release: { ...f.release, version: "0.0.02" } }), /exact stable version/);
	// A signed `0.0.01` target would otherwise pass as reader 0.0.1, and the client would never accept it.
	const forged = f.prepare("forged");
	resign(forged.out, f.keys, (targets) => {
		const file = targets.targets["linux-x64/releases/0.0.1.tar.gz"];
		delete targets.targets["linux-x64/releases/0.0.1.tar.gz"];
		targets.addTarget(
			new TargetFile({ path: "linux-x64/releases/0.0.01.tar.gz", length: file.length, hashes: file.hashes }),
		);
	});
	assert.throws(
		() => f.prepare("non-canonical", { ...second, previous: forged.out, rollbackQualification: records }),
		/0\.0\.01\.tar\.gz does not name a canonical stable release version/,
	);
	assert.equal(f.prepare("canonical", { ...second, previous: first.out, rollbackQualification: records }).descriptor.version, "0.0.2");
	// 2^53 + 1 and 2^53 are one Number; as versions they differ, and the smaller one is a downgrade.
	const big = (version, name, previous) => {
		const path = join(f.directory, `unit-001-${version}-linux-x64.tar.gz`);
		writeFileSync(path, `archive bytes ${version}`);
		return f.prepare(name, {
			archive: path,
			release: { ...f.release, version },
			previous,
			rollbackQualification: [qualification([version, path], ["0.0.1", f.archive])],
		});
	};
	const higher = big("9007199254740993.0.0", "higher", first.out);
	assert.throws(() => big("9007199254740992.0.0", "lower", higher.out), /cannot downgrade/);
});

test("scheduled renewal reuses authenticated immutable archive bytes", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const out = join(f.directory, "renewal");
	const renewed = renewRepository({ out, rootBytes: f.rootBytes, keys: f.keys }, remote);
	assert.equal(renewed.descriptor.version, "0.0.1");
	assert.deepEqual(readFileSync(join(out, "unit-001-0.0.1-linux-x64.tar.gz")), readFileSync(f.archive));
	publishRepository(join(out, "publication"), f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 2);
	assert.equal(remote.operations.filter((item) => item === "unit-v0.0.1:unit-001-0.0.1-linux-x64.tar.gz").length, 1);
	remote.releases.get("unit-v0.0.1").get("unit-001-0.0.1-linux-x64.tar.gz").bytes = Buffer.from("tampered");
	assert.throws(
		() =>
			renewRepository({ out: join(f.directory, "tampered-renewal"), rootBytes: f.rootBytes, keys: f.keys }, remote),
		/Archive hash/,
	);
});

test("publication validates root rotation chain and signed private-source provenance before freshness", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	const first = f.prepare("first");
	publishRepository(first.out, f.rootBytes, remote);
	const newKeys = join(f.directory, "rotated-keys");
	generateRepositoryKeys(newKeys);
	const rootBytes = rotateRepositoryRoot(f.rootBytes, f.keys, newKeys);
	const second = f.prepare("rotated", {
		rootBytes,
		keys: newKeys,
		previous: first.out,
		previousRootBytes: f.rootBytes,
	});
	publishRepository(second.out, rootBytes, remote);
	assert(remote.releases.get(METADATA_RELEASE).has("2.root.json"));
	const timestampBefore = remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes;
	const planPath = join(second.out, "publication.json");
	const plan = JSON.parse(readFileSync(planPath));
	writeFileSync(planPath, JSON.stringify({ ...plan, sourceCommit: "b".repeat(40) }));
	assert.throws(() => publishRepository(second.out, rootBytes, remote), /source commit/);
	assert.deepEqual(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes, timestampBefore);
});

test("changed existing remote archive is not clobbered and no timestamp is published", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	remote.create("unit-v0.0.1");
	remote.releases.get("unit-v0.0.1").set("unit-001-0.0.1-linux-x64.tar.gz", {
		name: "unit-001-0.0.1-linux-x64.tar.gz",
		bytes: Buffer.from("foreign bytes"),
	});
	assert.throws(
		() => publishRepository(f.prepare("first").out, f.rootBytes, remote),
		/Immutable release asset differs/,
	);
	assert.equal(remote.assets(METADATA_RELEASE), null);
});

test("publisher assets interoperate with public downloads without accounts, tokens, or GitHub API", async (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const base = join(f.directory, "transport");
	mkdirSync(base, { mode: 0o700 });
	const bootstrapRoot = join(base, "bootstrap.json");
	writeFileSync(bootstrapRoot, f.rootBytes, { mode: 0o600 });
	const fetch = async (url, options) => {
		const parsed = new URL(url);
		assert.equal(parsed.origin, "https://github.com");
		assert.equal(options.headers.Authorization, undefined);
		const match = parsed.pathname.match(/^\/francman\/unit-001-releases\/releases\/download\/([^/]+)\/([^/]+)$/);
		assert(match, "Public clients must use exact direct download URLs");
		const asset = remote.releases.get(match[1])?.get(match[2]);
		return asset === undefined ? new Response("missing", { status: 404 }) : new Response(asset.bytes);
	};
	const result = await fetchUpdate(
		{ metadataDir: join(base, "metadata"), downloadDir: join(base, "downloads"), bootstrapRoot },
		{ fetch, ownerUid: process.getuid(), platform: "linux", arch: "x64" },
	);
	assert.equal(result.version, "0.0.1");
	assert.deepEqual(readFileSync(result.archivePath), readFileSync(f.archive));
	assert.equal(result.sourceCommit, f.release.source.commit);
});

test("recovers a failed timestamp replacement after GitHub deleted old freshness", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const second = f.prepare("second", { previous });
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("/timestamp.json")) {
			remote.releases.get(tag).delete("timestamp.json");
			throw new Error("upload failed after delete");
		}
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(second.out, f.rootBytes, remote), /after delete/);
	remote.upload = upload;
	publishRepository(second.out, f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 2);
	remote.releases.get(METADATA_RELEASE).delete("timestamp.json");
	const recovered = join(f.directory, "recovered");
	fetchRepository(recovered, remote);
	const third = f.prepare("third", { previous: recovered });
	publishRepository(third.out, f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 3);
});

test("renews the live release after a different release's snapshot upload is interrupted", async (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	const first = f.prepare("first");
	publishRepository(first.out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const archive = join(f.directory, "unit-001-0.0.2-linux-x64.tar.gz");
	writeFileSync(archive, "second archive bytes");
	const second = f.prepare("second", {
		previous,
		archive,
		release: { ...f.release, version: "0.0.2" },
		rollbackQualification: [qualification(["0.0.2", archive], ["0.0.1", f.archive])],
	});
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("/2.snapshot.json")) throw new Error("interrupted snapshot upload");
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(second.out, f.rootBytes, remote), /interrupted snapshot/);
	const entries = remote.releases.get(METADATA_RELEASE);
	assert.deepEqual(entries.get("timestamp.json").bytes, first.files["timestamp.json"]);
	const pendingTargets = entries.get("2.targets.json").bytes;
	remote.upload = upload;
	const out = join(f.directory, "renewal");
	const renewed = renewRepository({ out, rootBytes: f.rootBytes, keys: f.keys }, remote);
	publishRepository(join(out, "publication"), f.rootBytes, remote);
	assert.deepEqual(entries.get("2.targets.json").bytes, pendingTargets);
	assert.deepEqual(entries.get("3.targets.json").bytes, renewed.files["3.targets.json"]);
	const receipt = await verifyPublicMetadata(f.rootBytes, async (name) => entries.get(name).bytes);
	assert.equal(receipt.release, "0.0.1");
	assert.equal(remote.operations.at(-1), "latest:unit-v0.0.1");
});

// #18: rotation must work for scheduled renewal and remain usable after the first rotated publication.
test("renewal accepts a cross-signed previous root only when current credentials cannot verify prior metadata", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const keys = join(f.directory, "rotated-online");
	generateRepositoryKeys(keys);
	const rootBytes = rotateRepositoryRoot(f.rootBytes, f.keys, keys);
	const options = { rootBytes, keys, previousRootBytes: f.rootBytes };
	renewRepository({ ...options, out: join(f.directory, "rotation-renew") }, remote);
	publishRepository(join(f.directory, "rotation-renew/publication"), rootBytes, remote);
	renewRepository({ ...options, out: join(f.directory, "normal-renew") }, remote);
	publishRepository(join(f.directory, "normal-renew/publication"), rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 3);
	assert(remote.releases.get(METADATA_RELEASE).has("1.root.json"));
	assert(remote.releases.get(METADATA_RELEASE).has("2.root.json"));
});

// #18: a client that already fetched a still-valid old timestamp must retain its authenticated dependencies.
test("retention preserves an old valid timestamp's snapshot, targets, and descriptor for an in-flight client", async (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	const now = new Date();
	const firstTime = new Date(now.getTime() - 86400000);
	const first = f.prepare("old-client", { now: firstTime });
	publishRepository(first.out, f.rootBytes, remote, firstTime);
	publishRepository(f.prepare("current-client", { previous: first.out, now }).out, f.rootBytes, remote, now);
	const files = Object.fromEntries(remote.assets(METADATA_RELEASE).map(({ name, bytes }) => [name, bytes]));
	files["timestamp.json"] = first.files["timestamp.json"];
	const updater = await client(t, f, [{ files }]);
	await updater.refresh();
	const info = await updater.getTargetInfo("linux-x64/stable.json");
	assert.deepEqual(JSON.parse(readFileSync(await updater.downloadTarget(info))), first.descriptor);
});

// #18: pruning is tied to successful freshness publication, never merely to preparing or staging assets.
test("failed freshness leaves old metadata intact; successful publication prunes aged metadata but preserves unknowns", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	const now = new Date();
	const oldTime = new Date(now.getTime() - 40 * 86400000);
	const first = f.prepare("aged", { now: oldTime });
	publishRepository(first.out, f.rootBytes, remote, oldTime);
	const entries = remote.releases.get(METADATA_RELEASE);
	entries.set("operator-notes.txt", { id: 9999, name: "operator-notes.txt", bytes: Buffer.from("preserve") });
	const second = f.prepare("fresh", { previous: first.out, now });
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("/timestamp.json")) throw new Error("freshness interrupted");
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(second.out, f.rootBytes, remote, now), /freshness interrupted/);
	assert(entries.has("1.snapshot.json"));
	assert(!remote.operations.some((operation) => operation.startsWith("remove:")));
	remote.upload = upload;
	publishRepository(second.out, f.rootBytes, remote, now);
	for (const name of ["1.timestamp.json", "1.snapshot.json", "1.targets.json"]) assert(!entries.has(name));
	assert(entries.has("operator-notes.txt"));
	assert(entries.has("1.root.json"));
	assert(remote.releases.get("unit-v0.0.1").has("unit-001-0.0.1-linux-x64.tar.gz"));
	entries.set("999.targets.json", { id: 9998, name: "999.targets.json", bytes: Buffer.from("not signed") });
	const before = [...entries.keys()];
	assert.throws(() => pruneRepository(f.rootBytes, remote, now));
	assert.deepEqual([...entries.keys()], before);
});

// #18: six-hour renewal must not exhaust GitHub's 1,000-assets-per-release limit over the service's lifetime.
test("authenticated seven-day retention bounds assets across more than 1000 six-hour renewals", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	remote.create(METADATA_RELEASE);
	remote.create("unit-v0.0.1");
	remote.upload("unit-v0.0.1", f.archive);
	const start = Date.now() - 1200 * 6 * 3600000;
	let previous;
	let now;
	for (let index = 0; index < 1200; index++) {
		now = new Date(start + index * 6 * 3600000);
		const publication = f.prepare(`renewal-${index}`, { previous, now });
		for (const name of Object.keys(publication.files)) {
			if (name !== "timestamp.json" && remote.releases.get(METADATA_RELEASE).has(name)) continue;
			remote.upload(METADATA_RELEASE, join(publication.out, name), name === "timestamp.json");
		}
		previous = publication.out;
		// Even a backlog of twenty successful renewals fits; production prunes after every successful publication.
		if (index % 20 === 0) pruneRepository(f.rootBytes, remote, now);
		assert(remote.assets(METADATA_RELEASE).length < 1000);
	}
	const result = pruneRepository(f.rootBytes, remote, now);
	assert(result.retained < 300);
	assert(remote.releases.get(METADATA_RELEASE).has("1200.timestamp.json"));
	assert(remote.releases.get(METADATA_RELEASE).has("1.root.json"));
	assert.equal(remote.releases.get("unit-v0.0.1").size, 1);
});
