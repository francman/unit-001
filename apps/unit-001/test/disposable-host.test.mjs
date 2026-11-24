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
		for (const standalone of ["0", "1"]) {
			const result = spawnSync(command, [fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), ...args], {
				encoding: "utf8",
				timeout: 10000,
				env: {
					PATH: process.env.PATH,
					GITHUB_ACTIONS: "true",
					RUNNER_ENVIRONMENT: "github-hosted",
					RUNNER_OS: "Linux",
					RUNNER_ARCH: "X64",
					UNIT_001_DISPOSABLE_CI: "1",
					UNIT_001_STANDALONE_ACCEPTANCE: standalone,
					NODE_OPTIONS: "--require=/missing-preload-must-not-execute.cjs",
				},
			});
			assert.ifError(result.error);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /GitHub Actions is prohibited/);
			assert.doesNotMatch(result.stderr, /Cannot find module|No such file/);
		}
	}
});

test("#33: authorized standalone candidates reach fresh install and only 0.0.8 runs the historical migration", () => {
	const script = readFileSync(new URL("../scripts/verify-managed-install.sh", import.meta.url), "utf8");
	// Run the entry gate and dispatch blocks with command stubs. Omit the live preflight, install and service bodies.
	const entry = script.match(/^fail\(\).*\n[\s\S]*?^fi$/m)?.[0];
	const migrationAndInstall = script.match(/^# #33: The published 0\.0\.7 migration .*\n[\s\S]*?^\(umask 077; bash .*\)$/m)?.[0];
	assert.ok(entry && migrationAndInstall);
	const fixture = `
set -eu
record() { printf '%s\n' "\${1##*/}"; }
function candidate/runtime/bin/node { record "$@"; }
bash() { record "$@"; }
${entry}
release=$1
node=$release/runtime/bin/node
version=$CANDIDATE_VERSION
${migrationAndInstall}
`;
	for (const version of ["0.0.7", "0.0.8", "0.0.8-rc.1", "0.0.9", "1.2.0"]) {
		const result = spawnSync("/bin/bash", ["-s", "--", "candidate"], {
			input: fixture,
			encoding: "utf8",
			timeout: 10000,
			env: { PATH: "/usr/bin:/bin", CANDIDATE_VERSION: version, UNIT_001_STANDALONE_ACCEPTANCE: "1" },
		});
		assert.ifError(result.error);
		const expected = ["disposable-host.mjs"];
		if (version === "0.0.8") expected.push("verify-published-current.mjs");
		expected.push("install.sh");
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(result.stdout.trim().split("\n"), expected, version);
	}
});
