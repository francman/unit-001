// Runs the capacity profiler against actual SQLite and the faux provider in a small isolated fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// #64: a profiler result must cover actual replay and requests, not only an in-memory memory index.
test("profiles persisted replay, startup and 31 faux requests without live model access", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "unit-capacity-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const output = join(directory, "result.json");
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("../scripts/profile-capacity.mjs", import.meta.url)),
			"--records",
			"10",
			"--tail",
			"3",
			"--out",
			output,
		],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.count, 10);
	assert.equal(report.tail, 3);
	assert.ok(report.phases.every((phase) => phase.rss > 0 && phase.peakRss > 0));
	assert.equal(report.phases.find((phase) => phase.name === "receipt-delta-tail").samplesMs.length, 3);
	assert.equal(report.phases.find((phase) => phase.name === "storage-open-snapshot-close").samplesMs.length, 25);
	const requests = report.phases.find((phase) => phase.name === "foreground-submit-to-provider");
	assert.equal(requests.fauxCalls, 31);
	assert.equal(requests.samplesMs.length, 25);
	assert.ok(report.phases.find((phase) => phase.name === "closed-storage").diskBytes > 0);
});

// #64: invalid workload sizes fail before a profile or database is created.
test("refuses invalid record and replay-tail bounds", () => {
	for (const args of [
		["--records", "0"],
		["--records", "1000", "--tail", "64"],
	]) {
		const result = spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("../scripts/profile-capacity.mjs", import.meta.url)),
				...args,
				"--out",
				"/not-used/result.json",
			],
			{ encoding: "utf8", timeout: 10_000 },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Usage: profile-capacity/);
	}
});
