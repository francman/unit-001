// Exercises the production asset check without writing to web-dist or launching Chromium.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertFreshWebAssets } from "../scripts/build-web-freshness.mjs";

const builder = fileURLToPath(new URL("../scripts/build-web.mjs", import.meta.url));

test("production web assets must exist and match even when timestamps do not change", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "unit-web-freshness-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const dist = join(directory, "web-dist");
	await assert.rejects(assertFreshWebAssets(dist), {
		message: /Missing web-dist\/index\.html.*node apps\/unit-001\/scripts\/build-web\.mjs/,
	});

	execFileSync(process.execPath, [builder, dist]);
	const css = join(dist, "style.css");
	const timestamp = new Date();
	await utimes(css, timestamp, timestamp);
	await assertFreshWebAssets(dist);
	await appendFile(css, "\n/* different artifact bytes */\n");
	await utimes(css, timestamp, timestamp);
	await assert.rejects(assertFreshWebAssets(dist), {
		message: /Stale web-dist\/style\.css.*node apps\/unit-001\/scripts\/build-web\.mjs/,
	});
});
