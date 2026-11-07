import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarize } from "../bench/benchmark.ts";

describe("latency budget enforcement", () => {
	it("reports a slow p95 even when the median and MAD hide the tail", () => {
		// #4: robust noise reporting must never remove a latency regression from the budget gate.
		expect(summarize([...Array<number>(23).fill(1), 100, 100])).toEqual({
			medianMs: 1,
			p95Ms: 100,
			madMs: 0,
			madNoise: 0,
		});
	});

	it.each([
		{ budget: 1, status: 1 },
		{ budget: 2, status: 0 },
	])("exits $status for a 2 ms p95 and a $budget ms budget", ({ budget, status }) => {
		const fixture = fileURLToPath(new URL("./fixtures/latency-budget.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture, String(budget)], {
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(status);
		expect(JSON.parse(result.stdout).passed).toBe(status === 0);
	});
});
