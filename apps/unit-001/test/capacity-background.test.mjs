// Covers #64's paired faux-owner workload with real capture, publication and SQLite reopen evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { measureBackground } from "../scripts/capacity-background.mjs";
import { resolveCells } from "../scripts/run-capacity-matrix.mjs";

const profiler = fileURLToPath(new URL("../scripts/profile-capacity.mjs", import.meta.url));
const driver = fileURLToPath(new URL("../scripts/run-capacity-matrix.mjs", import.meta.url));

function scratch(t) {
	const dir = mkdtempSync(join(tmpdir(), "unit-capacity-background-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function profile(dir, output, args, nodeArgs = []) {
	return spawnSync(process.execPath, [...nodeArgs, profiler, "--out", output, ...args], {
		encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir },
	});
}

test("#64: matched probes see actual consolidation overlap and both copies retain their outcomes", (t) => {
	const dir = scratch(t);
	const fixture = join(dir, "baseline");
	const seeded = profile(dir, join(dir, "seed.json"), ["--records", "12", "--tail", "63", "--quiescent", "--keep", fixture]);
	assert.equal(seeded.status, 0, seeded.stderr);
	const baseline = join(fixture, "state.sqlite");
	const before = readFileSync(baseline);
	const output = join(dir, "background.json");
	const measured = profile(dir, output, [
		"--reuse", fixture, "--background-burst", "150", "--background-pairs", "2", "--sample-ms", "0",
	]);
	assert.equal(measured.status, 0, measured.stderr);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.status, "complete");
	assert.deepEqual(report.phasesRequested, ["background"]);
	assert.equal(existsSync(report.directory), false);
	assert.deepEqual(readFileSync(baseline), before);
	assert.equal(existsSync(`${baseline}-wal`), false);
	const observations = report.phases.filter(({ name }) => name === "owner-background-pair");
	const summary = report.phases.find(({ name }) => name === "owner-background");
	const valid = observations.filter(({ windowMissed }) => !windowMissed);
	assert.equal(summary.validPairs, valid.length);
	assert.equal(summary.overlapMisses, observations.length - valid.length);
	assert.deepEqual(summary.pairedProbeDeltasMs, valid.map(({ active, idle }) => active.probe.submitToFauxMs - idle.probe.submitToFauxMs));
	assert.deepEqual(observations.map(({ order }) => order), [["idle", "active"], ["active", "idle"]]);
	for (const { pair, active, idle, windowMissed } of observations) {
		assert.equal(idle.proof.emptyProbeCaptures, 0);
		assert.equal(active.proof.summaries, idle.proof.summaries);
		for (const arm of [active, idle]) {
			assert.deepEqual([
				arm.proof.captured, arm.proof.publicationBatches,
				arm.proof.consolidated, arm.proof.pending, arm.proof.consolidationStatus,
			], [150, 2, 100, 50, "sleeping"]);
			assert.equal(arm.proof.captureReceipts - arm.proof.emptyProbeCaptures, 1);
			assert.ok(arm.proof.summaries > 0);
			assert.ok(arm.capture.endedAtMs <= arm.consolidation.startedAtMs);
			for (const task of [arm.capture, arm.consolidation]) {
				assert.equal(task.queueMs, task.startedAtMs - task.scheduledAtMs);
				assert.ok(task.queueMs >= 0);
			}
			assert.ok(arm.consolidation.publicationsAtMs.every((ms) =>
				arm.consolidation.startedAtMs <= ms && ms < arm.consolidation.endedAtMs));
			assert.ok(arm.probe.submitToFauxMs > 0 && arm.probe.submitToFauxMs <= arm.probe.submitToSettledMs);
		}
		assert.equal(windowMissed, !active.probe.activeAtSubmit || !(active.probe.activeAtFaux || active.probe.publicationsDuringProbe > 0));
		assert.equal(idle.probe.activeAtSubmit, false);
		assert.equal(idle.probe.activeAtFaux, false);
		assert.equal(idle.probe.publicationsDuringProbe, 0);
		assert.ok(idle.consolidation.endedAtMs <= idle.probe.startedAtMs);
		for (const arm of ["idle", "active"]) {
			const samples = report.samples.filter((sample) => sample.pair === pair && sample.arm === arm);
			assert.deepEqual(samples.map(({ milestone }) => milestone), [
				"before-copy", "owner-open", "before-probe", "quiescent", "owner-closed", "verified",
			]);
			for (const sample of samples) {
				assert.ok(sample.rss > 0);
				assert.equal("vmHWM" in sample, false);
				if (summary.cgroup["memory.current"] !== null) assert.ok(sample.cgroupCurrent > 0);
				if (summary.cgroup["memory.swap.current"] !== null) assert.ok(sample.cgroupSwapCurrent >= 0);
			}
		}
	}
	for (const arm of ["idle", "active"]) {
		const open = report.diskPhases.find(({ phase }) => phase === `background-${arm}-open`);
		const closed = report.diskPhases.find(({ phase }) => phase === `background-${arm}-closed`);
		assert.ok(open.files["state.sqlite-wal"] > 0);
		assert.equal(closed.files["state.sqlite-wal"], null);
	}
});

function runScriptedPairs(t, windows) {
	const directory = scratch(t);
	const file = join(directory, "baseline.sqlite");
	writeFileSync(file, "");
	const reported = [];
	let arms = 0;
	const run = measureBackground({
		file, directory, burst: 100, pairs: windows.length, records: 12, tail: 0,
		onPair: (observation) => reported.push(observation),
	}, async ({ arm }) => {
		const pairIndex = Math.floor(arms++ / 2);
		assert.equal(reported.length, pairIndex, "publish the previous pair before starting another arm");
		const window = windows[pairIndex];
		const active = arm === "active";
		return {
			probe: {
				messages: 4,
				activeAtSubmit: active && window !== "before-submit",
				activeAtFaux: active && window === "at-faux",
				publicationsDuringProbe: active && window === "publication" ? 1 : 0,
			},
		};
	});
	return { run, reported };
}

test("#64: overlap misses are checkpointed but only valid windows qualify", async (t) => {
	const { run, reported } = runScriptedPairs(t, ["before-submit", "publication", "before-faux", "at-faux"]);
	const qualifying = await run;
	assert.deepEqual(reported.map(({ pair, windowMissed }) => [pair, windowMissed]), [
		[1, true], [2, false], [3, true], [4, false],
	]);
	assert.deepEqual(qualifying.map(({ pair }) => pair), [2, 4]);
});

test("#64: all misses fail after every pair has been checkpointed", async (t) => {
	const missed = runScriptedPairs(t, ["before-submit", "before-faux"]);
	await assert.rejects(missed.run, { code: "CAPACITY_BACKGROUND_NO_OVERLAP" });
	assert.deepEqual(missed.reported.map(({ pair, windowMissed }) => [pair, windowMissed]), [[1, true], [2, true]]);
});

test("#64: the profiler retains a checkpoint after a later real reopen invariant fails", (t) => {
	const dir = scratch(t);
	const baseline = join(dir, "baseline");
	const wrong = join(dir, "wrong");
	for (const [fixture, records] of [[baseline, "12"], [wrong, "13"]]) {
		const seeded = profile(dir, `${fixture}.json`, ["--records", records, "--quiescent", "--keep", fixture]);
		assert.equal(seeded.status, 0, seeded.stderr);
	}
	const output = join(dir, "background.json");
	const checkpoint = join(dir, "checkpoint.json");
	const preload = join(dir, "replace-second-active-copy.mjs");
	// Replace only pair 2's active clone, after reading the actual on-disk checkpoint.
	writeFileSync(preload, `
		import fs from "node:fs/promises";
		import { syncBuiltinESMExports } from "node:module";
		import { basename } from "node:path";
		const copyFile = fs.copyFile;
		let activeCopies = 0;
		fs.copyFile = async (from, to, ...args) => {
			if (basename(to) === "active.sqlite" && ++activeCopies === 2) {
				await copyFile(${JSON.stringify(output)}, ${JSON.stringify(checkpoint)});
				from = ${JSON.stringify(join(wrong, "state.sqlite"))};
			}
			return copyFile(from, to, ...args);
		};
		syncBuiltinESMExports();
	`);
	const measured = profile(dir, output, [
		"--reuse", baseline, "--background-burst", "100", "--background-pairs", "3",
	], ["--import", preload]);
	assert.equal(measured.status, 1, measured.stderr);
	const before = JSON.parse(readFileSync(checkpoint, "utf8"));
	const after = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(before.status, "running");
	assert.equal(after.status, "failed");
	assert.equal(after.background.failure, "invariant");
	assert.deepEqual(after.background.currentArm, { pair: 2, arm: "active" });
	assert.match(after.error, /unexpected reopened record count/);
	const completed = before.phases.filter(({ name }) => name === "owner-background-pair");
	assert.deepEqual(completed.map(({ pair, active, idle }) => [pair, active.proof.captured, idle.proof.captured]), [[1, 100, 100]]);
	assert.deepEqual(after.phases.filter(({ name }) => name === "owner-background-pair"), completed);
});

test("#64: background workload rejects invalid bursts and mixed phases before opening a fixture", (t) => {
	const dir = scratch(t);
	const output = join(dir, "invalid.json");
	for (const args of [
		["--background-burst", "99"],
		["--background-burst", "501"],
		["--background-burst", "150", "--background-pairs", "0"],
		["--background-pairs", "2"],
		["--background-burst", "150", "--phases", "seed,foreground,background"],
		["--background-burst", "150", "--capture-cycles", "1"],
	]) {
		const run = profile(dir, output, ["--records", "12", ...args]);
		assert.equal(run.status, 1, run.stderr);
		assert.match(run.stderr, /Usage: profile-capacity/);
		assert.equal(existsSync(output), false);
	}
});

test("#64: opt-in background matrix plans an independently scoped seed and measure, not legacy foreground", (t) => {
	const dir = scratch(t);
	const matrix = join(dir, "matrix.json");
	const cell = { id: "burst", records: 12, backgroundBurst: 150, backgroundPairs: 2, memoryMax: "160M" };
	writeFileSync(matrix, JSON.stringify({ cells: [cell] }));
	const result = spawnSync(process.execPath, [
		driver, "--matrix", matrix, "--out-dir", join(dir, "out"), "--tmpdir", dir, "--scope", "user", "--require-scope", "--dry-run",
	], { encoding: "utf8", timeout: 15_000 });
	assert.equal(result.status, 0, result.stderr);
	const [, seed, measure] = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(seed.step, "seed");
	assert.deepEqual(seed.args.slice(-3), ["--quiescent", "--keep", "<fixture>"]);
	assert.equal(measure.step, "background");
	assert.deepEqual(measure.args, ["--reuse", "<fixture>", "--background-burst", "150", "--background-pairs", "2"]);
	for (const { command } of [seed, measure]) assert.ok(command.includes("MemoryMax=160M"));
	for (const options of [{ backgroundBurst: "150" }, { backgroundPairs: 31 }, { split: false }, { settledTurns: 0 }])
		assert.throws(() => resolveCells({ cells: [{ ...cell, ...options }] }), /background/);
});
