#!/usr/bin/env node
// Measures a fresh faux-provider owner, persisted memory replay, foreground requests and optional memory mutations without changing latency gates.
import assert from "node:assert/strict";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { copyFile, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, release, tmpdir, totalmem, uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, createSession, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	forgetMemory,
	isLiveRelation,
	MEMORY_RELATION_DEGREE_LIMIT,
	MEMORY_RELATION_LIMIT,
	MemoryDoc,
	MemoryInputEntry,
	MemoryInputsDoc,
	MemoryRecall,
	MemoryRelationsDoc,
	recordMemoryInput,
	rememberMemory,
} from "unit-memory";
import { Agent } from "../dist/agent.js";

const SCHEMA_VERSION = 2;
const PHASE_ORDER = ["seed", "grow", "fixture-check", "replay", "startup", "probe", "foreground", "mutate"];
const DEFAULT_PHASES = ["seed", "replay", "startup", "foreground"];
const MUTATE_MIXES = {
	"remember-heavy": { remember: 1, forget: 0 },
	"forget-heavy": { remember: 0, forget: 1 },
	mixed: { remember: 0.6, forget: 0.2 },
};
const SAMPLE_LIMIT = 20000;
const OP_LIMIT = 5000;
const FIXTURE_TIME = 1_700_000_000_000;
const FIXTURE_ANSWER = "Acknowledged.";
const CHURN_CONTENT = "zinnia bookkeeping fixture";
const CGROUP_PHASE_FILES = ["memory.current", "memory.peak", "memory.swap.current", "memory.swap.peak", "memory.events"];
const CGROUP_FINAL_FILES = [
	"memory.max",
	"memory.high",
	"memory.peak",
	"memory.swap.max",
	"memory.swap.current",
	"memory.swap.peak",
	"memory.events",
	"io.stat",
];
const SQLITE_FILES = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"];
const USAGE = `Usage: profile-capacity.mjs --records 1..50000 --relations 0..min(records-1,${MEMORY_RELATION_LIMIT}) --tail 0..63 --out RESULT.json [--forgotten N] [--topology chain|dense] [--phases ${PHASE_ORDER.join(",")}] [--keep DIR | --reuse DIR] [--mutate ${Object.keys(MUTATE_MIXES).join("|")} (--duration-s N | --mutate-ops N) [--mutate-interval-ms N]] [--sample-ms N]
Mutation runs only seed,mutate (fresh) or mutate (--reuse).
Growth fixtures: --quiescent --keep BASE; then --reuse BASE --keep GROWN --phases grow
  (--settled-turns 0..20000 [--query-chars 40..2000] | --capture-cycles 0..30000).
Measure with --reuse GROWN --phases fixture-check|replay|startup|probe (one phase per process).`;

const config = parseConfig();
const { count, relations, tail, forgotten, topology, hubs } = config.fixture;
const startedAt = new Date().toISOString();
const startedMs = performance.now();
const phases = [];
const diskPhases = [];
const samples = [];
let samplesDropped = 0;
let currentPhase = "init";
let directory = "";
let file = "";
// Declared before the top-level run below: function bodies read them once phases start.
let fauxInstance;
let modelsInstance;
const cgroupDirectory = findCgroupDirectory();
const oomScoreAdj = lowerOomPriority();

installSignalHandlers();
const sampler = config.sampleMs > 0 ? setInterval(takeSample, config.sampleMs) : undefined;
sampler?.unref();
mkdirSync(dirname(config.out), { recursive: true });
let failure;
try {
	if (config.keep !== undefined) {
		mkdirSync(config.keep, { recursive: true });
		// mkdir succeeds on a symlink to a directory; root would then write the fixture wherever the link points.
		if (lstatSync(config.keep).isSymbolicLink()) throw new Error(`--keep ${config.keep} is a symbolic link`);
		if (existsSync(join(config.keep, "state.sqlite"))) throw new Error(`--keep ${config.keep} already holds a fixture`);
		directory = config.keep;
	} else directory = await mkdtemp(join(tmpdir(), "unit-capacity-"));
	file = join(directory, "state.sqlite");
	flush("running");
	if (config.reuse !== undefined) await copyFixture();
	for (const phase of config.phases) await runPhase(phase);
	setPhase("finish");
	await diskSnapshot("final");
	flush("complete");
} catch (error) {
	failure = error;
	flush("failed", error);
} finally {
	clearInterval(sampler);
	if (config.keep === undefined && directory !== "") await rm(directory, { recursive: true, force: true });
}
if (failure !== undefined) throw failure;

// ---- configuration -------------------------------------------------------------------------------------------

function parseConfig() {
	const { values } = parseArgs({
		options: {
			records: { type: "string" },
			relations: { type: "string" },
			tail: { type: "string" },
			forgotten: { type: "string" },
			topology: { type: "string" },
			out: { type: "string" },
			phases: { type: "string" },
			keep: { type: "string" },
			reuse: { type: "string" },
			mutate: { type: "string" },
			quiescent: { type: "boolean" },
			"settled-turns": { type: "string" },
			"query-chars": { type: "string" },
			"capture-cycles": { type: "string" },
			"duration-s": { type: "string" },
			"mutate-ops": { type: "string" },
			"mutate-interval-ms": { type: "string", default: "1000" },
			"sample-ms": { type: "string", default: "250" },
		},
	});
	const fail = () => {
		throw new Error(USAGE);
	};
	if (values.out === undefined) fail();
	let manifest;
	if (values.reuse !== undefined) {
		try {
			manifest = JSON.parse(readFileSync(join(resolve(values.reuse), "fixture.json"), "utf8"));
		} catch {
			fail();
		}
	}
	const pick = (name, fallback) => {
		const given = values[name];
		if (manifest === undefined) return given === undefined ? fallback : Number(given);
		if (given !== undefined && Number(given) !== manifest[name]) fail();
		return manifest[name];
	};
	const count = manifest === undefined ? Number(values.records) : pick("records", 0);
	const relations = pick("relations", 0);
	const tail = pick("tail", 63);
	const forgotten = pick("forgotten", 0);
	const topology = manifest?.topology ?? values.topology ?? "chain";
	if (manifest !== undefined && values.topology !== undefined && values.topology !== manifest.topology) fail();
	if (
		!Number.isSafeInteger(count) ||
		count < 1 ||
		count > 50000 ||
		!Number.isSafeInteger(relations) ||
		relations < 0 ||
		relations > MEMORY_RELATION_LIMIT ||
		!Number.isInteger(tail) ||
		tail < 0 ||
		tail > 63 ||
		!Number.isSafeInteger(forgotten) ||
		forgotten < 0 ||
		(topology !== "chain" && topology !== "dense")
	)
		fail();
	// Records [0, footprint) hold or anchor relations; forgotten seeds come from the top so they never break a relation.
	const hubs = topology === "dense" ? Math.ceil(relations / MEMORY_RELATION_DEGREE_LIMIT) : 0;
	const footprint = relations === 0 ? 0 : topology === "dense" ? hubs + relations : relations + 1;
	if (footprint > count || forgotten > count - footprint) fail();
	const mutate = values.mutate;
	let phases;
	if (values.phases !== undefined) {
		phases = values.phases.split(",");
		if (phases.length === 0 || phases.some((name) => !PHASE_ORDER.includes(name)) || new Set(phases).size !== phases.length)
			fail();
	} else if (values.keep !== undefined) phases = ["seed"];
	else if (mutate !== undefined) phases = values.reuse === undefined ? ["seed", "mutate"] : ["mutate"];
	else if (values.reuse !== undefined) phases = DEFAULT_PHASES.filter((name) => name !== "seed");
	else phases = DEFAULT_PHASES;
	phases = PHASE_ORDER.filter((name) => phases.includes(name));
	const [phase] = phases;
	const quiescent = values.quiescent === true || manifest?.quiescent === true;
	const hasGrowthArgs = ["settled-turns", "query-chars", "capture-cycles"].some((key) => values[key] !== undefined);
	let workload = manifest?.workload;
	if (phase === "grow") {
		if (
			phases.length !== 1 || values.keep === undefined || manifest?.quiescent !== true || workload !== undefined ||
			(values["settled-turns"] === undefined) === (values["capture-cycles"] === undefined)
		) fail();
		const turns = Number(values["settled-turns"]);
		const queryChars = Number(values["query-chars"]);
		const cycles = Number(values["capture-cycles"]);
		workload = values["settled-turns"] !== undefined
			? { kind: "settled-chat", turns, queryChars: values["query-chars"] === undefined ? 0 : queryChars }
			: { kind: "capture-forget", cycles };
		if (workload.kind === "capture-forget" && values["query-chars"] !== undefined) fail();
	} else if (hasGrowthArgs) fail();
	if (values.quiescent === true && (phase !== "seed" || values.keep === undefined)) fail();
	if (quiescent && (relations !== 0 || forgotten !== 0 || mutate !== undefined)) fail();
	if (workload !== undefined) {
		const bounded = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
		if (!quiescent || phases.length !== 1 || !["grow", "fixture-check", "replay", "startup", "probe"].includes(phase)) fail();
		if (workload.kind === "settled-chat") {
			if (!bounded(workload.turns, 0, 20000) ||
				(workload.turns === 0 ? workload.queryChars !== 0 : !bounded(workload.queryChars, 40, 2000))) fail();
		} else if (workload.kind !== "capture-forget" || !bounded(workload.cycles, 0, 30000)) fail();
	} else if (quiescent && phase !== "seed") fail();
	if ((phase === "fixture-check" || phase === "probe") && workload === undefined) fail();
	if (values.keep !== undefined && (phases.length !== 1 || !["seed", "grow"].includes(phase))) fail();
	if (phases.includes("seed") === (values.reuse !== undefined)) fail();
	const durationS = values["duration-s"] === undefined ? undefined : Number(values["duration-s"]);
	const mutateOps = values["mutate-ops"] === undefined ? undefined : Number(values["mutate-ops"]);
	const intervalMs = Number(values["mutate-interval-ms"]);
	const sampleMs = Number(values["sample-ms"]);
	if (
		phases.includes("mutate") !== (mutate !== undefined) ||
		// Start at the seed's exact record counts and checkpoint position, without owner activity.
		(mutate !== undefined && phases.some((name) => name !== "seed" && name !== "mutate")) ||
		(mutate !== undefined && !Object.hasOwn(MUTATE_MIXES, mutate)) ||
		(mutate !== undefined && durationS === undefined && mutateOps === undefined) ||
		(mutate === undefined && (durationS !== undefined || mutateOps !== undefined)) ||
		(durationS !== undefined && !(durationS > 0)) ||
		(mutateOps !== undefined && (!Number.isSafeInteger(mutateOps) || mutateOps < 1)) ||
		!Number.isSafeInteger(intervalMs) ||
		intervalMs < 0 ||
		!Number.isSafeInteger(sampleMs) ||
		sampleMs < 0
	)
		fail();
	return {
		out: resolve(values.out),
		keep: values.keep === undefined ? undefined : resolve(values.keep),
		reuse: values.reuse === undefined ? undefined : resolve(values.reuse),
		phases,
		fixture: { count, relations, tail, forgotten, topology, hubs },
		quiescent,
		workload,
		mutate: mutate === undefined ? undefined : { mix: mutate, durationS, ops: mutateOps, intervalMs },
		sampleMs,
	};
}

// ---- phases --------------------------------------------------------------------------------------------------

async function runPhase(name) {
	setPhase(name);
	// Flushing at the start names the phase an OOM-killed run died in.
	flush("running");
	if (name === "seed") await seedPhase();
	else if (name === "grow") await growPhase();
	else if (name === "fixture-check") await fixtureCheckPhase();
	else if (name === "replay") await replayPhase();
	else if (name === "startup") await startupPhase();
	else if (name === "probe") await probePhase();
	else if (name === "foreground") await foregroundPhase();
	else await mutatePhase();
}

// Builds the fixture in one process so a later process can measure the owner without seed construction in its peak.
async function seedPhase() {
	const storage = await openNodeSqliteStorage(file);
	const seed = config.quiescent
		? await Harness.open(storage, { models: createModels(), registry: createRegistry(), now: () => FIXTURE_TIME }, context)
		: createSession(storage);
	try {
		if (config.quiescent) {
			await seed.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" } },
				init: (tx, id) => tx.doc(MemoryInputsDoc, id),
			});
		}
		const started = performance.now();
		await seed.commit(async (tx) => {
			const state = await tx.doc(MemoryDoc);
			const links = await tx.doc(MemoryRelationsDoc);
			for (let index = 0; index < count; index++) {
				const id = rememberMemory(
					state,
					{
						writeKey: `capacity:${index}`,
						content: seedContent(index),
						relations: seedRelations(index),
						now: config.quiescent ? FIXTURE_TIME : Date.now(),
						provenance: { origin: "user", conversationId: 1, entryIds: [], derivation: "explicit" },
					},
					links,
				);
				if (config.quiescent) state.records[id].tier.consolidation = { state: "done", summaryIds: [] };
			}
		}, context);
		record("seed", { elapsedMs: performance.now() - started, count, relations, topology });
		if (forgotten > 0) {
			const forgetStarted = performance.now();
			await seed.commit(async (tx) => {
				const state = await tx.doc(MemoryDoc);
				const links = await tx.doc(MemoryRelationsDoc);
				for (let index = 0; index < forgotten; index++)
					forgetMemory(state, { writeKey: `forgotten:${index}`, id: `memory:capacity:${count - 1 - index}` }, links);
			}, context);
			record("seed-forgotten", { elapsedMs: performance.now() - forgetStarted, forgotten });
		}
		const commits = [];
		for (let index = 0; index < tail; index++) {
			const start = performance.now();
			await seed.commit(
				async (tx) =>
					forgetMemory(await tx.doc(MemoryDoc), { writeKey: `tail:${index}`, id: "absent" }, await tx.doc(MemoryRelationsDoc)),
				context,
			);
			commits.push(performance.now() - start);
		}
		record("receipt-delta-tail", { tail, samplesMs: commits });
		// The WAL only holds data while a connection is open; close truncates it, so sample before closing.
		await diskSnapshot("seed-open");
	} finally {
		await seed.close(context);
	}
	await diskSnapshot("seed-closed");
	if (config.keep !== undefined) writeFixtureManifest();
}

async function growPhase() {
	const workload = config.workload;
	const chat = workload.kind === "settled-chat";
	const limit = chat ? workload.turns : workload.cycles;
	const target = chat ? MemoryInputsDoc : MemoryDoc;
	const ordinary = [];
	const checkpoints = [];
	const final = [];
	const session = createSession(await openNodeSqliteStorage(file));
	try {
		const probe = openRevisionProbe(file, target.definition.kind);
		assert.ok(probe, `cannot read base position for ${target.definition.kind}`);
		try {
			let lastBase = probe.read();
			assert.notEqual(lastBase, undefined);
			const initialBaseSeq = lastBase;
			const log = openSync(`${config.out}.ops.ndjson`, "wx", 0o600);
			try {
				for (let index = 0; index < limit; index++) {
					const started = performance.now();
					await session.commit(chat ? (tx) => appendSettledTurn(tx, index) : (tx) => captureForget(tx, index), context);
					const ms = performance.now() - started;
					const baseSeq = probe.read();
					const checkpoint = baseSeq !== lastBase;
					lastBase = baseSeq;
					(checkpoint ? checkpoints : ordinary).push(ms);
					if (index >= limit - 1000) final.push(ms);
					writeSync(log, `${JSON.stringify({ op: index + 1, ms, checkpoint, baseSeq })}\n`);
				}
			} finally {
				closeSync(log);
			}
			record("fixture-commits", {
				commits: limit, documentKind: target.definition.kind, initialBaseSeq, finalBaseSeq: lastBase,
				ordinary: summarizeCommits(ordinary), checkpoints: summarizeCommits(checkpoints),
				final1000: summarizeCommits(final),
			});
		} finally {
			probe.close();
		}
		await diskSnapshot("fixture-writer-open");
	} finally {
		await session.close(context);
	}
	await diskSnapshot("fixture-writer-closed");
	writeFixtureManifest();
}

function settledQuery(index) {
	const prefix = `Describe the numbered sample ${String(index).padStart(5, "0")}: `;
	return prefix + "x".repeat(config.workload.queryChars - prefix.length);
}

async function appendSettledTurn(tx, index) {
	const query = settledQuery(index);
	const input = await tx.appendEntry(MemoryInputEntry, ROOT_CONVERSATION_ID, {
		data: { origin: "human" },
		model: [{ role: "user", content: query, timestamp: FIXTURE_TIME + index }],
	});
	const answer = await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, {
		model: [fauxAssistantMessage(FIXTURE_ANSWER, { timestamp: FIXTURE_TIME + index })],
	});
	const submission = await tx.createSubmission({
		conversationId: ROOT_CONVERSATION_ID, type: "input", status: "placed", entry: input.id,
	});
	tx.settleSubmission(submission.id, { status: "done", answer: answer.id });
	await recordMemoryInput(tx, ROOT_CONVERSATION_ID, submission.id, "human", query);
}

function churnIdentity(index) {
	const entry = 100000 + index;
	const generation = 200000 + index;
	const writeKey = `capture:${generation}:${entry}:0`;
	return {
		entry, generation, writeKey, id: `memory:${writeKey}`,
		taskId: 300000 + index, forgetKey: `capacity-forget:${generation}`,
	};
}

function churnRemember({ entry, writeKey }) {
	return {
		writeKey, content: CHURN_CONTENT, now: FIXTURE_TIME,
		provenance: { origin: "user", conversationId: ROOT_CONVERSATION_ID, entryIds: [entry], derivation: "capture" },
	};
}

async function captureForget(tx, index) {
	const cycle = churnIdentity(index);
	const state = await tx.doc(MemoryDoc);
	const links = await tx.doc(MemoryRelationsDoc);
	const id = rememberMemory(state, churnRemember(cycle));
	state.captures[cycle.generation] = { taskId: cycle.taskId, outcome: { state: "completed", memoryIds: [id] } };
	state.revision++;
	assert.equal(forgetMemory(state, { writeKey: cycle.forgetKey, id }, links), true);
}

async function readGrowthDocs(session) {
	return {
		state: await session.snapshot(MemoryDoc, context),
		links: await session.snapshot(MemoryRelationsDoc, context),
		inputs: (await session.snapshot(MemoryInputsDoc, ROOT_CONVERSATION_ID, context))?.inputs,
	};
}

// Full scans and retries run in their own process so their peaks and writes do not contaminate replay.
async function fixtureCheckPhase() {
	const { workload } = config;
	const turns = workload.kind === "settled-chat" ? workload.turns : 0;
	const cycles = workload.kind === "capture-forget" ? workload.cycles : 0;
	const storage = await openNodeSqliteStorage(file);
	const session = createSession(storage);
	try {
		const { state, links, inputs } = await readGrowthDocs(session);
		const receipts = count + tail + 2 * cycles;
		assertFixture(state, links, { records: count + cycles, live: count, relations: 0 });
		assert.deepEqual(Object.keys(state).sort(), ["captures", "consolidation", "receipts", "records", "revision"]);
		assert.deepEqual(links, { relations: {} });
		assert.deepEqual(state.consolidation, { state: "idle" });
		assert.equal(state.revision, count + tail + 3 * cycles);
		assert.equal(Object.keys(state.receipts).length, receipts);
		assert.equal(Object.keys(state.captures).length, cycles);
		assert.equal(Object.keys(inputs).length, turns);
		assert.equal((await storage.scanTasks({}, 1, undefined, context)).items.length, 0);
		assert.deepEqual(
			(await storage.scanConversations({}, 2, undefined, context)).items.map((entry) => entry.id),
			[ROOT_CONVERSATION_ID],
		);
		for (let index = 0; index < count; index++) {
			const key = `capacity:${index}`;
			const id = `memory:${key}`;
			assert.deepEqual(state.receipts[key], { kind: "remember", memoryId: id });
			assert.deepEqual(state.records[id], {
				state: "live", id, revision: 1, content: seedContent(index), kind: "fact", importance: 0.5,
				createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME,
				provenance: { origin: "user", conversationId: ROOT_CONVERSATION_ID, entryIds: [], derivation: "explicit" },
				tier: { kind: "working", consolidation: { state: "done", summaryIds: [] } },
			});
		}
		for (let index = 0; index < tail; index++)
			assert.deepEqual(state.receipts[`tail:${index}`], { kind: "forget", removed: false });
		for (let index = 0; index < cycles; index++) {
			const { generation, taskId, writeKey, forgetKey, id } = churnIdentity(index);
			assert.deepEqual(state.records[id], { state: "forgotten", id, revision: 2 });
			assert.deepEqual(state.receipts[writeKey], { kind: "remember", memoryId: id });
			assert.deepEqual(state.receipts[forgetKey], { kind: "forget", removed: true });
			assert.deepEqual(state.captures[generation], { taskId, outcome: { state: "completed", memoryIds: [id] } });
		}
		const history = await verifySettledHistory(storage, inputs, turns);
		if (cycles > 0) {
			await session.commit(async (tx) => {
				const draft = await tx.doc(MemoryDoc);
				const links = await tx.doc(MemoryRelationsDoc);
				for (const index of new Set([0, cycles - 1])) {
					const cycle = churnIdentity(index);
					assert.equal(rememberMemory(draft, churnRemember(cycle)), cycle.id);
					assert.equal(forgetMemory(draft, { writeKey: cycle.forgetKey, id: cycle.id }, links), true);
				}
			}, context);
			const after = await session.snapshot(MemoryDoc, context);
			assert.deepEqual(after, state);
			assert.deepEqual(new MemoryRecall().recall(after, links, "zinnia", { now: FIXTURE_TIME }), []);
		}
		record("fixture-counts", {
			live: count, relations: 0, tombstones: cycles, writeReceipts: receipts, completedCaptures: cycles,
			memoryRevision: state.revision, memoryTasks: 0, inputMetadata: turns,
			queryChars: workload.queryChars ?? 0, queryBytes: turns * (workload.queryChars ?? 0), ...history,
			writeReceiptRetry: cycles > 0 ? "verified" : "not applicable",
		});
	} finally {
		await session.close(context);
	}
}

async function verifySettledHistory(storage, inputs, turns) {
	async function* scan(read) {
		let cursor;
		do {
			const page = await read(cursor);
			yield* page.items;
			cursor = page.next;
		} while (cursor !== undefined);
	}
	const entries = scan((cursor) =>
		storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 128, cursor, context));
	const submissions = scan((cursor) => storage.scanSubmissions({}, 128, cursor, context));
	let index = 0;
	let first = null;
	let last = null;
	for await (const submission of submissions) {
		assert.ok(index < turns, "unexpected submission");
		const query = settledQuery(index);
		const input = (await entries.next()).value;
		const answer = (await entries.next()).value;
		assert.equal(submission.conversationId, ROOT_CONVERSATION_ID);
		assert.equal(submission.requestId, undefined);
		assert.equal(submission.type, "input");
		assert.equal(submission.status, "done");
		assert.equal(submission.entry, input?.id);
		assert.equal(submission.answer, answer?.id);
		assert.ok(MemoryInputEntry.is(input) && AssistantEntry.is(answer));
		assert.deepEqual(input.data, { origin: "human" });
		assert.deepEqual(inputs[submission.id], { origin: "human", query });
		assert.deepEqual(input.model, [{ role: "user", content: query, timestamp: FIXTURE_TIME + index }]);
		assert.deepEqual(answer.model, [fauxAssistantMessage(FIXTURE_ANSWER, { timestamp: FIXTURE_TIME + index })]);
		last = { submission: submission.id, input: input.id, answer: answer.id };
		first ??= last;
		index++;
	}
	assert.equal(index, turns);
	assert.equal((await entries.next()).done, true, "unexpected transcript entry");
	return { settledInputs: index, transcriptEntries: 2 * index, first, last };
}

function summarizeCommits(samples) {
	return samples.length === 0 ? { count: 0 } :
		{ count: samples.length, maxMs: Math.max(...samples), ...summarize(samples) };
}

function writeFixtureManifest() {
	const fixture = {
		schemaVersion: 1, records: count, relations, tail, forgotten, topology,
		...(config.quiescent ? { quiescent: true } : {}),
		...(config.workload === undefined ? {} : { workload: config.workload }),
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(directory, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`);
}

async function replayPhase() {
	const replay = [];
	for (let index = 0; index < 30; index++) {
		const workload = config.workload;
		const started = performance.now();
		const session = createSession(await openNodeSqliteStorage(file));
		try {
			if (workload !== undefined) {
				await readGrowthDocs(session);
				replay.push(performance.now() - started);
				continue;
			}
			assertFixture(await session.snapshot(MemoryDoc, context), await session.snapshot(MemoryRelationsDoc, context), {
				records: count,
				live: count - forgotten,
				relations,
			});
		} finally {
			await session.close(context);
		}
		if (index >= 5) replay.push(performance.now() - started);
	}
	if (config.workload !== undefined) {
		const samplesMs = replay.slice(5);
		record("fixture-open-snapshots", { ...summarize(samplesMs), samplesMs, warmupMs: replay.slice(0, 5) });
		await diskSnapshot("fixture-replay-closed");
		return;
	}
	record("storage-open-snapshot-close", { relations, forgotten, ...summarize(replay), samplesMs: replay });
	await diskSnapshot("replay");
}

async function startupPhase() {
	const startup = [];
	for (let index = 0; index < 6; index++) {
		const copy = join(directory, `owner-${index}.sqlite`);
		await copyFile(file, copy);
		const started = performance.now();
		const agent = await openAgent(copy);
		startup.push(performance.now() - started);
		await agent.close(context);
		await rm(copy);
	}
	assert.equal(fauxState().callCount, 0);
	record("owner-startup", { samplesMs: startup, firstMs: startup[0], warm: summarize(startup.slice(1)) });
	await diskSnapshot("startup");
}

async function probePhase() {
	const observations = [];
	for (let index = 0; index < 31; index++) {
		// Each request sees the full grown history, even if the preceding owner compacted its own copy.
		const copy = join(directory, "probe.sqlite");
		await copyFile(file, copy);
		const agent = await openAgent(copy);
		const compactionCallsMs = [];
		let elapsed;
		let messages;
		try {
			fauxHandle().setResponses([function respond(request) {
				const ms = performance.now() - started;
				const first = request.messages[0];
				if (first?.role === "system" && first.content.startsWith("You are a context summarization assistant.")) {
					compactionCallsMs.push(ms);
					fauxHandle().appendResponses([respond]);
					return fauxAssistantMessage("The history contains numbered samples and acknowledgments.");
				}
				const user = request.messages.findLast((message) => message.role === "user");
				const hasEvidence = (text) => text.includes("Retrieved memory evidence") && text.includes("redis deployment");
				assert.ok(
					user !== undefined && (typeof user.content === "string" ? hasEvidence(user.content) :
						user.content.some((part) => part.type === "text" && hasEvidence(part.text))),
					"redis probe did not retrieve seeded memory",
				);
				elapsed = ms;
				messages = request.messages.length;
				return fauxAssistantMessage(FIXTURE_ANSWER);
			}]);
			const started = performance.now();
			const submission = await agent.submit("redis", context);
			const settled = await submission.wait(context);
			await agent.idle(context);
			assert.equal(settled.type, "input");
			assert.equal(settled.status, "done");
			assert.equal(typeof elapsed, "number");
			observations.push({ ms: elapsed, messages, compactionCallsMs });
			if (index === 30) await diskSnapshot("fixture-probe-open", copy);
		} finally {
			await agent.close(context);
		}
		if (index === 30) {
			await diskSnapshot("fixture-probe-closed", copy);
			const storage = await openNodeSqliteStorage(copy);
			try {
				assert.equal((await storage.scanTasks({ kind: "unit.memory.consolidation" }, 1, undefined, context)).items.length, 0);
			} finally {
				await storage.close(context);
			}
		}
		await rm(copy);
	}
	const samplesMs = observations.slice(6).map((sample) => sample.ms);
	const compactionCalls = observations.reduce((sum, entry) => sum + entry.compactionCallsMs.length, 0);
	assert.equal(fauxState().callCount, observations.length + compactionCalls);
	record("fixture-submit-to-chat", {
		firstMs: observations[0].ms, ...summarize(samplesMs), samplesMs, observations,
		answered: observations.length, compactionCalls, lastCopyConsolidationTasks: 0,
	});
}

async function foregroundPhase() {
	const agent = await openAgent(file);
	try {
		const samples = [];
		let firstMs;
		for (let index = 0; index < 31; index++) {
			let elapsed;
			fauxHandle().setResponses([
				(request) => {
					elapsed = performance.now() - started;
					assert.match(JSON.stringify(request.messages), /Retrieved memory evidence/);
					return fauxAssistantMessage("done");
				},
			]);
			const started = performance.now();
			await agent.ask("redis", context);
			await agent.idle(context);
			assert.equal(typeof elapsed, "number");
			if (index === 0) firstMs = elapsed;
			if (index >= 6) samples.push(elapsed);
		}
		assert.equal(fauxState().callCount, 31);
		record("foreground-submit-to-provider", {
			firstMs,
			...summarize(samples),
			samplesMs: samples,
			fauxCalls: fauxState().callCount,
		});
		await diskSnapshot("foreground-open");
	} finally {
		await agent.close(context);
	}
	await diskSnapshot("foreground-closed");
}

// Drives remember, forget and recall through one session, as the owner would, and reports per-operation cost.
async function mutatePhase() {
	const { mix, durationS, ops: maxOps, intervalMs } = config.mutate;
	const weights = MUTATE_MIXES[mix];
	const random = prng(64);
	const recall = new MemoryRecall();
	// Seeded records outside the relation footprint can be forgotten without changing the relation count.
	const footprint = relations === 0 ? 0 : topology === "dense" ? hubs + relations : relations + 1;
	const pool = [];
	for (let index = footprint; index < count - forgotten; index++) pool.push(`memory:capacity:${index}`);
	let nextForget = 0;
	const log = [];
	const tally = { remember: 0, forget: 0, recall: 0, forgetFallbacks: 0, checkpoints: 0 };
	const probe = openRevisionProbe(file);
	let lastRevision = probe?.read();
	const session = createSession(await openNodeSqliteStorage(file));
	const started = performance.now();
	try {
		for (let op = 0; ; op++) {
			if (maxOps !== undefined && op >= maxOps) break;
			if (durationS !== undefined && performance.now() - started >= durationS * 1000) break;
			const draw = random();
			let kind = draw < weights.remember ? "remember" : draw < weights.remember + weights.forget ? "forget" : "recall";
			if (kind === "forget" && nextForget >= pool.length) {
				tally.forgetFallbacks++;
				kind = "remember";
			}
			const opStarted = performance.now();
			if (kind === "remember") {
				const index = tally.remember++;
				await session.commit(async (tx) => {
					rememberMemory(await tx.doc(MemoryDoc), {
						writeKey: `mutate:${index}`,
						content: seedContent(count + index),
						now: Date.now(),
						provenance: { origin: "user", conversationId: 1, entryIds: [], derivation: "explicit" },
					});
				}, context);
				pool.push(`memory:mutate:${index}`);
			} else if (kind === "forget") {
				const id = pool[nextForget++];
				const index = tally.forget++;
				await session.commit(
					async (tx) =>
						assert.ok(
							forgetMemory(
								await tx.doc(MemoryDoc),
								{ writeKey: `mutate-forget:${index}`, id },
								await tx.doc(MemoryRelationsDoc),
							),
						),
					context,
				);
			} else {
				tally.recall++;
				recall.recall(
					await session.snapshot(MemoryDoc, context),
					await session.snapshot(MemoryRelationsDoc, context),
					"redis",
					{ now: Date.now() },
				);
			}
			const ms = performance.now() - opStarted;
			const revision = probe?.read();
			const checkpoint = revision !== undefined && lastRevision !== undefined && revision !== lastRevision;
			lastRevision = revision;
			if (checkpoint) tally.checkpoints++;
			if (log.length < OP_LIMIT)
				log.push({ op, kind, ms, checkpoint, maxRssBytes: process.resourceUsage().maxRSS * 1024 });
			if (intervalMs > 0) await delay(Math.max(0, intervalMs - ms));
		}
	} finally {
		await session.close(context);
		probe?.close();
	}
	const byKind = {};
	for (const kind of ["remember", "forget", "recall"]) {
		const times = log.filter((entry) => entry.kind === kind).map((entry) => entry.ms);
		if (times.length > 0) byKind[kind] = { count: times.length, maxMs: Math.max(...times), ...summarize(times) };
	}
	record("mutate", {
		mix,
		elapsedMs: performance.now() - started,
		...tally,
		// "checkpoints" counts base-revision changes seen after each operation (any document); null probe means unreadable.
		checkpointProbe: probe === undefined ? "unavailable" : "revision-table",
		byKind,
		opsLogged: log.length,
		ops: log,
	});
	await diskSnapshot("mutate-closed");
	// Reopen and verify exact counts after the churn, as the matrix requires.
	const reopen = [];
	for (let index = 0; index < 10; index++) {
		const reopenStarted = performance.now();
		const check = createSession(await openNodeSqliteStorage(file));
		try {
			assertFixture(await check.snapshot(MemoryDoc, context), await check.snapshot(MemoryRelationsDoc, context), {
				records: count + tally.remember,
				live: count - forgotten + tally.remember - tally.forget,
				relations,
			});
		} finally {
			await check.close(context);
		}
		reopen.push(performance.now() - reopenStarted);
	}
	record("mutate-reopen", { ...summarize(reopen), samplesMs: reopen });
}

async function copyFixture() {
	const source = join(config.reuse, "state.sqlite");
	assert.ok(!existsSync(`${source}-wal`) || (await stat(`${source}-wal`)).size === 0, "fixture has an unflushed WAL");
	const started = performance.now();
	await copyFile(source, file);
	record("fixture-copy", { elapsedMs: performance.now() - started, bytes: (await stat(file)).size, fixture: config.reuse });
}

function assertFixture(state, links, expected) {
	assert.equal(Object.keys(state.records).length, expected.records);
	if (forgotten > 0 || expected.live !== expected.records)
		assert.equal(Object.values(state.records).filter((entry) => entry.state === "live").length, expected.live);
	const relations = links?.relations ?? {};
	assert.equal(Object.keys(relations).length, expected.relations);
	assert.ok(Object.values(relations).every((relation) => isLiveRelation(state, relation)));
}

function seedContent(index) {
	return `redis deployment ${index}: ${"bounded evidence ".repeat(30)}`;
}

// Chain keeps endpoint degree at two; dense gives each hub the maximum degree so graph and verification see the worst case.
function seedRelations(index) {
	if (relations === 0) return [];
	if (topology === "chain") return index > 0 && index <= relations ? [{ id: `memory:capacity:${index - 1}`, kind: "supports" }] : [];
	if (index < hubs || index >= hubs + relations) return [];
	const hub = Math.floor((index - hubs) / MEMORY_RELATION_DEGREE_LIMIT);
	return [{ id: `memory:capacity:${hub}`, kind: "supports" }];
}

// ---- owner and faux provider ---------------------------------------------------------------------------------

function fauxHandle() {
	if (fauxInstance === undefined) {
		fauxInstance = fauxProvider();
		modelsInstance = createModels();
		modelsInstance.setProvider(fauxInstance.provider);
	}
	return fauxInstance;
}

function fauxState() {
	return fauxHandle().state;
}

async function openAgent(path) {
	fauxHandle();
	return Agent.open(
		{
			storage: await openNodeSqliteStorage(path),
			models: modelsInstance,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
		},
		context,
	);
}

// ---- recording -----------------------------------------------------------------------------------------------

function setPhase(name) {
	currentPhase = name;
	takeSample();
}

function record(name, fields) {
	const value = {
		name,
		observedAt: new Date().toISOString(),
		rss: process.memoryUsage().rss,
		peakRss: process.resourceUsage().maxRSS * 1024,
		proc: readProcStatus() ?? "unavailable",
		cgroup: readCgroupFiles(CGROUP_PHASE_FILES),
		...fields,
	};
	phases.push(value);
	// The per-operation log can hold thousands of entries; the result file keeps it, the console line does not.
	console.log(JSON.stringify({ ...value, ops: undefined }));
	flush("running");
}

// Writes the whole result atomically so a killed run still leaves the last completed phase on disk.
function flush(status, error) {
	const document = {
		schemaVersion: SCHEMA_VERSION,
		status,
		startedAt,
		updatedAt: new Date().toISOString(),
		elapsedMs: performance.now() - startedMs,
		currentPhase,
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		count,
		relations,
		relationTopology: relations === 0 ? "none" : topology === "dense" ? "supports-hubs" : "supports-chain",
		tail,
		workload: config.workload ?? null,
		operationLog: config.phases[0] === "grow" ? `${config.out}.ops.ndjson` : null,
		forgotten,
		phasesRequested: config.phases,
		mutate: config.mutate ?? null,
		fixtureSource: config.reuse ?? null,
		directory,
		host: hostFacts(),
		phases,
		diskPhases,
		sampleIntervalMs: config.sampleMs,
		samples,
		samplesDropped,
		cgroupDirectory,
		cgroup: readCgroupFiles(CGROUP_FINAL_FILES),
		...(error === undefined ? {} : { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
	};
	// Remove, then create exclusively, so a pre-planted symlink at the temporary name is never followed.
	const temporary = `${config.out}.tmp`;
	rmSync(temporary, { force: true });
	writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	renameSync(temporary, config.out);
}

// Makes this process the kernel's first OOM victim, so a runaway cell cannot cost the host its sshd or journald.
// An unprivileged process may raise its own score, so this works without root.
function lowerOomPriority() {
	if (process.platform !== "linux") return { applied: false, reason: `no /proc/self/oom_score_adj on ${process.platform}` };
	try {
		writeFileSync("/proc/self/oom_score_adj", "1000");
		return { applied: true, value: Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()) };
	} catch (error) {
		return { applied: false, reason: error.message };
	}
}

function installSignalHandlers() {
	for (const [signal, code] of [
		["SIGTERM", 143],
		["SIGINT", 130],
	]) {
		process.on(signal, () => {
			try {
				flush("interrupted", new Error(`received ${signal}`));
			} finally {
				process.exit(code);
			}
		});
	}
}

function takeSample() {
	if (samples.length >= SAMPLE_LIMIT) {
		samplesDropped++;
		return;
	}
	const memory = process.memoryUsage();
	const sample = {
		t: Math.round(performance.now() - startedMs),
		phase: currentPhase,
		rss: memory.rss,
		heapUsed: memory.heapUsed,
		external: memory.external,
		arrayBuffers: memory.arrayBuffers,
	};
	const proc = readProcStatus();
	if (proc !== undefined) Object.assign(sample, proc);
	const cgroupCurrent = readCgroupFiles(["memory.current"])["memory.current"];
	if (cgroupCurrent !== null) sample.cgroupCurrent = Number(cgroupCurrent);
	samples.push(sample);
}

// ---- disk ----------------------------------------------------------------------------------------------------

async function diskSnapshot(label, path = file) {
	const files = {};
	for (const name of SQLITE_FILES) {
		try {
			files[name] = (await stat(`${path}${name.slice("state.sqlite".length)}`)).size;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			files[name] = null;
		}
	}
	let directoryBytes = 0;
	for (const name of await readdir(directory)) {
		try {
			directoryBytes += (await stat(join(directory, name))).size;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	let filesystem = "unavailable";
	try {
		const info = await statfs(directory);
		filesystem = {
			blockSize: info.bsize,
			totalBytes: info.blocks * info.bsize,
			freeBytes: info.bfree * info.bsize,
			availableBytes: info.bavail * info.bsize,
			...mountFacts(directory),
		};
	} catch {
		// statfs is not available on every platform or filesystem.
	}
	diskPhases.push({
		phase: label,
		observedAt: new Date().toISOString(),
		files,
		directoryBytes,
		filesystem,
		sqlite: readSqliteFacts(path, files["state.sqlite-wal"] !== null, files["state.sqlite-shm"] !== null),
	});
}

// A second read-only connection reads what the writer's adapter configured; per-connection settings are not read back.
function readSqliteFacts(path, hadWal, hadShm) {
	let database;
	try {
		database = new DatabaseSync(path, { readOnly: true });
		const one = (sql) => Object.values(database.prepare(sql).get())[0];
		const facts = {
			journalMode: one("PRAGMA journal_mode"),
			pageSize: one("PRAGMA page_size"),
			pageCount: one("PRAGMA page_count"),
			freelistCount: one("PRAGMA freelist_count"),
		};
		const revisions = revisionTable(database);
		if (revisions !== undefined)
			facts.revisions = database
				.prepare(`SELECT kind, count(*) AS rows, sum(length(content)) AS bytes FROM "${revisions}" GROUP BY kind`)
				.all()
				.map((row) => ({ kind: row.kind, rows: Number(row.rows), bytes: Number(row.bytes) }));
		const documents = durableTable(database, "documents");
		if (documents !== undefined && revisions !== undefined && config.quiescent)
			facts.revisionsByDocument = database.prepare(`
				SELECT json_extract(d.kind, '$') AS documentKind, r.kind, r.version,
					count(*) AS rows, sum(length(CAST(r.content AS BLOB))) AS bytes, max(r.seq) AS lastSeq
				FROM "${revisions}" r JOIN "${documents}" d ON d.id = r.document_id
				GROUP BY d.kind, r.kind, r.version ORDER BY d.kind, r.kind, r.version
			`).all();
		const entries = durableTable(database, "entries");
		if (entries !== undefined)
			facts.entries = Number(Object.values(database.prepare(`SELECT count(*) FROM "${entries}"`).get())[0]);
		if (entries !== undefined && config.quiescent)
			facts.entryBytes = one(`SELECT coalesce(sum(length(CAST(record AS BLOB))), 0) FROM "${entries}"`);
		return facts;
	} catch (error) {
		return { unknown: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			database?.close();
		} catch {
			// The probe must never fail a run.
		}
		// A read-only connection can leave empty -wal/-shm files that no writer owns; remove only those it created.
		if (!hadWal) rmSync(`${path}-wal`, { force: true });
		if (!hadShm) rmSync(`${path}-shm`, { force: true });
	}
}

function revisionTable(database) {
	return durableTable(database, "document_revisions");
}

// Durable's tables carry an optional prefix; the profiler's fixtures use none, but a prefixed one is still found.
function durableTable(database, base) {
	return database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name = ? OR name LIKE ? ESCAPE '\\')")
		.get(base, `%\\_${base.replaceAll("_", "\\_")}`)?.name;
}

// The fixture probe reads only the current document's newest base; legacy mutation counts bases across all documents.
function openRevisionProbe(path, documentKind) {
	let database;
	try {
		database = new DatabaseSync(path, { readOnly: true });
		const table = revisionTable(database);
		if (table === undefined) {
			database.close();
			return undefined;
		}
		if (documentKind !== undefined) {
			const documents = durableTable(database, "documents");
			const document = database.prepare(`SELECT id FROM "${documents}" WHERE kind = ? AND retired_at IS NULL`)
				.get(JSON.stringify(documentKind));
			if (document === undefined) {
				database.close();
				return undefined;
			}
			const base = database.prepare(`SELECT seq FROM "${table}" WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1`);
			return { read: () => base.get(document.id)?.seq, close: () => database.close() };
		}
		const query = database.prepare(`SELECT count(*) AS rows, coalesce(max(seq), 0) AS last FROM "${table}" WHERE kind = 'base'`);
		return {
			read: () => {
				const row = query.get();
				return `${row.rows}:${row.last}`;
			},
			close: () => database.close(),
		};
	} catch {
		database?.close();
		return undefined;
	}
}

// ---- host and Linux readers (every reader degrades instead of throwing) ---------------------------------------

function hostFacts() {
	const processors = cpus();
	return {
		platform: process.platform,
		arch: process.arch,
		release: release(),
		node: process.version,
		execArgv: process.execArgv,
		heapSizeLimit: getHeapStatistics().heap_size_limit,
		cpuCount: processors.length,
		cpuModel: processors[0]?.model ?? "unavailable",
		totalMemory: totalmem(),
		freeMemory: freemem(),
		loadAverage: loadavg(),
		uptimeS: uptime(),
		tmpdir: tmpdir(),
		tmpdirEnv: process.env.TMPDIR ?? null,
		meminfo: readMeminfo(),
		oomScoreAdj,
		// Verified against packages/chord/src/sqlite/node.ts: the adapter sets these on every open.
		sqliteAdapter: { journalMode: "WAL", synchronous: "NORMAL", walAutoCheckpointPages: 1000, checkpointOnClose: "TRUNCATE" },
	};
}

function readMeminfo() {
	if (process.platform !== "linux") return "unavailable";
	try {
		const result = {};
		for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
			const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB/.exec(line);
			if (match !== null) result[match[1]] = Number(match[2]) * 1024;
		}
		return result;
	} catch {
		return "unavailable";
	}
}

function readProcStatus() {
	if (process.platform !== "linux") return undefined;
	try {
		const result = {};
		for (const line of readFileSync("/proc/self/status", "utf8").split("\n")) {
			const match = /^(VmHWM|VmRSS|RssAnon|RssFile|RssShmem|VmSwap):\s+(\d+) kB/.exec(line);
			if (match !== null) result[match[1][0].toLowerCase() + match[1].slice(1)] = Number(match[2]) * 1024;
		}
		return result;
	} catch {
		return undefined;
	}
}

function findCgroupDirectory() {
	try {
		const membership = readFileSync("/proc/self/cgroup", "utf8")
			.split("\n")
			.find((line) => line.startsWith("0::"));
		return membership === undefined ? null : join("/sys/fs/cgroup", membership.slice(3));
	} catch {
		return null;
	}
}

function readCgroupFiles(names) {
	const result = {};
	for (const name of names) {
		try {
			result[name] = cgroupDirectory === null ? null : readFileSync(join(cgroupDirectory, name), "utf8").trim();
		} catch {
			result[name] = null;
		}
	}
	return result;
}

// Longest matching mount point from mountinfo identifies the filesystem type, which shows whether the fixture was on tmpfs.
function mountFacts(path) {
	if (process.platform !== "linux") return {};
	try {
		const real = realpathSync(path);
		let best;
		for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
			const [left, right] = line.split(" - ");
			if (right === undefined) continue;
			const fields = left.split(" ");
			const mountPoint = fields[4].replaceAll("\\040", " ");
			if (!(real === mountPoint || real.startsWith(mountPoint === "/" ? "/" : `${mountPoint}/`))) continue;
			if (best === undefined || mountPoint.length > best.mountPoint.length) {
				const [type, source] = right.split(" ");
				best = { mountPoint, fsType: type, source };
			}
		}
		return best ?? {};
	} catch {
		return {};
	}
}

// ---- statistics ----------------------------------------------------------------------------------------------

function summarize(samples) {
	const sorted = [...samples].sort((left, right) => left - right);
	const medianMs = sorted[Math.floor(sorted.length / 2)];
	const deviations = samples.map((value) => Math.abs(value - medianMs)).sort((left, right) => left - right);
	return {
		medianMs,
		p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
		madMs: deviations[Math.floor(deviations.length / 2)],
	};
}

// Fixed seed so every mutate run issues the same operation sequence.
function prng(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}
