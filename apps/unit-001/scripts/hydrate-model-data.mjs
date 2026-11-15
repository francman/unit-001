#!/usr/bin/env node
// Restores reviewed Unit model data from a content-pinned public release, without live catalog discovery.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hydrateModelCatalog } from "../../../packages/ai/scripts/hydrate-model-catalog.ts";
import { readModelDataProviderIds } from "../../../packages/ai/scripts/model-data.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

/** Checks the downloaded or cached archive boundary before any extraction or provider-data replacement. */
export async function verifyPinnedArchive(path, expectedSha256) {
	if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))
		throw new Error("Invalid reviewed model-data archive hash");
	const info = lstatSync(path);
	if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) throw new Error("Expected a regular archive at most 128 MiB");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	if (hash.digest("hex") !== expectedSha256) throw new Error("Archive differs from the reviewed model-data pin");
}

/** Adds only reviewed historical identities, refusing a stale allowlist or missing source evidence. */
export function addHistoricalModels(released, historical, additions) {
	const catalog = { ...released };
	const seen = new Set();
	for (const item of additions) {
		const { provider, type, id } = item;
		if (
			!/^[a-z0-9-]+$/.test(provider) ||
			!["chat", "image", "classifier"].includes(type) ||
			typeof id !== "string" ||
			id.length === 0
		)
			throw new Error("Invalid historical model identity");
		const identity = `${provider}:${type}:${id}`;
		if (seen.has(identity)) throw new Error(`Duplicate historical model addition: ${identity}`);
		seen.add(identity);
		if (!Array.isArray(released[provider]) || !Array.isArray(historical[provider]))
			throw new Error(`Historical model provider is unavailable: ${provider}`);
		if (released[provider].some((model) => model.type === type && model.id === id))
			throw new Error(`Historical addition is already released; review and remove it: ${identity}`);
		const matches = historical[provider].filter((model) => model.type === type && model.id === id);
		if (matches.length !== 1) throw new Error(`Historical model evidence is missing or duplicated: ${identity}`);
		catalog[provider] = [...catalog[provider], matches[0]];
	}
	return catalog;
}

/** Rejects release provenance that does not match the exact clean source accepted in the Unit pin. */
export function verifyModelDataSource(release, pin) {
	if (
		release.version !== pin.release ||
		release.source?.commit !== pin.sourceCommit ||
		release.source?.dirty !== false
	)
		throw new Error("Model-data archive source differs from the reviewed pin");
}

/** Hydrates ignored provider JSON from exact published bytes while leaving upstream source and tests unchanged. */
export async function hydratePinnedModelData(archivePath) {
	const pin = JSON.parse(readFileSync(join(repository, "apps/unit-001/model-data-pin.json"), "utf8"));
	if (
		!/^\d+\.\d+\.\d+$/.test(pin.release) ||
		!/^[a-f0-9]{40}$/.test(pin.sourceCommit) ||
		!/^sha256-[a-f0-9]{64}$/.test(pin.historicalCatalogRevision) ||
		!Array.isArray(pin.additionalModels)
	)
		throw new Error("Invalid model-data release pin");
	const staging = mkdtempSync(join(tmpdir(), "unit-model-data-"));
	try {
		const archive = join(staging, "release.tar.gz");
		if (archivePath !== undefined) {
			const info = lstatSync(archivePath);
			if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES)
				throw new Error("Expected a regular archive at most 128 MiB");
			// Verify and extract only the private copy, so a caller cannot replace its cached path between those steps.
			copyFileSync(archivePath, archive);
		} else
			execFileSync(
				"curl",
				[
					"--fail",
					"--silent",
					"--show-error",
					"--location",
					"--max-redirs",
					"5",
					"--proto",
					"=https",
					"--proto-redir",
					"=https",
					"--connect-timeout",
					"15",
					"--max-time",
					"180",
					"--max-filesize",
					String(MAX_ARCHIVE_BYTES),
					`https://github.com/francman/unit-001-releases/releases/download/unit-v${pin.release}/unit-001-${pin.release}-linux-x64.tar.gz`,
					"--output",
					archive,
				],
				{ stdio: "inherit" },
			);
		await verifyPinnedArchive(archive, pin.archiveSha256);
		const prefix = `unit-001-${pin.release}-linux-x64`;
		const dataPath = `${prefix}/app/node_modules/@earendil-works/pi-ai/dist/providers/data`;
		execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", staging, dataPath]);
		const release = JSON.parse(
			execFileSync("tar", ["-xOf", archive, `${prefix}/release.json`], { encoding: "utf8" }),
		);
		verifyModelDataSource(release, pin);
		// The published runtime has newer OpenAI models; one explicitly pinned historical identity serves unchanged tests.
		const historicalPath = join(staging, "historical.json");
		execFileSync(
			"curl",
			[
				"--fail",
				"--silent",
				"--show-error",
				"--proto",
				"=https",
				"--connect-timeout",
				"15",
				"--max-time",
				"30",
				"--max-filesize",
				String(16 * 1024 * 1024),
				`https://pi.dev/api/models/revisions/${pin.historicalCatalogRevision}?types=chat,image,classifier`,
				"--output",
				historicalPath,
			],
			{ stdio: "inherit" },
		);
		await verifyPinnedArchive(historicalPath, pin.historicalCatalogRevision.slice("sha256-".length));
		const historical = JSON.parse(readFileSync(historicalPath, "utf8"));
		const released = {};
		for (const provider of readModelDataProviderIds(join(repository, "packages/ai"))) {
			const groups = JSON.parse(readFileSync(join(staging, dataPath, `${provider}.json`), "utf8"));
			released[provider] = Object.values(groups).flatMap((group) => Object.values(group));
		}
		const catalog = addHistoricalModels(released, historical, pin.additionalModels);
		const path = join(staging, "models.all.json");
		writeFileSync(path, JSON.stringify(catalog));
		hydrateModelCatalog(join(repository, "packages/ai"), path);
		return pin;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const { values } = parseArgs({ options: { archive: { type: "string" } } });
	const pin = await hydratePinnedModelData(values.archive);
	console.log(
		`Hydrated reviewed model-data archive ${pin.archiveSha256} with ${pin.additionalModels.length} historical addition(s)`,
	);
}
