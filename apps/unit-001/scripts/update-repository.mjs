#!/usr/bin/env node
// Signs and publishes the unit-owned TUF repository; never updates a running installation.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Key, Metadata, MetaFile, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models";
// The installed updater's own grammar and order: a version the publisher accepts is one every client accepts.
import { compareReleaseVersions, isReleaseVersion } from "../deploy/release-version.mjs";

export const UPDATE_REPOSITORY = "francman/unit-001-releases";
export const METADATA_RELEASE = "unit-updates-stable";
export const DOWNLOAD_ASSET = "unit-001-linux-x64.tar.gz";
export const DOWNLOAD_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/${DOWNLOAD_ASSET}`;
const roles = ["root", "targets", "snapshot", "timestamp"];
const digest = (data) => createHash("sha256").update(data).digest("hex");
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const expires = (now, days) => new Date(now.getTime() + days * 86400000).toISOString();

function publicKey(privateKey) {
	const jwk = createPublicKey(privateKey).export({ format: "jwk" });
	const hex = Buffer.from(jwk.x, "base64url").toString("hex");
	return new Key({ keyID: digest(Buffer.from(hex)), keyType: "ed25519", scheme: "ed25519", keyVal: { public: hex } });
}

function signed(value, keys) {
	const metadata = new Metadata(value);
	for (const key of keys) {
		metadata.sign(
			(data) => new Signature({ keyID: publicKey(key).keyID, sig: sign(null, data, key).toString("hex") }),
		);
	}
	return metadata;
}

function privateKey(directory, role) {
	const path = join(directory, `${role}.pem`);
	const stat = lstatSync(path);
	if (!stat.isFile() || (stat.mode & 0o077) !== 0)
		throw new Error(`Signing key must be a protected regular file: ${path}`);
	const key = createPrivateKey(readFileSync(path));
	if (key.asymmetricKeyType !== "ed25519") throw new Error("Only Ed25519 signing keys are supported");
	return key;
}

/** Explicitly creates a new protected key directory and self-signed bootstrap; refuses overwrite. */
export function generateRepositoryKeys(directory, now = new Date()) {
	mkdirSync(directory, { mode: 0o700 });
	const root = new Root({ version: 1, expires: expires(now, 365), consistentSnapshot: true });
	let rootKey;
	for (const role of roles) {
		const { privateKey: key } = generateKeyPairSync("ed25519");
		writeFileSync(join(directory, `${role}.pem`), key.export({ type: "pkcs8", format: "pem" }), {
			flag: "wx",
			mode: 0o600,
		});
		root.addKey(publicKey(key), role);
		if (role === "root") rootKey = key;
	}
	const bytes = encode(signed(root, [rootKey]).toJSON());
	writeFileSync(join(directory, "root.json"), bytes, { flag: "wx", mode: 0o644 });
	return bytes;
}

/** Rotates all roles with signatures from the old and new offline root keys. */
export function rotateRepositoryRoot(rootBytes, oldKeys, newKeys, now = new Date()) {
	const old = Metadata.fromJSON("root", JSON.parse(rootBytes));
	old.verifyDelegate("root", old);
	const root = new Root({ version: old.signed.version + 1, expires: expires(now, 365), consistentSnapshot: true });
	for (const role of roles) root.addKey(publicKey(privateKey(newKeys, role)), role);
	const rotated = signed(root, [privateKey(oldKeys, "root"), privateKey(newKeys, "root")]);
	old.verifyDelegate("root", rotated);
	rotated.verifyDelegate("root", rotated);
	return encode(rotated.toJSON());
}

function rootMetadata(rootBytes, now) {
	if (rootBytes.length > 4 * 1024 * 1024) throw new Error("Approved root exceeds the client metadata limit");
	const root = Metadata.fromJSON("root", JSON.parse(rootBytes));
	root.verifyDelegate("root", root);
	if (!root.signed.consistentSnapshot || root.signed.isExpired(now))
		throw new Error("Bootstrap root must be unexpired with consistent snapshots");
	return root;
}

function priorMetadata(directory, root) {
	if (directory === undefined || !existsSync(join(directory, "timestamp.json"))) return undefined;
	const timestamp = Metadata.fromJSON("timestamp", JSON.parse(readFileSync(join(directory, "timestamp.json"))));
	root.verifyDelegate("timestamp", timestamp);
	const snapshotBytes = readFileSync(join(directory, `${timestamp.signed.snapshotMeta.version}.snapshot.json`));
	timestamp.signed.snapshotMeta.verify(snapshotBytes);
	const snapshot = Metadata.fromJSON("snapshot", JSON.parse(snapshotBytes));
	root.verifyDelegate("snapshot", snapshot);
	const targetsMeta = snapshot.signed.meta["targets.json"];
	const targetBytes = readFileSync(join(directory, `${targetsMeta.version}.targets.json`));
	targetsMeta.verify(targetBytes);
	const targets = Metadata.fromJSON("targets", JSON.parse(targetBytes));
	root.verifyDelegate("targets", targets);
	return { timestamp, snapshot, targets, timestampBytes: readFileSync(join(directory, "timestamp.json")) };
}

function fileMetadata(bytes, version) {
	return new MetaFile({ version, length: bytes.length, hashes: { sha256: digest(bytes) } });
}

function priorForRoot(directory, root, previousRootBytes) {
	try {
		return priorMetadata(directory, root);
	} catch (error) {
		if (previousRootBytes === undefined) throw error;
		const previousRoot = Metadata.fromJSON("root", JSON.parse(previousRootBytes));
		previousRoot.verifyDelegate("root", previousRoot);
		if (root.signed.version !== previousRoot.signed.version + 1)
			throw new Error("Root rotations must advance by exactly one version");
		previousRoot.verifyDelegate("root", root);
		return priorMetadata(directory, previousRoot);
	}
}

/**
 * Builds fresh signed metadata from reviewed release metadata and immutable archive bytes. A version new to the feed
 * also needs `rollbackQualification`, the records `test/rollback/qualify.mjs` writes for this exact archive, one per earlier release.
 * `archiveBytes` are the archive's contents read once by the caller; the signed digest and the download alias both come
 * from them, never from a second read of `archive`.
 */
export function prepareRepository({
	archive,
	archiveBytes = readFileSync(archive),
	release,
	rootBytes,
	keys,
	previous,
	previousRootBytes,
	rollbackQualification,
	expectedSourceCommit = release.source?.commit,
	out,
	now = new Date(),
}) {
	if (
		!isReleaseVersion(release.version) ||
		release.platform !== "linux-x64" ||
		!/^[a-f0-9]{40}$/.test(release.source?.commit ?? "") ||
		release.source.dirty !== false
	)
		throw new Error("Publishing requires a clean Linux x64 release with an exact stable version and source commit");
	if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit) || release.source.commit !== expectedSourceCommit)
		throw new Error("Archive source commit does not match the trusted build checkout");
	const compatibility = release.compatibility;
	if (
		compatibility?.stateVersion !== 1 ||
		compatibility.minReaderVersion !== 1 ||
		compatibility.maintenanceProtocol !== 1
	)
		throw new Error("Release compatibility requires an explicitly reviewed supported policy");
	const root = rootMetadata(rootBytes, now);
	const prior = priorForRoot(previous, root, previousRootBytes);
	const floor =
		previous !== undefined && existsSync(join(previous, "publisher-floor.json"))
			? JSON.parse(readFileSync(join(previous, "publisher-floor.json")))
			: {};
	for (const value of Object.values(floor))
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid publication version floor");
	const version = release.version;
	const assetName = `unit-001-${version}-linux-x64.tar.gz`;
	if (basename(archive) !== assetName) throw new Error("Archive filename does not match release version");
	const archiveTarget = `linux-x64/releases/${version}.tar.gz`;
	const releaseTag = `unit-v${version}`;
	const descriptor = {
		schemaVersion: 1,
		version,
		platform: "linux-x64",
		sourceCommit: release.source.commit,
		archiveTarget,
		compatibility,
	};
	const descriptorBytes = encode(descriptor);
	if (descriptorBytes.length > 16384) throw new Error("Stable descriptor exceeds the client metadata limit");
	const targets = new Targets({
		version: Math.max(prior?.targets.signed.version ?? 0, floor.targets ?? 0) + 1,
		expires: expires(now, 30),
	});
	// Preserve every prior archive target so exact-version pins remain downloadable.
	for (const [path, file] of Object.entries(prior?.targets.signed.targets ?? {}))
		if (path !== "linux-x64/stable.json") targets.addTarget(file);
	const archiveFile = new TargetFile({
		path: archiveTarget,
		length: archiveBytes.length,
		hashes: { sha256: digest(archiveBytes) },
		unrecognizedFields: { custom: { releaseTag, assetName } },
	});
	const oldArchive = targets.targets[archiveTarget];
	if (oldArchive !== undefined && !oldArchive.equals(archiveFile))
		throw new Error("Refusing to reuse a release version with different archive bytes");
	if (
		Object.keys(targets.targets).some((path) => {
			const published = releaseVersion(path);
			return published !== undefined && compareReleaseVersions(published, version) > 0;
		})
	)
		throw new Error("Stable publication cannot downgrade the release version");
	// A renewal re-signs a release already in the targets and needs no record. Records given anyway are checked and
	// kept: publish falls back on them when no live timestamp proves the release was promoted.
	const qualified =
		oldArchive === undefined || rollbackQualification !== undefined
			? checkRollbackQualification(rollbackQualification, version, archiveBytes, targets.targets)
			: [];
	targets.addTarget(archiveFile);
	targets.addTarget(
		new TargetFile({
			path: "linux-x64/stable.json",
			length: descriptorBytes.length,
			hashes: { sha256: digest(descriptorBytes) },
		}),
	);
	const targetsMetadata = signed(targets, [privateKey(keys, "targets")]);
	root.verifyDelegate("targets", targetsMetadata);
	const targetsBytes = encode(targetsMetadata.toJSON());
	if (targetsBytes.length > 4 * 1024 * 1024)
		throw new Error("Targets exceed the client metadata limit; publication requires a reviewed repository migration");
	const snapshot = signed(
		new Snapshot({
			version: Math.max(prior?.snapshot.signed.version ?? 0, floor.snapshot ?? 0) + 1,
			expires: expires(now, 7),
			meta: { "targets.json": fileMetadata(targetsBytes, targets.version) },
		}),
		[privateKey(keys, "snapshot")],
	);
	root.verifyDelegate("snapshot", snapshot);
	const snapshotBytes = encode(snapshot.toJSON());
	const timestamp = signed(
		new Timestamp({
			version: Math.max(prior?.timestamp.signed.version ?? 0, floor.timestamp ?? 0) + 1,
			expires: expires(now, 2),
			snapshotMeta: fileMetadata(snapshotBytes, snapshot.signed.version),
		}),
		[privateKey(keys, "timestamp")],
	);
	root.verifyDelegate("timestamp", timestamp);
	mkdirSync(out, { mode: 0o700 });
	const files = {
		[`${root.signed.version}.root.json`]: rootBytes,
		[`${targets.version}.targets.json`]: targetsBytes,
		[`${snapshot.signed.version}.snapshot.json`]: snapshotBytes,
		[`linux-x64-${digest(descriptorBytes)}.stable.json`]: descriptorBytes,
		[`${timestamp.signed.version}.timestamp.json`]: encode(timestamp.toJSON()),
		"timestamp.json": encode(timestamp.toJSON()),
	};
	for (const [name, bytes] of Object.entries(files)) writeFileSync(join(out, name), bytes, { flag: "wx" });
	writeFileSync(join(out, DOWNLOAD_ASSET), archiveBytes, { flag: "wx" });
	writeFileSync(
		join(out, "publication.json"),
		encode({
			schemaVersion: 1,
			repository: UPDATE_REPOSITORY,
			sourceCommit: expectedSourceCommit,
			archive: resolve(archive),
			releaseTag,
			assetName,
			expectedTimestampSha256: prior === undefined ? null : digest(prior.timestampBytes),
			expectedTimestampVersion: prior?.timestamp.signed.version ?? null,
		}),
		{ flag: "wx" },
	);
	writeFileSync(
		join(out, QUALIFICATION_RECEIPT),
		encode({
			schemaVersion: 1,
			version,
			archiveSha256: digest(archiveBytes),
			renewal: oldArchive !== undefined,
			records: qualified,
		}),
		{ flag: "wx" },
	);
	return { descriptor, files };
}

const RELEASE_TARGET = /^linux-x64\/releases\/(.*)\.tar\.gz$/;
const QUALIFICATION_RECEIPT = "rollback-qualification.json";
const REQUIRED_SCENARIOS = ["fresh", "version-2"];
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Returns the release version a target path names, or undefined for a target that is not a release archive. A
 * non-canonical name is refused: `0.0.01` would otherwise stand in for `0.0.1` and hide a reader from the gate.
 */
function releaseVersion(path) {
	const version = path.match(RELEASE_TARGET)?.[1];
	if (version !== undefined && !isReleaseVersion(version))
		throw new Error(`Signed target ${path} does not name a canonical stable release version`);
	return version;
}

/** Lists every release in `published` older than `version`, with the archive digest the signed targets pin. */
function earlierReleases(version, published) {
	const earlier = [];
	for (const file of Object.values(published)) {
		const reader = releaseVersion(file.path);
		if (reader === undefined || compareReleaseVersions(reader, version) >= 0) continue;
		// TUF accepts a hash map without SHA-256; two missing digests must never compare as a match.
		if (!SHA256.test(file.hashes.sha256 ?? ""))
			throw new Error(`Signed target ${file.path} has no SHA-256 digest to qualify against`);
		earlier.push({ version: reader, archiveSha256: file.hashes.sha256 });
	}
	return earlier.sort((a, b) => compareReleaseVersions(a.version, b.version));
}

/**
 * Refuses a new stable version unless the whole owner was qualified with these archive bytes against every earlier
 * published release: the updater accepts any installed release that declares the supported compatibility numbers as
 * a source, so an installation may skip versions and roll back to any of them. The qualification is a list of
 * `qualify.mjs` records, one per earlier release, each naming that reader's exact archive and the candidate's.
 */
function checkRollbackQualification(records, version, archiveBytes, published) {
	const earlier = earlierReleases(version, published);
	// The first publication has no earlier release to roll back to.
	if (earlier.length === 0) return [];
	if (!Array.isArray(records) || records.length === 0)
		throw new Error(
			"A new stable release requires a passed full-owner rollback qualification for every earlier release (test/rollback/qualify.mjs)",
		);
	for (const record of records) {
		if (
			record?.schemaVersion !== 1 ||
			record.kind !== "unit.full-owner-rollback" ||
			record.result !== "passed" ||
			// An array, not a string: `"fresh version-2".includes("fresh")` would also pass.
			!Array.isArray(record.scenarios) ||
			record.scenarios.length !== REQUIRED_SCENARIOS.length ||
			!REQUIRED_SCENARIOS.every((scenario) => record.scenarios.includes(scenario)) ||
			!SHA256.test(record.reader?.archiveSha256 ?? "")
		)
			throw new Error("A new stable release requires a passed full-owner rollback qualification (test/rollback/qualify.mjs)");
		if (record.candidate?.version !== version || record.candidate.archiveSha256 !== digest(archiveBytes))
			throw new Error("Rollback qualification does not cover this exact release archive");
	}
	for (const reader of earlier) {
		const matching = records.filter((record) => record.reader?.version === reader.version);
		if (matching.length === 0) throw new Error(`Rollback qualification is missing for earlier release ${reader.version}`);
		if (matching.length > 1 || matching[0].reader.archiveSha256 !== reader.archiveSha256)
			throw new Error(`Rollback qualification must use the published ${reader.version} archive`);
	}
	if (records.length !== earlier.length)
		throw new Error("Rollback qualification names a reader that is not an earlier published release");
	return records;
}

/**
 * Checks the approved root against the published root chain and returns the published root one version below it, or
 * undefined for version one. The predecessor is chosen by version, never as the newest upload: after a rotation was
 * interrupted between the root and the freshness upload, the newest published root is the approved one while the live
 * timestamp is still signed under its predecessor.
 */
function predecessorRoot(assets, root, rootBytes, remote) {
	const published = new Map();
	for (const asset of assets) {
		const match = asset.name.match(/^([1-9]\d*)\.root\.json$/);
		if (match !== null) published.set(Number(match[1]), asset);
	}
	const version = root.signed.version;
	const newest = Math.max(0, ...published.keys());
	if (newest > version) throw new Error("A newer root is already published; fetch and prepare again with it");
	if (newest === version && !remote.read(published.get(version)).equals(rootBytes))
		throw new Error("Published root version cannot change bytes");
	if (version === 1) return undefined;
	if (newest === 0) throw new Error("Missing bootstrap root chain");
	if (newest < version - 1) throw new Error("Published root rotation must advance by one version");
	const asset = published.get(version - 1);
	if (asset === undefined) throw new Error("Published root chain has a gap");
	const bytes = remote.read(asset);
	const previous = Metadata.fromJSON("root", JSON.parse(bytes));
	previous.verifyDelegate("root", previous);
	if (previous.signed.version !== version - 1) throw new Error("Published root filename does not match its version");
	previous.verifyDelegate("root", root);
	return bytes;
}

/**
 * Fetches the metadata the feed serves now, authenticated against `root` or its predecessor, and says which timestamp
 * it came from. After an interrupted freshness replacement this is the newest signed receipt, so a missing
 * `timestamp.json` is not mistaken for an empty feed.
 */
function servedMetadata(remote, root, previousRootBytes) {
	const scratch = mkdtempSync(join(tmpdir(), "unit-served-"));
	try {
		const directory = join(scratch, "served");
		const { freshness } = fetchRepository(directory, remote);
		return { freshness, metadata: priorForRoot(directory, root, previousRootBytes) };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * A stage's releases must be exactly the feed's plus the candidate. It must carry forward every served release byte for
 * byte, or a stage prepared without the served predecessor could drop the earlier releases from the gate (a "first
 * publication") on a live feed. It must add nothing else, or a release the feed never authenticated would enter history.
 */
function checkFeedContinuity(served, signedTargets, candidate) {
	const servedTargets = served?.targets.signed.targets ?? {};
	for (const [path, file] of Object.entries(servedTargets)) {
		if (releaseVersion(path) === undefined) continue;
		if (signedTargets[path]?.equals(file) !== true)
			throw new Error(`Staged publication drops or changes ${path}, which the feed serves; fetch and prepare again`);
	}
	for (const path of Object.keys(signedTargets))
		if (releaseVersion(path) !== undefined && path !== candidate && servedTargets[path] === undefined)
			throw new Error(`Staged publication adds ${path}, which the feed does not serve; only the candidate may be new`);
}

/**
 * Without a live `timestamp.json`, the served receipt's own candidate (the release its stable descriptor names) was
 * never proven promoted or qualified: its publication may have stopped before the live pointer, or come from a
 * publisher that predates the gate. A later version would carry it into served history without its own qualification,
 * since the gate checks only the stage's candidate. So only a stage of that same candidate may go out, and
 * `checkStagedQualification` then requires the records for it. Every other served release passed through a live
 * timestamp or through this rule.
 */
function checkInterruptedCandidate(served, signedTargets) {
	if (served.freshness !== "receipt") return;
	const interrupted = served.metadata.targets.signed.targets["linux-x64/stable.json"];
	if (signedTargets["linux-x64/stable.json"]?.equals(interrupted) !== true)
		throw new Error(
			"The feed has no live timestamp.json, so the release its newest receipt names was never proven promoted; publish that release again (renew with --rollback-qualification) before any other",
		);
}

/** Reads the staged receipt `prepare` wrote and repeats the gate against the signed targets and archive bytes. */
function checkStagedQualification(directory, descriptor, archiveBytes, signedTargets, served, remote, plan) {
	const path = join(directory, QUALIFICATION_RECEIPT);
	if (!existsSync(path))
		throw new Error("Staged publication has no rollback qualification receipt; prepare it again with this publisher");
	const receipt = JSON.parse(readFileSync(path));
	if (
		receipt.schemaVersion !== 1 ||
		receipt.version !== descriptor.version ||
		receipt.archiveSha256 !== digest(archiveBytes) ||
		typeof receipt.renewal !== "boolean"
	)
		throw new Error("Rollback qualification receipt does not match the signed archive");
	if (receipt.renewal && served.freshness === "live") {
		// A renewal re-signs a release the feed already serves. The live timestamp must pin this archive: an uploaded
		// asset alone proves nothing, since an orphaned upload never passed the gate.
		const pinned = served.metadata?.targets.signed.targets[descriptor.archiveTarget];
		const published = remote.assets(plan.releaseTag)?.find((asset) => asset.name === plan.assetName);
		if (
			pinned === undefined ||
			pinned.hashes.sha256 !== digest(archiveBytes) ||
			published === undefined ||
			!remote.read(published).equals(archiveBytes)
		)
			throw new Error("Staged publication claims a renewal but the feed does not serve this archive");
		return;
	}
	// Only the live `timestamp.json` proves promotion. Every publication uploads its numbered receipt before the live
	// pointer, so without one the newest receipt may belong to a publication that never went live, possibly from a
	// publisher that predates the gate. A renewal then passes the gate like a new version.
	try {
		checkRollbackQualification(receipt.records, descriptor.version, archiveBytes, signedTargets);
	} catch (error) {
		if (!receipt.renewal) throw error;
		throw new Error(
			`The feed has no live timestamp.json to prove ${descriptor.version} was promoted, so its renewal needs the rollback qualification (prepare or renew with --rollback-qualification): ${error.message}`,
			{ cause: error },
		);
	}
}

/** Publishes only to the public release repository; its credential never reaches downloaded bundles. */
export function githubPublisher() {
	const run = (args, options = {}) => execFileSync("gh", args, { maxBuffer: 1024 * 1024 * 1024, ...options });
	let publicRepository = false;
	return {
		assets(tag) {
			if (!publicRepository) {
				const repository = JSON.parse(run(["api", `repos/${UPDATE_REPOSITORY}`]));
				if (repository.private !== false) throw new Error("The distribution repository must be public");
				publicRepository = true;
			}
			try {
				const release = JSON.parse(run(["api", `repos/${UPDATE_REPOSITORY}/releases/tags/${tag}`]));
				return JSON.parse(
					run([
						"api",
						"--paginate",
						"--slurp",
						`repos/${UPDATE_REPOSITORY}/releases/${release.id}/assets?per_page=100`,
					]),
				).flat();
			} catch (error) {
				if (error.stderr?.toString().includes("404")) return null;
				throw error;
			}
		},
		read(asset) {
			return run([
				"api",
				`repos/${UPDATE_REPOSITORY}/releases/assets/${asset.id}`,
				"-H",
				"Accept: application/octet-stream",
			]);
		},
		create(tag) {
			run([
				"release",
				"create",
				tag,
				"--repo",
				UPDATE_REPOSITORY,
				"--title",
				tag,
				"--notes",
				`Download: ${DOWNLOAD_URL}\n\nUbuntu 24.04 LTS, Linux x64. Extract the download and run sudo ./install.sh.`,
				"--latest=false",
			]);
		},
		markLatest(tag) {
			run(["release", "edit", tag, "--repo", UPDATE_REPOSITORY, "--latest"]);
		},
		upload(tag, path, replace = false) {
			run(["release", "upload", tag, path, "--repo", UPDATE_REPOSITORY, ...(replace ? ["--clobber"] : [])]);
		},
		remove(_tag, asset) {
			if (!Number.isSafeInteger(asset.id) || asset.id < 1) throw new Error("Invalid asset deletion identifier");
			run(["api", "--method", "DELETE", `repos/${UPDATE_REPOSITORY}/releases/assets/${asset.id}`]);
		},
	};
}

/**
 * Fetches publisher state; only a confirmed missing release represents an empty repository. Returns which timestamp it
 * used: `live` (`timestamp.json`), `receipt` (the newest numbered one, after an interrupted replacement deleted the live
 * pointer) or `none`. No timestamp at all means no publication ever reached its freshness step: each uploads its
 * numbered receipt before the live pointer, and retention keeps the newest receipt.
 */
export function fetchRepository(out, remote = githubPublisher()) {
	mkdirSync(out, { mode: 0o700 });
	const assets = remote.assets(METADATA_RELEASE) ?? [];
	const floor = {};
	for (const asset of assets) {
		const match = asset.name.match(/^([1-9]\d*)\.(targets|snapshot|timestamp)\.json$/);
		if (match !== null) floor[match[2]] = Math.max(floor[match[2]] ?? 0, Number(match[1]));
	}
	writeFileSync(join(out, "publisher-floor.json"), encode(floor), { flag: "wx" });
	const timestampAsset =
		assets.find((asset) => asset.name === "timestamp.json") ??
		assets
			.filter((asset) => /^[1-9]\d*\.timestamp\.json$/.test(asset.name))
			.sort((a, b) => Number.parseInt(b.name, 10) - Number.parseInt(a.name, 10))[0];
	if (timestampAsset === undefined) return { freshness: "none" };
	const timestampBytes = remote.read(timestampAsset);
	writeFileSync(join(out, "timestamp.json"), timestampBytes, { flag: "wx" });
	const timestamp = Metadata.fromJSON("timestamp", JSON.parse(timestampBytes));
	const snapshotName = `${timestamp.signed.snapshotMeta.version}.snapshot.json`;
	const snapshotAsset = assets.find((asset) => asset.name === snapshotName);
	if (snapshotAsset === undefined) throw new Error("Missing snapshot asset");
	const snapshotBytes = remote.read(snapshotAsset);
	writeFileSync(join(out, snapshotName), snapshotBytes, { flag: "wx" });
	const snapshot = Metadata.fromJSON("snapshot", JSON.parse(snapshotBytes));
	const targetsName = `${snapshot.signed.meta["targets.json"].version}.targets.json`;
	const targetsAsset = assets.find((asset) => asset.name === targetsName);
	if (targetsAsset === undefined) throw new Error("Missing targets asset");
	writeFileSync(join(out, targetsName), remote.read(targetsAsset), { flag: "wx" });
	return { freshness: timestampAsset.name === "timestamp.json" ? "live" : "receipt" };
}

/**
 * Renews metadata for the exact existing archive; never rebuilds an already published version. `rollbackQualification`
 * is needed only when the feed has lost its live `timestamp.json` (see `checkStagedQualification`).
 */
export function renewRepository(
	{ out, rootBytes, keys, previousRootBytes, rollbackQualification, now = new Date() },
	remote = githubPublisher(),
) {
	mkdirSync(out, { mode: 0o700 });
	const previous = join(out, "previous");
	fetchRepository(previous, remote);
	const prior = priorForRoot(previous, rootMetadata(rootBytes, now), previousRootBytes);
	if (prior === undefined) throw new Error("Cannot renew an empty repository");
	const info = prior.targets.signed.targets["linux-x64/stable.json"];
	const name = `linux-x64-${info.hashes.sha256}.stable.json`;
	const asset = remote.assets(METADATA_RELEASE).find((entry) => entry.name === name);
	if (asset === undefined) throw new Error("Missing authenticated descriptor asset");
	const bytes = remote.read(asset);
	if (info.length !== bytes.length || info.hashes.sha256 !== digest(bytes))
		throw new Error("Descriptor hash mismatch");
	const descriptor = JSON.parse(bytes);
	if (
		!isReleaseVersion(descriptor.version) ||
		descriptor.archiveTarget !== `linux-x64/releases/${descriptor.version}.tar.gz`
	)
		throw new Error("Invalid descriptor target");
	const file = prior.targets.signed.targets[descriptor.archiveTarget];
	const releaseTag = `unit-v${descriptor.version}`;
	const assetName = `unit-001-${descriptor.version}-linux-x64.tar.gz`;
	if (file?.custom.releaseTag !== releaseTag || file.custom.assetName !== assetName)
		throw new Error("Archive location mismatch");
	const archiveAsset = remote.assets(releaseTag)?.find((entry) => entry.name === assetName);
	if (archiveAsset === undefined) throw new Error("Missing archive asset");
	const archiveBytes = remote.read(archiveAsset);
	if (file.length !== archiveBytes.length || file.hashes.sha256 !== digest(archiveBytes))
		throw new Error("Archive hash mismatch");
	const archive = join(out, assetName);
	writeFileSync(archive, archiveBytes, { flag: "wx" });
	return prepareRepository({
		archive,
		archiveBytes,
		release: {
			version: descriptor.version,
			platform: descriptor.platform,
			source: { commit: descriptor.sourceCommit, dirty: false },
			compatibility: descriptor.compatibility,
		},
		rootBytes,
		keys,
		previous,
		previousRootBytes,
		rollbackQualification,
		now,
		out: join(out, "publication"),
	});
}

/**
 * Publishes immutable content first, with timestamp last and a stale-publisher check. The stage is copied once into a
 * private directory and everything is validated and uploaded from that copy, so a file swapped in the stage after
 * validation cannot change what ships.
 */
export function publishRepository(directory, rootBytes, remote = githubPublisher(), now = new Date()) {
	const snapshot = mkdtempSync(join(tmpdir(), "unit-publish-"));
	try {
		for (const entry of readdirSync(directory, { withFileTypes: true }))
			if (entry.isFile()) writeFileSync(join(snapshot, entry.name), readFileSync(join(directory, entry.name)));
		publishSnapshot(snapshot, rootBytes, remote, now);
	} finally {
		rmSync(snapshot, { recursive: true, force: true });
	}
}

function publishSnapshot(directory, rootBytes, remote, now) {
	const plan = JSON.parse(readFileSync(join(directory, "publication.json")));
	if (plan.repository !== UPDATE_REPOSITORY || plan.schemaVersion !== 1) throw new Error("Invalid publication plan");
	const root = rootMetadata(rootBytes, now);
	const metadata = priorMetadata(directory, root);
	if (
		metadata === undefined ||
		[metadata.timestamp, metadata.snapshot, metadata.targets].some((entry) => entry.signed.isExpired(now))
	)
		throw new Error("Missing or expired publication metadata");
	const archiveBytes = readFileSync(plan.archive);
	const descriptorFile = metadata.targets.signed.targets["linux-x64/stable.json"];
	const descriptorAsset = `linux-x64-${descriptorFile.hashes.sha256}.stable.json`;
	const descriptorBytes = readFileSync(join(directory, descriptorAsset));
	if (descriptorFile.length !== descriptorBytes.length || digest(descriptorBytes) !== descriptorFile.hashes.sha256)
		throw new Error("Descriptor hash mismatch");
	const descriptor = JSON.parse(descriptorBytes);
	if (plan.sourceCommit !== descriptor.sourceCommit)
		throw new Error("Signed descriptor source commit differs from the trusted publication plan");
	const archiveFile = metadata.targets.signed.targets[descriptor.archiveTarget];
	if (
		basename(plan.archive) !== plan.assetName ||
		plan.releaseTag !== `unit-v${descriptor.version}` ||
		plan.assetName !== `unit-001-${descriptor.version}-linux-x64.tar.gz` ||
		archiveFile?.custom.releaseTag !== plan.releaseTag ||
		archiveFile.custom.assetName !== plan.assetName ||
		archiveFile?.length !== archiveBytes.length ||
		archiveFile.hashes.sha256 !== digest(archiveBytes)
	)
		throw new Error("Archive publication plan mismatch");
	if (!readFileSync(join(directory, DOWNLOAD_ASSET)).equals(archiveBytes))
		throw new Error("Direct download alias differs from the signed archive");
	// The archive is read from its path once; the validated bytes are what every upload below sends.
	const archivePath = join(directory, plan.assetName);
	writeFileSync(archivePath, archiveBytes, { flag: "wx" });
	const rootName = `${root.signed.version}.root.json`;
	if (!readFileSync(join(directory, rootName)).equals(rootBytes))
		throw new Error("Staged root differs from approved root");
	if (
		!readFileSync(join(directory, `${metadata.timestamp.signed.version}.timestamp.json`)).equals(
			metadata.timestampBytes,
		)
	)
		throw new Error("Staged timestamp receipt differs from signed freshness metadata");
	const initial = remote.assets(METADATA_RELEASE);
	if (initial === null && root.signed.version !== 1)
		throw new Error("A fresh repository requires bootstrap root version one");
	const previousRootBytes = predecessorRoot(initial ?? [], root, rootBytes, remote);
	// Bootstrap and renewal come from what the feed authenticates now, not from the stage's own claims.
	const served = servedMetadata(remote, root, previousRootBytes);
	checkFeedContinuity(served.metadata, metadata.targets.signed.targets, descriptor.archiveTarget);
	checkInterruptedCandidate(served, metadata.targets.signed.targets);
	checkStagedQualification(directory, descriptor, archiveBytes, metadata.targets.signed.targets, served, remote, plan);
	const checkTimestamp = () => {
		const assets = remote.assets(METADATA_RELEASE) ?? [];
		const asset = assets.find((entry) => entry.name === "timestamp.json");
		const bytes = asset === undefined ? undefined : remote.read(asset);
		const actual = bytes === undefined ? null : digest(bytes);
		const receipts = assets.filter((entry) => /^[1-9]\d*\.timestamp\.json$/.test(entry.name));
		if (receipts.some((entry) => Number.parseInt(entry.name, 10) > metadata.timestamp.signed.version))
			throw new Error("Publisher state changed; newer timestamp receipt exists");
		const recovery =
			actual === null &&
			receipts
				.filter(
					(entry) =>
						entry.name === `${metadata.timestamp.signed.version}.timestamp.json` ||
						entry.name === `${plan.expectedTimestampVersion}.timestamp.json`,
				)
				.some((entry) => {
					const hash = digest(remote.read(entry));
					return hash === plan.expectedTimestampSha256 || hash === digest(metadata.timestampBytes);
				});
		if (actual !== plan.expectedTimestampSha256 && actual !== digest(metadata.timestampBytes) && !recovery)
			throw new Error("Publisher state changed; fetch and prepare again");
		if (
			bytes !== undefined &&
			actual !== digest(metadata.timestampBytes) &&
			JSON.parse(bytes).signed.version >= metadata.timestamp.signed.version
		)
			throw new Error("Timestamp version must increase monotonically");
	};
	checkTimestamp();
	const put = (tag, name, path) => {
		let assets = remote.assets(tag);
		if (assets === null) {
			// Public tags anchor the release-only repository, never private source git objects.
			remote.create(tag);
			assets = [];
		}
		const existing = assets.find((asset) => asset.name === name);
		if (existing !== undefined) {
			if (!remote.read(existing).equals(readFileSync(path)))
				throw new Error(`Immutable release asset differs: ${name}`);
			return;
		}
		remote.upload(tag, path);
	};
	put(plan.releaseTag, plan.assetName, archivePath);
	put(plan.releaseTag, DOWNLOAD_ASSET, join(directory, DOWNLOAD_ASSET));
	if (initial === null) remote.create(METADATA_RELEASE);
	const names = [
		`${metadata.targets.signed.version}.targets.json`,
		`${metadata.snapshot.signed.version}.snapshot.json`,
		descriptorAsset,
		`${metadata.timestamp.signed.version}.timestamp.json`,
	];
	for (const name of names) put(METADATA_RELEASE, name, join(directory, name));
	checkTimestamp();
	// A rotated root goes out right before freshness: clients that see it reject the live timestamp its predecessor
	// signed, so the feed fails closed for one upload only, and a stale publisher is refused before that window opens.
	// A retry from here finds the root published and authenticates the old timestamp with `predecessorRoot`.
	put(METADATA_RELEASE, rootName, join(directory, rootName));
	remote.upload(METADATA_RELEASE, join(directory, "timestamp.json"), true);
	const current = remote.assets(METADATA_RELEASE)?.find((asset) => asset.name === "timestamp.json");
	if (current === undefined || !remote.read(current).equals(metadata.timestampBytes))
		throw new Error("Published timestamp readback differs; retention was not run");
	remote.markLatest(plan.releaseTag);
	pruneRepository(rootBytes, remote, now);
}

const RETENTION_MS = 7 * 86400000;

/** Removes only authenticated expired metadata after seven additional days, preserving live dependency chains. */
export function pruneRepository(rootBytes, remote = githubPublisher(), now = new Date()) {
	const root = rootMetadata(rootBytes, now);
	const inventory = remote.assets(METADATA_RELEASE);
	if (inventory === null) throw new Error("Cannot prune a missing metadata repository");
	const assets = new Map(inventory.map((asset) => [asset.name, asset]));
	if (assets.size !== inventory.length) throw new Error("Duplicate metadata asset names prevent retention");
	const read = (asset) => {
		const bytes = remote.read(asset);
		if (bytes.length > 4 * 1024 * 1024) throw new Error("Retention metadata exceeds its size limit");
		return bytes;
	};
	const roots = [];
	for (const asset of inventory.filter((entry) => /^[1-9]\d*\.root\.json$/.test(entry.name))) {
		const bytes = read(asset);
		const metadata = Metadata.fromJSON("root", JSON.parse(bytes));
		metadata.verifyDelegate("root", metadata);
		if (`${metadata.signed.version}.root.json` !== asset.name) throw new Error("Root filename/version mismatch");
		roots.push({ metadata, bytes });
	}
	roots.sort((a, b) => a.metadata.signed.version - b.metadata.signed.version);
	if (roots.length !== root.signed.version || !roots.at(-1)?.bytes.equals(rootBytes))
		throw new Error("Retention requires the complete approved root chain");
	for (let index = 0; index < roots.length; index++) {
		if (roots[index].metadata.signed.version !== index + 1) throw new Error("Root chain has a gap");
		if (index > 0) roots[index - 1].metadata.verifyDelegate("root", roots[index].metadata);
	}
	const records = new Map();
	for (const asset of inventory) {
		const match = asset.name.match(/^([1-9]\d*)\.(timestamp|snapshot|targets)\.json$/);
		if (match === null) continue;
		const bytes = read(asset);
		const metadata = Metadata.fromJSON(match[2], JSON.parse(bytes));
		if (metadata.signed.version !== Number(match[1]) || !Number.isFinite(Date.parse(metadata.signed.expires)))
			throw new Error("Retention metadata has an invalid version or expiry");
		const authorized = roots.some(({ metadata: trusted }) => {
			try {
				trusted.verifyDelegate(match[2], metadata);
				return true;
			} catch {
				return false;
			}
		});
		if (!authorized) throw new Error("Unauthenticated numbered metadata prevents retention");
		records.set(asset.name, { asset, bytes, metadata, kind: match[2] });
	}
	const timestampAsset = assets.get("timestamp.json");
	if (timestampAsset === undefined) throw new Error("Retention requires published freshness metadata");
	const currentBytes = read(timestampAsset);
	const current = Metadata.fromJSON("timestamp", JSON.parse(currentBytes));
	root.verifyDelegate("timestamp", current);
	if (current.signed.isExpired(now)) throw new Error("Cannot prune with expired freshness metadata");
	const receipt = records.get(`${current.signed.version}.timestamp.json`);
	if (receipt === undefined || !receipt.bytes.equals(currentBytes))
		throw new Error("Current timestamp receipt mismatch");
	const keep = new Set(["timestamp.json", ...roots.map(({ metadata }) => `${metadata.signed.version}.root.json`)]);
	const protect = (record) => {
		if (record === undefined) throw new Error("Retained metadata dependency is missing");
		if (keep.has(record.asset.name)) return;
		keep.add(record.asset.name);
		if (record.kind === "targets") return;
		const reference =
			record.kind === "timestamp"
				? record.metadata.signed.snapshotMeta
				: record.metadata.signed.meta["targets.json"];
		const child = records.get(`${reference.version}.${record.kind === "timestamp" ? "snapshot" : "targets"}.json`);
		if (child === undefined) throw new Error("Retained metadata dependency is missing");
		reference.verify(child.bytes);
		protect(child);
	};
	const timestamps = [...records.values()].filter((record) => record.kind === "timestamp");
	const highest = timestamps.reduce(
		(previous, record) =>
			previous === undefined || record.metadata.signed.version > previous.metadata.signed.version
				? record
				: previous,
		undefined,
	);
	protect(receipt);
	if (highest !== undefined) protect(highest);
	for (const record of records.values())
		if (Date.parse(record.metadata.signed.expires) + RETENTION_MS >= now.getTime()) protect(record);
	const descriptors = new Map();
	for (const record of records.values()) {
		if (record.kind !== "targets") continue;
		const info = record.metadata.signed.targets["linux-x64/stable.json"];
		if (info === undefined || !/^[a-f0-9]{64}$/.test(info.hashes.sha256))
			throw new Error("Retention requires an authenticated stable descriptor");
		const name = `linux-x64-${info.hashes.sha256}.stable.json`;
		const asset = assets.get(name);
		if (asset === undefined) {
			if (keep.has(record.asset.name)) throw new Error("Retained descriptor is missing");
			continue;
		}
		if (!descriptors.has(name)) {
			const bytes = read(asset);
			if (bytes.length !== info.length || digest(bytes) !== info.hashes.sha256)
				throw new Error("Descriptor hash mismatch during retention");
			descriptors.set(name, asset);
		}
		if (keep.has(record.asset.name)) keep.add(name);
	}
	const removals = [...records.values()]
		.map((record) => record.asset)
		.concat([...descriptors.values()])
		.filter((asset) => !keep.has(asset.name));
	// Recheck freshness after validation: a competing publication must never lose its dependency chain.
	const latest = remote.assets(METADATA_RELEASE)?.find((asset) => asset.name === "timestamp.json");
	if (latest === undefined || !remote.read(latest).equals(currentBytes))
		throw new Error("Freshness changed during retention");
	for (const asset of removals) remote.remove(METADATA_RELEASE, asset);
	return { removed: removals.map((asset) => asset.name), retained: inventory.length - removals.length };
}

/** Reads the `--rollback-qualification` record files, one per earlier published release; undefined when none given. */
function qualificationRecords(values) {
	return values["rollback-qualification"]?.map((file) => JSON.parse(readFileSync(file, "utf8")));
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	const command = process.argv[2];
	const { values } = parseArgs({
		args: process.argv.slice(3),
		options: {
			...Object.fromEntries(
				["out", "root", "keys", "new-keys", "previous", "previous-root", "archive", "source-commit"].map((name) => [
					name,
					{ type: "string" },
				]),
			),
			// One qualify.mjs record per earlier published release.
			"rollback-qualification": { type: "string", multiple: true },
		},
	});
	if (command === "keygen") generateRepositoryKeys(values.out);
	else if (command === "rotate-root")
		writeFileSync(values.out, rotateRepositoryRoot(readFileSync(values.root), values.keys, values["new-keys"]), {
			flag: "wx",
			mode: 0o644,
		});
	else if (command === "fetch") fetchRepository(values.out);
	else if (command === "renew")
		renewRepository({
			out: values.out,
			rootBytes: readFileSync(values.root),
			keys: values.keys,
			rollbackQualification: qualificationRecords(values),
			...(values["previous-root"] === undefined ? {} : { previousRootBytes: readFileSync(values["previous-root"]) }),
		});
	else if (command === "prepare") {
		if (!/^[a-f0-9]{40}$/.test(values["source-commit"] ?? ""))
			throw new Error("Prepare requires --source-commit from the trusted build checkout");
		const version = basename(values.archive)
			.replace(/^unit-001-/, "")
			.replace(/-linux-x64\.tar\.gz$/, "");
		// One read: the members checked here, the signed digest and the download alias all come from these bytes, so a
		// file swapped at the path meanwhile cannot bind one build's archive to another build's descriptor.
		const archiveBytes = readFileSync(values.archive);
		const member = (path, maxBuffer) =>
			execFileSync("tar", ["-xzOf", "-", `unit-001-${version}-linux-x64/${path}`], { input: archiveBytes, maxBuffer });
		const release = JSON.parse(member("release.json", 1024 * 1024));
		const rootBytes = readFileSync(values.root);
		const bootstrap = member("deploy/update-root.json", 4 * 1024 * 1024);
		const feed = JSON.parse(member("deploy/update-feed.json", 8192));
		if (
			!bootstrap.equals(rootBytes) ||
			JSON.stringify(feed) !== JSON.stringify({ schemaVersion: 1, repository: UPDATE_REPOSITORY, channel: "stable" })
		)
			throw new Error("Public release must bundle the approved verification root and fixed public update feed");
		prepareRepository({
			...values,
			archiveBytes,
			release,
			rollbackQualification: qualificationRecords(values),
			expectedSourceCommit: values["source-commit"],
			rootBytes,
			...(values["previous-root"] === undefined ? {} : { previousRootBytes: readFileSync(values["previous-root"]) }),
		});
	} else if (command === "publish") publishRepository(values.out, readFileSync(values.root));
	else
		throw new Error(
			"Usage: update-repository.mjs keygen|rotate-root|fetch|prepare|renew|publish --out PATH [--root FILE --keys DIR --new-keys DIR --previous DIR --previous-root FILE --archive FILE --source-commit SHA --rollback-qualification FILE]",
		);
}
