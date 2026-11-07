#!/usr/bin/env node
// Signs and publishes the unit-owned TUF repository; never updates a running installation.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Key, Metadata, MetaFile, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models";

export const UPDATE_REPOSITORY = "francman/unit-001";
export const METADATA_RELEASE = "unit-updates-stable";
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

/** Builds fresh signed metadata from reviewed release metadata and immutable archive bytes. */
export function prepareRepository({
	archive,
	release,
	rootBytes,
	keys,
	previous,
	previousRootBytes,
	out,
	now = new Date(),
}) {
	if (
		!/^\d+\.\d+\.\d+$/.test(release.version) ||
		release.platform !== "linux-x64" ||
		!/^[a-f0-9]{40}$/.test(release.source?.commit ?? "") ||
		release.source.dirty !== false
	)
		throw new Error("Publishing requires a clean Linux x64 release with an exact stable version and source commit");
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
	const archiveBytes = readFileSync(archive);
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
	const versions = Object.keys(targets.targets)
		.map((path) =>
			path
				.match(/^linux-x64\/releases\/(\d+)\.(\d+)\.(\d+)\.tar\.gz$/)
				?.slice(1)
				.map(Number),
		)
		.filter(Boolean);
	const selected = version.split(".").map(Number);
	if (
		versions.some((parts) =>
			parts.some(
				(part, index) => part > selected[index] && parts.slice(0, index).every((value, i) => value === selected[i]),
			),
		)
	)
		throw new Error("Stable publication cannot downgrade the release version");
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
	writeFileSync(
		join(out, "publication.json"),
		encode({
			schemaVersion: 1,
			repository: UPDATE_REPOSITORY,
			archive: resolve(archive),
			releaseTag,
			assetName,
			expectedTimestampSha256: prior === undefined ? null : digest(prior.timestampBytes),
			expectedTimestampVersion: prior?.timestamp.signed.version ?? null,
		}),
		{ flag: "wx" },
	);
	return { descriptor, files };
}

/** Uses only the fixed private GitHub repository, without embedding credentials in URLs. */
export function githubPublisher() {
	const run = (args, options = {}) => execFileSync("gh", args, { maxBuffer: 1024 * 1024 * 1024, ...options });
	return {
		assets(tag) {
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
		commit(tag) {
			return run(["api", `repos/${UPDATE_REPOSITORY}/commits/${tag}`, "--jq", ".sha"])
				.toString()
				.trim();
		},
		create(tag, commit) {
			run([
				"release",
				"create",
				tag,
				"--repo",
				UPDATE_REPOSITORY,
				"--title",
				tag,
				"--notes",
				"Authenticated unit-001 release assets.",
				...(commit === undefined ? [] : ["--target", commit]),
			]);
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

/** Fetches publisher state; only a confirmed missing release represents an empty repository. */
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
	if (timestampAsset === undefined) return;
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
}

/** Renews metadata for the exact existing archive; never rebuilds an already published version. */
export function renewRepository(
	{ out, rootBytes, keys, previousRootBytes, now = new Date() },
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
		!/^\d+\.\d+\.\d+$/.test(descriptor.version) ||
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
		now,
		out: join(out, "publication"),
	});
}

/** Publishes immutable content first, with timestamp last and a stale-publisher check. */
export function publishRepository(directory, rootBytes, remote = githubPublisher(), now = new Date()) {
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
	const publishedRoots = (initial ?? [])
		.filter((asset) => /^[1-9]\d*\.root\.json$/.test(asset.name))
		.sort((a, b) => Number.parseInt(a.name, 10) - Number.parseInt(b.name, 10));
	const latestRootAsset = publishedRoots.at(-1);
	if (latestRootAsset !== undefined) {
		const previousRootBytes = remote.read(latestRootAsset);
		const previousRoot = Metadata.fromJSON("root", JSON.parse(previousRootBytes));
		previousRoot.verifyDelegate("root", previousRoot);
		if (root.signed.version === previousRoot.signed.version) {
			if (!rootBytes.equals(previousRootBytes)) throw new Error("Published root version cannot change bytes");
		} else {
			if (root.signed.version !== previousRoot.signed.version + 1)
				throw new Error("Published root rotation must advance by one version");
			previousRoot.verifyDelegate("root", root);
		}
	} else if (root.signed.version !== 1) throw new Error("Missing bootstrap root chain");
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
			remote.create(tag, tag === plan.releaseTag ? descriptor.sourceCommit : undefined);
			assets = [];
		}
		if (tag === plan.releaseTag && remote.commit(tag) !== descriptor.sourceCommit)
			throw new Error("Release tag does not identify the built source commit");
		const existing = assets.find((asset) => asset.name === name);
		if (existing !== undefined) {
			if (!remote.read(existing).equals(readFileSync(path)))
				throw new Error(`Immutable release asset differs: ${name}`);
			return;
		}
		remote.upload(tag, path);
	};
	put(plan.releaseTag, plan.assetName, plan.archive);
	if (initial === null) remote.create(METADATA_RELEASE);
	const names = [
		rootName,
		`${metadata.targets.signed.version}.targets.json`,
		`${metadata.snapshot.signed.version}.snapshot.json`,
		descriptorAsset,
		`${metadata.timestamp.signed.version}.timestamp.json`,
	];
	for (const name of names) put(METADATA_RELEASE, name, join(directory, name));
	checkTimestamp();
	remote.upload(METADATA_RELEASE, join(directory, "timestamp.json"), true);
	const current = remote.assets(METADATA_RELEASE)?.find((asset) => asset.name === "timestamp.json");
	if (current === undefined || !remote.read(current).equals(metadata.timestampBytes))
		throw new Error("Published timestamp readback differs; retention was not run");
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

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	const command = process.argv[2];
	const { values } = parseArgs({
		args: process.argv.slice(3),
		options: Object.fromEntries(
			["out", "root", "keys", "new-keys", "previous", "previous-root", "archive"].map((name) => [
				name,
				{ type: "string" },
			]),
		),
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
			...(values["previous-root"] === undefined ? {} : { previousRootBytes: readFileSync(values["previous-root"]) }),
		});
	else if (command === "prepare") {
		const version = basename(values.archive)
			.replace(/^unit-001-/, "")
			.replace(/-linux-x64\.tar\.gz$/, "");
		const release = JSON.parse(
			execFileSync("tar", ["-xOf", values.archive, `unit-001-${version}-linux-x64/release.json`], {
				encoding: "utf8",
			}),
		);
		prepareRepository({
			...values,
			release,
			rootBytes: readFileSync(values.root),
			...(values["previous-root"] === undefined ? {} : { previousRootBytes: readFileSync(values["previous-root"]) }),
		});
	} else if (command === "publish") publishRepository(values.out, readFileSync(values.root));
	else
		throw new Error(
			"Usage: update-repository.mjs keygen|rotate-root|fetch|prepare|renew|publish --out PATH [--root FILE --keys DIR --new-keys DIR --previous DIR --previous-root FILE --archive FILE]",
		);
}
