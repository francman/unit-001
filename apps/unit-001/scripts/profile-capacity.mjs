#!/usr/bin/env node
// Measures a fresh faux-provider owner, persisted memory replay and foreground requests without changing latency gates.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { forgetMemory, MemoryDoc, rememberMemory } from "unit-memory";
import { Agent } from "../dist/agent.js";

const { values } = parseArgs({
	options: {
		records: { type: "string" },
		tail: { type: "string", default: "63" },
		out: { type: "string" },
	},
});
const count = Number(values.records),
	tail = Number(values.tail);
if (
	!Number.isSafeInteger(count) ||
	count < 1 ||
	count > 50000 ||
	!Number.isInteger(tail) ||
	tail < 0 ||
	tail > 63 ||
	values.out === undefined
)
	throw new Error("Usage: profile-capacity.mjs --records 1..50000 --tail 0..63 --out RESULT.json");
const directory = await mkdtemp(join(tmpdir(), "unit-capacity-"));
const file = join(directory, "state.sqlite");
const phases = [];
const record = (name, fields) => {
	const value = {
		name,
		observedAt: new Date().toISOString(),
		rss: process.memoryUsage().rss,
		peakRss: process.resourceUsage().maxRSS * 1024,
		...fields,
	};
	phases.push(value);
	console.log(JSON.stringify(value));
};
try {
	const seed = createSession(await openNodeSqliteStorage(file));
	try {
		const started = performance.now();
		await seed.commit(async (tx) => {
			const state = await tx.doc(MemoryDoc);
			for (let index = 0; index < count; index++)
				rememberMemory(state, {
					writeKey: `capacity:${index}`,
					content: `redis deployment ${index}: ${"bounded evidence ".repeat(30)}`,
					now: Date.now(),
					provenance: { origin: "user", conversationId: 1, entryIds: [], derivation: "explicit" },
				});
		}, context);
		record("seed", { elapsedMs: performance.now() - started, count });
		const commits = [];
		for (let index = 0; index < tail; index++) {
			const start = performance.now();
			await seed.commit(
				async (tx) => forgetMemory(await tx.doc(MemoryDoc), { writeKey: `tail:${index}`, id: "absent" }),
				context,
			);
			commits.push(performance.now() - start);
		}
		record("receipt-delta-tail", { tail, samplesMs: commits });
	} finally {
		await seed.close(context);
	}
	const replay = [];
	for (let index = 0; index < 30; index++) {
		const started = performance.now();
		const session = createSession(await openNodeSqliteStorage(file));
		try {
			assert.equal(Object.keys((await session.snapshot(MemoryDoc, context)).records).length, count);
		} finally {
			await session.close(context);
		}
		if (index >= 5) replay.push(performance.now() - started);
	}
	record("storage-open-snapshot-close", { ...summarize(replay), samplesMs: replay });
	const faux = fauxProvider(),
		models = createModels();
	models.setProvider(faux.provider);
	const startup = [];
	for (let index = 0; index < 6; index++) {
		const copy = join(directory, `owner-${index}.sqlite`);
		await copyFile(file, copy);
		const started = performance.now();
		const agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(copy),
				models,
				model: { provider: "faux", modelId: "faux-1" },
				cwd: directory,
			},
			context,
		);
		startup.push(performance.now() - started);
		await agent.close(context);
		await rm(copy);
	}
	assert.equal(faux.state.callCount, 0);
	record("owner-startup", { samplesMs: startup, firstMs: startup[0], warm: summarize(startup.slice(1)) });
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(file),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
		},
		context,
	);
	try {
		const samples = [];
		let firstMs;
		for (let index = 0; index < 31; index++) {
			let elapsed;
			faux.setResponses([
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
		assert.equal(faux.state.callCount, 31);
		record("foreground-submit-to-provider", {
			firstMs,
			...summarize(samples),
			samplesMs: samples,
			fauxCalls: faux.state.callCount,
		});
	} finally {
		await agent.close(context);
	}
	let diskBytes = 0;
	for (const name of await readdir(directory)) diskBytes += (await stat(join(directory, name))).size;
	record("closed-storage", { diskBytes });
	const cgroup = {};
	let cgroupDirectory = null;
	try {
		const membership = (await readFile("/proc/self/cgroup", "utf8"))
			.split("\n")
			.find((line) => line.startsWith("0::"));
		if (membership !== undefined) cgroupDirectory = join("/sys/fs/cgroup", membership.slice(3));
	} catch (error) {
		if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
	}
	for (const name of [
		"memory.max",
		"memory.peak",
		"memory.swap.max",
		"memory.swap.current",
		"memory.swap.peak",
		"memory.events",
		"io.stat",
	]) {
		if (cgroupDirectory === null) {
			cgroup[name] = null;
			continue;
		}
		try {
			cgroup[name] = (await readFile(join(cgroupDirectory, name), "utf8")).trim();
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
			cgroup[name] = null;
		}
	}
	await writeFile(
		resolve(values.out),
		`${JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, node: process.version, count, tail, phases, cgroupDirectory, cgroup }, null, 2)}\n`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}

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
