// Verifies Linux publisher locking, credential refusal and cleanup without signing or posting live metadata.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("../scripts/renew-update-metadata.sh", import.meta.url));
const supported = process.platform === "linux" && process.getuid() !== 0;

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "unit-renewal-wrapper-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const state = join(directory, "state"),
		keys = join(directory, "keys"),
		bin = join(directory, "bin"),
		root = join(directory, "root.json");
	for (const path of [state, keys, bin]) mkdirSync(path, { mode: 0o700 });
	writeFileSync(root, "{}");
	writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "invoked\\n" >> "$UNIT_TEST_CALLS"\nexit 17\n', { mode: 0o700 });
	writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const calls = join(directory, "calls");
	const env = {
		...process.env,
		PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
		GH_TOKEN: "inert-test-token",
		UNIT_TEST_CALLS: calls,
		GITHUB_ACTIONS: "false",
	};
	return {
		state,
		root,
		keys,
		calls,
		env,
		run: (extra = {}) =>
			spawnSync("bash", [wrapper, root, keys, state], {
				env: { ...env, ...extra },
				encoding: "utf8",
				timeout: 10_000,
			}),
	};
}

// #18: a maintainer job must not fall back to a broad stored login when its scoped credential is absent.
test(
	"refuses missing publication credentials and an Actions environment before invoking publisher code",
	{ skip: !supported },
	(t) => {
		const f = fixture(t);
		assert.equal(f.run({ GH_TOKEN: "" }).status, 2);
		assert.equal(f.run({ GITHUB_ACTIONS: "true" }).status, 2);
		assert.deepEqual(readdirSync(f.state), []);
	},
);

// #18: failed downloads/signing/publication must not accumulate archive trees or leave a stale lock.
test("preserves publisher failure and removes scratch output while releasing its lock", { skip: !supported }, (t) => {
	const f = fixture(t);
	const stale = join(f.state, "renewal.ABC123");
	mkdirSync(stale, { mode: 0o700 });
	writeFileSync(join(stale, ".owned"), "unit-001-renewal-v1\n");
	writeFileSync(join(stale, "leftover.tar.gz"), "inert interrupted download");
	assert.equal(f.run().status, 17);
	assert.equal(existsSync(stale), false);
	assert.equal(f.run().status, 17);
	assert.equal(readFileSync(f.calls, "utf8"), "invoked\ninvoked\n");
	assert.deepEqual(readdirSync(f.state), ["publication.lock"]);
});

// #18: cleanup owns only its marked scratch namespace, not arbitrary files in publisher state.
test("preserves unexpected scratch content for operator inspection", { skip: !supported }, (t) => {
	const f = fixture(t);
	const unexpected = join(f.state, "renewal.ABC123");
	mkdirSync(unexpected, { mode: 0o700 });
	writeFileSync(join(unexpected, "keep"), "unrecognized data");
	assert.equal(f.run().status, 2);
	assert.equal(readFileSync(join(unexpected, "keep"), "utf8"), "unrecognized data");
});

// #18: an active publisher prevents competing writes; killing the holder releases the OS lock.
test("defers under a real competing flock and proceeds after process death", { skip: !supported }, async (t) => {
	const f = fixture(t);
	const holder = spawn(
		"flock",
		[
			"--exclusive",
			join(f.state, "publication.lock"),
			process.execPath,
			"--input-type=module",
			"-e",
			"process.stdout.write('locked\\n'); process.stdin.resume();",
		],
		{ detached: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	const exit = once(holder, "exit");
	t.after(() => {
		if (holder.exitCode === null && holder.signalCode === null) process.kill(-holder.pid, "SIGKILL");
	});
	await once(holder.stdout, "data");
	const deferred = f.run();
	assert.equal(deferred.status, 0, deferred.stderr);
	assert.match(deferred.stdout, /publication is active/);
	process.kill(-holder.pid, "SIGKILL");
	await exit;
	assert.equal(f.run().status, 17);
});
