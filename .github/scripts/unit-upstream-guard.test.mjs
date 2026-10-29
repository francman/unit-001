import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findViolations } from "./unit-upstream-guard.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "unit-upstream-guard.mjs");

function git(cwd, ...args) {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function write(cwd, path, content) {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), content);
}

/** A repository whose `upstream` branch holds the baseline and whose `work` branch starts from it. */
function createRepository() {
	const cwd = mkdtempSync(join(tmpdir(), "unit-guard-"));
	git(cwd, "init", "-q", "-b", "upstream");
	write(cwd, "src/core.ts", "export const core = 1;\n");
	write(cwd, "src/other.ts", "export const other = 1;\n");
	write(cwd, "package-lock.json", "{}\n");
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "-m", "baseline");
	git(cwd, "checkout", "-q", "-b", "work");
	return cwd;
}

function commit(cwd, message) {
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "-m", message);
}

describe("findViolations", () => {
	const repositories = [];
	const fresh = () => {
		const cwd = createRepository();
		repositories.push(cwd);
		return cwd;
	};
	const run = (cwd, options = {}) => findViolations({ cwd, upstream: "upstream", ...options });

	after(() => {
		for (const cwd of repositories) rmSync(cwd, { recursive: true, force: true });
	});

	it("accepts a branch with no changes", () => {
		assert.deepEqual(run(fresh()).violations, []);
	});

	it("accepts added files", () => {
		const cwd = fresh();
		write(cwd, "apps/unit-001/src/index.ts", "export {};\n");
		commit(cwd, "add launcher");
		assert.deepEqual(run(cwd).violations, []);
	});

	it("rejects a modified upstream file", () => {
		const cwd = fresh();
		write(cwd, "src/core.ts", "export const core = 2;\n");
		commit(cwd, "edit upstream");
		assert.deepEqual(run(cwd).violations, [{ status: "M", path: "src/core.ts" }]);
	});

	it("rejects a deleted upstream file", () => {
		const cwd = fresh();
		git(cwd, "rm", "-q", "src/other.ts");
		commit(cwd, "delete upstream");
		assert.deepEqual(run(cwd).violations, [{ status: "D", path: "src/other.ts" }]);
	});

	it("rejects a renamed upstream file as a deletion", () => {
		const cwd = fresh();
		git(cwd, "mv", "src/core.ts", "src/renamed.ts");
		commit(cwd, "move upstream");
		assert.deepEqual(run(cwd).violations, [{ status: "D", path: "src/core.ts" }]);
	});

	it("accepts changes to a file we added earlier", () => {
		const cwd = fresh();
		write(cwd, "apps/unit-001/a.ts", "1\n");
		commit(cwd, "add");
		write(cwd, "apps/unit-001/a.ts", "2\n");
		commit(cwd, "edit own file");
		assert.deepEqual(run(cwd).violations, []);
	});

	it("accepts a modified lockfile by default and rejects it when the allowlist is empty", () => {
		const cwd = fresh();
		write(cwd, "package-lock.json", '{"lockfileVersion":3}\n');
		commit(cwd, "lock");
		assert.deepEqual(run(cwd).violations, []);
		assert.deepEqual(run(cwd, { allowlist: [] }).violations, [{ status: "M", path: "package-lock.json" }]);
	});

	it("handles paths with spaces and non-ASCII characters", () => {
		const cwd = fresh();
		write(cwd, "docs/new file é.md", "x\n");
		commit(cwd, "add odd path");
		write(cwd, "src/core.ts", "export const core = 3;\n");
		commit(cwd, "edit upstream");
		assert.deepEqual(run(cwd).violations, [{ status: "M", path: "src/core.ts" }]);
	});

	it("ignores upstream commits that landed after the branch point", () => {
		const cwd = fresh();
		write(cwd, "apps/unit-001/a.ts", "1\n");
		commit(cwd, "add");
		git(cwd, "checkout", "-q", "upstream");
		write(cwd, "src/core.ts", "export const core = 9;\n");
		commit(cwd, "upstream moves on");
		git(cwd, "checkout", "-q", "work");
		assert.deepEqual(run(cwd).violations, []);
	});

	it("accepts a merge of newer upstream and still catches later edits", () => {
		const cwd = fresh();
		git(cwd, "checkout", "-q", "upstream");
		write(cwd, "src/core.ts", "export const core = 9;\n");
		commit(cwd, "upstream moves on");
		git(cwd, "checkout", "-q", "work");
		git(cwd, "merge", "-q", "--no-edit", "upstream");
		assert.deepEqual(run(cwd).violations, []);
		write(cwd, "src/other.ts", "export const other = 2;\n");
		commit(cwd, "edit upstream after merge");
		assert.deepEqual(run(cwd).violations, [{ status: "M", path: "src/other.ts" }]);
	});

	it("throws when the upstream ref is missing", () => {
		assert.throws(() => run(fresh(), { upstream: "missing" }), /fetch the upstream ref first/);
	});
});

describe("command line", () => {
	let cwd;
	before(() => {
		cwd = createRepository();
	});
	after(() => rmSync(cwd, { recursive: true, force: true }));

	const cli = (...args) => {
		try {
			const stdout = execFileSync("node", [script, "--upstream", "upstream", ...args], {
				cwd,
				encoding: "utf8",
				stdio: "pipe",
			});
			return { code: 0, stdout, stderr: "" };
		} catch (error) {
			return { code: error.status, stdout: error.stdout, stderr: error.stderr };
		}
	};

	it("exits 0 on a clean branch", () => {
		const result = cli();
		assert.equal(result.code, 0);
		assert.match(result.stdout, /^OK:/);
	});

	it("exits 1 and annotates the file on a violation", () => {
		write(cwd, "src/core.ts", "export const core = 2;\n");
		commit(cwd, "edit upstream");
		const result = cli();
		assert.equal(result.code, 1);
		assert.match(result.stdout, /::error file=src\/core\.ts::/);
	});

	it("exits 2 on unknown arguments", () => {
		const result = cli("--bogus", "x");
		assert.equal(result.code, 2);
		assert.match(result.stderr, /Unknown or incomplete argument/);
	});
});
