#!/usr/bin/env node
// Exercises signed fixture updates and rollback on the explicitly disposable managed-install acceptance host.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installationPaths, listInstallations, readInstallation } from "../deploy/installation.mjs";
import { extractUpdateArchive } from "../deploy/update.mjs";
import {
	activateUpdate,
	createUpdateContext,
	readUpdateJournal,
	rollbackUpdate,
	updatePaths,
} from "../deploy/update-activation.mjs";
import { fetchUpdate } from "../deploy/update-trust.mjs";
import { writeReleaseArchive, writeReleaseChecksums, writeUpdateBootstrap } from "./build-release.mjs";
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

const [sourceArgument, id, mode] = process.argv.slice(2);
assert.ok(
	mode === undefined || mode === "--expect-operator" || mode === "--published-entry-only",
	"Unknown update acceptance option",
);
const expectOperator = mode === "--expect-operator";
const publishedEntry = mode === "--published-entry-only";
const source = resolve(sourceArgument);
const record = readInstallation(id);
const baseline = record.releaseVersion;
mkdirSync("/var/cache/unit-001", { recursive: true, mode: 0o755 });
const work = mkdtempSync("/var/cache/unit-001/update-acceptance-");
const context = createUpdateContext();
try {
	const keys = join(work, "keys");
	const rootBytes = generateRepositoryKeys(keys);
	const parts = baseline.split(".").map(Number);
	const version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
	const activationContext = {
		...context,
		async ready(current, operationId) {
			await context.ready(current, operationId);
			if (expectOperator && current.releaseVersion === version) {
				// #33: candidate readiness must include the operator endpoint, not just its private updater socket.
				const directory = lstatSync(`/run/unit-001-${id}`);
				const socket = lstatSync(`/run/unit-001-${id}/default.sock`);
				const account = execFileSync("getent", ["passwd", current.account], { encoding: "utf8" }).trim().split(":");
				assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
				assert.equal(directory.uid, Number(account[2]));
				assert.equal(directory.gid, Number(account[3]));
				assert.equal(directory.mode & 0o777, 0o750);
				assert.ok(socket.isSocket());
				assert.equal(socket.uid, Number(account[2]));
				assert.equal(socket.gid, Number(account[3]));
				assert.equal(socket.mode & 0o777, 0o660);
			}
		},
	};
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
	writeUpdateBootstrap(candidate, join(keys, "root.json"));
	writeReleaseChecksums(candidate);
	const archive = join(work, `${name}.tar.gz`);
	writeReleaseArchive(work, name, archive);
	const { files } = prepareRepository({
		archive,
		release,
		rootBytes,
		keys,
		out: join(work, "metadata"),
	});
	const assets = new Map(
		Object.entries(files).map(([assetName, bytes]) => [`unit-updates-stable/${assetName}`, bytes]),
	);
	assets.set(`unit-v${version}/${name}.tar.gz`, readFileSync(archive));
	const requests = [];
	chmodSync(work, 0o700);
	const verified = await fetchUpdate(
		{
			metadataDir: join(work, "cache"),
			bootstrapRoot: join(candidate, "deploy/update-root.json"),
			downloadDir: join(work, "downloads"),
		},
		{
			ownerUid: 0,
			async fetch(url, init) {
				requests.push({ url, headers: init.headers });
				const route = new URL(url);
				assert.equal(route.origin, "https://github.com");
				assert.equal(init.headers.Authorization, undefined);
				const match = route.pathname.match(/^\/francman\/unit-001-releases\/releases\/download\/([^/]+)\/([^/]+)$/);
				assert.notEqual(match, null);
				const asset = assets.get(`${match[1]}/${match[2]}`);
				return asset === undefined ? new Response("missing", { status: 404 }) : new Response(asset);
			},
		},
	);
	assert.equal(verified.version, version);
	assert.ok(requests.length > 0);
	assert.ok(
		requests.every(({ url, headers }) => !url.includes("api.github.com") && headers.Authorization === undefined),
	);
	const extraction = join(work, "extracted");
	mkdirSync(extraction, { mode: 0o700 });
	const releasePath = await extractUpdateArchive(verified.archivePath, extraction, version);
	// #18: the actual downloaded installer seeds public trust without changing host accounts or services.
	const image = join(work, "public-image");
	execFileSync("bash", [join(releasePath, "install.sh"), "--root", image, "--name", "public-ci"], {
		env: {
			...process.env,
			PATH: `${releasePath}/runtime/bin:${process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin"}`,
		},
		stdio: "inherit",
		timeout: 180000,
	});
	const installed = listInstallations(image);
	assert.equal(installed.length, 1);
	const staged = installed[0];
	assert.equal(staged.name, "public-ci");
	assert.equal(staged.desiredState, "stopped");
	const stagedUpdate = updatePaths(staged.id, image);
	assert.deepEqual(JSON.parse(readFileSync(stagedUpdate.config)), {
		schemaVersion: 1,
		id: staged.id,
		enabled: true,
		pin: null,
		repository: "francman/unit-001-releases",
		channel: "stable",
	});
	assert.deepEqual(readFileSync(stagedUpdate.trustRoot), rootBytes);
	assert.equal(existsSync(stagedUpdate.token), false);
	const stagedInstallation = installationPaths(staged.id, image);
	for (const unit of [stagedInstallation.updaterService, stagedInstallation.updaterTimer])
		assert.equal(existsSync(join(image, "etc/systemd/system", unit)), true);
	assert.equal(existsSync(`/etc/systemd/system/${stagedInstallation.unit}`), false);
	assert.equal(spawnSync("getent", ["passwd", staged.account], { timeout: 10000 }).status, 2);
	if (publishedEntry) {
		assert.equal(baseline, "0.0.6");
		const oldCore = join(updatePaths(id).cores, baseline);
		const fixtureAssets = join(work, "published-assets");
		mkdirSync(fixtureAssets);
		const manifest = [];
		for (const [route, bytes] of assets) {
			const file = join(fixtureAssets, String(manifest.length));
			writeFileSync(file, bytes, { mode: 0o600 });
			manifest.push([route, file]);
		}
		const assetManifest = join(work, "published-assets.json");
		writeFileSync(assetManifest, JSON.stringify(manifest), { mode: 0o600 });
		const entry = join(work, "published-entry.mjs");
		// Literal static imports execute the installed published updater, without altering its core inventory.
		writeFileSync(
			entry,
			`import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runUpdate } from ${JSON.stringify(pathToFileURL(join(oldCore, "lib/update.mjs")).href)};
import { createUpdateContext } from ${JSON.stringify(pathToFileURL(join(oldCore, "lib/update-activation.mjs")).href)};
const assets = new Map(JSON.parse(readFileSync(${JSON.stringify(assetManifest)}, "utf8")));
const context = { ...createUpdateContext(), async fetch(url, init) {
  assert.equal(new URL(url).origin, "https://github.com");
  assert.equal(init.headers.Authorization, undefined);
  const route = new URL(url).pathname.match(/^\\/francman\\/unit-001-releases\\/releases\\/download\\/([^/]+)\\/([^/]+)$/);
  assert.notEqual(route, null);
  const file = assets.get(route[1] + "/" + route[2]);
  return file === undefined ? new Response("missing", { status: 404 }) : new Response(readFileSync(file));
} };
const result = await runUpdate(["apply", "--id", ${JSON.stringify(id)}], context);
assert.equal(result.status, "updated");
assert.equal(result.version, ${JSON.stringify(version)});
console.log("Installed published 0.0.6 updater verified and activated the signed candidate.");
`,
			{ mode: 0o600 },
		);
		const policyPaths = updatePaths(id);
		const originalRoot = readFileSync(policyPaths.trustRoot);
		const originalPolicy = readFileSync(policyPaths.config);
		assert.equal(existsSync(policyPaths.cache), false, "Published fixture requires its own fresh update cache");
		const originalUnit = readFileSync(installationPaths(id).unitFile);
		try {
			writeFileSync(policyPaths.trustRoot, rootBytes);
			execFileSync(join(oldCore, "runtime/bin/node"), [entry], { stdio: "inherit", timeout: 180000 });
			assert.deepEqual(readFileSync(installationPaths(id).unitFile), originalUnit);
			assert.equal(existsSync(`/run/unit-001-${id}`), false);
		} finally {
			writeFileSync(policyPaths.trustRoot, originalRoot);
			rmSync(policyPaths.cache, { recursive: true, force: true });
			assert.deepEqual(readFileSync(policyPaths.config), originalPolicy);
		}
	} else {
		assert.deepEqual(await activateUpdate(record, { releasePath, ...verified }, activationContext), {
			status: "updated",
			version,
		});
	}
	assert.equal(readInstallation(id).releaseVersion, version);
	const status = context.control(readInstallation(id), ["service-status"]);
	assert.equal(status.version, version);
	assert.equal(status.inhibited, false);
	assert.equal(status.maintenance.state, "open");
	if (!publishedEntry) {
		// Exercise the independent management entry point rather than the application's launcher.
		const help = execFileSync("/usr/local/sbin/unit-001-update", [id, "--help"], { encoding: "utf8" });
		assert.match(help, /Usage: update/);
		const packagedStatus = () =>
			JSON.parse(
				execFileSync("/usr/local/sbin/unit-001-update", [id, "status"], { encoding: "utf8", timeout: 10000 }),
			);
		assert.equal(packagedStatus().installedVersion, version);
		assert.equal(packagedStatus().runningVersion, version);
		// #18: state produced after commit must survive code rollback; restoring the pre-update backup would lose it.
		const marker = `/var/lib/unit-001/agents/${id}/workspace/post-update-evidence`;
		execFileSync("runuser", ["-u", record.account, "--", "tee", marker], {
			input: "created-after-update-commit\n",
			stdio: ["pipe", "ignore", "inherit"],
			timeout: 10000,
		});
		assert.deepEqual(await rollbackUpdate(readInstallation(id), activationContext), {
			status: "updated",
			version: baseline,
		});
		assert.equal(context.control(readInstallation(id), ["service-status"]).version, baseline);
		assert.equal(packagedStatus().runningVersion, baseline);
		assert.equal(readFileSync(marker, "utf8"), "created-after-update-commit\n");
		await assert.rejects(
			activateUpdate(
				readInstallation(id),
				{ releasePath, ...verified },
				{
					...activationContext,
					async ready(current, operationId) {
						await activationContext.ready(current, operationId);
						if (current.releaseVersion === version) throw new Error("Injected candidate health failure");
					},
				},
			),
			/Injected candidate health failure/,
		);
		assert.equal(readInstallation(id).releaseVersion, baseline);
		assert.equal(context.control(readInstallation(id), ["service-status"]).inhibited, false);
		assert.equal(readFileSync(marker, "utf8"), "created-after-update-commit\n");
		// #18: SIGKILL releases the real kernel lock; the next main-unit start must invoke its boot dependencies.
		const crashCandidate = join(work, "crash-candidate.json");
		writeFileSync(crashCandidate, JSON.stringify({ releasePath, ...verified }), { mode: 0o600 });
		const killed = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./verify-update-crash.mjs", import.meta.url)), id, crashCandidate],
			{ encoding: "utf8", timeout: 60000, maxBuffer: 1048576 },
		);
		assert.equal(killed.signal, "SIGKILL", `Crash helper did not reach candidate: ${killed.stderr}`);
		assert.equal(readUpdateJournal(id).phase, "candidate");
		assert.equal(readInstallation(id).desiredState, "running");
		const mainUnit = `unit-001@${id}.service`;
		context.run("systemctl", ["start", mainUnit]);
		const deadline = performance.now() + 45000;
		let recovered = false,
			failure;
		do {
			try {
				const current = readInstallation(id);
				const status = context.control(
					current,
					["service-status"],
					Math.min(2000, Math.max(1, deadline - performance.now())),
				);
				assert.equal(readUpdateJournal(id).phase, "complete");
				assert.equal(current.releaseVersion, baseline);
				assert.equal(current.desiredState, "running");
				assert.equal(status.installationId, id);
				assert.equal(status.version, baseline);
				assert.equal(status.inhibited, false);
				assert.equal(status.maintenance.state, "open");
				recovered = true;
				break;
			} catch (error) {
				failure = error;
			}
			await setTimeout(100);
		} while (performance.now() < deadline);
		if (!recovered) {
			const paths = updatePaths(id);
			try {
				context.run("systemctl", ["status", "--no-pager", mainUnit, paths.prepareUnit, paths.finalizeUnit]);
			} catch {}
			throw new Error(`Boot dependency recovery did not finish within 45 seconds: ${failure?.message}`);
		}
		assert.equal(readFileSync(marker, "utf8"), "created-after-update-commit\n");
		assert.equal(packagedStatus().runningVersion, baseline);
		console.log(
			"Managed public download/bootstrap, signed update, current-state rollback, and SIGKILL/startup-dependency recovery passed (real systemd; no GitHub credentials, reboot or model requests).",
		);
	} else console.log("Published updater migration retained the legacy unit and a healthy private owner.");
} catch (error) {
	console.error(`Native update acceptance failed: ${error.message}`);
	const paths = updatePaths(id),
		mainUnit = `unit-001@${id}.service`;
	try {
		console.error(`Recovery journal phase: ${readUpdateJournal(id)?.phase ?? "absent"}`);
	} catch {}
	for (const [command, args] of [
		[
			"systemctl",
			[
				"show",
				"--property=ActiveState,SubState,Result,MainPID,LoadState",
				mainUnit,
				paths.prepareUnit,
				paths.finalizeUnit,
			],
		],
		[
			"journalctl",
			[
				"--no-pager",
				"--output=short-monotonic",
				"-n",
				"80",
				"-u",
				mainUnit,
				"-u",
				paths.prepareUnit,
				"-u",
				paths.finalizeUnit,
			],
		],
	]) {
		try {
			context.run(command, args);
		} catch (diagnosticError) {
			console.error(`Bounded ${command} diagnostics failed: ${diagnosticError.message}`);
		}
	}
	throw error;
} finally {
	rmSync(work, { recursive: true, force: true });
}
