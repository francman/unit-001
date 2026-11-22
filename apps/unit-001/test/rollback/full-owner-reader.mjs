// #72: Full-owner rollback qualification, published-reader step. Copied into an untouched published release bundle
// at `app/test/rollback/` and run with its bundled Linux Node by test/rollback/qualify.mjs:
// `runtime/bin/node app/test/rollback/full-owner-reader.mjs write|recheck FILE VERSION`. VERSION is the version the
// archive's `release.json` names; the bundle must be that version. `write` opens the current owner's database and does
// real work through that release's own owner; `recheck` opens it again after the current owner wrote.
//
// Coverage follows the reader's own surface: every release answers sends, and a release with `memory` or `mission`
// operations also reads and writes those. `write` records what it covered in FILE.reader.json, the current owner's
// `verify` checks exactly that, and qualify.mjs copies it into the record.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../dist/agent.js";

const [mode, file, version] = process.argv.slice(2);
assert.ok((mode === "write" || mode === "recheck") && file !== undefined && version !== undefined);
assert.equal(JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version, version);
const coverage = [
	"transcript",
	...(typeof Agent.prototype.memory === "function" ? ["memory"] : []),
	...(typeof Agent.prototype.mission === "function" ? ["mission"] : []),
];
const seeded = JSON.parse(await readFile(`${file}.seed.json`, "utf8"));
const requests = [];
const faux = fauxProvider();
faux.setResponses(
	["Reader answer.", "Reader noted teal."].map((text) => (request) => {
		requests.push(JSON.stringify(request.messages));
		return fauxAssistantMessage(text);
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
		mission: { kind: "developer-local", directory: dirname(file), session: "default" },
		name: "bob",
	},
	context,
);
try {
	if (mode === "write") await write();
	else await recheck();
} finally {
	await agent.close(context);
}

async function write() {
	const written = { version, coverage };
	// Step 2a: the reader opens the whole owner database and reads the current owner's work.
	if (coverage.includes("memory")) await readMemory();
	const before = coverage.includes("mission") ? await readMission() : undefined;
	// Step 2b: it writes memory, forgetting a relation endpoint, then sends, captures, and amends the mission.
	if (coverage.includes("memory")) written.e = await rememberAndForget();
	// The current owner's ID-bearing send replays to its original answer without a provider call.
	assert.deepEqual(await agent.ask(seeded.seedPrompt, context, { requestId: "seed-send" }), {
		status: "answered",
		text: "Noted the budget.",
	});
	assert.equal(requests.length, 0);
	written.prompt = "Status check for the dashboards.";
	assert.deepEqual(await agent.ask(written.prompt, context, { requestId: "reader-send" }), {
		status: "answered",
		text: "Reader answer.",
	});
	// The provider request carries the current owner's transcript, so the reader materialized every entry it wrote.
	assert.ok(requests[0].includes("I prefer violet dashboards for the status page"));
	if (coverage.includes("memory")) written.captured = await captureTeal();
	if (before !== undefined) written.amended = await amendMission(before);
	await writeFile(`${file}.reader.json`, JSON.stringify(written));
	console.log(`published ${version} opened the full owner database and wrote; coverage ${coverage.join(", ")}`);
}

async function readMemory() {
	const stats = await agent.memory({ operation: "stats" }, context);
	assert.deepEqual(
		{ working: stats.working, tombstones: stats.tombstones, consolidation: stats.consolidation },
		{ working: 5, tombstones: 0, consolidation: "scheduled" },
	);
	const recalled = (await agent.memory({ operation: "recall", query: "violet dashboards" }, context)).records;
	assert.ok(recalled.some((record) => record.id === seeded.a));
}

async function readMission() {
	const before = await agent.mission({ operation: "status" }, context);
	assert.equal(before.agreementValid, true);
	assert.deepEqual(before.formation.agreement, seeded.agreement);
	return before;
}

async function rememberAndForget() {
	const e = (
		await agent.memory(
			{ operation: "remember", content: "Teal dashboards are allowed for on-call", requestId: "reader-e" },
			context,
		)
	).id;
	assert.equal(
		(await agent.memory({ operation: "forget", id: seeded.c, requestId: "reader-forget-c", confirmed: true }, context)).removed,
		true,
	);
	return e;
}

// A model turn whose capture the reader's own memory stores.
async function captureTeal() {
	assert.deepEqual(await agent.ask("I prefer teal alerts for on-call.", context), {
		status: "answered",
		text: "Reader noted teal.",
	});
	await agent.idle(context);
	return capturedRecord("teal alerts");
}

async function amendMission(before) {
	const draft = await agent.mission(
		{
			operation: "draft",
			expectedRevision: 1,
			requestId: "draft-2",
			terms: { ...before.formation.agreement.terms, objective: "Keep dashboards and alerts consistent" },
		},
		context,
	);
	const proposal = await agent.mission(
		{ operation: "propose", expectedRevision: draft.formation.draft.revision, requestId: "propose-2" },
		context,
	);
	const amended = await agent.mission(
		{
			operation: "approve-local",
			expectedRevision: proposal.formation.draft.revision,
			digest: proposal.formation.draft.digest,
			requestId: "approve-2",
		},
		context,
	);
	assert.equal(amended.formation.agreement.revision, 2);
	return amended.formation.agreement;
}

async function recheck() {
	// Step 4: after the current owner wrote relations again, the reader still opens and reads everything it can.
	const verified = JSON.parse(await readFile(`${file}.verify.json`, "utf8"));
	if (coverage.includes("memory")) {
		const recalled = (await agent.memory({ operation: "recall", query: "teal on-call night shift" }, context)).records;
		assert.ok(recalled.some((record) => record.id === verified.f));
	}
	if (coverage.includes("mission"))
		assert.equal((await agent.mission({ operation: "status" }, context)).formation.agreement.revision, 2);
	// The send the current owner receipted after the rollback replays here too, still without a provider call.
	assert.deepEqual(await agent.ask(verified.verifyPrompt, context, { requestId: "verify-send" }), {
		status: "answered",
		text: "Violet, per memory.",
	});
	assert.equal(requests.length, 0);
	console.log(`published ${version} reopened after the current owner's second write`);
}

async function capturedRecord(text) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const stats = await agent.memory({ operation: "stats" }, context);
		if (stats.pendingCaptures === 0) {
			assert.equal(stats.failedCaptures, 0);
			const records = (await agent.memory({ operation: "recall", query: text }, context)).records;
			assert.ok(records.length > 0, "the reader captured the human preference");
			return records[0].id;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("capture did not settle");
}
