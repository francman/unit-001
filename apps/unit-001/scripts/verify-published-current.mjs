// Verifies the actual published 0.0.7 updater activates the candidate and preserves its private state.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	installationPaths,
	listInstallations,
	readInstallation,
	removeUnusedRelease,
	withManagementLock,
	writeInstallation,
} from "../deploy/installation.mjs";
import { createUpdateContext } from "../deploy/update-activation.mjs";
import { requireDisposableHost } from "./disposable-host.mjs";

requireDisposableHost();
assert.equal(process.argv.length, 3, "Usage: verify-published-current.mjs EXTRACTED_CANDIDATE");
assert.deepEqual(listInstallations(), [], "Refusing to adopt an existing managed installation");
const source = resolve(process.argv[2]);
assert.equal(readFileSync(join(source, "VERSION"), "utf8").trim(), "0.0.8");
for (const version of ["0.0.7", "0.0.8", "0.0.9"])
	assert.equal(existsSync(`/opt/unit-001/releases/${version}`), false, "Refusing to adopt an existing release");
const name = "unit-release-migration";
assert.equal(spawnSync("which", [name]).status, 1);
const work = mkdtempSync(join(tmpdir(), "unit-published-current-"));
chmodSync(work, 0o700);
const node = join(source, "runtime/bin/node");
let owned;
try {
	const archive = join(work, "baseline.tar.gz");
	execFileSync(
		"curl",
		[
			"--fail",
			"--silent",
			"--show-error",
			"--location",
			"--proto",
			"=https",
			"--proto-redir",
			"=https",
			"--max-time",
			"180",
			"--max-filesize",
			"134217728",
			"--output",
			archive,
			"https://github.com/francman/unit-001-releases/releases/download/unit-v0.0.7/unit-001-0.0.7-linux-x64.tar.gz",
		],
		{ stdio: "inherit", timeout: 185000 },
	);
	assert.equal(
		createHash("sha256").update(readFileSync(archive)).digest("hex"),
		"7c47febdc58f3e728fdb2dba90f9c50da4d3636ce3022d929f23bcefd54fae38",
	);
	execFileSync("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", work]);
	const baseline = join(work, "unit-001-0.0.7-linux-x64");
	execFileSync("bash", [join(baseline, "install.sh"), "--name", name], { stdio: "inherit", timeout: 180000 });
	const records = listInstallations();
	assert.equal(records.length, 1);
	owned = records[0];
	assert.equal(owned.name, name);
	const paths = installationPaths(owned.id);
	writeFileSync(paths.environment, "OPENAI_API_KEY=not-a-real-acceptance-key\nUNIT_001_MODEL=openai/gpt-5\n", {
		mode: 0o600,
	});
	for (const [file, contents] of [
		["auth.json", '{"google":{"type":"api_key","key":"retain-fixture-only"}}\n'],
		["settings.json", '{"schemaVersion":1,"model":"openai/gpt-5"}\n'],
	]) {
		const path = join(work, file);
		writeFileSync(path, contents, { mode: 0o600 });
		execFileSync("install", ["-o", owned.account, "-g", owned.account, "-m", "600", path, join(paths.state, file)]);
	}
	const retained = ["auth.json", "settings.json"].map((file) => [file, readFileSync(join(paths.state, file))]);
	execFileSync(`/usr/local/bin/${name}`, ["update", "disable"], { stdio: "inherit", timeout: 30000 });
	await startPublishedOwner(readInstallation(owned.id));
	const verify = fileURLToPath(new URL("./verify-managed-updates.mjs", import.meta.url));
	execFileSync(node, [verify, source, owned.id, "--published-entry-only"], { stdio: "inherit", timeout: 360000 });
	assert.equal(readInstallation(owned.id).releaseVersion, "0.0.8");
	assert.equal(readInstallation(owned.id).name, name);
	assert.equal(readInstallation(owned.id).account, owned.account);
	for (const [file, bytes] of retained) assert.deepEqual(readFileSync(join(paths.state, file)), bytes);
	// A paused, already-executed ledger must survive an actual old-reader activation, not just direct SQLite opens.
	execFileSync(`/usr/local/bin/${name}`, ["stop", "--yes"], { stdio: "inherit", timeout: 60000 });
	const ledger = join(paths.state, "workspace", "paused-reader-proof");
	const ledgerFixture = fileURLToPath(new URL("../test/fixtures/execution-release-current.mjs", import.meta.url));
	execFileSync("runuser", ["-u", owned.account, "--", node, ledgerFixture, "seed", ledger, "paused"], {
		stdio: "inherit",
		timeout: 120000,
	});
	execFileSync("cp", [
		"--preserve=mode,ownership",
		join(ledger, "session.sqlite"),
		join(paths.state, "sessions/default.sqlite"),
	]);
	execFileSync(`/usr/local/bin/${name}`, ["start", "--yes"], { stdio: "inherit", timeout: 60000 });
	const rollbackEntry = join(work, "rollback-executed.mjs");
	const installedCore = `/usr/lib/unit-001/updaters/${owned.id}/cores/0.0.8/lib`;
	writeFileSync(
		rollbackEntry,
		`import assert from "node:assert/strict";
import { rollbackUpdate, createUpdateContext } from ${JSON.stringify(pathToFileURL(join(installedCore, "update-activation.mjs")).href)};
import { readInstallation } from ${JSON.stringify(pathToFileURL(join(installedCore, "installation.mjs")).href)};
assert.deepEqual(await rollbackUpdate(readInstallation(${JSON.stringify(owned.id)}), createUpdateContext()), { status: "updated", version: "0.0.7" });
`,
		{ mode: 0o600 },
	);
	execFileSync(node, [rollbackEntry], { stdio: "inherit", timeout: 180000 });
	assert.equal(readInstallation(owned.id).releaseVersion, "0.0.7");
	execFileSync(`/usr/local/bin/${name}`, ["stop", "--yes"], { stdio: "inherit", timeout: 60000 });
	execFileSync("cp", [
		"--preserve=mode,ownership",
		join(paths.state, "sessions/default.sqlite"),
		join(ledger, "session.sqlite"),
	]);
	execFileSync("runuser", ["-u", owned.account, "--", node, ledgerFixture, "verify", ledger, "paused"], {
		stdio: "inherit",
		timeout: 120000,
	});
	await startPublishedOwner(readInstallation(owned.id));
	// Reuse the already authenticated payload: regenerating fixture keys would change immutable version 0.0.8.
	const reactivateEntry = join(work, "reactivate-verified.mjs");
	writeFileSync(
		reactivateEntry,
		`import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activateUpdate, createUpdateContext } from ${JSON.stringify(pathToFileURL(join(installedCore, "update-activation.mjs")).href)};
import { readInstallation } from ${JSON.stringify(pathToFileURL(join(installedCore, "installation.mjs")).href)};
const releasePath = "/opt/unit-001/releases/0.0.8";
const release = JSON.parse(readFileSync(releasePath + "/release.json", "utf8"));
assert.deepEqual(await activateUpdate(readInstallation(${JSON.stringify(owned.id)}), { releasePath, version: release.version, compatibility: release.compatibility }, createUpdateContext()), { status: "updated", version: "0.0.8" });
`,
		{ mode: 0o600 },
	);
	execFileSync(node, [reactivateEntry], { stdio: "inherit", timeout: 180000 });
	assert.equal(readInstallation(owned.id).releaseVersion, "0.0.8");
	// The candidate now owns the actual service: exercise its update, rollback and crash recovery too.
	// Full-system CPU emulation includes archive copies and four activations; production readiness deadlines stay fixed.
	execFileSync(node, [verify, source, owned.id], { stdio: "inherit", timeout: 900000 });
	assert.equal(readInstallation(owned.id).releaseVersion, "0.0.8");
	for (const [file, bytes] of retained) assert.deepEqual(readFileSync(join(paths.state, file)), bytes);
	execFileSync(`/usr/local/bin/${name}`, ["stop", "--yes"], { stdio: "inherit", timeout: 60000 });
	execFileSync("cp", [
		"--preserve=mode,ownership",
		join(paths.state, "sessions/default.sqlite"),
		join(ledger, "session.sqlite"),
	]);
	execFileSync("runuser", ["-u", owned.account, "--", node, ledgerFixture, "verify", ledger, "paused"], {
		stdio: "inherit",
		timeout: 120000,
	});
	console.log(
		"Published 0.0.7 updater → candidate 0.0.8, retained identity/auth/settings, and candidate rollback/crash recovery passed; no model requests.",
	);
} catch (error) {
	console.error(`Published migration acceptance failed: ${error.stack ?? error}`);
	throw error;
} finally {
	if (owned !== undefined) {
		const record = readInstallation(owned.id);
		assert.equal(record.name, name);
		assert.equal(record.account, owned.account);
		execFileSync(node, [join(source, "deploy/agent-command.mjs"), owned.id, name, "uninstall", "--yes"], {
			stdio: "inherit",
			timeout: 90000,
		});
		assert.equal(readInstallation(owned.id).desiredState, "uninstalled");
		assert.notEqual(spawnSync("systemctl", ["is-active", "--quiet", installationPaths(owned.id).unit]).status, 0);
		for (const releaseVersion of ["0.0.7", "0.0.8", "0.0.9"]) removeUnusedRelease({ ...record, releaseVersion });
		const account = execFileSync("getent", ["passwd", owned.account], { encoding: "utf8" }).trim().split(":");
		assert.equal(account[5], installationPaths(owned.id).state);
		assert.notEqual(account[2], "0");
		execFileSync("userdel", [owned.account]);
		rmSync(installationPaths(owned.id).state, { recursive: true });
		rmSync(installationPaths(owned.id).config, { recursive: true });
	}
	rmSync(work, { recursive: true, force: true });
}

async function startPublishedOwner(record) {
	// The old CLI loads every provider inside its 2s status deadline. Use real bounded IPC for this slow guest only.
	const context = createUpdateContext();
	await withManagementLock(async () => {
		writeInstallation({ ...readInstallation(record.id), desiredState: "running" });
		context.run("systemctl", ["enable", "--now", installationPaths(record.id).unit]);
		const deadline = performance.now() + 30000;
		let failure;
		do {
			try {
				const status = context.control(record, ["service-status"], 2000);
				const pid = Number(
					context.run(
						"systemctl",
						["show", "--property=MainPID", "--value", installationPaths(record.id).unit],
						true,
					),
				);
				assert.equal(status.version, "0.0.7");
				assert.equal(status.installationId, record.id);
				assert.equal(status.pid, pid);
				assert.equal(status.inhibited, false);
				return;
			} catch (error) {
				failure = error;
			}
			await setTimeout(100);
		} while (performance.now() < deadline);
		throw failure;
	});
}
