// #72: Full-owner rollback qualification, current-owner steps. `seed` writes real work (memory with relations,
// a model tool call, a captured preference, a sleeping consolidation, an agreed mission and its purpose record);
// an ID-bearing send with its `unit.send.receipts` receipt); `to-v2` rewrites memory into the unreleased version-2
// layout of edfa9d085; `convert` opens it with the current owner; `verify` checks what the published reader wrote, as
// far as that reader's recorded coverage goes, and writes again. Run by test/rollback/qualify.mjs:
// `node test/rollback/full-owner-current.mjs seed|to-v2|convert|verify FILE` from an app root that has `dist/`.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, createSession, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryDoc, MemoryRelationsDoc } from "unit-memory";
import { Agent } from "../../dist/agent.js";
import { readMissionPurpose } from "../../dist/missions/purpose.js";
import { MissionFoundation } from "../../dist/missions/state.js";
import { sendDigest } from "../../dist/send-receipt.js";
import { assertConversionPreserved, assertRelationsLive } from "./checks.mjs";

const [mode, file] = process.argv.slice(2);
assert.ok(["seed", "to-v2", "convert", "verify"].includes(mode) && file !== undefined);
const location = { kind: "developer-local", directory: dirname(file), session: "default" };
const seedPrompt = "I prefer violet dashboards for the status page. Please remember the dashboard budget is fixed.";

// Step 1: the current owner does real work through its public surfaces only.
async function seed() {
	const { agent, requests } = await open([
		fauxAssistantMessage(
			fauxToolCall("remember", {
				content: "The violet dashboard budget is fixed for this quarter",
				relations: [{ id: "memory:operator:seed-a", kind: "updates" }],
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Noted the budget."),
	]);
	try {
		const a = await remember(agent, "seed-a", "Violet dashboards are the operations default");
		const b = await remember(agent, "seed-b", "Violet dashboards load faster for the night shift", [
			{ id: a, kind: "supports" },
		]);
		const c = await remember(agent, "seed-c", "Grey dashboards replaced violet ones last spring", [
			{ id: a, kind: "contradicts" },
		]);
		// An ID-bearing send: its receipt commits in the admission commit, in the chat's `unit.send.receipts`.
		const answer = await agent.ask(seedPrompt, context, { requestId: "seed-send" });
		assert.deepEqual(answer, { status: "answered", text: "Noted the budget." });
		assert.deepEqual(await agent.admission("seed-send", sendDigest(seedPrompt), context), {
			status: "admitted",
			source: "model",
			binding: "exact",
			outcome: "answered",
		});
		await agent.idle(context);
		const stats = await settledStats(agent);
		// Settled work: the generation, its tool call and its capture. Pending work: the sleeping consolidation.
		assert.equal(stats.consolidation, "scheduled");
		const graph = await agent.memory({ operation: "graph" }, context);
		const tool = graph.nodes.find((node) => node.origin === "agent");
		const captured = graph.nodes.find((node) => node.content.includes("I prefer violet dashboards"));
		assert.ok(tool !== undefined && captured !== undefined, "tool and capture memories are stored");
		const relations = relationEdges(graph);
		assert.deepEqual(
			relations,
			[`${b} supports ${a}`, `${c} contradicts ${a}`, `${tool.id} updates ${a}`].sort(),
		);
		assert.equal(stats.relations, 3);
		const agreement = await agreeMission(agent);
		assert.equal(requests.length, 2);
		await writeFile(
			`${file}.seed.json`,
			JSON.stringify({ a, b, c, tool: tool.id, captured: captured.id, relations, stats, agreement, seedPrompt }),
		);
		console.log(`seed: ${graph.nodes.length} memories, ${relations.length} relations, consolidation scheduled, mission agreed`);
	} finally {
		await agent.close(context);
	}
}

// A Session that ran edfa9d085 holds `unit.memory` version 2 with relations inside and no relations document.
const VersionTwoMemoryDoc = defineDoc({
	kind: "unit.memory",
	version: 2,
	scope: "session",
	initial: () => ({ ...MemoryDoc.definition.initial(), relations: {} }),
	migrate: (value) => ({ ...value, relations: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});

async function toVersionTwo() {
	const storage = await openNodeSqliteStorage(file);
	const session = createSession(storage);
	try {
		const before = await session.commit(async (tx) => {
			const memory = JSON.parse(JSON.stringify(await tx.doc(MemoryDoc)));
			const links = JSON.parse(JSON.stringify(await tx.doc(MemoryRelationsDoc)));
			await tx.retireDoc(MemoryDoc);
			await tx.retireDoc(MemoryRelationsDoc);
			Object.assign(await tx.doc(VersionTwoMemoryDoc), { ...memory, relations: links.relations });
			return { memory, relations: links };
		}, context);
		assert.equal(await storedVersion(storage, "unit.memory"), 2);
		assert.equal(await session.snapshot(MemoryRelationsDoc, context), undefined);
		// `convert` compares the stored documents it produces with these, field for field.
		await writeFile(`${file}.v1.json`, JSON.stringify(before));
		console.log("to-v2: memory rewritten as unit.memory version 2 with embedded relations");
	} finally {
		await session.close(context);
	}
}

// Step 1b (version-2 scenario): opening converts to version 1 plus the relations document, losing nothing. The stats
// view alone cannot show a lost consolidation: open schedules a new one, which also reads "scheduled". So the stored
// documents must equal the ones `to-v2` started from, including the sleeping consolidation task's identity.
async function convert() {
	const seeded = JSON.parse(await readFile(`${file}.seed.json`, "utf8"));
	const before = JSON.parse(await readFile(`${file}.v1.json`, "utf8"));
	const { agent } = await open([]);
	try {
		assert.deepEqual(relationEdges(await agent.memory({ operation: "graph" }, context)), seeded.relations);
		assert.deepEqual(await agent.memory({ operation: "stats" }, context), seeded.stats);
	} finally {
		await agent.close(context);
	}
	const after = await checkStored();
	assertConversionPreserved(before, after);
	console.log(
		`convert: current owner rewrote version 2 as version 1 plus unit.memory.relations; every field kept, ` +
			`consolidation ${after.memory.consolidation.state} task ${after.memory.consolidation.taskId}`,
	);
}

// Step 3: the current owner reopens what the published reader wrote, then writes again.
async function verify() {
	const seeded = JSON.parse(await readFile(`${file}.seed.json`, "utf8"));
	const reader = JSON.parse(await readFile(`${file}.reader.json`, "utf8"));
	// What the reader wrote depends on its surface (full-owner-reader.mjs); a reader without memory or mission
	// operations must have left that work exactly as seeded.
	const readerMemory = reader.coverage.includes("memory");
	const readerMission = reader.coverage.includes("mission");
	const { agent, requests } = await open([fauxAssistantMessage("Violet, per memory.")]);
	let view;
	try {
		const graph = await agent.memory({ operation: "graph" }, context);
		const ids = new Set(graph.nodes.map((node) => node.id));
		if (readerMemory) assert.ok(ids.has(reader.e) && ids.has(reader.captured), "the reader's memories are live");
		assert.equal(ids.has(seeded.c), !readerMemory, "the reader's forget holds");
		// The relation to the memory the reader forgot is gone; the others survive the round trip.
		const surviving = readerMemory
			? [`${seeded.b} supports ${seeded.a}`, `${seeded.tool} updates ${seeded.a}`].sort()
			: seeded.relations;
		assert.deepEqual(relationEdges(graph), surviving);
		const f = await remember(agent, "verify-f", "Teal on-call dashboards also suit the night shift", [
			{ id: readerMemory ? reader.e : seeded.a, kind: "supports" },
		]);
		// Send receipts survive the round trip: the seed's stays exact; the reader's ID-bearing send has none.
		assert.deepEqual(await agent.admission("seed-send", sendDigest(seedPrompt), context), {
			status: "admitted",
			source: "model",
			binding: "exact",
			outcome: "answered",
		});
		assert.deepEqual(await agent.admission("seed-send", sendDigest("another prompt"), context), {
			status: "rejected",
			reason: "different-prompt",
		});
		assert.deepEqual(await agent.admission("reader-send", sendDigest(reader.prompt), context), {
			status: "admitted",
			source: "model",
			binding: "unverified",
			outcome: "answered",
		});
		await assert.rejects(agent.ask("another prompt", context, { requestId: "seed-send" }), /different prompt/);
		const verifyPrompt = "Which dashboards do I prefer for the status page?";
		const answer = await agent.ask(verifyPrompt, context, { requestId: "verify-send" });
		assert.deepEqual(answer, { status: "answered", text: "Violet, per memory." });
		assert.equal((await agent.admission("verify-send", sendDigest(verifyPrompt), context)).binding, "exact");
		assert.ok(requests[0].includes(seeded.a), "recall injects the seeded memory after the round trip");
		await agent.idle(context);
		const stats = await settledStats(agent);
		assert.equal(stats.relations, surviving.length + 1);
		assert.equal(stats.tombstones, readerMemory ? 1 : 0);
		view = await agent.mission({ operation: "status" }, context);
		await writeFile(`${file}.verify.json`, JSON.stringify({ f, verifyPrompt }));
	} finally {
		await agent.close(context);
	}
	const agreements = readerMission ? [seeded.agreement, reader.amended] : [seeded.agreement];
	assert.equal(view.agreementValid, true);
	assert.deepEqual(view.formation.agreement, agreements.at(-1));
	await checkStored();
	const harness = await openMissions();
	try {
		const purpose = await readMissionPurpose(harness, context);
		assert.deepEqual(
			purpose.work.map((work) => [work.workId, work.source.agreement]),
			agreements.map((agreement, index) => [`legacy-${index + 1}`, agreement]),
		);
		assert.equal(purpose.purpose.revision, agreements.length);
		assert.deepEqual(purpose.operation, { status: "closed", reason: "autonomy_not_approved" });
	} finally {
		await harness.close(context);
	}
	console.log("verify: reader memories, forget and mission amendment imported; stale relation pruned; new writes ok");
}

async function open(responses) {
	const faux = fauxProvider();
	const requests = [];
	faux.setResponses(
		responses.map((response) => (request) => {
			requests.push(JSON.stringify(request.messages));
			return response;
		}),
	);
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
	return { agent, requests };
}

async function remember(agent, requestId, content, relations) {
	const result = await agent.memory(
		{ operation: "remember", content, requestId, ...(relations === undefined ? {} : { relations }) },
		context,
	);
	return result.id;
}

// Capture runs as background work after the answer; wait until no capture is pending.
async function settledStats(agent) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const stats = await agent.memory({ operation: "stats" }, context);
		if (stats.pendingCaptures === 0) {
			assert.equal(stats.failedCaptures, 0);
			return stats;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("capture did not settle");
}

function relationEdges(graph) {
	return graph.edges
		.filter((edge) => edge.kind !== "summary")
		.map((edge) => `${edge.from} ${edge.kind} ${edge.to}`)
		.sort();
}

async function agreeMission(agent) {
	await agent.mission(
		{
			operation: "configure-local",
			creator: { kind: "human", id: "rollback-fixture", uid: process.getuid() },
			ceiling: {
				allowedTools: ["read"],
				maxCycles: 3,
				maxRequests: 4,
				maxRetries: 1,
				maxConsecutiveNoProgress: 2,
				maxDurationMs: 3_600_000,
			},
		},
		context,
	);
	await agent.mission(
		{
			operation: "draft",
			expectedRevision: 0,
			requestId: "draft-1",
			terms: {
				objective: "Keep the rollback fixture's dashboards consistent",
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
		},
		context,
	);
	const proposal = await agent.mission({ operation: "propose", expectedRevision: 1, requestId: "propose-1" }, context);
	const view = await agent.mission(
		{ operation: "approve-local", expectedRevision: 1, digest: proposal.formation.draft.digest, requestId: "approve-1" },
		context,
	);
	assert.equal(view.agreementValid, true);
	return view.formation.agreement;
}

// The stored layout every supported reader opens: memory at version 1, every stored relation's endpoints live at
// their pinned revisions. Returns the stored documents.
async function checkStored() {
	const storage = await openNodeSqliteStorage(file);
	const session = createSession(storage);
	try {
		assert.equal(await storedVersion(storage, "unit.memory"), 1);
		const stored = {
			memory: await session.snapshot(MemoryDoc, context),
			relations: await session.snapshot(MemoryRelationsDoc, context),
		};
		assertRelationsLive(stored.memory, stored.relations);
		return stored;
	} finally {
		await session.close(context);
	}
}

async function storedVersion(storage, kind) {
	const record = await storage.findDocument({ kind, scope: { kind: "session" } }, "current", context);
	return record === undefined ? undefined : (await storage.document(record.id, "current", context))?.version;
}

async function openMissions() {
	const registry = createRegistry();
	registry.install(MissionFoundation);
	return Harness.open(
		await openNodeSqliteStorage(file),
		{ registry, models: createModels(), setTimer: () => () => {} },
		context,
	);
}

// Last, so every declaration above is initialized before a step runs.
await { seed, "to-v2": toVersionTwo, convert, verify }[mode]();
