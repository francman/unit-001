// #14: Managed mission authority uses only the selected protected release, never a root Agent or caller-selected path.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { dispatchAgent } from "../deploy/agent-command.mjs";
import { installationPaths, writeInstallation } from "../deploy/installation.mjs";

const temporary = [];
afterEach(async () => {
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(uid = 0) {
	const root = await mkdtemp(join(tmpdir(), "unit-mission-dispatch-"));
	temporary.push(root);
	const record = {
		schemaVersion: 1,
		id: "11111111-1111-4111-8111-111111111111",
		name: "bob",
		account: "ua-111111111111411181111111",
		releaseVersion: "0.0.7",
		desiredState: "running",
	};
	await mkdir(installationPaths(record.id, root).config, { recursive: true });
	writeInstallation(record, root);
	const calls = [];
	return {
		record,
		calls,
		context: {
			root,
			uid,
			administratorOrigin: { SUDO_UID: "2001", SUDO_USER: "creator" },
			async release() {
				return "/opt/verified-release";
			},
			async account() {
				assert.fail("Root mission metadata must not initialize an application account");
			},
			async applicationEnvironment() {
				assert.fail("Root mission metadata must not read provider credentials");
			},
			async run(...arguments_) {
				calls.push(arguments_);
				return 0;
			},
		},
	};
}

test("#14 executes only the selected-release mission module with fixed installation identity", async () => {
	const { record, calls, context } = await fixture();
	await dispatchAgent(
		record.id,
		record.name,
		["mission", "approve", "--revision", "1", "--digest", "a".repeat(64)],
		context,
	);
	assert.deepEqual(calls, [
		[
			"/opt/verified-release/runtime/bin/node",
			[
				"/opt/verified-release/deploy/mission.mjs",
				"approve",
				"--revision",
				"1",
				"--digest",
				"a".repeat(64),
				"--id",
				record.id,
			],
			false,
			{ SUDO_UID: "2001", SUDO_USER: "creator" },
		],
	]);
});

test("#14 rejects operator authority changes and installation identity overrides before execution", async () => {
	const operator = await fixture(2001);
	for (const action of ["creator", "approve"])
		await assert.rejects(
			dispatchAgent(operator.record.id, "bob", ["mission", action], operator.context),
			/host administrator/,
		);
	assert.deepEqual(operator.calls, []);
	const administrator = await fixture();
	for (const override of [["--id", "other"], ["--id=other"]])
		await assert.rejects(
			dispatchAgent(administrator.record.id, "bob", ["mission", "approve", ...override], administrator.context),
			/installation identity/,
		);
	assert.deepEqual(administrator.calls, []);
});
