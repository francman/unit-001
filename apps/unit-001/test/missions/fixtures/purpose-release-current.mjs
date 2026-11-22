// #72: Seeds and verifies a database with the purpose document around the published 0.0.9 rollback reader.
// Run from apps/unit-001 after `npm run build`: `node test/missions/fixtures/purpose-release-current.mjs seed|verify FILE`.
// The published reader step between them is test/missions/fixtures/purpose-release-old.mjs; docs/missions/purpose.md
// describes the whole sequence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../../dist/agent.js";
import { readMissionAuthority } from "../../../dist/missions/authority.js";
import { readMissionPurpose } from "../../../dist/missions/purpose.js";
import { matchingPurposeApproval } from "../../../dist/missions/purpose-authority.js";
import { MissionFoundation } from "../../../dist/missions/state.js";

const [mode, file] = process.argv.slice(2);
assert.ok(mode === "seed" || mode === "verify");
const location = { kind: "developer-local", directory: dirname(file), session: "default" };

// The mission documents are opened on their own, with nothing scheduled.
async function openMissions() {
	const registry = createRegistry();
	registry.install(MissionFoundation);
	return Harness.open(await openNodeSqliteStorage(file), { registry, models: createModels(), setTimer: () => () => {} }, context);
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const work = (path, text) => ({
	kind: "artifact-digest",
	path,
	sha256: sha(text),
	instructions: `Write ${path}.`,
	maxCycles: 2,
	maxRequests: 2,
	maxRetries: 0,
	maxConsecutiveNoProgress: 2,
});
const writes = (content) => fauxAssistantMessage(fauxToolCall("unit_work_write", { content }), { stopReason: "toolUse" });

async function until(agent, predicate) {
	for (let i = 0; i < 1000; i++) {
		const view = await agent.mission({ operation: "status" }, context);
		if (predicate(view.purpose)) return view;
		await setTimeout(10);
	}
	throw new Error("The purpose loop did not settle.");
}

if (mode === "seed") {
	// Step 1: the full current owner agrees one-shot revision 1, then runs a continuous purpose to the end: A's first
	// attempt fails ambiguously (unsettled), is acknowledged, A runs again and B runs; then operation is closed.
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "socket hang up" }),
		writes("alpha"),
		writes("beta"),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(file),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: dirname(file),
			mission: location,
			name: "bob",
		},
		context,
	);
	try {
		const mission = (request) => agent.mission(request, context);
		await mission({
			operation: "configure-local",
			creator: { kind: "human", id: "purpose-rollback-fixture", uid: process.getuid() },
			ceiling: {
				allowedTools: ["read"],
				maxCycles: 3,
				maxRequests: 4,
				maxRetries: 1,
				maxConsecutiveNoProgress: 2,
				maxDurationMs: 3_600_000,
			},
			purposeCeiling: {
				capabilities: ["artifact-digest"],
				paths: ["reports/"],
				maxWorkItems: 4,
				maxCycles: 6,
				maxRequests: 6,
				maxRetries: 1,
				maxConsecutiveNoProgress: 2,
				maxDurationMs: 3_600_000,
			},
		});
		await mission({
			operation: "draft",
			expectedRevision: 0,
			requestId: "draft-1",
			terms: {
				objective: "Keep the rollback fixture's dependencies secure",
				scope: "Only the fixture",
				successCriteria: ["Return recorded evidence"],
				policy: {
					allowedTools: ["read"],
					maxCycles: 2,
					maxRequests: 3,
					maxRetries: 0,
					maxConsecutiveNoProgress: 1,
					deadlineAt: Date.now() + 1_800_000,
				},
				approvalBoundary: [],
				reviewEveryMs: 1000,
			},
		});
		const proposal = await mission({ operation: "propose", expectedRevision: 1, requestId: "propose-1" });
		const view = await mission({
			operation: "approve-local",
			expectedRevision: 1,
			digest: proposal.formation.draft.digest,
			requestId: "approve-1",
		});
		assert.equal(view.agreementValid, true);
		const proposed = await mission({
			operation: "purpose-propose",
			expectedRevision: 0,
			requestId: "purpose-1",
			terms: {
				purpose: "Keep the fixture reports current",
				scope: "The fixture reports directory",
				reviewEveryMs: 1,
				works: [work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")],
				lifetime: { maxWorkItems: 4, maxCycles: 6, maxRequests: 6, deadlineAt: Date.now() + 1_800_000 },
			},
		});
		await mission({
			operation: "purpose-approve-local",
			revision: proposed.purpose.proposed.revision,
			digest: proposed.purpose.proposed.digest,
			requestId: "purpose-approve-1",
		});
		await mission({ operation: "operate-local", action: "open", expectedOperationRevision: 0, requestId: "open-1" });
		const blocked = await until(agent, (purpose) => purpose?.activity === "blocked");
		assert.equal(blocked.purpose.reason, "unsettled_effects");
		const runId = blocked.purpose.works[0].runId;
		await mission({
			operation: "operate-local",
			action: "acknowledge",
			expectedOperationRevision: 1,
			requestId: "ack-1",
			runId,
		});
		await until(agent, (purpose) => purpose?.activity === "idle");
		await mission({ operation: "operate-local", action: "close", expectedOperationRevision: 1, requestId: "close-1" });
		const closed = await mission({ operation: "status" });
		assert.equal(closed.purpose.operation, "closed");
		assert.equal(closed.purpose.rollback, "no-live-loop");
		assert.deepEqual(closed.purpose.used, {
			workItems: 3,
			cycles: 3,
			requests: 3,
			estimatedCost: 0,
			reservedCost: 0,
			unknownRequests: 1,
			unpricedResponses: 2,
		});
		await writeFile(`${file}.seeded`, JSON.stringify(view.formation.agreement));
	} finally {
		await agent.close(context);
	}
	const harness = await openMissions();
	try {
		const purpose = await readMissionPurpose(harness, context);
		assert.equal(purpose.purpose.revision, 1);
		assert.deepEqual(
			purpose.loop.runs.map((run) => [run.workId, run.state.status, run.settlement]),
			[
				["p1-w1", "blocked", { acknowledged: "ack-1" }],
				["p1-w1", "verified", "settled"],
				["p1-w2", "verified", "settled"],
			],
		);
		await writeFile(`${file}.loop`, JSON.stringify(purpose.loop));
		console.log("seed: one-shot revision 1 agreed; purpose loop ran A (ambiguous, acknowledged), A, B, then closed");
	} finally {
		await harness.close(context);
	}
} else {
	// Step 3: the full current owner opens the published reader's write; opening imports the agreement it lacks.
	const agent = await Agent.open(
		{ storage: await openNodeSqliteStorage(file), models: createModels(), model: null, cwd: dirname(file), mission: location, name: "bob" },
		context,
	);
	let view;
	try {
		view = await agent.mission({ operation: "status" }, context);
	} finally {
		await agent.close(context);
	}
	const harness = await openMissions();
	try {
		const purpose = await readMissionPurpose(harness, context);
		const seeded = JSON.parse(await readFile(`${file}.seeded`, "utf8"));
		const amended = JSON.parse(await readFile(`${file}.amended`, "utf8"));
		const loop = JSON.parse(await readFile(`${file}.loop`, "utf8"));
		assert.equal(view.agreementValid, true);
		assert.deepEqual(view.formation.agreement, amended);
		assert.deepEqual(purpose.work.map((work) => [work.workId, work.source.agreement]), [
			["legacy-1", seeded],
			["legacy-2", amended],
		]);
		assert.equal(purpose.purpose.revision, 2);
		assert.equal(purpose.purpose.purpose, amended.terms.objective);
		assert.deepEqual(purpose.operation, { status: "closed", reason: "autonomy_not_approved" });
		// Purpose history, work digests, acknowledgment and lifetime totals are exactly what the current owner wrote.
		assert.deepEqual(purpose.loop, loop);
		// The old writer rebuilt the authority file from the fields it knows: the purpose grant needs fresh consent.
		const authority = await readMissionAuthority(location);
		assert.equal(authority.purposeApprovals, undefined);
		assert.equal(authority.purposeCeiling, undefined);
		const agreed = purpose.loop.agreements.at(-1);
		assert.equal(
			matchingPurposeApproval(authority, agreed.approval.receiptId, agreed.missionId, agreed.revision, agreed.terms),
			undefined,
		);
		assert.equal(view.purpose.rollback, "no-live-loop");
		console.log(
			"verify: legacy-2 imported; purpose loop history and ledger unchanged; reopening needs fresh purpose consent",
		);
	} finally {
		await harness.close(context);
	}
}
