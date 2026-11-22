// #14: Managed mission authority uses only the selected protected release, never a root Agent or caller-selected path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
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

// #72: purpose approval and continuous operation are protected records the application refuses on managed hosts.
test("#72 purpose approval and operation execute only the selected-release mission module", async () => {
	const { record, calls, context } = await fixture();
	await dispatchAgent(
		record.id,
		record.name,
		["mission", "approve-purpose", "--revision", "2", "--digest", "b".repeat(64)],
		context,
	);
	await dispatchAgent(record.id, record.name, ["mission", "operate", "open", "--operation-revision", "0"], context);
	assert.deepEqual(
		calls.map((call) => call[1]),
		[
			[
				"/opt/verified-release/deploy/mission.mjs",
				"approve-purpose",
				"--revision",
				"2",
				"--digest",
				"b".repeat(64),
				"--id",
				record.id,
			],
			[
				"/opt/verified-release/deploy/mission.mjs",
				"operate",
				"open",
				"--operation-revision",
				"0",
				"--id",
				record.id,
			],
		],
	);
	for (const call of calls) {
		assert.equal(call[0], "/opt/verified-release/runtime/bin/node");
		assert.deepEqual(call.slice(2), [false, { SUDO_UID: "2001", SUDO_USER: "creator" }]);
	}
});

// #72: a run from an older purpose revision still blocks the loop, but the view's `works` lists only the current
// revision, so the managed acknowledgment must accept any run in `unsettled`. mission.mjs runs as root on Linux at
// import, so this pins the rule in its source; the native acceptance step 7 exercises it (docs/missions/verification.md).
test("#72 managed acknowledgment accepts any unsettled run, from every purpose revision", () => {
	const source = readFileSync(fileURLToPath(new URL("../deploy/mission.mjs", import.meta.url)), "utf8");
	const acknowledge = source.slice(source.indexOf('if (operateAction === "acknowledge") {'));
	const check = acknowledge.slice(0, acknowledge.indexOf("Only a run with unsettled effects can be acknowledged."));
	assert.match(check, /!purpose\.unsettled\.some\(\(run\) => run\.runId === values\.run\)/);
	assert.doesNotMatch(check, /purpose\.works/);
});

// #72: the owner reconciles an acknowledgment before an intent, so one request ID naming both would make close report
// success without applying it. The guard is lifted from the source (mission.mjs cannot be imported here) and run.
test("#72 managed operate refuses a request ID reused across acknowledgment and intent", () => {
	const source = readFileSync(fileURLToPath(new URL("../deploy/mission.mjs", import.meta.url)), "utf8");
	const start = source.indexOf("// A request ID names one command");
	const end = source.indexOf('throw new Error("Conflicting operation request ID.");', start);
	assert.ok(start > 0 && end > start, "The guard precedes both writers.");
	assert.ok(end < source.indexOf('if (operateAction === "acknowledge") {', start));
	const guard = new Function(
		"operateAction",
		"previous",
		"requestId",
		`${source.slice(start, end)}throw new Error("Conflicting operation request ID.");`,
	);
	const previous = {
		operationIntent: { requestId: "intent-1", action: "open" },
		operationAcknowledgments: [{ requestId: "ack-1", runId: "run-1" }],
	};
	for (const action of ["open", "suspend", "close"])
		assert.throws(() => guard(action, previous, "ack-1"), /Conflicting operation request ID/);
	assert.throws(() => guard("acknowledge", previous, "intent-1"), /Conflicting operation request ID/);
	// Retries of the same command and fresh IDs pass to their own writer.
	assert.doesNotThrow(() => guard("acknowledge", previous, "ack-1"));
	assert.doesNotThrow(() => guard("close", previous, "intent-1"));
	assert.doesNotThrow(() => guard("close", {}, "fresh"));
	assert.doesNotThrow(() => guard("acknowledge", {}, "fresh"));
});

test("#14 rejects operator authority changes and installation identity overrides before execution", async () => {
	const operator = await fixture(2001);
	for (const action of ["creator", "approve", "approve-purpose", "operate", "start", "pause", "resume", "stop"])
		await assert.rejects(
			dispatchAgent(operator.record.id, "bob", ["mission", action], operator.context),
			/host administrator/,
		);
	assert.deepEqual(operator.calls, []);
	const administrator = await fixture();
	for (const override of [["--id", "other"], ["--id=other"]])
		for (const action of [["approve"], ["approve-purpose"], ["operate", "open"]]) {
			const args = ["mission", ...action, ...override];
			await assert.rejects(
				dispatchAgent(administrator.record.id, "bob", args, administrator.context),
				/installation identity/,
			);
		}
	assert.deepEqual(administrator.calls, []);
});

test("#17 lifecycle commands execute only the verified privileged metadata client", async () => {
	const { record, calls, context } = await fixture();
	for (const action of ["start", "pause", "resume", "stop"])
		await dispatchAgent(record.id, record.name, ["mission", action, "--policy-revision", "1"], context);
	assert.equal(calls.length, 4);
	for (const call of calls) {
		assert.equal(call[0], "/opt/verified-release/runtime/bin/node");
		assert.equal(call[1][0], "/opt/verified-release/deploy/mission.mjs");
		assert.deepEqual(call[1].slice(-2), ["--id", record.id]);
	}
});
