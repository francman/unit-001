// Measures one real capture-triggered consolidation burst and matched foreground probes on disposable SQLite copies.
import assert from "node:assert/strict";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createSession, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryCapture, MemoryConsolidation, MemoryDoc, MemoryInputEntry, MemoryRelationsDoc } from "unit-memory";
import { Agent } from "../dist/agent.js";

const captureKind = MemoryCapture.definition.name;
const consolidationKind = MemoryConsolidation.definition.name;
const publicationKind = "unit.memory.consolidated";
const probeText = "redis";
const answer = "Acknowledged.";

export async function measureBackground(
	{ file, directory, burst, pairs, records, tail, diskSnapshot, sampleArm, onPair },
	runArm = measureArm,
) {
	const statements = Array.from({ length: burst }, (_, index) =>
		`The saffron vault inventory has verified label ${String(index).padStart(3, "0")}.`,
	);
	const prompt = statements.map((statement) => `Remember that ${statement}`).join("\n");
	const qualifying = [];
	for (let pair = 1; pair <= pairs; pair++) {
		const order = pair % 2 === 1 ? ["idle", "active"] : ["active", "idle"];
		const observation = { pair, order };
		for (const arm of order) {
			const sample = (milestone) => sampleArm?.(pair, arm, milestone);
			sample("before-copy");
			const copy = join(directory, `${arm}.sqlite`);
			await copyFile(file, copy);
			try {
				observation[arm] = await runArm({
					arm, copy, directory, prompt, statements, records, tail, sample,
					diskSnapshot: pair === pairs ? diskSnapshot : undefined,
				});
			} finally {
				await rm(copy);
			}
			sample("verified");
		}
		const { active, idle } = observation;
		assert.equal(active.probe.messages, idle.probe.messages, `pair ${pair}: probe histories differ in length`);
		observation.windowMissed = !active.probe.activeAtSubmit ||
			!(active.probe.activeAtFaux || active.probe.publicationsDuringProbe > 0);
		onPair(observation);
		if (!observation.windowMissed) qualifying.push(observation);
	}
	if (qualifying.length === 0)
		throw Object.assign(new Error(`no qualifying consolidation overlap in ${pairs} background pair(s)`), {
			code: "CAPACITY_BACKGROUND_NO_OVERLAP",
		});
	return qualifying;
}

async function measureArm({ arm, copy, directory, prompt, statements, records, tail, diskSnapshot, sample }) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const ownerStarted = performance.now();
	const storage = await openNodeSqliteStorage(copy);
	const clock = { start: undefined };
	const observed = observeBackground(storage, clock);
	const owner = await Agent.open({ storage, models, model: { provider: "faux", modelId: "faux-1" }, cwd: directory }, context);
	const ownerOpenMs = performance.now() - ownerStarted;
	sample("owner-open");
	const controller = new AbortController();
	let deadline;
	let result;
	try {
		const timeout = new Promise((_, reject) => {
			deadline = setTimeout(() => {
				const error = Object.assign(new Error(`${arm} arm did not reach foreground and background quiescence within 30 s`), {
					code: "CAPACITY_BACKGROUND_TIMEOUT",
				});
				controller.abort(error);
				reject(error);
			}, 30_000);
		});
		result = await Promise.race([
			timeout,
			submitProbes({ owner, faux, arm, prompt, clock, observed, sample }, withAbortSignal(controller.signal, context)),
		]);
		await diskSnapshot?.(`background-${arm}-open`, copy);
	} finally {
		clearTimeout(deadline);
		await owner.close(context);
	}
	sample("owner-closed");
	await diskSnapshot?.(`background-${arm}-closed`, copy);
	const proof = await verifyArm(copy, { observed, ...result, statements, records, tail });
	const { capture, consolidation, publicationsAtMs } = observed;
	return {
		ownerOpenMs, trigger: result.triggerTimes, probe: result.probeTimes, proof,
		capture: {
			...capture, queueMs: capture.startedAtMs - capture.scheduledAtMs, runMs: capture.endedAtMs - capture.startedAtMs,
		},
		consolidation: {
			...consolidation, publicationsAtMs,
			queueMs: consolidation.startedAtMs - consolidation.scheduledAtMs,
			firstPublicationMs: publicationsAtMs[0] - consolidation.startedAtMs,
			runToSleepMs: consolidation.endedAtMs - consolidation.startedAtMs,
		},
	};
}

async function submitProbes({ owner, faux, arm, prompt, clock, observed, sample }, ctx) {
	let triggerFauxAtMs;
	let probeFauxAtMs;
	let messages;
	faux.setResponses([
		(request) => {
			triggerFauxAtMs = performance.now() - clock.start;
			assert.ok(textBlocks(request.messages.findLast((message) => message.role === "user")).includes(prompt));
			return fauxAssistantMessage(answer);
		},
		(request) => {
			probeFauxAtMs = performance.now() - clock.start;
			messages = request.messages.length;
			const users = request.messages.filter((message) => message.role === "user");
			assert.equal(users.length, 2);
			assert.ok(textBlocks(users[0]).includes(prompt), "probe lost the trigger from its transcript");
			const text = textBlocks(users[1]);
			assert.equal(text.split("\n", 1)[0], probeText);
			assert.ok(text.includes("Retrieved memory evidence") && text.includes("redis deployment"));
			return fauxAssistantMessage(answer);
		},
	]);
	clock.start = performance.now();
	const trigger = await (await owner.submit(prompt, ctx)).wait(ctx);
	const triggerSettledAtMs = performance.now() - clock.start;
	assert.equal(trigger.status, "done");
	await owner.idle(ctx); // The triggering foreground lane has drained in both arms.
	const triggerTimes = {
		submitToFauxMs: triggerFauxAtMs, submitToSettledMs: triggerSettledAtMs,
		submitToIdleMs: performance.now() - clock.start,
	};

	if (arm === "active") await observed.running;
	else await observed.quiescent;
	ctx.abortSignal.throwIfAborted();
	sample("before-probe");
	const startedAtMs = performance.now() - clock.start;
	const probe = await (await owner.submit(probeText, ctx)).wait(ctx);
	const settledAtMs = performance.now() - clock.start;
	assert.equal(probe.status, "done");
	assert.equal(typeof probeFauxAtMs, "number");
	await owner.idle(ctx);
	await observed.quiescent;
	// Concurrent publication entries can make the run-end history read span another page and dispatch an empty capture.
	if (observed.probeCapture.taskId !== undefined) await observed.probeCaptureFinished;
	sample("quiescent");
	const { consolidation, publicationsAtMs } = observed;
	const hit = (ms) => consolidation.startedAtMs <= ms && ms < consolidation.endedAtMs;
	const activeAtSubmit = hit(startedAtMs);
	const activeAtFaux = hit(probeFauxAtMs);
	const publicationsDuringProbe = publicationsAtMs.filter((ms) => startedAtMs <= ms && ms <= probeFauxAtMs).length;
	if (arm === "idle")
		assert.ok(consolidation.endedAtMs <= startedAtMs, "idle probe started before consolidation slept");
	assert.equal(faux.state.callCount, 2);
	return {
		trigger, probe, triggerTimes,
		probeTimes: {
			startedAtMs, fauxAtMs: probeFauxAtMs, submitToFauxMs: probeFauxAtMs - startedAtMs,
			submitToSettledMs: settledAtMs - startedAtMs, messages, activeAtSubmit, activeAtFaux, publicationsDuringProbe,
		},
	};
}

function textBlocks(message) {
	return typeof message.content === "string" ? message.content :
		message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

// Observe only committed records. Do not gate tasks, poll SQLite, or call the owner inside Storage's adopt callback.
function observeBackground(storage, clock) {
	const running = Promise.withResolvers();
	const quiescent = Promise.withResolvers();
	const capture = {};
	const probeCapture = {};
	const probeCaptureFinished = Promise.withResolvers();
	const consolidation = {};
	const publicationsAtMs = [];
	const commit = storage.commit.bind(storage);
	storage.commit = (writes, adopt, ctx) => commit(writes, (seq) => {
		const ms = clock.start === undefined ? undefined : performance.now() - clock.start;
		adopt(seq);
		if (ms === undefined) return;
		for (const { type, value } of writes) {
			if (type === "entry" && value.kind === publicationKind) publicationsAtMs.push(ms);
			if (type !== "task") continue;
			const firstCapture = capture.taskId === undefined || capture.taskId === value.id;
			const target = value.kind === captureKind ? (firstCapture ? capture : probeCapture) :
				value.kind === consolidationKind ? consolidation : undefined;
			if (target === undefined) continue;
			target.taskId ??= value.id;
			target.scheduledAtMs ??= ms;
			const { status } = value.state;
			if (status === "running" && target.startedAtMs === undefined) {
				target.startedAtMs = ms;
				if (target === consolidation) running.resolve();
			}
			if ((status === "sleeping" || status === "terminal") && target.endedAtMs === undefined) {
				target.endedAtMs = ms;
				if (target === consolidation) quiescent.resolve();
				if (target === probeCapture) probeCaptureFinished.resolve();
			}
		}
	}, ctx);
	return {
		running: running.promise, quiescent: quiescent.promise, capture, consolidation, publicationsAtMs,
		probeCapture, probeCaptureFinished: probeCaptureFinished.promise,
	};
}

async function verifyArm(file, { observed, trigger, probe, statements, records, tail }) {
	const storage = await openNodeSqliteStorage(file);
	const session = createSession(storage);
	try {
		const state = await session.snapshot(MemoryDoc, context);
		const expectedCaptures = observed.probeCapture.taskId === undefined ? 1 : 2;
		assert.equal(Object.keys(state.captures).length, expectedCaptures);
		const captures = await storage.scanTasks({ kind: captureKind }, expectedCaptures + 1, undefined, context);
		assert.equal(captures.items.length, expectedCaptures);
		const [capture, probeCapture] = captures.items;
		assert.equal(capture.id, observed.capture.taskId);
		const generation = capture.input.generationTaskId;
		const receipt = state.captures[generation];
		assert.ok(receipt, "missing learning capture receipt");
		assert.equal(receipt.taskId, capture.id);
		assert.equal(receipt.outcome.state, "completed");
		const { memoryIds } = receipt.outcome;
		assert.equal(new Set(memoryIds).size, statements.length);
		assert.equal(memoryIds.length, statements.length);
		assert.equal(capture.background, true);
		assert.equal(capture.input.conversationId, ROOT_CONVERSATION_ID);
		assert.equal(capture.input.first, trigger.entry);
		assert.equal(capture.input.answer, trigger.answer);
		assert.deepEqual(capture.state, { status: "terminal", outcome: { status: "completed", result: { memoryIds, skipped: 0 } } });
		if (probeCapture !== undefined) {
			assert.equal(probeCapture.id, observed.probeCapture.taskId);
			assert.equal(probeCapture.background, true);
			assert.equal(probeCapture.input.first, probe.entry);
			assert.equal(probeCapture.input.answer, probe.answer);
			assert.deepEqual(probeCapture.state, {
				status: "terminal", outcome: { status: "completed", result: { memoryIds: [], skipped: 0 } },
			});
			assert.deepEqual(state.captures[probeCapture.input.generationTaskId], {
				taskId: probeCapture.id, outcome: { state: "completed", memoryIds: [] },
			});
		}
		assert.ok(MemoryInputEntry.is((await storage.entry(trigger.entry, context)).entry));
		for (const submission of [trigger, probe]) assert.deepEqual(await storage.submission(submission.id, context), submission);
		assert.equal((await storage.scanSubmissions({}, 3, undefined, context)).items.length, 2);
		const captureTiming = observed.capture;
		assert.ok(captureTiming.scheduledAtMs <= captureTiming.startedAtMs && captureTiming.startedAtMs <= captureTiming.endedAtMs,
			"capture must be queued, run and finish in that order");
		const consolidations = await storage.scanTasks({ kind: consolidationKind }, 2, undefined, context);
		assert.equal(consolidations.items.length, 1);
		const [consolidation] = consolidations.items;
		assert.deepEqual(state.consolidation, { state: "scheduled", taskId: observed.consolidation.taskId });
		assert.equal(consolidation.id, state.consolidation.taskId);
		assert.equal(consolidation.background, true);
		assert.equal(consolidation.state.status, "sleeping");
		assert.deepEqual(consolidation.state.checkpoint, { phase: "select" });
		const expectedBatches = Math.floor((statements.length - 100) / 50) + 1;
		const expectedConsolidated = expectedBatches * 50;
		assert.equal(observed.publicationsAtMs.length, expectedBatches);
		const timing = observed.consolidation;
		assert.ok(captureTiming.endedAtMs <= timing.startedAtMs && timing.scheduledAtMs <= timing.startedAtMs,
			"consolidation must start after scheduling and after capture finishes");
		assert.ok(observed.publicationsAtMs.every((ms) => timing.startedAtMs <= ms && ms < timing.endedAtMs),
			"publications must occur between consolidation start and sleep");
		const entries = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, expectedBatches + 20, undefined, context);
		assert.equal(entries.next, undefined);
		const publications = entries.items.filter((entry) => entry.kind === publicationKind);
		assert.equal(publications.length, expectedBatches);
		const summaryIds = publications.flatMap((entry) => entry.data.ids);
		assert.equal(new Set(summaryIds).size, summaryIds.length);
		const summarized = new Set();
		const captured = new Set(memoryIds);
		for (const id of summaryIds) {
			const summary = state.records[id];
			assert.equal(summary?.state, "live", `publication must refer to a live summary: ${id}`);
			assert.equal(summary.tier.kind, "episodic");
			assert.equal(summary.provenance.derivation, "summary");
			for (const source of summary.tier.summaryOf) {
				assert.ok(captured.has(source.id) && !summarized.has(source.id));
				const record = state.records[source.id];
				assert.equal(record?.state, "live", `summary must refer to a live source: ${source.id}`);
				assert.equal(source.revision, record.revision);
				assert.ok(summary.content.includes(`[${source.id}] ${record.content}`));
				assert.deepEqual(record.tier.consolidation, { state: "done", summaryIds: [id] });
				summarized.add(source.id);
			}
		}
		assert.equal(summarized.size, expectedConsolidated);
		for (const [ordinal, id] of memoryIds.entries()) {
			const key = `capture:${generation}:${trigger.entry}:${ordinal}`;
			assert.deepEqual(state.receipts[key], { kind: "remember", memoryId: id });
			const record = state.records[id];
			assert.equal(record?.state, "live", `capture must refer to a live record: ${id}`);
			assert.equal(record.content, statements[ordinal]);
			assert.equal(record.tier.kind, "working");
			assert.deepEqual(record.provenance, {
				origin: "user", conversationId: ROOT_CONVERSATION_ID, entryIds: [trigger.entry], derivation: "capture",
			});
			if (!summarized.has(id)) assert.deepEqual(record.tier.consolidation, { state: "pending" });
		}
		assert.equal(Object.keys(state.records).length, records + statements.length + summaryIds.length, "unexpected reopened record count");
		assert.equal(Object.keys(state.receipts).length, records + tail + statements.length);
		assert.deepEqual(await session.snapshot(MemoryRelationsDoc, context), { relations: {} });
		return {
			triggerSubmissionId: trigger.id, triggerEntryId: trigger.entry, probeSubmissionId: probe.id,
			captureReceipts: expectedCaptures, emptyProbeCaptures: expectedCaptures - 1,
			captured: memoryIds.length, publicationBatches: publications.length,
			summaries: summaryIds.length, consolidated: summarized.size, pending: memoryIds.length - summarized.size,
			consolidationStatus: consolidation.state.status,
		};
	} finally {
		await session.close(context);
	}
}
