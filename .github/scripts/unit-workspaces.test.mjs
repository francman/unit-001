import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listWorkspaces } from "./unit-workspaces.mjs";

describe("listWorkspaces", () => {
	const roots = [];
	const fresh = () => {
		const root = mkdtempSync(join(tmpdir(), "unit-workspaces-"));
		roots.push(root);
		return root;
	};
	const addPackage = (root, path, scripts) => {
		mkdirSync(join(root, path), { recursive: true });
		writeFileSync(join(root, path, "package.json"), JSON.stringify({ name: path, scripts }));
	};

	after(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	it("returns nothing when there are no unit workspaces", () => {
		assert.deepEqual(listWorkspaces({ root: fresh(), script: "test" }), []);
	});

	it("finds unit apps and packages that define the script, sorted", () => {
		const root = fresh();
		addPackage(root, "packages/unit-memory", { test: "vitest --run" });
		addPackage(root, "apps/unit-001", { test: "vitest --run", bench: "node bench.ts" });
		assert.deepEqual(listWorkspaces({ root, script: "test" }), ["apps/unit-001", "packages/unit-memory"]);
		assert.deepEqual(listWorkspaces({ root, script: "bench" }), ["apps/unit-001"]);
	});

	it("skips upstream packages, packages without the script, and directories without a manifest", () => {
		const root = fresh();
		addPackage(root, "packages/durable", { test: "vitest --run" });
		addPackage(root, "packages/unit-empty", {});
		mkdirSync(join(root, "packages/unit-nomanifest"), { recursive: true });
		writeFileSync(join(root, "packages/unit-file"), "not a directory");
		assert.deepEqual(listWorkspaces({ root, script: "test" }), []);
	});
});
