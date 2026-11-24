// Verifies that standalone destructive acceptance cannot adopt an unmarked or unrelated host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateDisposableHost } from "../scripts/disposable-host.mjs";

const allowed = {
	actions: undefined,
	authorization: "1",
	platform: "linux",
	arch: "x64",
	uid: 0,
	init: "systemd",
	os: 'ID=ubuntu\nVERSION_ID="24.04"\n',
	hostname: "disposable-test",
	bootId: "test-boot",
	markerUid: 0,
	markerMode: 0o600,
	marker: "disposable-test\ntest-boot\n",
};

test("#18: explicit standalone authorization permits a protected boot-bound Ubuntu host", () => {
	assert.doesNotThrow(() => validateDisposableHost(allowed));
});

test("#18: Actions and missing, unprotected, stale or unrelated host authorization fail closed", () => {
	for (const denied of [
		{ actions: "true" },
		{ authorization: undefined },
		{ platform: "darwin" },
		{ arch: "arm64" },
		{ uid: 1000 },
		{ init: "bash" },
		{ os: 'ID=debian\nVERSION_ID="24.04"\n' },
		{ os: 'ID=ubuntu\nVERSION_ID="22.04"\n' },
		{ markerUid: 1000 },
		{ markerMode: 0o644 },
		{ marker: "other-host\ntest-boot\n" },
		{ marker: "disposable-test\nprevious-boot\n" },
	])
		assert.throws(() => validateDisposableHost({ ...allowed, ...denied }), /explicitly authorized/);
});

test("#18: actual shell and Python entry points reject Actions before candidate access or preload", () => {
	for (const [command, file, args] of [
		["bash", "verify-managed-install.sh", ["/missing-release-must-not-execute"]],
		["python3", "verify-operator-access.py", []],
		["python3", "verify-managed-terminal.py", []],
	]) {
		const result = spawnSync(command, [fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), ...args], {
			encoding: "utf8",
			timeout: 10000,
			env: {
				...process.env,
				GITHUB_ACTIONS: "true",
				RUNNER_ENVIRONMENT: "github-hosted",
				RUNNER_OS: "Linux",
				RUNNER_ARCH: "X64",
				UNIT_001_DISPOSABLE_CI: "1",
				UNIT_001_STANDALONE_ACCEPTANCE: "1",
				NODE_OPTIONS: "--require=/missing-preload-must-not-execute.cjs",
			},
		});
		assert.equal(result.error, undefined);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /GitHub Actions is prohibited/);
		assert.doesNotMatch(result.stderr, /Cannot find module|No such file/);
	}
});

test("#33: authorized runners reach fresh install and only exact historical pairs migrate", () => {
	const script = readFileSync(new URL("../scripts/verify-managed-install.sh", import.meta.url), "utf8");
	// Run the entry gate and dispatch blocks with command stubs. Omit the live preflight, install and service bodies.
	const entry = script.match(/^fail\(\).*\n[\s\S]*?^fi$/m)?.[0];
	const migrationAndInstall = script.match(/^case "\$runner:\$version" in\n[\s\S]*?^\(umask 077; bash .*\)$/m)?.[0];
	const freshChecks = script.match(/^python3 .*managed-terminal\.test\.py"\n[\s\S]*?^fi$/m)?.[0];
	assert.ok(entry && migrationAndInstall && freshChecks);
	const fixture = `
set -eu
record() { printf '%s\n' "\${1##*/}"; }
function candidate/runtime/bin/node { record "$@"; }
bash() { record "$@"; }
python3() { record "$@"; }
${entry}
release=$1
node=$release/runtime/bin/node
version=$CANDIDATE_VERSION
first=first
second=second
${migrationAndInstall}
${freshChecks}
`;
	const ci = {
		GITHUB_ACTIONS: "true",
		RUNNER_ENVIRONMENT: "github-hosted",
		RUNNER_OS: "Linux",
		RUNNER_ARCH: "X64",
		UNIT_001_DISPOSABLE_CI: "1",
	};
	const standalone = { UNIT_001_STANDALONE_ACCEPTANCE: "1" };
	for (const [version, authorization, migration] of [
		["0.0.7", ci, "verify-operator-migration.mjs"],
		["0.0.8", ci, undefined],
		["0.0.9", ci, undefined],
		["0.0.9", { ...ci, RUNNER_ENVIRONMENT: "self-hosted" }, undefined],
		["0.0.9", { ...ci, UNIT_001_DISPOSABLE_CI: "0" }, undefined],
		["0.0.9", { ...ci, RUNNER_OS: "macOS" }, undefined],
		["0.0.9", { ...ci, RUNNER_ARCH: "ARM64" }, undefined],
		["0.0.7", standalone, undefined],
		["0.0.8", standalone, "verify-published-current.mjs"],
		["0.0.8-rc.1", standalone, undefined],
		["0.0.9", standalone, undefined],
		["1.2.0", standalone, undefined],
	]) {
		const result = spawnSync("/bin/bash", ["-s", "--", "candidate"], {
			input: fixture,
			encoding: "utf8",
			timeout: 10000,
			env: { PATH: "/usr/bin:/bin", CANDIDATE_VERSION: version, ...authorization },
		});
		assert.ifError(result.error);
		if (authorization !== ci && authorization !== standalone) {
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Requires explicit disposable GitHub-hosted CI authorization/);
			assert.equal(result.stdout, "");
			continue;
		}
		const expected = [];
		if (authorization === standalone) expected.push("disposable-host.mjs");
		if (migration) expected.push(migration);
		expected.push("install.sh", "managed-terminal.test.py");
		if (authorization === standalone) expected.push("verify-operator-access.py", "verify-managed-terminal.py");
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(result.stdout.trim().split("\n"), expected, `${version} on ${authorization === ci ? "CI" : "standalone"}`);
	}
});
