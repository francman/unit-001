// #72: Runs the full-owner rollback qualification against an exact published reader archive in a disposable,
// network-disabled linux/amd64 container, and writes the record that release publication requires.
//
//   node test/rollback/qualify.mjs --reader unit-001-X.Y.Z-linux-x64.tar.gz --image IMAGE --work DIR --record FILE
//     [--candidate unit-001-X.Y.Z-linux-x64.tar.gz]
//
// Any published release can be the reader: its version comes from the archive's `release.json` and is passed to
// full-owner-reader.mjs, which checks the bundle against it. Publication needs one record per earlier release.
// Without --candidate, the current-owner steps run on this host from the checkout's `dist/` (run `npm run build`
// first); that record names the checkout and cannot satisfy publication. With --candidate, every step runs in the
// container from the two release archives, and the record binds both archive digests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: Object.fromEntries(["reader", "candidate", "image", "work", "record"].map((name) => [name, { type: "string" }])),
});
assert.ok(values.reader && values.image && values.work && values.record, "--reader, --image, --work and --record are required");
const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "../..");
const work = resolve(values.work);
mkdirSync(work, { recursive: true, mode: 0o700 });

const reader = unpack(values.reader, "reader", ["full-owner-reader.mjs"]);
const candidate =
	values.candidate === undefined
		? undefined
		: unpack(values.candidate, "candidate", ["full-owner-current.mjs", "checks.mjs"]);
const scenarios = {
	// A Session this candidate created, rolled back to the reader and forward again.
	fresh: ["seed", "reader:write", "verify", "reader:recheck"],
	// A Session that already holds unreleased `unit.memory` version 2 from a build of edfa9d085.
	"version-2": ["seed", "to-v2", "convert", "reader:write", "verify", "reader:recheck"],
};
for (const [name, steps] of Object.entries(scenarios)) withContainer(name, (step) => step(), steps);
const coverage = readerCoverage();
const negativeControl = runNegativeControl(coverage.includes("memory"));

const record = {
	schemaVersion: 1,
	kind: "unit.full-owner-rollback",
	candidate:
		candidate === undefined
			? { version: packageVersion(appRoot), archiveSha256: null, source: checkout() }
			: { version: candidate.version, archiveSha256: candidate.sha256 },
	reader: { version: reader.version, archiveSha256: reader.sha256, coverage },
	image: values.image,
	scenarios: Object.keys(scenarios),
	negativeControl,
	result: "passed",
	finishedAt: new Date().toISOString(),
};
writeFileSync(values.record, `${JSON.stringify(record, null, "\t")}\n`, { flag: "wx" });
console.log(`qualified: ${JSON.stringify(record)}`);

function unpack(archive, name, fixtures) {
	// One read feeds both the digest and the extraction: reading the path twice would let a swap in between record
	// the digest of one archive and qualify another.
	const bytes = readFileSync(archive);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const target = join(work, name);
	mkdirSync(target, { mode: 0o700 });
	execFileSync("tar", ["-xzf", "-", "-C", target], { input: bytes });
	const [top] = readdirSync(target);
	const root = join(target, top);
	const release = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
	assert.equal(release.platform, "linux-x64");
	// The fixtures are the only files added to the unpacked release; the release's own files stay untouched.
	mkdirSync(join(root, "app/test/rollback"), { recursive: true });
	for (const fixture of fixtures) copyFileSync(join(here, fixture), join(root, "app/test/rollback", fixture));
	return { root, sha256, version: release.version };
}

// Both scenarios must report the same coverage; a reader that covered less in one would hide work from `verify`.
function readerCoverage() {
	const [fresh, converted] = Object.keys(scenarios).map(
		(name) => JSON.parse(readFileSync(join(work, name, "state/session.sqlite.reader.json"), "utf8")).coverage,
	);
	assert.deepEqual(converted, fresh);
	return fresh;
}

// The same version-2 Session without `convert`: a reader that loads memory must refuse it, which shows that the
// `version-2` scenario's pass comes from the conversion and that this reader checks stored document versions.
function runNegativeControl(loadsMemory) {
	let refusal;
	withContainer("control", (step, mode) => {
		if (mode !== "reader:write") return step();
		try {
			step("pipe");
		} catch (error) {
			refusal = String(error.stderr ?? error);
		}
	}, ["seed", "to-v2", "reader:write"]);
	const refused = refusal?.includes("unit.memory) has newer version 2 than 1") === true;
	console.log(`control: reader ${refused ? `refused: ${refusal.match(/.*newer version 2 than 1.*/)[0].trim()}` : "opened"}`);
	assert.equal(refused, loadsMemory, `negative control: expected ${loadsMemory ? "refusal" : "open"}, got ${refusal ?? "open"}`);
	return { scenario: "version-2 without convert", result: refused ? "refused" : "opened" };
}

// Runs each step in one disposable container; `run(step, mode)` lets the caller wrap a step's execution.
function withContainer(name, run, steps) {
	const container = `unit-rollback-${name}-${process.pid}`;
	const host = join(work, name);
	mkdirSync(join(host, "state"), { recursive: true, mode: 0o700 });
	const mounts = ["-v", `${reader.root}:/reader:ro`];
	if (candidate !== undefined) mounts.push("-v", `${candidate.root}:/candidate:ro`);
	docker(["run", "-d", "--platform", "linux/amd64", "--network", "none", "--name", container, ...mounts]
		.concat(["--entrypoint", "sleep", values.image, "3600"]));
	try {
		docker(["exec", container, "mkdir", "-p", "-m", "700", "/fixture/state"]);
		for (const step of steps) {
			console.log(`${name}: ${step}`);
			run((stdio = "inherit") => runStep(container, host, step, stdio), step);
		}
		if (candidate !== undefined) copyOut(container, host);
	} finally {
		docker(["rm", "-f", container]);
	}
}

function runStep(container, host, step, stdio) {
	const [owner, mode] = step.startsWith("reader:") ? ["reader", step.slice(7)] : ["current", step];
	if (owner === "current" && candidate === undefined) {
		execFileSync(process.execPath, [join(here, "full-owner-current.mjs"), mode, join(host, "state/session.sqlite")], {
			cwd: appRoot,
			stdio,
		});
		return;
	}
	// Checkout-mode state lives on the host between steps; it moves into the container for each release step.
	if (candidate === undefined) copyIn(container, host);
	const [root, script, extra] =
		owner === "reader"
			? ["/reader", "full-owner-reader.mjs", [reader.version]]
			: ["/candidate", "full-owner-current.mjs", []];
	try {
		docker(
			["exec", "-w", `${root}/app`, container, `${root}/runtime/bin/node`, `${root}/app/test/rollback/${script}`]
				.concat([mode, "/fixture/state/session.sqlite", ...extra]),
			stdio,
		);
	} finally {
		if (candidate === undefined) copyOut(container, host);
	}
}

function copyIn(container, host) {
	docker(["exec", container, "rm", "-rf", "/fixture/state"]);
	docker(["cp", join(host, "state"), `${container}:/fixture/state`]);
	docker(["exec", container, "sh", "-c", "chown -R root:root /fixture/state && chmod 700 /fixture/state"]);
}

function copyOut(container, host) {
	rmSync(join(host, "state"), { recursive: true, force: true });
	docker(["cp", `${container}:/fixture/state`, join(host, "state")]);
}

function docker(args, stdio = "pipe") {
	return execFileSync("docker", args, { stdio });
}

function packageVersion(root) {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function checkout() {
	const git = (...args) => execFileSync("git", ["-C", appRoot, ...args], { encoding: "utf8" }).trim();
	return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
}
