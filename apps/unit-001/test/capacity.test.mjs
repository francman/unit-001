// Runs the capacity profiler and matrix driver against actual SQLite and the faux provider in small isolated fixtures.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createSession, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryDoc, MemoryInputEntry, MemoryInputsDoc } from "unit-memory";
import { Agent } from "../dist/agent.js";
import {
	checkPreflight,
	globToRegExp,
	outputDirectoryProblem,
	parseMeminfo,
	resolveCells,
	resolveRuns,
	scrubbedEnvironment,
	tmpParentProblem,
	unitOomLines,
	untrustedCodePaths,
} from "../scripts/run-capacity-matrix.mjs";

const profiler = fileURLToPath(new URL("../scripts/profile-capacity.mjs", import.meta.url));
const driver = fileURLToPath(new URL("../scripts/run-capacity-matrix.mjs", import.meta.url));
const defaultMatrix = fileURLToPath(new URL("../scripts/capacity-matrix.default.json", import.meta.url));
const MIB = 1024 * 1024;

function scratch(t) {
	const directory = mkdtempSync(join(tmpdir(), "unit-capacity-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function profile(args, options = {}) {
	return spawnSync(process.execPath, [profiler, ...args], { encoding: "utf8", timeout: 60_000, ...options });
}

function phase(report, name) {
	return report.phases.find((entry) => entry.name === name);
}

function digest(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// #64: a profiler result must cover actual replay and requests, not only an in-memory memory index.
for (const relations of [0, 9]) {
	test(`profiles persisted replay, startup and 31 faux requests with ${relations} relations`, (t) => {
		const directory = scratch(t);
		const output = join(directory, "result.json");
		const result = profile([
			"--records",
			"10",
			...(relations === 0 ? [] : ["--relations", String(relations)]),
			"--tail",
			"3",
			"--out",
			output,
		]);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(report.count, 10);
		assert.equal(report.relations, relations);
		assert.equal(report.relationTopology, relations === 0 ? "none" : "supports-chain");
		assert.equal(phase(report, "seed").relations, relations);
		assert.equal(phase(report, "storage-open-snapshot-close").relations, relations);
		assert.equal(report.tail, 3);
		assert.ok(report.phases.every((entry) => entry.rss > 0 && entry.peakRss > 0));
		assert.equal(phase(report, "receipt-delta-tail").samplesMs.length, 3);
		assert.equal(phase(report, "storage-open-snapshot-close").samplesMs.length, 25);
		const requests = phase(report, "foreground-submit-to-provider");
		assert.equal(requests.fauxCalls, 31);
		assert.equal(requests.samplesMs.length, 25);
		assert.ok(phase(report, "closed-storage")?.diskBytes > 0 || report.diskPhases.at(-1).directoryBytes > 0);
	});
}

// #64: schemaVersion 2 keeps the v1 fields and adds host, sampler, disk and status evidence.
test("writes schema v2 evidence: status, host, samples and per-phase disk with WAL", (t) => {
	const directory = scratch(t);
	const output = join(directory, "result.json");
	const result = profile(["--records", "50", "--tail", "3", "--sample-ms", "10", "--out", output]);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.schemaVersion, 2);
	assert.equal(report.status, "complete");
	assert.deepEqual(report.phasesRequested, ["seed", "replay", "startup", "foreground"]);
	for (const field of ["platform", "arch", "node", "count", "relations", "relationTopology", "tail", "phases", "cgroup"])
		assert.ok(field in report, `v1 field ${field} kept`);
	assert.ok(report.host.cpuCount > 0 && report.host.totalMemory > 0 && report.host.heapSizeLimit > 0);
	assert.equal(report.host.sqliteAdapter.journalMode, "WAL");
	assert.ok(report.samples.length >= 4);
	assert.ok(report.samples.every((sample) => sample.rss > 0 && sample.heapUsed > 0 && typeof sample.phase === "string"));
	const labels = report.diskPhases.map((entry) => entry.phase);
	assert.deepEqual(labels.slice(0, 2), ["seed-open", "seed-closed"]);
	assert.ok(labels.includes("foreground-open") && labels.at(-1) === "final");
	const open = report.diskPhases.find((entry) => entry.phase === "seed-open");
	// The adapter runs WAL: while the writer is open the log holds the data, and close truncates it.
	assert.equal(open.sqlite.journalMode, "wal");
	assert.ok(open.files["state.sqlite-wal"] > 0);
	assert.equal(report.diskPhases.find((entry) => entry.phase === "seed-closed").files["state.sqlite-wal"], null);
	assert.ok(open.sqlite.pageCount > 0 && open.sqlite.pageSize > 0 && open.sqlite.freelistCount >= 0);
	assert.ok(open.sqlite.revisions.some((entry) => entry.kind === "base"));
	if (process.platform === "linux") {
		for (const entry of report.phases) assert.ok(entry.proc.vmHWM > 0 && entry.proc.rssAnon > 0);
		assert.ok(report.samples.every((sample) => sample.vmRSS > 0));
		assert.equal(typeof open.filesystem.fsType, "string");
	} else {
		// Linux-only readers degrade instead of throwing.
		for (const entry of report.phases) assert.equal(entry.proc, "unavailable");
		assert.equal(report.host.meminfo, "unavailable");
	}
});

// #64: a fixture seeded by one process is measured by another without being modified.
test("keeps a seeded fixture and measures it from a separate process on a copy", (t) => {
	const directory = scratch(t);
	const fixture = join(directory, "fixture");
	const seeded = profile(["--records", "50", "--relations", "9", "--tail", "3", "--keep", fixture, "--out", join(directory, "seed.json")]);
	assert.equal(seeded.status, 0, seeded.stderr);
	const seedReport = JSON.parse(readFileSync(join(directory, "seed.json"), "utf8"));
	assert.deepEqual(seedReport.phasesRequested, ["seed"]);
	assert.equal(JSON.parse(readFileSync(join(fixture, "fixture.json"), "utf8")).relations, 9);
	const before = digest(join(fixture, "state.sqlite"));
	const output = join(directory, "measure.json");
	const measured = profile(["--reuse", fixture, "--out", output]);
	assert.equal(measured.status, 0, measured.stderr);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.status, "complete");
	assert.equal(report.fixtureSource, fixture);
	assert.equal(report.count, 50);
	assert.equal(report.relations, 9);
	assert.deepEqual(report.phasesRequested, ["replay", "startup", "foreground"]);
	assert.equal(phase(report, "foreground-submit-to-provider").fauxCalls, 31);
	assert.equal(phase(report, "seed"), undefined);
	assert.equal(digest(join(fixture, "state.sqlite")), before);
});

// #64: tombstones stay in the document; replay checks total and live counts and the dense hub topology.
test("seeds forgotten records and dense relation hubs and verifies exact counts", (t) => {
	const directory = scratch(t);
	const output = join(directory, "result.json");
	const result = profile([
		"--records",
		"80",
		"--relations",
		"40",
		"--topology",
		"dense",
		"--forgotten",
		"20",
		"--tail",
		"2",
		"--phases",
		"seed,replay",
		"--out",
		output,
	]);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.relationTopology, "supports-hubs");
	assert.equal(report.forgotten, 20);
	assert.equal(phase(report, "seed-forgotten").forgotten, 20);
	assert.equal(phase(report, "storage-open-snapshot-close").forgotten, 20);
	assert.equal(phase(report, "foreground-submit-to-provider"), undefined);
});

// #64: mutation defaults must not run the owner against the mutation fixture.
for (const [mix, total] of [
	["remember-heavy", 6],
	["forget-heavy", 6],
	["mixed", 20],
]) {
	test(`mutates under ${mix}, then reopens with exact counts`, (t) => {
		const directory = scratch(t);
		const output = join(directory, "result.json");
		const result = profile([
			"--records",
			"50",
			"--tail",
			"3",
			...(mix === "mixed" ? [] : ["--phases", "seed,mutate"]),
			"--mutate",
			mix,
			"--mutate-interval-ms",
			"0",
			"--mutate-ops",
			String(total),
			"--out",
			output,
		]);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(readFileSync(output, "utf8"));
		assert.deepEqual(report.phasesRequested, ["seed", "mutate"]);
		const mutate = phase(report, "mutate");
		assert.equal(mutate.remember + mutate.forget + mutate.recall, total);
		assert.equal(mutate.ops.length, total);
		if (mix === "remember-heavy") assert.equal(mutate.remember, total);
		if (mix === "forget-heavy") assert.equal(mutate.forget, total);
		if (mix === "mixed") assert.ok(mutate.remember > 0 && mutate.forget > 0 && mutate.recall > 0);
		assert.ok(mutate.ops.every((entry) => entry.ms >= 0 && entry.maxRssBytes > 0));
		assert.equal(mutate.checkpointProbe, "revision-table");
		assert.equal(phase(report, "mutate-reopen").samplesMs.length, 10);
		assert.ok(report.diskPhases.some((entry) => entry.phase === "mutate-closed"));
	});
}

// #64: a run that fails mid-way still leaves its last completed phases and the error.
test("a failed run leaves partial evidence with status failed", (t) => {
	const directory = scratch(t);
	const fixture = join(directory, "fixture");
	const seeded = profile(["--records", "50", "--tail", "1", "--keep", fixture, "--out", join(directory, "seed.json")]);
	assert.equal(seeded.status, 0, seeded.stderr);
	// Claim one more record than the database holds, so replay verification fails.
	const manifest = JSON.parse(readFileSync(join(fixture, "fixture.json"), "utf8"));
	writeFileSync(join(fixture, "fixture.json"), JSON.stringify({ ...manifest, records: 51 }));
	const output = join(directory, "failed.json");
	const result = profile(["--reuse", fixture, "--phases", "replay", "--out", output]);
	assert.notEqual(result.status, 0);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.status, "failed");
	assert.match(report.error, /AssertionError|Expected values/);
	assert.equal(report.currentPhase, "replay");
	assert.ok(phase(report, "fixture-copy"));
});

// #64: invalid workload sizes fail before a profile or database is created.
test("refuses invalid workload, phase, fixture and mutation options", () => {
	for (const args of [
		["--records", "0"],
		["--records", "1000", "--tail", "64"],
		["--records", "10", "--relations=-1"],
		["--records", "10", "--relations", "1.5"],
		["--records", "10", "--relations", "10"],
		["--records", "5000", "--relations", "4097"],
		["--records", "10", "--forgotten", "11"],
		["--records", "10", "--relations", "5", "--forgotten", "5"],
		// Dense needs one hub per 32 relations on top of the relation-bearing records.
		["--records", "10", "--relations", "10", "--topology", "dense"],
		["--records", "10", "--topology", "star"],
		["--records", "10", "--phases", "seed,bogus"],
		["--records", "10", "--phases", "replay"],
		["--records", "10", "--keep", "/not-used/fixture", "--phases", "seed,replay"],
		["--records", "10", "--keep", "/not-used/a", "--reuse", "/not-used/b"],
		["--reuse", "/not-used/missing"],
		["--records", "10", "--phases", "seed,mutate"],
		["--records", "10", "--phases", "seed,foreground,mutate", "--mutate", "mixed", "--mutate-ops", "3"],
		["--records", "10", "--mutate", "mixed"],
		["--records", "10", "--phases", "seed,mutate", "--mutate", "chaos", "--mutate-ops", "3"],
		["--records", "10", "--mutate-ops", "3"],
		["--records", "10", "--phases", "seed,mutate", "--mutate", "mixed", "--mutate-ops", "0"],
	]) {
		const result = profile([...args, "--out", "/not-used/result.json"], { timeout: 10_000 });
		assert.equal(result.status, 1, args.join(" "));
		assert.match(result.stderr, /Usage: profile-capacity/, args.join(" "));
	}
});

// #64: the default matrix is the research list scaled to the 412 MB host, every enabled cell is a valid profiler workload, and disabled cells say why.
test("default matrix lists the research cells with valid workloads", () => {
	const matrix = JSON.parse(readFileSync(defaultMatrix, "utf8"));
	const ids = matrix.cells.map((cell) => cell.id);
	assert.equal(new Set(ids).size, ids.length);
	const resolved = matrix.cells.map((cell) => ({ ...matrix.defaults, ...cell }));
	const enabled = resolved.filter((cell) => cell.disabled === undefined);
	assert.ok(enabled.length >= 20 && enabled.length <= 30, `${enabled.length} enabled cells`);
	for (const cell of resolved.filter((entry) => entry.disabled !== undefined)) assert.ok(cell.disabled.length > 10);
	for (const cell of enabled) {
		const hubs = cell.topology === "dense" ? Math.ceil(cell.relations / 32) : 0;
		const footprint = cell.relations === 0 ? 0 : cell.topology === "dense" ? hubs + cell.relations : cell.relations + 1;
		assert.ok(cell.records >= 1 && cell.records <= 50000, cell.id);
		assert.ok(cell.relations <= 4096 && footprint <= cell.records, cell.id);
		assert.ok(cell.forgotten <= cell.records - footprint && cell.tail >= 0 && cell.tail <= 63, cell.id);
		assert.ok(cell.mutate === undefined || cell.durationS > 0 || cell.mutateOps > 0, cell.id);
	}
	for (const records of [1000, 2500, 5000, 10000, 20000, 30000])
		for (const swap of ["swap0", "swap256m"]) assert.ok(ids.includes(`records-${records}-${swap}`));
	const dryRun = spawnSync(process.execPath, [driver, "--out-dir", "/not-used", "--dry-run"], { encoding: "utf8", timeout: 30_000 });
	assert.equal(dryRun.status, 0, dryRun.stderr);
	const lines = dryRun.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines[0].hostClass, matrix.hostClass);
	assert.equal(lines.filter((line) => line.skipped !== undefined).length, ids.length - enabled.length);
	assert.equal(lines.filter((line) => line.step === "seed").length, enabled.length);
});

test("dry run prints the exact systemd-run command for an explicit scope", () => {
	const result = spawnSync(
		process.execPath,
		[driver, "--out-dir", "/not-used", "--dry-run", "--scope", "user", "--only", "records-1000-swap256m"],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(result.status, 0, result.stderr);
	const seed = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.find((line) => line.step === "seed");
	assert.deepEqual(seed.command.slice(0, 2), ["systemd-run", "--user"]);
	for (const part of ["--scope", "MemoryMax=224M", "MemoryHigh=200M", "MemorySwapMax=256M"]) assert.ok(seed.command.includes(part), part);
	// #64 L6: a non-interactive run must never wait for a polkit password.
	assert.ok(seed.command.includes("--no-ask-password"));
});

// #64: the driver writes one JSON per cell with exit status, limit status and the profiler result, and says when limits are not enforced.
test("matrix driver runs split and single cells and records evidence, falling back without systemd-run", (t) => {
	const directory = scratch(t);
	const matrix = join(directory, "matrix.json");
	writeFileSync(
		matrix,
		JSON.stringify({
			name: "tiny",
			defaults: { records: 50, tail: 3, memoryMax: "192M", memoryHigh: "180M", swapMax: "0" },
			cells: [
				{ id: "tiny-split", mutate: "mixed", mutateOps: 6, mutateIntervalMs: 0 },
				{ id: "tiny-single", split: false, relations: 9, forgotten: 5 },
				{ id: "tiny-single-mutate", split: false, mutate: "mixed", mutateOps: 6, mutateIntervalMs: 0 },
				{ id: "tiny-disabled", disabled: "not implemented in this harness" },
			],
		}),
	);
	const outDir = join(directory, "out");
	const result = spawnSync(
		process.execPath,
		// The preflight is covered below; this test is about the evidence, and a small CI host or a tmpfs must not fail it.
		[driver, "--matrix", matrix, "--out-dir", outDir, "--tmpdir", join(directory, "tmp"), "--allow-overcommit"],
		{ encoding: "utf8", timeout: 120_000 },
	);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
	assert.deepEqual(
		manifest.cells.map((cell) => `${cell.id}:${cell.status}`),
		["tiny-split:complete", "tiny-single:complete", "tiny-single-mutate:complete", "tiny-disabled:skipped"],
	);
	assert.ok(manifest.finishedAt && manifest.host.platform === process.platform && "sha" in manifest.git);
	const split = JSON.parse(readFileSync(join(outDir, "tiny-split.json"), "utf8"));
	assert.deepEqual(
		split.steps.map((step) => `${step.step}:${step.status}:${step.exitCode}`),
		["seed:complete:0", "measure:complete:0"],
	);
	assert.ok(split.host.commands["uname -a"]);
	assert.equal(split.steps[1].profile.status, "complete");
	assert.deepEqual(split.steps[1].profile.phasesRequested, ["mutate"]);
	assert.equal(phase(split.steps[1].profile, "mutate-reopen").samplesMs.length, 10);
	assert.equal(typeof split.steps[0].oom.suspected, "boolean");
	assert.equal(split.steps[0].oom.suspected, false);
	if (split.limits.scope.kind === "none") {
		// Without systemd-run the driver must run unlimited and say so everywhere.
		assert.match(result.stderr, /NOT enforced/);
		assert.equal(split.limits.enforced, false);
		assert.equal(split.steps[1].limit.enforced, false);
		assert.ok(split.steps[1].limit.reason.length > 0);
		assert.deepEqual(split.steps[1].command.slice(0, 1), [process.execPath]);
	} else assert.equal(split.steps[1].command[0], "systemd-run");
	const single = JSON.parse(readFileSync(join(outDir, "tiny-single.json"), "utf8"));
	assert.equal(single.steps.length, 1);
	assert.deepEqual(single.steps[0].profile.phasesRequested, ["seed", "replay", "startup", "foreground"]);
	assert.equal(phase(single.steps[0].profile, "foreground-submit-to-provider").fauxCalls, 31);
	assert.equal(single.steps[0].profile.relations, 9);
	assert.equal(single.steps[0].profile.forgotten, 5);
	const singleMutation = JSON.parse(readFileSync(join(outDir, "tiny-single-mutate.json"), "utf8"));
	assert.equal(singleMutation.steps.length, 1);
	assert.deepEqual(singleMutation.steps[0].profile.phasesRequested, ["seed", "mutate"]);
	assert.equal(phase(singleMutation.steps[0].profile, "mutate-reopen").samplesMs.length, 10);
	const skipped = JSON.parse(readFileSync(join(outDir, "tiny-disabled.json"), "utf8"));
	assert.equal(skipped.status, "skipped");
	assert.equal(skipped.reason, "not implemented in this harness");
});

// #64: the shipped tail-62 cell must cross the seeded boundary without a foreground write.
test("selected checkpoint-boundary cell checkpoints on the second remember and reopens exactly", (t) => {
	const directory = scratch(t);
	const id = "mutate-5000-checkpoint-boundary";
	const result = spawnSync(
		process.execPath,
		[driver, "--only", id, "--out-dir", directory, "--tmpdir", directory, "--scope", "none", "--allow-overcommit"],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
	assert.deepEqual(manifest.cells.map((cell) => cell.id), [id]);
	const cell = JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
	assert.equal(cell.status, "complete");
	const [seed, measured] = cell.steps;
	assert.equal(phase(seed.profile, "receipt-delta-tail").tail, 62);
	assert.deepEqual(measured.profile.phasesRequested, ["mutate"]);
	const mutate = phase(measured.profile, "mutate");
	assert.equal(mutate.checkpointProbe, "revision-table");
	assert.equal(mutate.remember, 3);
	assert.equal(mutate.checkpoints, 1);
	// The first remember brings the tail to 63 deltas; the next writes the new base.
	assert.deepEqual(mutate.ops.map((entry) => entry.checkpoint), [false, true, false]);
	assert.equal(phase(measured.profile, "mutate-reopen").samplesMs.length, 10);
});

// #64: all arms start from one closed baseline, and normal owner activity never lands on the grown artifacts.
test("growth fixtures isolate settled chat, capture bookkeeping and the zero control", async (t) => {
	const directory = scratch(t);
	const matrix = join(directory, "matrix.json");
	const out = join(directory, "out");
	const turns = 264;
	const cycles = 65;
	writeFileSync(matrix, JSON.stringify({
		defaults: { records: 8, tail: 63 },
		cells: [
			{ id: "control", settledTurns: 0 },
			{ id: "chat", settledTurns: turns, queryChars: 2000 },
			{ id: "churn", captureCycles: cycles },
		],
	}));
	const result = spawnSync(process.execPath, [
		driver, "--matrix", matrix, "--out-dir", out, "--tmpdir", directory, "--scope", "none",
		"--keep-fixtures", "--min-free-disk-mb", "0",
	], { encoding: "utf8", timeout: 120_000 });
	const cell = (id) => JSON.parse(readFileSync(join(out, `${id}.json`), "utf8"));
	if (result.status !== 0) {
		const errors = ["control", "chat", "churn"].flatMap((id) =>
			existsSync(join(out, `${id}.json`)) ? cell(id).steps.map((step) => step.stderrTail) : []);
		assert.fail(`${result.error ?? result.status}\n${result.stderr}\n${errors.join("\n")}`);
	}
	for (const [id, settled, churn] of [["control", 0, 0], ["chat", turns, 0], ["churn", 0, cycles]]) {
		const { steps } = cell(id);
		assert.deepEqual(steps.map((step) => step.step), ["seed", "grow", "fixture-check", "replay", "startup", "probe"]);
		assert.equal(steps[0].sharedFrom, id === "control" ? undefined : "control");
		const [seed, grow, check, replay, startup, probe] = steps.map((step) => step.profile);
		assert.equal(grow.fixtureSource, seed.directory);
		for (const profile of [check, replay, startup, probe]) assert.equal(profile.fixtureSource, grow.directory);
		const counts = phase(check, "fixture-counts");
		assert.deepEqual(
			[counts.live, counts.relations, counts.tombstones, counts.writeReceipts, counts.completedCaptures],
			[8, 0, churn, 71 + 2 * churn, churn],
		);
		assert.deepEqual(
			[counts.inputMetadata, counts.queryBytes, counts.transcriptEntries, counts.settledInputs, counts.memoryTasks],
			[settled, settled * 2000, 2 * settled, settled, 0],
		);
		assert.equal(counts.writeReceiptRetry, churn > 0 ? "verified" : "not applicable");
		const raw = readFileSync(grow.operationLog, "utf8").trim();
		const operations = raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line));
		assert.equal(operations.length, settled + churn);
		const commits = phase(grow, "fixture-commits");
		assert.equal(commits.ordinary.count + commits.checkpoints.count, operations.length);
		const disk = grow.diskPhases.find((entry) => entry.phase === "fixture-writer-closed");
		assert.equal(disk.sqlite.entries, 2 * settled);
		assert.ok(disk.sqlite.entryBytes >= settled * 2000);
		for (const kind of ["unit.memory", "unit.memory.inputs", "unit.memory.relations"]) {
			const base = disk.sqlite.revisionsByDocument.find((entry) => entry.documentKind === kind && entry.kind === "base");
			assert.equal(base.version, 1);
			if (kind === commits.documentKind) assert.equal(base.lastSeq, commits.finalBaseSeq);
		}
		assert.equal(disk.files["state.sqlite-wal"], null);
		if (id === "control")
			assert.equal(digest(join(grow.directory, "state.sqlite")), digest(join(seed.directory, "state.sqlite")));
		if (id === "churn")
			assert.deepEqual(operations.filter((entry) => entry.checkpoint).map((entry) => entry.op), [1, 65]);
		if (id === "chat") {
			assert.ok(counts.first.input < counts.last.input && counts.last.input < counts.last.answer);
			assert.deepEqual(operations.filter((entry) => entry.checkpoint).map((entry) => entry.op), [64, 128, 192, 256]);
		}
		assert.equal(phase(replay, "fixture-open-snapshots").samplesMs.length, 25);
		assert.equal(phase(startup, "owner-startup").samplesMs.length, 6);
		const requests = phase(probe, "fixture-submit-to-chat");
		assert.equal(requests.answered, 31);
		assert.equal(requests.samplesMs.length, 25);
		assert.ok(requests.observations.every((entry) => id === "chat" ? entry.compactionCallsMs.length > 0 : entry.compactionCallsMs.length === 0));
		const storage = await openNodeSqliteStorage(join(grow.directory, "state.sqlite"));
		try {
			assert.equal((await storage.scanTasks({}, 1, undefined, context)).items.length, 0);
			assert.equal((await storage.scanSubmissions({}, settled + 1, undefined, context)).items.length, settled);
		} finally {
			await storage.close(context);
		}
	}

	const control = cell("control").steps[1].profile.directory;
	const real = join(directory, "real-admission.sqlite");
	copyFileSync(join(control, "state.sqlite"), real);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const open = async () => Agent.open({
		storage: await openNodeSqliteStorage(real), cwd: directory, models, model: { provider: "faux", modelId: "faux-1" },
	}, context);
	const query = "Describe the numbered sample 00000: " + "x".repeat(1964);
	const answer = "Acknowledged.";
	const request = { requestId: "capacity-fixture-retry" };
	faux.setResponses([fauxAssistantMessage(answer), fauxAssistantMessage(answer)]);
	let owner = await open();
	let unkeyed;
	let keyed;
	try {
		unkeyed = await (await owner.submit(query, context)).wait(context);
		await owner.idle(context);
		keyed = await (await owner.submit(query, context, request)).wait(context);
		await owner.idle(context);
	} finally {
		await owner.close(context);
	}
	owner = await open();
	try {
		const retried = await (await owner.submit(query, context, request)).wait(context);
		assert.deepEqual([retried.id, retried.answer], [keyed.id, keyed.answer]);
		await assert.rejects(owner.submit(`${query}!`, context, request), /different|conflict/i);
		await owner.idle(context);
		assert.equal(faux.state.callCount, 2);
	} finally {
		await owner.close(context);
	}
	const storage = await openNodeSqliteStorage(real);
	const session = createSession(storage);
	try {
		const metadata = await session.snapshot(MemoryInputsDoc, ROOT_CONVERSATION_ID, context);
		assert.deepEqual(metadata.inputs, { [unkeyed.id]: { origin: "human", query }, [keyed.id]: { origin: "human", query } });
		assert.deepEqual((await storage.scanSubmissions({}, 3, undefined, context)).items.map((entry) => entry.id), [unkeyed.id, keyed.id]);
		for (const submission of [unkeyed, keyed]) {
			assert.equal(submission.status, "done");
			const input = (await storage.entry(submission.entry, context)).entry;
			const reply = (await storage.entry(submission.answer, context)).entry;
			assert.ok(MemoryInputEntry.is(input) && AssistantEntry.is(reply));
			assert.deepEqual(input.data, { origin: "human" });
			assert.equal(input.model[0].content, query);
			assert.equal(reply.model[0].content[0].text, answer);
		}
		const memory = await session.snapshot(MemoryDoc, context);
		assert.deepEqual(memory.captures, {});
		assert.equal(memory.revision, 71);
	} finally {
		await session.close(context);
	}
});

test("growth fixture matrix rejects incompatible workload options", () => {
	for (const fields of [
		{ settledTurns: 3 },
		{ settledTurns: 1, queryChars: 2001 },
		{ settledTurns: 0, captureCycles: 0 },
		{ captureCycles: "1" },
		{ captureCycles: 5, mutate: "mixed" },
		{ captureCycles: 1, seedUnderLimit: false },
	]) assert.throws(() => resolveCells({ cells: [{ id: "invalid", ...fields }] }), /cell "invalid"/);
});

// codex-15: every manifest row owns one result file and one set of raw outputs.
test("matrix run IDs are resolved before work and never overwrite each other or the manifest", () => {
	const cells = (...entries) => resolveCells({ cells: entries.map((id) => (typeof id === "string" ? { id } : id)) });
	assert.deepEqual(
		resolveRuns(cells("a", "b"), 2).map(({ id, run, cell }) => [id, run, cell.id]),
		[["a.r1", 1, "a"], ["a.r2", 2, "a"], ["b.r1", 1, "b"], ["b.r2", 2, "b"]],
	);
	assert.deepEqual(resolveRuns(cells("a", "a.r1"), 2).map(({ id }) => id), ["a.r1", "a.r2", "a.r1.r1", "a.r1.r2"]);
	assert.deepEqual(resolveRuns(cells("a"), undefined).map(({ id }) => id), ["a"]);
	for (const entries of [
		[{ id: "a", repeat: 2 }, "a.r1"],
		["a", "a"],
		["A", "a"],
		["manifest"],
		["Manifest"],
	])
		assert.throws(() => resolveRuns(cells(...entries), undefined), /collides/, JSON.stringify(entries));
	for (const repeat of [0, -1, 1.5])
		assert.throws(() => resolveCells({ cells: [{ id: "invalid", repeat }] }), /repeat must be a positive integer/);
});

test("matrix driver reports a failed cell and --require-scope refuses to run unlimited", (t) => {
	const directory = scratch(t);
	const matrix = join(directory, "matrix.json");
	writeFileSync(matrix, JSON.stringify({ name: "bad", cells: [{ id: "bad-cell", records: 10, relations: 10 }] }));
	const failed = spawnSync(
		process.execPath,
		[driver, "--matrix", matrix, "--out-dir", join(directory, "out"), "--scope", "none", "--allow-overcommit"],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(failed.status, 1);
	const cell = JSON.parse(readFileSync(join(directory, "out", "bad-cell.json"), "utf8"));
	assert.equal(cell.status, "failed-in-seed");
	assert.match(cell.steps[0].stderrTail, /Usage: profile-capacity/);
	const refused = spawnSync(
		process.execPath,
		[driver, "--matrix", defaultMatrix, "--out-dir", join(directory, "out2"), "--scope", "none", "--require-scope", "--only", "records-1000-swap0"],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /--require-scope/);
});

// ---- #64 security and correctness fixes (sec-ops H1, M3 to M6, L4 to L6) -------------------------------------

function meminfoFile(directory, { totalMiB, availableMiB, swapFreeMiB = 1024 }) {
	const path = join(directory, "meminfo");
	writeFileSync(path, `MemTotal: ${totalMiB * 1024} kB\nMemFree: 1024 kB\nMemAvailable: ${availableMiB * 1024} kB\nSwapTotal: 1048576 kB\nSwapFree: ${swapFreeMiB * 1024} kB\n`);
	return path;
}

function tinyMatrix(directory, defaults = {}) {
	const path = join(directory, "matrix.json");
	writeFileSync(
		path,
		JSON.stringify({
			name: "tiny",
			hostClass: "412 MB host (test)",
			defaults: { records: 50, tail: 3, memoryMax: "192M", memoryHigh: "180M", swapMax: "0", ...defaults },
			cells: [{ id: "tiny-cell" }],
		}),
	);
	return path;
}

// H1: the profiler lowers its own OOM priority so the kernel kills it before sshd or journald.
test("profiler sets oom_score_adj to 1000 on Linux and records the result", (t) => {
	const directory = scratch(t);
	const output = join(directory, "result.json");
	const result = profile(["--records", "5", "--tail", "1", "--phases", "seed", "--out", output]);
	assert.equal(result.status, 0, result.stderr);
	const { oomScoreAdj } = JSON.parse(readFileSync(output, "utf8")).host;
	if (process.platform === "linux") assert.deepEqual(oomScoreAdj, { applied: true, value: 1000 });
	else assert.equal(oomScoreAdj.applied, false);
});

// H1: a limit above available memory minus the reserve cannot bind before the kernel reclaims other processes.
test("preflight refuses a MemoryMax the host cannot back, before creating anything", (t) => {
	const directory = scratch(t);
	const outDir = join(directory, "out");
	const run = (meminfo, extra = []) =>
		spawnSync(
			process.execPath,
			[driver, "--matrix", defaultMatrix, "--only", "records-1000-swap0", "--out-dir", outDir, "--scope", "none", "--min-free-disk-mb", "0", "--meminfo", meminfo, ...extra],
			{ encoding: "utf8", timeout: 30_000 },
		);
	// The existing agent running: about 223 MiB available on a 412 MB host. 223 - 64 reserve < 224.
	const busy = run(meminfoFile(directory, { totalMiB: 389, availableMiB: 223 }));
	assert.equal(busy.status, 2, busy.stderr);
	assert.match(busy.stderr, /preflight refused/);
	assert.match(busy.stderr, /MemoryMax=224M exceeds available memory 223 MiB minus the 64 MiB reserve/);
	assert.equal(existsSync(outDir), false);
	// A limit at or above physical RAM can never bind.
	const small = run(meminfoFile(directory, { totalMiB: 200, availableMiB: 190 }));
	assert.equal(small.status, 2);
	assert.match(small.stderr, /at or above physical RAM/);
	// A free swap smaller than MemorySwapMax is refused too.
	const swap = spawnSync(
		process.execPath,
		[driver, "--matrix", defaultMatrix, "--only", "records-1000-swap256m", "--out-dir", outDir, "--scope", "none", "--min-free-disk-mb", "0", "--meminfo", meminfoFile(directory, { totalMiB: 389, availableMiB: 300, swapFreeMiB: 100 })],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(swap.status, 2);
	assert.match(swap.stderr, /MemorySwapMax=256M exceeds free swap 100 MiB/);
	// Disk below the minimum is refused.
	const disk = run(meminfoFile(directory, { totalMiB: 389, availableMiB: 300 }), ["--min-free-disk-mb", "999999999"]);
	assert.equal(disk.status, 2);
	assert.match(disk.stderr, /work directory has \d+ MiB free, below/);
	assert.equal(existsSync(outDir), false);
});

test("--allow-overcommit runs but labels the limit unreachable and the host class", (t) => {
	const directory = scratch(t);
	const outDir = join(directory, "out");
	const meminfo = meminfoFile(directory, { totalMiB: 160, availableMiB: 140 });
	const result = spawnSync(
		process.execPath,
		[driver, "--matrix", tinyMatrix(directory), "--out-dir", outDir, "--tmpdir", join(directory, "tmp"), "--scope", "none", "--min-free-disk-mb", "0", "--meminfo", meminfo, "--allow-overcommit"],
		{ encoding: "utf8", timeout: 120_000 },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /--allow-overcommit with preflight problems/);
	const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
	assert.equal(manifest.hostClass, "412 MB host (test)");
	assert.deepEqual(manifest.preflight.unreachable, ["tiny-cell"]);
	const cell = JSON.parse(readFileSync(join(outDir, "tiny-cell.json"), "utf8"));
	assert.equal(cell.hostClass, "412 MB host (test)");
	assert.equal(cell.limits.reachable, false);
	assert.ok(cell.steps.every((step) => step.limit.reachable === false));
});

test("preflight helpers: meminfo parsing, a fitting matrix and the shipped matrix against the 412 MB host", () => {
	const meminfo = parseMeminfo("MemTotal:         398080 kB\nMemAvailable:     228352 kB\nSwapFree:        1048576 kB\n");
	assert.deepEqual(meminfo, { memTotal: 398080 * 1024, memAvailable: 228352 * 1024, swapFree: 1048576 * 1024 });
	assert.ok(Number.isNaN(parseMeminfo("nothing here").memTotal));
	const unreadable = checkPreflight({ cells: [{ id: "a", memoryMax: "1M" }], meminfo: parseMeminfo(""), reserveBytes: 0, minDiskBytes: 0 });
	assert.match(unreadable.problems[0], /cannot read MemTotal and MemAvailable/);
	const tmpfs = checkPreflight({ cells: [], meminfo, reserveBytes: 0, diskFreeBytes: 10 * 1024 * MIB, minDiskBytes: 0, fsType: "tmpfs" });
	assert.match(tmpfs.problems[0], /tmpfs/);
	const matrix = JSON.parse(readFileSync(defaultMatrix, "utf8"));
	assert.match(matrix.hostClass, /412 MB/);
	const enabled = resolveCells(matrix).filter((cell) => cell.disabled === undefined);
	// Every enabled limit leaves at least 128 MiB of a 412 MB host for the kernel, sshd and systemd.
	for (const cell of enabled) assert.ok(parseSizeMiB(cell.memoryMax) <= 412 - 128, cell.id);
	const stopped = { memTotal: 389 * MIB, memAvailable: 300 * MIB, swapFree: 1024 * MIB };
	assert.deepEqual(checkPreflight({ cells: enabled, meminfo: stopped, reserveBytes: 64 * MIB, diskFreeBytes: 8 * 1024 * MIB, minDiskBytes: 2 * 1024 * MIB, fsType: "ext4" }).problems, []);
	// With the existing agent still running the default matrix must be refused, not run.
	const running = { ...stopped, memAvailable: 223 * MIB };
	assert.ok(checkPreflight({ cells: enabled, meminfo: running, reserveBytes: 64 * MIB }).problems.length > 0);
});

function parseSizeMiB(text) {
	return Number(/^(\d+)M$/.exec(text)[1]);
}

// M3: only OOM lines that name this step's scope count against the cell.
test("OOM lines about other processes are counted as unrelated, not blamed on the cell", () => {
	const unit = "capacity-records-5000-swap0-measure-1700000000000";
	const lines = [
		"2026-11-21T10:00:00+0000 host kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/system.slice/unit-001@abc.service,task_memcg=/system.slice/unit-001@abc.service,task=node,pid=11,uid=900",
		"2026-11-21T10:00:00+0000 host kernel: Out of memory: Killed process 22 (journald) total-vm:1000kB",
		`2026-11-21T10:00:01+0000 host kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/system.slice/${unit}.scope,task_memcg=/system.slice/${unit}.scope,task=node,pid=33,uid=0`,
		"2026-11-21T10:00:01+0000 host kernel: unrelated line about disks",
	];
	const result = unitOomLines(lines, unit, `/system.slice/${unit}.scope`);
	assert.equal(result.own.length, 1);
	assert.match(result.own[0], /pid=33/);
	assert.equal(result.unrelated, 2);
	// The observed cgroup path alone also identifies the step when the unit name differs from the path.
	assert.equal(unitOomLines([lines[2]], "other", `/system.slice/${unit}.scope`).own.length, 1);
	assert.deepEqual(unitOomLines(lines.slice(0, 2), unit, null), { own: [], unrelated: 2 });
});

// M4: SIGTERM or SIGHUP stops the running step, removes the fixtures and run directory, and records the interruption.
for (const [signal, code] of [
	["SIGTERM", 143],
	["SIGHUP", 129],
]) {
	test(`${signal} interrupts the driver cleanly, leaving no child, fixture or temp directory`, async (t) => {
		const directory = scratch(t);
		const matrix = join(directory, "matrix.json");
		writeFileSync(
			matrix,
			JSON.stringify({
				name: "long",
				defaults: { records: 50, tail: 3 },
				cells: [
					{ id: "long-cell", mutate: "remember-heavy", durationS: 120, mutateIntervalMs: 1000 },
					{ id: "never-runs" },
				],
			}),
		);
		const outDir = join(directory, "out");
		const work = join(directory, "tmp");
		const child = spawn(process.execPath, [driver, "--matrix", matrix, "--out-dir", outDir, "--tmpdir", work, "--scope", "none", "--allow-overcommit"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exit = new Promise((resolveExit) => child.on("close", (status) => resolveExit(status)));
		const measuring = join(outDir, "raw", "long-cell.measure.json");
		for (let waited = 0; !existsSync(measuring) && waited < 60_000; waited += 100) await delay(100);
		assert.ok(existsSync(measuring), "measure step started");
		child.kill(signal);
		assert.equal(await exit, code);
		const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
		assert.equal(manifest.interrupted, signal);
		assert.ok(manifest.finishedAt);
		assert.deepEqual(manifest.cells.map((cell) => `${cell.id}:${cell.status}`), ["long-cell:interrupted"]);
		assert.equal(JSON.parse(readFileSync(join(outDir, "long-cell.json"), "utf8")).steps[1].status, "interrupted");
		assert.equal(JSON.parse(readFileSync(measuring, "utf8")).status, "interrupted");
		assert.deepEqual(readdirSync(work), [], "run directory and fixtures removed");
		// No profiler process may outlive the driver: its command line names this out-dir.
		assert.equal(spawnSync("pgrep", ["-f", outDir]).status, 1);
	});
}

// M5: results and fixtures never go through a path another local user could have prepared.
test("the run uses a private 0700 directory under --tmpdir and refuses an unsafe --tmpdir", (t) => {
	const directory = scratch(t);
	const work = join(directory, "tmp");
	const outDir = join(directory, "out");
	const kept = spawnSync(
		process.execPath,
		[driver, "--matrix", tinyMatrix(directory), "--out-dir", outDir, "--tmpdir", work, "--scope", "none", "--allow-overcommit", "--keep-fixtures"],
		{ encoding: "utf8", timeout: 120_000 },
	);
	assert.equal(kept.status, 0, kept.stderr);
	const [run] = readdirSync(work);
	assert.match(run, /^unit-capacity-run-/);
	assert.equal(statSync(join(work, run)).mode & 0o777, 0o700);
	assert.ok(existsSync(join(work, run, "fixture-tiny-cell", "fixture.json")));
	// A world-writable parent without the sticky bit is refused.
	const open = join(directory, "open");
	mkdirSync(open);
	chmodSync(open, 0o777);
	const refused = spawnSync(
		process.execPath,
		[driver, "--matrix", tinyMatrix(directory), "--out-dir", join(directory, "out2"), "--tmpdir", open, "--scope", "none", "--allow-overcommit"],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /refusing to use --tmpdir/);
	assert.deepEqual(readdirSync(open), []);
	chmodSync(open, 0o1777);
	assert.equal(tmpParentProblem(open, process.getuid?.()), undefined);
	chmodSync(open, 0o770);
	assert.match(tmpParentProblem(open, process.getuid?.()), /group or others/);
});

test("the driver refuses a symlinked or shared --out-dir and never follows a planted temporary file", (t) => {
	const directory = scratch(t);
	const target = join(directory, "elsewhere");
	mkdirSync(target);
	const link = join(directory, "link");
	symlinkSync(target, link);
	const args = (outDir) => [driver, "--matrix", tinyMatrix(directory), "--out-dir", outDir, "--tmpdir", join(directory, "tmp"), "--scope", "none", "--allow-overcommit"];
	const linked = spawnSync(process.execPath, args(link), { encoding: "utf8", timeout: 30_000 });
	assert.equal(linked.status, 2);
	assert.match(linked.stderr, /is a symbolic link/);
	assert.deepEqual(readdirSync(target), []);
	const shared = join(directory, "shared");
	mkdirSync(shared);
	chmodSync(shared, 0o777);
	const open = spawnSync(process.execPath, args(shared), { encoding: "utf8", timeout: 30_000 });
	assert.equal(open.status, 2);
	assert.match(open.stderr, /writable by group or others/);
	assert.equal(outputDirectoryProblem(shared, process.getuid?.()) !== undefined, true);
	// A symlink planted at the temporary name must be replaced, not written through.
	const outDir = join(directory, "planted");
	mkdirSync(outDir, { mode: 0o700 });
	const victim = join(directory, "victim.txt");
	writeFileSync(victim, "original");
	symlinkSync(victim, join(outDir, "manifest.json.tmp"));
	const planted = spawnSync(process.execPath, args(outDir), { encoding: "utf8", timeout: 120_000 });
	assert.equal(planted.status, 0, planted.stderr);
	assert.equal(readFileSync(victim, "utf8"), "original");
	assert.equal(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")).kind, "capacity-matrix-run");
});

test("the profiler refuses a symlinked --keep and never writes through a planted result.tmp", (t) => {
	const directory = scratch(t);
	const target = join(directory, "elsewhere");
	mkdirSync(target);
	const link = join(directory, "link");
	symlinkSync(target, link);
	const result = profile(["--records", "5", "--tail", "1", "--keep", link, "--out", join(directory, "seed.json")]);
	assert.notEqual(result.status, 0);
	assert.match(readFileSync(join(directory, "seed.json"), "utf8"), /symbolic link/);
	assert.deepEqual(readdirSync(target), []);
	const victim = join(directory, "victim.txt");
	writeFileSync(victim, "original");
	const output = join(directory, "result.json");
	symlinkSync(victim, `${output}.tmp`);
	const ok = profile(["--records", "5", "--tail", "1", "--phases", "seed", "--out", output]);
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(readFileSync(victim, "utf8"), "original");
	assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "complete");
});

// M6: root runs only code that its owner cannot change, and the child sees no credentials.
test("child environment is an allowlist and root refuses code that others can write", (t) => {
	const environment = scrubbedEnvironment(
		{
			PATH: "/usr/bin",
			HOME: "/root",
			NODE_OPTIONS: "--import /tmp/evil.mjs",
			ANTHROPIC_API_KEY: "sk-test",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			TMPDIR: "/should/be/replaced",
		},
		"/work",
	);
	assert.deepEqual(environment, { PATH: "/usr/bin", HOME: "/root", TMPDIR: "/work" });
	const directory = scratch(t);
	const code = join(directory, "profile.mjs");
	writeFileSync(code, "// code\n");
	chmodSync(code, 0o644);
	const uid = process.getuid?.() ?? 0;
	assert.deepEqual(untrustedCodePaths([code, join(directory, "missing.mjs")], uid), []);
	assert.match(untrustedCodePaths([code], uid + 1)[0], /owned by uid/);
	chmodSync(code, 0o666);
	assert.match(untrustedCodePaths([code], uid)[0], /writable by group or others/);
});

// L4: a matrix is code that root executes, so ids, numbers, sizes and node flags are validated; --only globs are literal.
test("matrix validation rejects hostile ids, node flags, sizes and numbers; globs escape ?", () => {
	const cell = (extra) => ({ cells: [{ id: "ok-1", ...extra }] });
	assert.equal(resolveCells(cell({ nodeArgs: ["--max-old-space-size=156"], memoryMax: "224M", memoryHigh: null, swapMax: "infinity" })).length, 1);
	for (const [extra, message] of [
		[{ id: "../escape" }, /id must match/],
		[{ id: "a b" }, /id must match/],
		[{ id: "." }, /id must match/],
		[{ id: "" }, /id must match/],
		[{ nodeArgs: ["--require=/tmp/evil.js"] }, /nodeArgs may only hold/],
		[{ nodeArgs: ["--eval=process.exit()"] }, /nodeArgs may only hold/],
		[{ memoryMax: "1G; rm -rf /" }, /memoryMax must be a size/],
		[{ swapMax: "lots" }, /swapMax must be a size/],
		[{ records: "--out" }, /records must be a number/],
		[{ topology: "star" }, /topology must be/],
		[{ mutate: "chaos" }, /mutate must be one of/],
		[{ split: "yes" }, /split must be a boolean/],
	])
		assert.throws(() => resolveCells(cell(extra)), message, JSON.stringify(extra));
	assert.throws(() => resolveCells({ cells: "nope" }), /needs a cells array/);
	assert.doesNotThrow(() => globToRegExp("records-?"));
	assert.equal(globToRegExp("records-?").test("records-?"), true);
	assert.equal(globToRegExp("records-?").test("records-1"), false);
	assert.equal(globToRegExp("records-1000-*").test("records-1000-swap0"), true);
});

test("the driver exits 2 on a hostile matrix instead of running it", (t) => {
	const directory = scratch(t);
	const matrix = join(directory, "matrix.json");
	writeFileSync(matrix, JSON.stringify({ name: "evil", cells: [{ id: "evil", nodeArgs: ["--require=/tmp/evil.js"] }] }));
	const result = spawnSync(process.execPath, [driver, "--matrix", matrix, "--out-dir", join(directory, "out"), "--scope", "none"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(result.status, 2);
	assert.match(result.stderr, /invalid matrix/);
	assert.equal(existsSync(join(directory, "out")), false);
});

// L5 and L6: a dry run starts no unit and runs no git; the scope probe must never wait on polkit.
test("dry run starts no systemd unit and runs no git", (t) => {
	const directory = scratch(t);
	const bin = join(directory, "bin");
	mkdirSync(bin);
	const marker = join(directory, "called.log");
	for (const name of ["systemd-run", "git"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 1\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const result = spawnSync(process.execPath, [driver, "--out-dir", join(directory, "out"), "--dry-run", "--only", "records-1000-swap0"], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
	assert.equal(existsSync(join(directory, "out")), false);
});

test("the scope probe passes --no-ask-password", { skip: process.platform !== "linux" }, (t) => {
	const directory = scratch(t);
	const bin = join(directory, "bin");
	mkdirSync(bin);
	const log = join(directory, "args.log");
	writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = "--version" ] && echo "systemd 255" && exit 0\nexit 1\n`);
	chmodSync(join(bin, "systemd-run"), 0o755);
	const result = spawnSync(
		process.execPath,
		[driver, "--matrix", tinyMatrix(directory), "--out-dir", join(directory, "out"), "--tmpdir", join(directory, "tmp"), "--allow-overcommit", "--only", "tiny-cell"],
		{ encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
	);
	assert.equal(result.status, 0, result.stderr);
	const probes = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("MemoryMax=1G"));
	assert.ok(probes.length > 0 && probes.every((line) => line.includes("--no-ask-password")), probes.join("\n"));
});
