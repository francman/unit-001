#!/usr/bin/env node
// #33: Exercises the published 0.0.6 owner through signed operator-socket migration on disposable native CI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	installationPaths,
	listInstallations,
	readInstallation,
	removeUnusedRelease,
} from "../deploy/installation.mjs";

if (
	process.platform !== "linux" ||
	process.arch !== "x64" ||
	process.getuid() !== 0 ||
	process.env.GITHUB_ACTIONS !== "true" ||
	process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
	process.env.UNIT_001_DISPOSABLE_CI !== "1" ||
	process.env.RUNNER_OS !== "Linux" ||
	process.env.RUNNER_ARCH !== "X64" ||
	execFileSync("ps", ["-p", "1", "-o", "comm="], { encoding: "utf8" }).trim() !== "systemd"
)
	throw new Error("Requires explicit disposable GitHub-hosted Linux x64/systemd root authorization.");
const operatingSystem = readFileSync("/etc/os-release", "utf8");
assert.match(operatingSystem, /^ID=ubuntu$/m);
assert.match(operatingSystem, /^VERSION_ID="24\.04"$/m);
assert.equal(process.argv.length, 3, "Usage: verify-operator-migration.mjs EXTRACTED_CANDIDATE");
const source = resolve(process.argv[2]);
assert.equal(readFileSync(join(source, "VERSION"), "utf8").trim(), "0.0.7");
const node = join(source, "runtime/bin/node");
assert.ok(existsSync(node));
assert.deepEqual(listInstallations(), [], "Refusing to adopt any existing managed installation");
for (const version of ["0.0.6", "0.0.7"])
	assert.equal(existsSync(`/opt/unit-001/releases/${version}`), false, "Refusing to adopt an existing release");
const name = "unit-ci-migration";
assert.equal(spawnSync("which", [name]).status, 1, "Refusing an existing migration command");
for (const directory of ["/opt", "/usr/local", "/usr/local/bin"]) {
	const info = lstatSync(directory);
	assert.ok(info.isDirectory() && !info.isSymbolicLink());
	execFileSync("chown", ["root:root", directory]);
	chmodSync(directory, info.mode & 0o755);
}
const work = mkdtempSync(join(tmpdir(), "unit-operator-migration-"));
chmodSync(work, 0o700);
const environment = {
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	LANG: "C.UTF-8",
	GITHUB_ACTIONS: "true",
	RUNNER_ENVIRONMENT: "github-hosted",
	UNIT_001_DISPOSABLE_CI: "1",
	RUNNER_OS: "Linux",
	RUNNER_ARCH: "X64",
};
let owned;
try {
	const url =
		"https://github.com/francman/unit-001-releases/releases/download/unit-v0.0.6/unit-001-0.0.6-linux-x64.tar.gz";
	const archive = join(work, "baseline.tar.gz");
	execFileSync(
		"curl",
		[
			"--fail",
			"--location",
			"--proto",
			"=https",
			"--proto-redir",
			"=https",
			"--max-time",
			"120",
			"--max-filesize",
			"268435456",
			"--output",
			archive,
			url,
		],
		{ env: environment, stdio: "inherit", timeout: 125000 },
	);
	assert.equal(
		createHash("sha256").update(readFileSync(archive)).digest("hex"),
		"b6537839dd16e0b863f51b609f8273e2c81492d714be6c9ac67c8ba36ca888f5",
		"Published baseline bytes failed verification before extraction or execution",
	);
	execFileSync("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", work], { env: environment });
	const baseline = join(work, "unit-001-0.0.6-linux-x64");
	execFileSync("bash", [join(baseline, "install.sh"), "--name", name], {
		env: environment,
		stdio: "inherit",
		timeout: 180000,
	});
	const records = listInstallations();
	assert.equal(records.length, 1);
	owned = records[0];
	assert.equal(owned.name, name);
	assert.equal(owned.releaseVersion, "0.0.6");
	writeFileSync(join(work, "owned-installation.json"), JSON.stringify(owned), { mode: 0o600 });
	const paths = installationPaths(owned.id);
	writeFileSync(paths.environment, "OPENAI_API_KEY=unit-ci-not-a-real-key\nUNIT_001_MODEL=openai/gpt-5\n", {
		mode: 0o600,
	});
	// Fixture-signed activations are explicit; public background updates must not race this test.
	execFileSync(`/usr/local/bin/${name}`, ["update", "disable"], {
		env: environment,
		stdio: "inherit",
		timeout: 30000,
	});
	execFileSync(`/usr/local/bin/${name}`, ["start", "--yes"], { env: environment, stdio: "inherit", timeout: 60000 });
	const status = JSON.parse(
		execFileSync(`/usr/local/bin/${name}`, ["service-status"], { env: environment, encoding: "utf8" }),
	);
	assert.equal(status.installationId, owned.id);
	assert.equal(status.version, "0.0.6");
	assert.equal(
		existsSync(`/run/unit-001-${owned.id}`),
		false,
		"Baseline unexpectedly has an operator runtime directory",
	);
	execFileSync(
		node,
		[fileURLToPath(new URL("./verify-managed-updates.mjs", import.meta.url)), source, owned.id, "--expect-operator"],
		{ env: environment, stdio: "inherit", timeout: 360000 },
	);
	assert.equal(readInstallation(owned.id).releaseVersion, "0.0.6");
	console.log("Published 0.0.6 to 0.0.7 operator migration, rollback and crash recovery passed; no model requests.");
} finally {
	if (owned !== undefined) {
		// Only the UUID recorded after this test's exclusive clean-host installation may be removed.
		const manifest = JSON.parse(readFileSync(join(work, "owned-installation.json"), "utf8"));
		assert.equal(manifest.id, owned.id);
		const record = readInstallation(owned.id);
		assert.equal(record.name, name);
		assert.equal(record.account, owned.account);
		execFileSync(node, [join(source, "deploy/agent-command.mjs"), owned.id, name, "uninstall", "--yes"], {
			env: environment,
			stdio: "inherit",
			timeout: 90000,
		});
		assert.equal(readInstallation(owned.id).desiredState, "uninstalled");
		assert.notEqual(spawnSync("systemctl", ["is-active", "--quiet", installationPaths(owned.id).unit]).status, 0);
		for (const releaseVersion of ["0.0.6", "0.0.7"]) removeUnusedRelease({ ...record, releaseVersion });
		const account = execFileSync("getent", ["passwd", owned.account], { env: environment, encoding: "utf8" })
			.trim()
			.split(":");
		assert.equal(account[0], owned.account);
		assert.equal(account[5], installationPaths(owned.id).state);
		assert.notEqual(account[2], "0");
		execFileSync("userdel", [owned.account], { env: environment, stdio: "inherit" });
		rmSync(installationPaths(owned.id).state, { recursive: true });
		rmSync(installationPaths(owned.id).config, { recursive: true });
	}
	rmSync(work, { recursive: true, force: true });
}
