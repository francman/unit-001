// Verifies the updater dependency closure works after the application directory disappears.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseFiles, writeUpdaterCore } from "../scripts/build-release.mjs";

test("#18 independent core retains nested dependency resolution without copying application dependencies", () => {
	const stage = mkdtempSync(join(tmpdir(), "updater-core-"));
	try {
		const modules = join(stage, "app/node_modules");
		for (const [name, dependencies, body] of [
			["tuf-js", { nested: "1.0.0" }, 'module.exports = require("nested");'],
			["tuf-js/node_modules/nested", {}, 'module.exports = "independent";'],
			["@tufjs/models", {}, 'module.exports = "models";'],
			["application-only", {}, 'throw new Error("must not copy");'],
		]) {
			const directory = join(modules, name);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "package.json"),
				JSON.stringify({
					name: name.split("node_modules/").at(-1),
					version: "1.0.0",
					main: "index.cjs",
					dependencies,
				}),
			);
			writeFileSync(join(directory, "index.cjs"), body);
		}
		mkdirSync(join(stage, "runtime/bin"), { recursive: true });
		writeFileSync(join(stage, "runtime/bin/node"), "independent-runtime");
		mkdirSync(join(stage, "deploy"));
		writeFileSync(
			join(stage, "deploy/update.mjs"),
			'import value from "tuf-js"; import models from "@tufjs/models"; console.log(value, models);',
		);
		writeUpdaterCore(stage);
		rmSync(join(stage, "app"), { recursive: true });
		assert.equal(
			execFileSync(process.execPath, [join(stage, "updater/lib/update.mjs")], { encoding: "utf8" }).trim(),
			"independent models",
		);
		assert.equal(readFileSync(join(stage, "updater/runtime/bin/node"), "utf8"), "independent-runtime");
		assert.ok(releaseFiles(join(stage, "updater")).every((path) => !path.includes("application-only")));
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
});
