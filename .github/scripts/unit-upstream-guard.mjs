// Fails when a commit range modifies, deletes, or retypes a file that exists in the upstream-pi baseline.
// unit-001 only adds files; the one allowed exception is the lockfile, which npm rewrites when workspaces change.
// Usage: node .github/scripts/unit-upstream-guard.mjs [--upstream upstream-pi/main] [--head HEAD] [--allow path]...
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_UPSTREAM = "upstream-pi/main";
export const DEFAULT_ALLOWLIST = ["package-lock.json"];

function git(cwd, args) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * Lists paths that changed between the merge base of `head` and `upstream` and `head`, without an added status.
 * Renames are reported as a deletion plus an addition (`--no-renames`), so moving an upstream file is a violation.
 * @returns {{ base: string, violations: { status: string, path: string }[] }}
 */
export function findViolations({
	cwd = process.cwd(),
	upstream = DEFAULT_UPSTREAM,
	head = "HEAD",
	allowlist = DEFAULT_ALLOWLIST,
} = {}) {
	let base;
	try {
		base = git(cwd, ["merge-base", head, upstream]).trim();
	} catch (error) {
		throw new Error(`No merge base between ${head} and ${upstream}; fetch the upstream ref first.`, { cause: error });
	}
	const output = git(cwd, ["diff", "--name-status", "--no-renames", "-z", base, head]);
	const fields = output.split("\0");
	const allowed = new Set(allowlist);
	const violations = [];
	// -z output alternates status and path, with a trailing empty field.
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const status = fields[index];
		const path = fields[index + 1];
		if (status === "A" || allowed.has(path)) continue;
		violations.push({ status, path });
	}
	return { base, violations };
}

function parseArguments(argv) {
	const options = { upstream: DEFAULT_UPSTREAM, head: "HEAD", allowlist: [...DEFAULT_ALLOWLIST] };
	let extraAllow = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (value === undefined || !["--upstream", "--head", "--allow"].includes(flag)) {
			throw new Error(`Unknown or incomplete argument: ${flag}`);
		}
		index++;
		if (flag === "--allow") {
			// Passing --allow replaces the default list, so the caller states the full exception set.
			if (!extraAllow) options.allowlist = [];
			extraAllow = true;
			options.allowlist.push(value);
		} else {
			options[flag.slice(2)] = value;
		}
	}
	return options;
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	const { base, violations } = findViolations(options);
	if (violations.length === 0) {
		console.log(`OK: no upstream file changed since ${base.slice(0, 12)} (${options.upstream}).`);
		return;
	}
	for (const { status, path } of violations) {
		const message = `unit-001 never modifies upstream files (git status ${status}). Add files instead.`;
		console.log(`::error file=${path}::${message}`);
	}
	console.error(`${violations.length} upstream file(s) changed since ${base.slice(0, 12)}:`);
	for (const { status, path } of violations) console.error(`  ${status}\t${path}`);
	process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
