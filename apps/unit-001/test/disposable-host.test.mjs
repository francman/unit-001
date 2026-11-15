// Verifies that standalone destructive acceptance cannot adopt an unmarked or unrelated host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
