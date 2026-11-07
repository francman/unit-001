#!/usr/bin/env node
// Exercises signed fixture updates and rollback on the explicitly disposable managed-install acceptance host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readInstallation } from "../deploy/installation.mjs";
import { extractUpdateArchive } from "../deploy/update.mjs";
import { activateUpdate, createUpdateContext, rollbackUpdate } from "../deploy/update-activation.mjs";
import { fetchUpdate } from "../deploy/update-trust.mjs";
import { writeReleaseArchive, writeReleaseChecksums } from "./build-release.mjs";
import { generateRepositoryKeys, prepareRepository } from "./update-repository.mjs";

if (
	process.platform !== "linux" ||
	process.arch !== "x64" ||
	process.getuid() !== 0 ||
	process.env.GITHUB_ACTIONS !== "true" ||
	process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
	process.env.UNIT_001_DISPOSABLE_CI !== "1" ||
	execFileSync("ps", ["-p", "1", "-o", "comm="], { encoding: "utf8" }).trim() !== "systemd"
)
	throw new Error("Requires explicit disposable GitHub-hosted Ubuntu/systemd acceptance authorization.");

const [sourceArgument, id] = process.argv.slice(2);
const source = resolve(sourceArgument);
const record = readInstallation(id);
const baseline = record.releaseVersion;
mkdirSync("/var/cache/unit-001", { recursive: true, mode: 0o755 });
const work = mkdtempSync("/var/cache/unit-001/update-acceptance-");
const context = createUpdateContext();
try {
	const parts = baseline.split(".").map(Number);
	const version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
	const name = `unit-001-${version}-linux-x64`;
	const candidate = join(work, name);
	cpSync(source, candidate, { recursive: true });
	writeFileSync(join(candidate, "VERSION"), `${version}\n`);
	const manifest = JSON.parse(readFileSync(join(candidate, "app/package.json")));
	manifest.version = version;
	writeFileSync(join(candidate, "app/package.json"), JSON.stringify(manifest));
	const release = JSON.parse(readFileSync(join(candidate, "release.json")));
	release.version = version;
	// This fixture signs copied payload bytes; it is never published as a production release.
	release.source.dirty = false;
	writeFileSync(join(candidate, "release.json"), JSON.stringify(release));
	writeReleaseChecksums(candidate);
	const archive = join(work, `${name}.tar.gz`);
	writeReleaseArchive(work, name, archive);
	const rootBytes = generateRepositoryKeys(join(work, "keys"));
	const { files } = prepareRepository({
		archive,
		release,
		rootBytes,
		keys: join(work, "keys"),
		out: join(work, "metadata"),
	});
	const assets = new Map();
	let nextId = 1;
	const inventory = (entries) =>
		entries.map(([assetName, bytes]) => {
			const asset = { id: nextId++, name: assetName };
			assets.set(asset.id, bytes);
			return asset;
		});
	const metadata = inventory(Object.entries(files));
	const archives = inventory([[`${name}.tar.gz`, readFileSync(archive)]]);
	writeFileSync(join(work, "root.json"), rootBytes);
	writeFileSync(join(work, "token"), "fixture-only", { mode: 0o600 });
	chmodSync(work, 0o700);
	const verified = await fetchUpdate(
		{
			metadataDir: join(work, "cache"),
			bootstrapRoot: join(work, "root.json"),
			tokenFile: join(work, "token"),
			downloadDir: join(work, "downloads"),
		},
		{
			ownerUid: 0,
			async fetch(url) {
				const route = new URL(url);
				if (route.pathname.endsWith("/releases/tags/unit-updates-stable"))
					return Response.json({ id: 100, assets: metadata });
				if (route.pathname.endsWith(`/releases/tags/unit-v${version}`))
					return Response.json({ id: 101, assets: archives });
				const listing = route.pathname.match(/\/releases\/(100|101)\/assets$/);
				if (listing !== null) {
					const inventory = listing[1] === "100" ? metadata : archives;
					const page = Number(route.searchParams.get("page") ?? "1");
					return Response.json(inventory.slice((page - 1) * 100, page * 100));
				}
				const asset = assets.get(Number(route.pathname.split("/").at(-1)));
				return asset === undefined ? new Response("missing", { status: 404 }) : new Response(asset);
			},
		},
	);
	assert.equal(verified.version, version);
	const extraction = join(work, "extracted");
	mkdirSync(extraction, { mode: 0o700 });
	const releasePath = await extractUpdateArchive(verified.archivePath, extraction, version);
	assert.deepEqual(await activateUpdate(record, { releasePath, ...verified }, context), {
		status: "updated",
		version,
	});
	assert.equal(readInstallation(id).releaseVersion, version);
	const status = context.control(readInstallation(id), ["service-status"]);
	assert.equal(status.version, version);
	assert.equal(status.inhibited, false);
	assert.equal(status.maintenance.state, "open");
	// Exercise the independent management entry point rather than the application's launcher.
	const help = execFileSync("/usr/local/sbin/unit-001-update", [id, "--help"], { encoding: "utf8" });
	assert.match(help, /Usage: update/);
	const packagedStatus = () =>
		JSON.parse(execFileSync("/usr/local/sbin/unit-001-update", [id, "status"], { encoding: "utf8", timeout: 10000 }));
	assert.equal(packagedStatus().installedVersion, version);
	assert.equal(packagedStatus().runningVersion, version);
	// #18: state produced after commit must survive code rollback; restoring the pre-update backup would lose it.
	const marker = `/var/lib/unit-001/agents/${id}/workspace/post-update-evidence`;
	execFileSync("runuser", ["-u", record.account, "--", "tee", marker], {
		input: "created-after-update-commit\n",
		stdio: ["pipe", "ignore", "inherit"],
		timeout: 10000,
	});
	assert.deepEqual(await rollbackUpdate(readInstallation(id), context), { status: "updated", version: baseline });
	assert.equal(context.control(readInstallation(id), ["service-status"]).version, baseline);
	assert.equal(packagedStatus().runningVersion, baseline);
	assert.equal(readFileSync(marker, "utf8"), "created-after-update-commit\n");
	await assert.rejects(
		activateUpdate(
			readInstallation(id),
			{ releasePath, ...verified },
			{
				...context,
				async ready(current, operationId) {
					await context.ready(current, operationId);
					if (current.releaseVersion === version) throw new Error("Injected candidate health failure");
				},
			},
		),
		/Injected candidate health failure/,
	);
	assert.equal(readInstallation(id).releaseVersion, baseline);
	assert.equal(context.control(readInstallation(id), ["service-status"]).inhibited, false);
	assert.equal(readFileSync(marker, "utf8"), "created-after-update-commit\n");
	console.log("Managed signed update and current-state rollback passed (real systemd; no model requests).");
} finally {
	rmSync(work, { recursive: true, force: true });
}
