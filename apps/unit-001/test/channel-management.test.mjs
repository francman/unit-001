// #56: Channel authority stays root-only and executes only the fixed module in the selected verified release.
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
	const root = await mkdtemp(join(tmpdir(), "unit-channel-dispatch-"));
	temporary.push(root);
	const record = {
		schemaVersion: 1,
		id: "11111111-1111-4111-8111-111111111111",
		name: "agent",
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
				assert.fail("Channel metadata issuer must not initialize the owner account");
			},
			async applicationEnvironment() {
				assert.fail("Channel metadata issuer must not inherit model-provider credentials");
			},
			async run(...arguments_) {
				calls.push(arguments_);
				return 0;
			},
		},
	};
}

test("#56 executes the selected-release channel issuer with a fixed installation identity", async () => {
	const { record, calls, context } = await fixture();
	await dispatchAgent(record.id, record.name, ["channels", "policy", "--file", "/private/policy.json"], context);
	assert.deepEqual(calls, [
		[
			"/opt/verified-release/runtime/bin/node",
			[
				join("/opt/verified-release", "deploy/channels.mjs"),
				"policy",
				"--file",
				"/private/policy.json",
				"--id",
				record.id,
			],
			false,
			{ SUDO_UID: "2001", SUDO_USER: "creator" },
		],
	]);
});

test("#56 rejects unprivileged changes and caller-selected installation IDs before running an issuer", async () => {
	const operator = await fixture(2001);
	for (const action of ["policy", "approve", "revoke", "telegram-bootstrap"])
		await assert.rejects(
			dispatchAgent(operator.record.id, "agent", ["channels", action], operator.context),
			/host administrator/,
		);
	assert.deepEqual(operator.calls, []);
	const administrator = await fixture();
	for (const override of [["--id", "other"], ["--id=other"]])
		await assert.rejects(
			dispatchAgent(administrator.record.id, "agent", ["channels", "approve", ...override], administrator.context),
			/installation identity/,
		);
	assert.deepEqual(administrator.calls, []);
});
