#!/usr/bin/env node
// Verifies the anonymous public metadata chain after renewal without downloading or executing an agent.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Metadata } from "@tufjs/models";
import { validateArchiveTarget, validateDescriptor, validateDescriptorTarget } from "../deploy/update-trust.mjs";
import { METADATA_RELEASE, UPDATE_REPOSITORY } from "./update-repository.mjs";

/** Verifies fresh signed metadata and its descriptor, reporting precisely which public evidence was checked. */
export async function verifyPublicMetadata(rootBytes, readAsset, now = new Date()) {
	const root = Metadata.fromJSON("root", JSON.parse(rootBytes));
	root.verifyDelegate("root", root);
	if (root.signed.isExpired(now)) throw new Error("Approved public root has expired");
	const timestampBytes = await readAsset("timestamp.json");
	const timestamp = Metadata.fromJSON("timestamp", JSON.parse(timestampBytes));
	root.verifyDelegate("timestamp", timestamp);
	if (timestamp.signed.isExpired(now)) throw new Error("Public freshness metadata has expired");
	if (
		!Number.isSafeInteger(timestamp.signed.snapshotMeta.length) ||
		!/^[a-f0-9]{64}$/.test(timestamp.signed.snapshotMeta.hashes?.sha256)
	)
		throw new Error("Public snapshot reference has no exact length and SHA256");
	const snapshotBytes = await readAsset(`${timestamp.signed.snapshotMeta.version}.snapshot.json`);
	timestamp.signed.snapshotMeta.verify(snapshotBytes);
	const snapshot = Metadata.fromJSON("snapshot", JSON.parse(snapshotBytes));
	root.verifyDelegate("snapshot", snapshot);
	if (snapshot.signed.isExpired(now)) throw new Error("Public snapshot has expired");
	const targetsMeta = snapshot.signed.meta["targets.json"];
	if (targetsMeta === undefined) throw new Error("Public snapshot has no targets metadata");
	if (!Number.isSafeInteger(targetsMeta.length) || !/^[a-f0-9]{64}$/.test(targetsMeta.hashes?.sha256))
		throw new Error("Public targets reference has no exact length and SHA256");
	const targetsBytes = await readAsset(`${targetsMeta.version}.targets.json`);
	targetsMeta.verify(targetsBytes);
	const targets = Metadata.fromJSON("targets", JSON.parse(targetsBytes));
	root.verifyDelegate("targets", targets);
	if (targets.signed.isExpired(now)) throw new Error("Public targets have expired");
	const info = validateDescriptorTarget(targets.signed.targets["linux-x64/stable.json"]);
	const descriptorBytes = await readAsset(`linux-x64-${info.hashes.sha256}.stable.json`);
	await info.verify(Readable.from([descriptorBytes]));
	const descriptor = validateDescriptor(JSON.parse(descriptorBytes));
	const archive = validateArchiveTarget(targets.signed.targets[descriptor.archiveTarget], descriptor.version);
	return {
		observedAt: now.toISOString(),
		metadataOnly: true,
		rootVersion: root.signed.version,
		timestampVersion: timestamp.signed.version,
		expires: timestamp.signed.expires,
		timestampSha256: createHash("sha256").update(timestampBytes).digest("hex"),
		release: descriptor.version,
		sourceCommit: descriptor.sourceCommit,
		archiveSha256: archive.hashes.sha256,
	};
}

async function readPublicAsset(name) {
	const response = await fetch(
		`https://github.com/${UPDATE_REPOSITORY}/releases/download/${METADATA_RELEASE}/${name}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (!response.ok || response.body === null) throw new Error(`Public metadata unavailable: HTTP ${response.status}`);
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > 4 * 1024 * 1024) throw new Error("Public metadata exceeds 4 MiB");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	const { values } = parseArgs({
		options: { root: { type: "string" }, "expected-timestamp": { type: "string" }, out: { type: "string" } },
	});
	if (values.root === undefined || values.out === undefined)
		throw new Error("Requires --root FILE --out RECEIPT.json");
	const receipt = await verifyPublicMetadata(readFileSync(values.root), readPublicAsset);
	if (
		values["expected-timestamp"] !== undefined &&
		createHash("sha256").update(readFileSync(values["expected-timestamp"])).digest("hex") !== receipt.timestampSha256
	)
		throw new Error("Public metadata differs from the prepared renewal");
	writeFileSync(values.out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	console.log(`Public metadata v${receipt.timestampVersion} verified; expires ${receipt.expires}`);
}
