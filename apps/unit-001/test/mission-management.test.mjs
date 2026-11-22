// #14: Managed mission authority uses only the selected protected release, never a root Agent or caller-selected path.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { dispatchAgent } from "../deploy/agent-command.mjs";
import { installationPaths, writeInstallation } from "../deploy/installation.mjs";
import { parseMissionAuthority, parseMissionCeiling } from "../src/missions/authority.ts";
import { MANAGED_MISSION_ACTIONS, missionObject, parseMissionCreator } from "../src/missions/contract.ts";
import { matchingPlanApproval, planDigest, planReceiptsRecorded } from "../src/missions/plan-authority.ts";
import { missingPlanTerms } from "../src/missions/plan-terms.ts";
import { MISSION, planTerms, PURPOSE_DIGEST } from "./missions/fixtures/plan.ts";

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

test("named plan approve dispatches to the selected privileged release only with fixed installation identity", async () => {
	const args = ["mission", "plan", "approve", "--revision", "1", "--digest", "c".repeat(64)];
	const { record, calls, context } = await fixture();
	await dispatchAgent(record.id, record.name, args, context);
	assert.deepEqual(calls[0][1], ["/opt/verified-release/deploy/mission.mjs", ...args.slice(1), "--id", record.id]);
	await assert.rejects(
		dispatchAgent(record.id, record.name, [...args, "--id=other"], context),
		/installation identity/,
	);
	await assert.rejects(dispatchAgent(record.id, record.name, args, { ...context, uid: 2001 }), /administrator/);
	assert.equal(calls.length, 1);
});

// Run the installed entry's actual dispatch, parser, CAS and writer with synthetic OS, IPC and storage boundaries.
// No archive, service account, root filesystem or live owner is needed for these command traces.
function managedPlan() {
	const record = {
		id: "11111111-1111-4111-8111-111111111111",
		name: "bob",
		account: "ua-fixture",
		releaseVersion: "fixture",
	};
	const state = {
		uid: "2001",
		serviceUid: 2002,
		writes: 0,
		locked: false,
		events: [],
		fail: null,
		auth: {
			schemaVersion: 1,
			installationId: record.id,
			session: "default",
			revision: 1,
			creator: { id: "creator", kind: "human", uid: 2001 },
			ceiling: {
				allowedTools: [],
				maxCycles: 1,
				maxRequests: 1,
				maxRetries: 0,
				maxConsecutiveNoProgress: 1,
				maxDurationMs: 1,
			},
			approvals: [],
		},
		status: {
			type: "status",
			installationId: record.id,
			name: record.name,
			version: record.releaseVersion,
			inhibited: false,
			maintenance: { protocol: 1, state: "open", operationId: null },
		},
		view: {
			planError: null,
			purposeError: null,
			plan: { missionId: MISSION, adopted: false, head: null, history: [], draft: null },
			purpose: {
				missionId: MISSION,
				revision: 1,
				digest: PURPOSE_DIGEST,
				operation: "closed",
				operationRevision: 0,
				appliedSequence: 0,
			},
		},
	};
	const source = readFileSync(new URL("../deploy/mission.mjs", import.meta.url), "utf8");
	const body = source.slice(
		source.indexOf('if (process.platform !== "linux"'),
		source.indexOf("async function owner(request)"),
	);
	assert.ok(body.includes("await withManagementLock(") && body.includes("async function approvePlan("));
	state.propose = (revision) => {
		const plan = state.view.plan;
		const terms = planTerms();
		const digest = planDigest(terms, MISSION, revision, plan.head?.digest ?? null, state.auth);
		plan.draft = { status: "proposed", revision, digest, baseRevision: plan.head?.revision ?? 0, terms, missing: [] };
		return ["plan", "approve", "--revision", String(revision), "--digest", digest, "--request-id", `id-${revision}`];
	};
	state.run = async (args) => {
		const env = state.uid === undefined ? {} : { SUDO_UID: state.uid, SUDO_USER: "creator" };
		const deps = {
			closeSync,
			constants,
			fstatSync,
			openSync,
			readSync,
			missionObject,
			parseMissionCreator,
			parseMissionCeiling,
			MANAGED_MISSION_ACTIONS,
			isDeepStrictEqual,
			process: { platform: "linux", geteuid: () => 0, env, stdout: { write() {} }, stderr: { write() {} } },
			parseArgs: (options) => parseArgs({ ...options, args: [...args, "--id", record.id] }),
			readInstallation: () => record,
			readUpdateJournal: () => null,
			execFileSync: (command, [, account]) => {
				assert.equal(command, "getent");
				return account === record.account ? `${account}:x:${state.serviceUid}:` : `creator:x:${account}:`;
			},
			withManagementLock: async (work) => {
				assert.equal(state.locked, false);
				state.locked = true;
				try {
					return await work();
				} finally {
					state.locked = false;
				}
			},
			randomUUID,
			planDigest,
			matchingPlanApproval,
			planReceiptsRecorded,
			missingPlanTerms,
			readMissionAuthority: () => {
				assert.equal(state.locked, true);
				return parseMissionAuthority(state.auth);
			},
			writeMissionAuthority: (_location, next) => {
				assert.equal(state.locked, true);
				state.auth = parseMissionAuthority(next);
				state.writes++;
				if (state.fail === "write") throw new Error("directory sync failed");
			},
			ownerFrame: (frame) => {
				assert.equal(state.locked, true);
				assert.deepEqual(frame, { type: "status" });
				state.onStatus?.();
				return state.status;
			},
			owner: ({ operation, receiptId, requestId, revision, digest }) => {
				assert.equal(state.locked, true);
				state.events.push(operation);
				if (operation === "prepare-plan") {
					const review = structuredClone(state.view);
					assert.equal(review.plan.draft.revision, revision);
					assert.equal(review.plan.draft.digest, digest);
					state.prepared = { requestId, draft: review.plan.draft };
					state.afterPrepare?.();
					return review;
				}
				if (operation === "reconcile-plan") {
					if (state.fail === "reconcile") throw new Error("owner disconnected");
					const plan = state.view.plan;
					const binding = state.auth.planRequests.find((entry) => entry.receiptId === receiptId);
					if (!plan.history.some((entry) => entry.revision === binding.revision)) {
						assert.equal(state.prepared.requestId, binding.requestId);
						const { revision, digest, terms } = state.prepared.draft;
						assert.equal(binding.digest, digest);
						plan.previous = plan.head;
						plan.head = {
							revision,
							digest,
							terms,
							receiptId,
							agreedAt: binding.issuedAt,
							previousDigest: plan.head?.digest ?? null,
						};
						plan.adopted = true;
						plan.headValid = true;
						plan.history.unshift({ revision, digest, agreedAt: binding.issuedAt });
						if (plan.draft?.revision === revision) plan.draft = null;
						state.prepared = undefined;
					}
				}
				return structuredClone(state.view);
			},
		};
		const run = new Function(...Object.keys(deps), `return (async () => { ${body} })();`);
		await run(...Object.values(deps));
	};
	return state;
}

async function rotateCreator(state) {
	const directory = await mkdtemp(join(tmpdir(), "unit-plan-rotation-"));
	temporary.push(directory);
	const file = join(directory, "creator.json");
	await writeFile(file, JSON.stringify({ creator: { ...state.auth.creator, uid: 2003 }, ceiling: state.auth.ceiling }), {
		mode: 0o600,
	});
	const previousUid = state.uid;
	state.uid = String(process.getuid());
	try {
		await state.run(["creator", "--file", file]);
	} finally {
		state.uid = previousUid;
	}
}

test("managed plan CAS publishes one receipt and keeps exact retries after eviction, conflicts and exhaustion", async () => {
	const state = managedPlan();
	const first = state.propose(1);
	await state.run(first);
	for (let revision = 2; revision <= 32; revision++) await state.run(state.propose(revision));
	assert.equal(state.auth.planRequests.length, 32);
	assert.deepEqual(
		state.auth.planApprovals.map((receipt) => receipt.revision),
		[31, 32],
	);
	state.events.length = 0;
	await state.run(first);
	assert.deepEqual(state.events, ["reconcile-plan"]);
	await assert.rejects(state.run(first.map((value) => (value === first[5] ? "0".repeat(64) : value))), /Conflicting/);
	await assert.rejects(state.run(state.propose(33)), /limit/);
	assert.equal(state.writes, 32);
});

test("managed approval checks the creator, OS service UID, hold, frozen terms and protected predecessor", async () => {
	for (const change of [
		(state) => {
			state.uid = undefined;
		},
		(state) => {
			state.uid = "0";
			state.auth.creator.uid = 0;
		},
		(state) => {
			state.uid = "2003";
		},
		(state) => {
			state.serviceUid = 2001;
		},
		(state) => {
			state.status.maintenance.state = "held";
		},
		(state) => {
			state.status.installationId = "another";
		},
		(state) => {
			state.status.version = "predecessor";
		},
		(state) => {
			state.view.plan.draft.terms.overall.scope = "changed";
		},
		(state) => {
			state.view.plan.draft.baseRevision = 99;
		},
		(state) => {
			state.view.plan.draft.missing = ["binding"];
		},
		(state) => {
			state.view.purpose.operation = "open";
		},
		(state) => {
			state.onStatus = () => {
				state.auth.revision++;
			};
		},
	]) {
		const state = managedPlan();
		const args = state.propose(1);
		change(state);
		await assert.rejects(state.run(args));
		assert.equal(state.writes, 0);
	}
	const state = managedPlan();
	await state.run(state.propose(1));
	const args = state.propose(2);
	const saved = structuredClone(state.auth);
	for (const drop of [["planApprovals"], ["planRequests"], ["planRequests", "planApprovals"]]) {
		state.auth = structuredClone(saved);
		for (const field of drop) delete state.auth[field];
		await assert.rejects(state.run(args), /unavailable/);
		assert.equal(state.writes, 1);
	}
	state.auth = saved;
	await state.run(args);
	const third = state.propose(3);
	await state.run(third);
	const next = state.propose(4);
	state.auth.planRequests.shift();
	await assert.rejects(state.run(next), /unavailable/);
	state.events.length = 0;
	await assert.rejects(state.run(third), /reconciliation outcome unknown/);
	assert.deepEqual(state.events, ["reconcile-plan"]);
	assert.equal(state.writes, 3);
});

test("plan metadata parses stale receipts and rejects malformed receipts, ledgers and Open bindings", async () => {
	const state = managedPlan();
	await state.run(state.propose(1));
	const { head } = state.view.plan;
	const receipt = state.auth.planApprovals[0];
	const binding = state.auth.planRequests[0];
	const rotated = parseMissionAuthority({ ...state.auth, revision: 2, creator: { ...state.auth.creator, uid: 2003 } });
	assert.deepEqual(rotated.planRequests, [binding]);
	assert.equal(matchingPlanApproval(rotated, receipt.receiptId, MISSION, head.revision, null, head.terms), undefined);
	for (const invalid of [
		{ session: "other" },
		{ installationId: "other" },
		{ authorityRevision: 2 },
		{ approvedBy: { kind: "host-administrator", uid: receipt.creator.uid } },
		{ approvedBy: { kind: "local-creator", uid: 0 } },
		{ requestId: "" },
		{ approvedAt: -1 },
		{ provenance: "developer-local" },
	])
		assert.throws(() => parseMissionAuthority({ ...state.auth, planApprovals: [{ ...receipt, ...invalid }] }));
	assert.throws(() => parseMissionAuthority({ ...state.auth, planApprovals: Array(3).fill(receipt) }));
	for (const ledger of [
		[binding, binding],
		Array(33).fill(binding),
		[{ ...binding, extra: true }],
		[{ ...binding, issuedAt: -1 }],
	])
		assert.throws(() => parseMissionAuthority({ ...state.auth, planRequests: ledger }));
	const partial = parseMissionAuthority({
		...state.auth,
		planRequests: [{ ...binding, issuedAt: binding.issuedAt + 1 }],
	});
	assert.equal(matchingPlanApproval(partial, receipt.receiptId, MISSION, head.revision, null, head.terms), undefined);
	const open = {
		requestId: "open",
		sequence: 1,
		action: "open",
		missionId: MISSION,
		purposeRevision: 1,
		purposeDigest: PURPOSE_DIGEST,
		authorityRevision: 1,
		expectedOperationRevision: 0,
		issuedAt: 1,
	};
	for (const invalid of [{ planDigest: "bad" }, { planDigest: null }, { action: "close", planDigest: head.digest }])
		assert.throws(() => parseMissionAuthority({ ...state.auth, operationIntent: { ...open, ...invalid } }));
	assert.deepEqual(parseMissionAuthority({ ...state.auth, operationIntent: open }).operationIntent, open);
});

test("managed creator rotation clears receipts, preserves ancestry and closes old request IDs", async () => {
	const state = managedPlan();
	const first = state.propose(1);
	await state.run(first);
	const firstBinding = state.auth.planRequests[0];
	await rotateCreator(state);
	assert.equal(state.auth.revision, 2);
	assert.equal(state.auth.planApprovals, undefined);
	assert.deepEqual(state.auth.planRequests, [firstBinding]);
	assert.equal(planReceiptsRecorded(state.auth), true);
	state.uid = "2003";
	state.events.length = 0;
	await assert.rejects(state.run(first), /unknown.*earlier creator authority/i);
	assert.deepEqual(state.events, []);
	await assert.rejects(state.run(["operate", "open"]), /current creator authority/);
	assert.equal(state.writes, 2);
	await state.run(state.propose(2));
	const head = state.view.plan.head;
	assert.equal(state.auth.planApprovals.length, 1);
	assert.equal(head.previousDigest, firstBinding.digest);
	assert.equal(
		matchingPlanApproval(state.auth, head.receiptId, MISSION, 2, firstBinding.digest, head.terms),
		state.auth.planApprovals[0],
	);
	assert.equal(matchingPlanApproval(state.auth, head.receiptId, MISSION, 2, null, head.terms), undefined);
	await state.run(state.propose(3));
	assert.deepEqual(state.auth.planApprovals.map((item) => item.revision), [2, 3]);
	assert.deepEqual(state.auth.planRequests[0], firstBinding);
	assert.deepEqual(
		state.auth.planRequests.map((item) => item.authorityRevision),
		[1, 2, 2],
	);
});

test("creator rotation waits for an unrecorded first or subsequent plan receipt", async () => {
	for (const revision of [1, 2]) {
		const state = managedPlan();
		if (revision === 2) await state.run(state.propose(1));
		const pending = state.propose(revision);
		state.fail = "reconcile";
		await assert.rejects(state.run(pending), /reconciliation outcome unknown/);
		const published = structuredClone(state.auth);
		await assert.rejects(rotateCreator(state), /Reconcile the protected plan/);
		assert.deepEqual(state.auth, published);
		assert.equal(state.writes, revision);
		state.fail = null;
		await state.run(pending);
		await rotateCreator(state);
		assert.equal(state.auth.revision, 2);
		assert.deepEqual(state.auth.planRequests, published.planRequests);
		assert.equal(state.auth.planApprovals, undefined);
	}
});

test("managed Open cannot publish when an older protected binding is missing or differs from the owner's", async () => {
	const state = managedPlan();
	for (const revision of [1, 2, 3]) await state.run(state.propose(revision));
	state.auth.purposeApprovals = [{ ...state.auth.planApprovals.at(-1), revision: 1, digest: PURPOSE_DIGEST }];
	const oldest = state.auth.planRequests.shift();
	await assert.rejects(state.run(["operate", "open"]), /history is unavailable/);
	// The projection cannot expose older request IDs. The owner reports the exact mismatch through headValid.
	state.auth.planRequests.unshift({ ...oldest, requestId: "different-old-request" });
	state.view.plan.headValid = false;
	await assert.rejects(state.run(["operate", "open"]), /ancestry changed/);
	assert.equal(state.auth.operationIntent, undefined);
	assert.equal(state.writes, 3);
});

test("managed publication and reconciliation failures can be retried using the same protected ID", async () => {
	for (const fail of ["write", "reconcile"]) {
		const state = managedPlan();
		const args = state.propose(1);
		state.fail = fail;
		await assert.rejects(state.run(args), /outcome unknown.*id-1/i);
		state.fail = null;
		await state.run(args);
		assert.equal(state.writes, 1);
		assert.equal(state.view.plan.history.length, 1);
	}
});

test("an owner edit between durable prepare and publication preserves the reviewed revision across a lost reply", async () => {
	const state = managedPlan();
	const command = state.propose(1);
	state.afterPrepare = () => state.propose(2);
	state.fail = "reconcile";
	await assert.rejects(state.run(command), /issued; reconciliation outcome unknown/);
	assert.equal(state.auth.planApprovals[0].revision, 1);
	assert.equal(state.view.plan.draft.revision, 2);
	state.events.length = 0;
	state.fail = null;
	await state.run(command);
	assert.deepEqual(state.events, ["reconcile-plan"]);
	assert.equal(state.writes, 1);
	assert.equal(state.view.plan.head.revision, 1);
	assert.equal(state.view.plan.head.digest, command[5]);
	assert.equal(state.view.plan.draft.revision, 2);
});

test("managed Open binds the exact protected plan and a replay preserves the original digest", async () => {
	const state = managedPlan();
	await state.run(state.propose(1));
	const open = ["operate", "open", "--request-id", "open-1", "--operation-revision", "0"];
	await assert.rejects(state.run(open), /current approved purpose/);
	const receipt = { ...state.auth.planApprovals[0], digest: PURPOSE_DIGEST };
	state.auth.purposeApprovals = [receipt];
	await state.run(open);
	const intent = structuredClone(state.auth.operationIntent);
	assert.equal(intent.planDigest, state.view.plan.head.digest);
	state.view.purpose.appliedSequence = intent.sequence;
	await state.run(state.propose(2));
	await state.run(open);
	assert.deepEqual(state.auth.operationIntent, intent);
	assert.notEqual(intent.planDigest, state.auth.planApprovals.at(-1).digest);
	assert.equal(state.writes, 3);
	const fresh = open.map((value) => (value === "open-1" ? "open-2" : value));
	state.onStatus = () => {
		state.auth.revision++;
	};
	await assert.rejects(state.run(fresh), /changed after review/);
	assert.equal(state.writes, 3);
	state.auth.revision--;
	state.onStatus = undefined;
	await state.run(fresh);
	assert.equal(state.auth.operationIntent.planDigest, state.auth.planApprovals.at(-1).digest);
});

test("an unadopted Open keeps the legacy shape and a restrictive intent can close a stale plan", async () => {
	const state = managedPlan();
	state.view.plan = null;
	await state.run(["operate", "open"]);
	assert.equal(Object.hasOwn(state.auth.operationIntent, "planDigest"), false);
	state.view.purpose.operation = "open";
	state.view.planError = "invalid stored plan";
	await state.run(["operate", "close"]);
	assert.equal(state.auth.operationIntent.action, "close");
	assert.equal(Object.hasOwn(state.auth.operationIntent, "planDigest"), false);
});
