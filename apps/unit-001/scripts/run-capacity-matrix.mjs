#!/usr/bin/env node
// Runs a capacity matrix: each cell is one or two profile-capacity.mjs processes under a systemd memory scope, with evidence kept per cell.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const profiler = join(scriptsDirectory, "profile-capacity.mjs");
const agentBuild = join(scriptsDirectory, "..", "dist", "agent.js");
const USAGE = `Usage: run-capacity-matrix.mjs --out-dir DIR [--matrix FILE] [--tmpdir DIR] [--only ID[,ID...]] [--repeat N] [--scope auto|system|user|none] [--require-scope] [--keep-fixtures] [--step-timeout-s N] [--reserve-mb N] [--min-free-disk-mb N] [--allow-overcommit] [--meminfo FILE] [--dry-run]`;
const WATCHED_CGROUP_FILES = [
	"memory.current",
	"memory.peak",
	"memory.max",
	"memory.high",
	"memory.events",
	"memory.swap.current",
	"memory.swap.peak",
	"memory.swap.max",
	"memory.swap.events",
];
const OOM_LINE = /out of memory|oom-kill|oom_kill|killed process|memory cgroup|invoked oom-killer/i;
const TAIL_BYTES = 8192;
const MIB = 1024 * 1024;
// A matrix file may omit any of these; the shipped matrix restates them so its baseline is visible.
const BUILT_IN_DEFAULTS = {
	records: 1000,
	relations: 0,
	topology: "chain",
	tail: 63,
	forgotten: 0,
	split: true,
	seedUnderLimit: true,
	repeat: 1,
};
// The profiler never needs credentials, so it gets only what node, systemd-run and git need to start.
const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
const CELL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SIZE = /^\d+[KMGT]?$/;
const NODE_ARG = /^--max-(old|semi)-space-size=\d+$/;
const MUTATE_MIXES = ["remember-heavy", "forget-heavy", "mixed"];
const NUMERIC_CELL_FIELDS = ["records", "relations", "tail", "forgotten", "durationS", "mutateOps", "mutateIntervalMs", "repeat"];
const FIXTURE_FIELDS = ["settledTurns", "queryChars", "captureCycles"];

// ---- pure helpers (exported for test/capacity.test.mjs) ------------------------------------------------------

// Parses a systemd size such as 512M into bytes; NaN when it is not digits plus an optional K/M/G/T.
export function parseSize(text) {
	const match = /^(\d+)([KMGT]?)$/.exec(String(text).trim());
	if (match === null) return Number.NaN;
	return Number(match[1]) * 1024 ** ["", "K", "M", "G", "T"].indexOf(match[2]);
}

// Reads MemTotal, MemAvailable and SwapFree (bytes, NaN when absent) from /proc/meminfo text.
export function parseMeminfo(text) {
	const read = (key) => {
		const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
		return match === null ? Number.NaN : Number(match[1]) * 1024;
	};
	return { memTotal: read("MemTotal"), memAvailable: read("MemAvailable"), swapFree: read("SwapFree") };
}

// A cgroup limit above physical RAM never binds first, so the kernel would reclaim sshd and systemd instead of the profiler.
export function checkPreflight({ cells, meminfo, reserveBytes, diskFreeBytes, minDiskBytes, fsType }) {
	const problems = [];
	const unreachable = new Set();
	if (!Number.isFinite(meminfo.memTotal) || !Number.isFinite(meminfo.memAvailable))
		problems.push("cannot read MemTotal and MemAvailable, so a memory limit cannot be checked against the host");
	else {
		const budget = meminfo.memAvailable - reserveBytes;
		for (const cell of cells) {
			if (cell.memoryMax === undefined) continue;
			const max = parseSize(cell.memoryMax);
			if (Number.isNaN(max)) problems.push(`${cell.id}: MemoryMax=${cell.memoryMax} is not a size`);
			else if (max >= meminfo.memTotal) {
				problems.push(`${cell.id}: MemoryMax=${cell.memoryMax} is at or above physical RAM (${Math.floor(meminfo.memTotal / MIB)} MiB), so the limit can never bind`);
				unreachable.add(cell.id);
			} else if (max > budget) {
				problems.push(
					`${cell.id}: MemoryMax=${cell.memoryMax} exceeds available memory ${Math.floor(meminfo.memAvailable / MIB)} MiB minus the ${Math.floor(reserveBytes / MIB)} MiB reserve`,
				);
				unreachable.add(cell.id);
			}
		}
	}
	if (Number.isFinite(meminfo.swapFree))
		for (const cell of cells) {
			const swap = cell.swapMax === undefined ? Number.NaN : parseSize(cell.swapMax);
			if (swap > meminfo.swapFree) problems.push(`${cell.id}: MemorySwapMax=${cell.swapMax} exceeds free swap ${Math.floor(meminfo.swapFree / MIB)} MiB`);
		}
	if (diskFreeBytes !== undefined && diskFreeBytes < minDiskBytes)
		problems.push(`work directory has ${Math.floor(diskFreeBytes / MIB)} MiB free, below the ${Math.floor(minDiskBytes / MIB)} MiB minimum`);
	if (fsType === "tmpfs" || fsType === "ramfs") problems.push(`work directory is on ${fsType}, which charges fixtures to RAM; use --tmpdir on the data volume`);
	return { problems, unreachable: [...unreachable] };
}

// Keeps only OOM lines that name this step's scope; lines about other processes are counted, not blamed on the cell.
export function unitOomLines(lines, unit, cgroupPath) {
	const own = [];
	let unrelated = 0;
	for (const line of lines) {
		if (!OOM_LINE.test(line)) continue;
		const named = line.includes(`${unit}.scope`) || (typeof cgroupPath === "string" && cgroupPath !== "" && line.includes(cgroupPath));
		if (!named) unrelated++;
		else if (own.length < 50) own.push(line);
	}
	return { own, unrelated };
}

// Returns the environment a profiler child may see: an allowlist plus its own TMPDIR.
export function scrubbedEnvironment(environment, workDirectory) {
	const result = {};
	for (const name of CHILD_ENV_ALLOWLIST) if (environment[name] !== undefined) result[name] = environment[name];
	result.TMPDIR = workDirectory;
	return result;
}

// Lists code paths that a user other than `uid` could have changed; root must not run code its owner can edit.
export function untrustedCodePaths(paths, uid) {
	const problems = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const info = statSync(path);
		if (info.uid !== uid) problems.push(`${path}: owned by uid ${info.uid}, not ${uid}`);
		else if ((info.mode & 0o022) !== 0) problems.push(`${path}: writable by group or others`);
	}
	return problems;
}

// An output directory must be a real directory (not a symlink) that only its owner can write.
export function outputDirectoryProblem(path, uid) {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) return `${path} is a symbolic link`;
	if (!info.isDirectory()) return `${path} is not a directory`;
	if (uid !== undefined && info.uid !== uid) return `${path} is owned by uid ${info.uid}, not ${uid}`;
	if ((info.mode & 0o022) !== 0) return `${path} is writable by group or others`;
	return undefined;
}

// A shared temporary parent is acceptable only when sticky, because the run creates its own 0700 directory inside it.
export function tmpParentProblem(path, uid) {
	const info = statSync(path);
	if (!info.isDirectory()) return `${path} is not a directory`;
	if ((info.mode & 0o1000) !== 0) return undefined;
	if (uid !== undefined && info.uid !== uid) return `${path} is owned by uid ${info.uid}, not ${uid}`;
	if ((info.mode & 0o022) !== 0) return `${path} is writable by group or others without the sticky bit`;
	return undefined;
}

// A matrix file is code that root executes: every field that reaches a command line is checked here.
export function resolveCells(source) {
	if (source === null || typeof source !== "object" || !Array.isArray(source.cells)) throw new Error("matrix needs a cells array");
	return source.cells.map((entry) => {
		const cell = { ...BUILT_IN_DEFAULTS, ...source.defaults, ...entry };
		const label = `cell ${JSON.stringify(cell.id)}`;
		const fail = (reason) => {
			throw new Error(`${label}: ${reason}`);
		};
		if (typeof cell.id !== "string" || !CELL_ID.test(cell.id)) fail(`id must match ${CELL_ID}`);
		for (const field of NUMERIC_CELL_FIELDS) if (cell[field] !== undefined && !(typeof cell[field] === "number" && Number.isFinite(cell[field]))) fail(`${field} must be a number`);
		if (cell.topology !== "chain" && cell.topology !== "dense") fail("topology must be chain or dense");
		if (cell.mutate !== undefined && !MUTATE_MIXES.includes(cell.mutate)) fail(`mutate must be one of ${MUTATE_MIXES.join(", ")}`);
		for (const field of ["split", "seedUnderLimit"]) if (typeof cell[field] !== "boolean") fail(`${field} must be a boolean`);
		if (cell.disabled !== undefined && typeof cell.disabled !== "string") fail("disabled must be a reason string");
		if (cell.memoryMax !== undefined && !(typeof cell.memoryMax === "string" && SIZE.test(cell.memoryMax))) fail("memoryMax must be a size such as 224M");
		if (cell.memoryHigh !== undefined && cell.memoryHigh !== null && !(typeof cell.memoryHigh === "string" && (SIZE.test(cell.memoryHigh) || cell.memoryHigh === "infinity")))
			fail("memoryHigh must be a size, infinity or null");
		if (cell.swapMax !== undefined && !(typeof cell.swapMax === "string" && (SIZE.test(cell.swapMax) || cell.swapMax === "infinity"))) fail("swapMax must be a size or infinity");
		if (cell.nodeArgs !== undefined && !(Array.isArray(cell.nodeArgs) && cell.nodeArgs.every((arg) => typeof arg === "string" && NODE_ARG.test(arg))))
			fail(`nodeArgs may only hold ${NODE_ARG}`);
		if (FIXTURE_FIELDS.some((field) => cell[field] !== undefined)) {
			const bounded = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
			if ((cell.settledTurns === undefined) === (cell.captureCycles === undefined))
				fail("specify exactly one of settledTurns or captureCycles");
			if (cell.settledTurns !== undefined &&
				(!bounded(cell.settledTurns, 0, 20000) ||
					(cell.settledTurns === 0 ? (cell.queryChars ?? 0) !== 0 : !bounded(cell.queryChars, 40, 2000))))
				fail("settledTurns must be 0..20000 with queryChars 40..2000 for positive turns");
			if (cell.captureCycles !== undefined && (!bounded(cell.captureCycles, 0, 30000) || cell.queryChars !== undefined))
				fail("captureCycles must be 0..30000 without queryChars");
			if (cell.mutate !== undefined || cell.durationS !== undefined || cell.mutateOps !== undefined ||
				cell.mutateIntervalMs !== undefined || cell.relations !== 0 || cell.forgotten !== 0 ||
				!cell.split || !cell.seedUnderLimit)
				fail("growth fixtures need a split, quiescent seed under the same limits, without mutation, relations or forgotten records");
		}
		return cell;
	});
}

// Turns an --only pattern into an anchored RegExp where only * is a wildcard.
export function globToRegExp(glob) {
	return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
}

// ---- run state (set by main) ---------------------------------------------------------------------------------

let values;
let outDir;
let rawDir;
let runDir;
let childEnv;
let only;
let scope;
let stepTimeoutMs;
let git;
let buildHash;
let host;
let hostClass;
let manifest;
let manifestMatrix;
let unreachableCells = new Set();
const fixtureSeeds = new Map();
let currentChild;
let interruptedSignal;

const isMain = process.argv[1] !== undefined && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) process.exit(await main());

// Returns the process exit code: 0 all cells complete, 1 a cell failed, 2 refused to run, 128+n interrupted.
async function main() {
	try {
		({ values } = parseArgs({
			options: {
				"out-dir": { type: "string" },
				matrix: { type: "string", default: join(scriptsDirectory, "capacity-matrix.default.json") },
				tmpdir: { type: "string" },
				only: { type: "string" },
				repeat: { type: "string" },
				scope: { type: "string", default: "auto" },
				"require-scope": { type: "boolean", default: false },
				"keep-fixtures": { type: "boolean", default: false },
				"step-timeout-s": { type: "string", default: "3600" },
				"reserve-mb": { type: "string", default: "64" },
				"min-free-disk-mb": { type: "string", default: "2048" },
				"allow-overcommit": { type: "boolean", default: false },
				meminfo: { type: "string" },
				"dry-run": { type: "boolean", default: false },
			},
		}));
	} catch (error) {
		return usageError(`${error.message}\n${USAGE}`);
	}
	const repeatOverride = values.repeat === undefined ? undefined : Number(values.repeat);
	stepTimeoutMs = Number(values["step-timeout-s"]) * 1000;
	const reserveBytes = Number(values["reserve-mb"]) * MIB;
	const minDiskBytes = Number(values["min-free-disk-mb"]) * MIB;
	if (
		values["out-dir"] === undefined ||
		!["auto", "system", "user", "none"].includes(values.scope) ||
		(repeatOverride !== undefined && (!Number.isSafeInteger(repeatOverride) || repeatOverride < 1)) ||
		!(stepTimeoutMs > 0) ||
		!(reserveBytes >= 0) ||
		!(minDiskBytes >= 0)
	)
		return usageError(USAGE);

	outDir = resolve(values["out-dir"]);
	rawDir = join(outDir, "raw");
	const matrixPath = resolve(values.matrix);
	const matrixText = readFileSync(matrixPath, "utf8");
	let allCells;
	try {
		const matrix = JSON.parse(matrixText);
		hostClass = typeof matrix.hostClass === "string" ? matrix.hostClass : null;
		allCells = resolveCells(matrix);
		manifestMatrix = { name: matrix.name, path: matrixPath, sha256: createHash("sha256").update(matrixText).digest("hex") };
	} catch (error) {
		return usageError(`invalid matrix ${matrixPath}: ${error.message}`);
	}
	only = values.only === undefined ? undefined : values.only.split(",").map(globToRegExp);
	const cells = allCells.filter((cell) => only === undefined || only.some((pattern) => pattern.test(cell.id)));
	const uid = process.getuid?.();
	if (uid === 0 && process.platform === "linux") {
		const untrusted = untrustedCodePaths([scriptsDirectory, profiler, matrixPath, dirname(agentBuild), agentBuild], 0);
		if (untrusted.length > 0) {
			console.error(`refusing to run repository code as root:\n  ${untrusted.join("\n  ")}\nInstall the scripts and dist under a root-owned directory (docs/capacity.md).`);
			return 2;
		}
	}
	scope = resolveScope(values.scope);

	if (scope.kind === "none" && values["require-scope"] && cells.some((cell) => cell.memoryMax !== undefined)) {
		console.error(`--require-scope: cannot enforce memory limits: ${scope.reason}`);
		return 2;
	}
	if (scope.kind === "none" && !values["dry-run"])
		console.error(`WARNING: memory limits are NOT enforced (${scope.reason}). Results are not capacity evidence.`);

	const runnable = cells.filter((cell) => cell.disabled === undefined || isSelected(cell));
	const workParent = values.tmpdir === undefined ? tmpdir() : resolve(values.tmpdir);
	const preflight = runPreflight(runnable, workParent, reserveBytes, minDiskBytes);

	if (values["dry-run"]) {
		console.log(JSON.stringify({ hostClass, preflight }));
		for (const cell of cells) {
			if (cell.disabled !== undefined && !isSelected(cell)) {
				console.log(JSON.stringify({ cell: cell.id, skipped: cell.disabled }));
				continue;
			}
			for (const plan of planCell(cell, "<fixture>"))
				console.log(
					JSON.stringify({
						cell: cell.id,
						...plan,
						command: wrapCommand("<unit>", plan.limited ? limitsOf(cell) : {}, [...(cell.nodeArgs ?? []), profiler, ...plan.args, "--out", "<out>"]),
					}),
				);
		}
		return 0;
	}
	if (preflight.problems.length > 0) {
		if (!values["allow-overcommit"]) {
			console.error(`preflight refused to run:\n  ${preflight.problems.join("\n  ")}\nLower the matrix limits or free memory; --allow-overcommit runs anyway and marks the limits unreachable.`);
			return 2;
		}
		console.error(`WARNING: --allow-overcommit with preflight problems; limits are marked unreachable:\n  ${preflight.problems.join("\n  ")}`);
	}
	unreachableCells = new Set(preflight.unreachable);

	// Everything below creates files, so the directories are vetted first and the fixtures live in a private 0700 directory.
	// An existing out-dir is vetted before mkdir, which would otherwise create raw/ inside a symlink's target.
	const existingProblem = existsSync(outDir) || isLink(outDir) ? outputDirectoryProblem(outDir, uid) : undefined;
	if (existingProblem !== undefined) {
		console.error(`refusing to write results: ${existingProblem}`);
		return 2;
	}
	mkdirSync(rawDir, { recursive: true, mode: 0o700 });
	for (const path of [outDir, rawDir]) {
		const problem = outputDirectoryProblem(path, uid);
		if (problem !== undefined) {
			console.error(`refusing to write results: ${problem}`);
			return 2;
		}
	}
	mkdirSync(workParent, { recursive: true, mode: 0o700 });
	const realParent = realpathSync(workParent);
	const parentProblem = tmpParentProblem(realParent, uid);
	if (parentProblem !== undefined) {
		console.error(`refusing to use --tmpdir: ${parentProblem}`);
		return 2;
	}
	runDir = mkdtempSync(join(realParent, "unit-capacity-run-"));
	childEnv = scrubbedEnvironment(process.env, runDir);
	git = gitFacts(uid);
	buildHash = hashFile(agentBuild);
	host = hostFacts();
	manifest = {
		schemaVersion: 1,
		kind: "capacity-matrix-run",
		startedAt: new Date().toISOString(),
		argv: process.argv.slice(2),
		hostClass,
		matrix: manifestMatrix,
		git,
		buildHash,
		scriptHashes: [hashFile(fileURLToPath(import.meta.url)), hashFile(profiler)],
		scope,
		preflight,
		tmpdir: runDir,
		host,
		cells: [],
	};
	installSignalHandlers();
	writeManifest();
	if (hostClass !== null) console.log(`host class: ${hostClass}`);
	let anyFailed = false;
	try {
		for (const cell of cells) {
			const repeat = repeatOverride ?? cell.repeat;
			for (let run = 1; run <= repeat && interruptedSignal === undefined; run++) {
				const id = repeat > 1 ? `${cell.id}.r${run}` : cell.id;
				const document = cell.disabled !== undefined && !isSelected(cell) ? skippedCell(cell, id) : await runCell(cell, id, run);
				writeAtomic(join(outDir, `${id}.json`), document);
				if (document.status !== "complete" && document.status !== "skipped") anyFailed = true;
				manifest.cells.push({ id, status: document.status, file: `${id}.json` });
				writeManifest();
				console.log(`${id}: ${document.status}`);
			}
		}
	} finally {
		if (!values["keep-fixtures"]) rmSync(runDir, { recursive: true, force: true });
		manifest.finishedAt = new Date().toISOString();
		if (interruptedSignal !== undefined) manifest.interrupted = interruptedSignal;
		writeManifest();
	}
	if (interruptedSignal !== undefined) return { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[interruptedSignal];
	return anyFailed ? 1 : 0;
}

// Kills the running step and lets the normal path remove fixtures and write the manifest; a second signal kills outright.
function installSignalHandlers() {
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => {
			if (interruptedSignal !== undefined) {
				currentChild?.kill("SIGKILL");
				return;
			}
			interruptedSignal = signal;
			currentChild?.kill("SIGTERM");
			setTimeout(() => currentChild?.kill("SIGKILL"), 10_000).unref();
		});
	}
}

// ---- cells ---------------------------------------------------------------------------------------------------

function isSelected(cell) {
	return only?.some((pattern) => pattern.test(cell.id)) === true;
}

function skippedCell(cell, id) {
	return { schemaVersion: 1, kind: "capacity-cell", id, status: "skipped", reason: cell.disabled, cell };
}

function limitsOf(cell) {
	return { memoryMax: cell.memoryMax, memoryHigh: cell.memoryHigh, swapMax: cell.swapMax };
}

// Profiler arguments shared by every step of a cell.
function fixtureArgs(cell) {
	return [
		"--records",
		String(cell.records),
		"--relations",
		String(cell.relations),
		"--topology",
		cell.topology,
		"--tail",
		String(cell.tail),
		"--forgotten",
		String(cell.forgotten),
	];
}

function mutateArgs(cell) {
	if (cell.mutate === undefined) return [];
	return [
		"--mutate",
		cell.mutate,
		...(cell.durationS === undefined ? [] : ["--duration-s", String(cell.durationS)]),
		...(cell.mutateOps === undefined ? [] : ["--mutate-ops", String(cell.mutateOps)]),
		...(cell.mutateIntervalMs === undefined ? [] : ["--mutate-interval-ms", String(cell.mutateIntervalMs)]),
	];
}

function growthArgs(cell) {
	if (cell.settledTurns !== undefined)
		return ["--settled-turns", String(cell.settledTurns), ...(cell.queryChars === undefined ? [] : ["--query-chars", String(cell.queryChars)])];
	if (cell.captureCycles !== undefined) return ["--capture-cycles", String(cell.captureCycles)];
	return [];
}

// Split cells seed in one process and measure the owner in another, so the owner peak excludes seed construction.
function planCell(cell, fixture, baseline = `${fixture}-base`) {
	const workload = growthArgs(cell);
	if (workload.length > 0)
		return [
			{ step: "seed", limited: true, args: [...fixtureArgs(cell), "--quiescent", "--phases", "seed", "--keep", baseline] },
			{ step: "grow", limited: true, args: ["--reuse", baseline, "--keep", fixture, "--phases", "grow", ...workload] },
			...["fixture-check", "replay", "startup", "probe"].map((phase) => ({
				step: phase, limited: true, args: ["--reuse", fixture, "--phases", phase],
			})),
		];
	// Foreground can append memory records and move the seed's checkpoint boundary.
	const measurePhases = cell.mutate === undefined ? "replay,startup,foreground" : "mutate";
	if (!cell.split)
		return [
			{
				step: "single",
				limited: true,
				args: [...fixtureArgs(cell), "--phases", `seed,${measurePhases}`, ...mutateArgs(cell)],
			},
		];
	return [
		{ step: "seed", limited: cell.seedUnderLimit, args: [...fixtureArgs(cell), "--phases", "seed", "--keep", fixture] },
		{ step: "measure", limited: true, args: ["--reuse", fixture, "--phases", measurePhases, ...mutateArgs(cell)] },
	];
}

async function runCell(cell, id, run) {
	const startedAt = new Date().toISOString();
	const fixture = join(runDir, `fixture-${id}`);
	// Arms at the same seed settings within one repetition share a single closed baseline.
	const seedKey = growthArgs(cell).length === 0 ? undefined : JSON.stringify([run, fixtureArgs(cell), limitsOf(cell), cell.nodeArgs]);
	const shared = fixtureSeeds.get(seedKey);
	const baseline = shared?.directory ?? `${fixture}-base`;
	const steps = [];
	let status = "complete";
	try {
		for (const plan of planCell(cell, fixture, baseline)) {
			if (interruptedSignal !== undefined) {
				status = "interrupted";
				break;
			}
			const step = plan.step === "seed" && shared !== undefined
				? { ...shared.step, sharedFrom: shared.cell }
				: await runStep(cell, id, plan);
			steps.push(step);
			if (step.status !== "complete") {
				status =
					step.status === "oom-killed" || step.status === "interrupted"
						? step.status
						: plan.step === "seed"
							? `${step.status}-in-seed`
							: step.status;
				break;
			}
			if (plan.step === "seed" && seedKey !== undefined && shared === undefined)
				fixtureSeeds.set(seedKey, { directory: baseline, step, cell: id });
		}
	} finally {
		if (!values["keep-fixtures"]) rmSync(fixture, { recursive: true, force: true });
	}
	return {
		schemaVersion: 1,
		kind: "capacity-cell",
		id,
		status,
		startedAt,
		finishedAt: new Date().toISOString(),
		hostClass,
		cell,
		git,
		buildHash,
		host,
		// True only if every step that asked for a memory limit ran under an enforced scope.
		limits: {
			requested: limitsOf(cell),
			scope,
			enforced: steps.filter((step) => step.limit.requested.memoryMax !== undefined).every((step) => step.limit.enforced),
			// False when the limit is at or above what the host can give, so the kernel would run out of memory before the cgroup binds.
			reachable: steps.filter((step) => step.limit.requested.memoryMax !== undefined).every((step) => step.limit.reachable !== false),
		},
		steps,
	};
}

async function runStep(cell, id, plan) {
	const unit = `capacity-${id.replace(/[^A-Za-z0-9_-]/g, "-")}-${plan.step}-${Date.now()}`;
	const rawBase = join(rawDir, `${id}.${plan.step}`);
	const out = `${rawBase}.json`;
	const profilerArgs = [...(cell.nodeArgs ?? []), profiler, ...plan.args, "--out", out];
	const limits = plan.limited ? limitsOf(cell) : {};
	const command = wrapCommand(unit, limits, profilerArgs);
	const startedMs = Date.now();
	const result = await execute(command, `${rawBase}.log`);
	const profile = readJson(out);
	const kernel = scope.kind === "none" ? { checked: false, reason: scope.reason } : kernelEvidence(unit, startedMs, result.cgroup?.path);
	const enforced = scope.kind !== "none" && limits.memoryMax !== undefined;
	const verified = enforced ? verifiedLimit(limits, profile) : null;
	const oom = oomEvidence(result, profile, kernel);
	let status = "complete";
	if (interruptedSignal !== undefined) status = "interrupted";
	else if (result.timedOut) status = "timeout";
	else if (oom.suspected) status = "oom-killed";
	else if (result.exitCode !== 0 || profile?.status !== "complete") status = "failed";
	else if (values["require-scope"] && limits.memoryMax !== undefined && verified !== true) status = "failed";
	return {
		step: plan.step,
		status,
		command,
		unit: scope.kind === "none" ? null : unit,
		limit: {
			requested: limits,
			enforced,
			verified,
			reachable: limits.memoryMax === undefined || preflightSkipped() ? null : !unreachableCells.has(cell.id),
			...(enforced ? {} : { reason: plan.limited ? scope.reason : "step runs outside the limit by matrix choice" }),
		},
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
		oom,
		cgroupLastObserved: result.cgroup,
		profileStatus: profile?.status ?? null,
		rawProfile: out,
		rawLog: `${rawBase}.log`,
		stderrTail: result.stderrTail,
		profile,
	};
}

function preflightSkipped() {
	return manifest?.preflight?.checked !== true;
}

// ---- running a command ---------------------------------------------------------------------------------------

function wrapCommand(unit, limits, profilerArgs) {
	const node = process.execPath;
	if (scope.kind === "none" || limits.memoryMax === undefined) return [node, ...profilerArgs];
	return [
		"systemd-run",
		...(scope.kind === "user" ? ["--user"] : []),
		"--scope",
		"--no-ask-password",
		"--quiet",
		`--unit=${unit}`,
		"-p",
		`MemoryMax=${limits.memoryMax}`,
		...(limits.memoryHigh === undefined || limits.memoryHigh === null ? [] : ["-p", `MemoryHigh=${limits.memoryHigh}`]),
		...(limits.swapMax === undefined ? [] : ["-p", `MemorySwapMax=${limits.swapMax}`]),
		"--",
		node,
		...profilerArgs,
	];
}

function execute(command, logPath) {
	return new Promise((resolveResult) => {
		const startedMs = Date.now();
		const log = createWriteStream(logPath);
		const child = spawn(command[0], command.slice(1), { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
		currentChild = child;
		// A signal that arrived between the last check and this spawn must still stop the step.
		if (interruptedSignal !== undefined) child.kill("SIGTERM");
		const watcher = watchCgroup(child.pid);
		let stderrTail = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
		}, stepTimeoutMs);
		child.stdout.on("data", (chunk) => log.write(chunk));
		child.stderr.on("data", (chunk) => {
			log.write(chunk);
			stderrTail = (stderrTail + chunk.toString()).slice(-TAIL_BYTES);
		});
		let settled = false;
		const finish = (exitCode, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (currentChild === child) currentChild = undefined;
			log.end();
			resolveResult({ exitCode, signal, timedOut, stderrTail, durationMs: Date.now() - startedMs, cgroup: watcher.stop() });
		};
		child.on("error", (error) => {
			stderrTail += `\nspawn failed: ${error.message}`;
			finish(-1, null);
		});
		child.on("close", finish);
	});
}

// Polls the child's cgroup while it runs, because a scope disappears the moment an OOM-killed process exits.
function watchCgroup(pid) {
	if (process.platform !== "linux" || pid === undefined) return { stop: () => null };
	let last = null;
	const timer = setInterval(() => {
		try {
			const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
				.split("\n")
				.find((entry) => entry.startsWith("0::"));
			const path = line?.slice(3);
			if (path === undefined || !path.endsWith(".scope")) return;
			const snapshot = { path, observedAt: new Date().toISOString() };
			for (const name of WATCHED_CGROUP_FILES) snapshot[name] = tryRead(join("/sys/fs/cgroup", path, name));
			last = snapshot;
		} catch {
			// The process may already be gone.
		}
	}, 200);
	return {
		stop: () => {
			clearInterval(timer);
			return last;
		},
	};
}

// ---- evidence ------------------------------------------------------------------------------------------------

function oomEvidence(result, profile, kernel) {
	const reasons = [];
	if (result.signal === "SIGKILL" || result.exitCode === 137) reasons.push("process killed by SIGKILL (exit 137)");
	for (const [source, text] of [
		["last observed cgroup memory.events", result.cgroup?.["memory.events"]],
		["profile end-of-run memory.events", profile?.cgroup?.["memory.events"]],
	]) {
		const kills = eventCount(text, "oom_kill");
		if (kills > 0) reasons.push(`${source}: oom_kill ${kills}`);
	}
	if (kernel.lines?.length > 0) reasons.push(`kernel log: ${kernel.lines.length} OOM line(s) naming this step's scope`);
	return { suspected: reasons.length > 0, reasons, kernel };
}

function eventCount(text, key) {
	const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text ?? "");
	return match === null ? 0 : Number(match[1]);
}

// The journal is best effort: it needs privileges the driver may not have, so failure is recorded, not hidden.
// There is no dmesg fallback: it cannot be limited to the step's window, so one old OOM line would taint every later cell.
function kernelEvidence(unit, sinceMs, cgroupPath) {
	const since = `@${Math.floor(sinceMs / 1000) - 1}`;
	const attempts = [
		["journalctl", ["-k", "--no-pager", "-o", "short-iso", "--since", since]],
		["journalctl", ["--no-pager", "-o", "short-iso", "-u", `${unit}.scope`, "--since", since]],
		...(scope.kind === "user"
			? [["journalctl", ["--user", "--no-pager", "-o", "short-iso", "-u", `${unit}.scope`, "--since", since]]]
			: []),
	];
	const sources = [];
	for (const [name, args] of attempts) {
		const result = spawnSync(name, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, env: childEnv });
		if (result.error !== undefined || result.status !== 0) {
			sources.push({ command: [name, ...args], ok: false, error: result.error?.message ?? result.stderr.trim().slice(0, 200) });
			continue;
		}
		sources.push({ command: [name, ...args], ok: true });
		const { own, unrelated } = unitOomLines(result.stdout.split("\n"), unit, cgroupPath);
		// A readable journal already covers the window.
		return { checked: true, sources, lines: own, unrelatedOomLines: unrelated };
	}
	return { checked: true, sources, lines: [], unrelatedOomLines: 0 };
}

// A step ran under the intended limits only if the profiler saw every explicitly requested value.
function verifiedLimit(limits, profile) {
	const pairs = [
		["memory.max", limits.memoryMax], ["memory.high", limits.memoryHigh], ["memory.swap.max", limits.swapMax],
	].filter(([, requested]) => requested !== undefined && requested !== null);
	if (pairs.some(([file]) => profile?.cgroup?.[file] == null)) return null;
	return pairs.every(([file, requested]) => requested === "infinity"
		? profile.cgroup[file] === "max"
		: Number(profile.cgroup[file]) === parseSize(requested));
}

// ---- scope, preflight and host -------------------------------------------------------------------------------

// A candidate scope counts only if a probe inside it reads back the memory.max it asked for.
function resolveScope(requested) {
	if (requested === "none") return { kind: "none", reason: "--scope none" };
	// A dry run must not start units: it names the scope it would try instead of probing.
	if (values["dry-run"] && requested !== "auto") return { kind: requested, reason: "dry run, scope not probed" };
	if (process.platform !== "linux") return { kind: "none", reason: `systemd-run is unavailable on ${process.platform}` };
	if (values["dry-run"]) return { kind: process.getuid?.() === 0 ? "system" : "user", reason: "dry run, scope not probed" };
	const version = spawnSync("systemd-run", ["--version"], { encoding: "utf8", env: childEnvForProbe() });
	if (version.error !== undefined || version.status !== 0) return { kind: "none", reason: "systemd-run is not installed" };
	const candidates = requested === "auto" ? (process.getuid?.() === 0 ? ["system"] : ["user", "system"]) : [requested];
	const failures = [];
	for (const kind of candidates) {
		const probe = spawnSync(
			"systemd-run",
			[
				...(kind === "user" ? ["--user"] : []),
				"--scope",
				// Without this a non-root system scope can wait for a polkit password until the timeout.
				"--no-ask-password",
				"--quiet",
				"-p",
				"MemoryMax=1G",
				"--",
				"sh",
				"-c",
				"cat /sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)/memory.max",
			],
			{ encoding: "utf8", timeout: 30_000, env: childEnvForProbe() },
		);
		if (probe.status === 0 && Number(probe.stdout.trim()) === 1024 ** 3)
			return { kind, reason: "probe read back MemoryMax=1G", version: version.stdout.split("\n")[0] };
		failures.push(`${kind}: ${probe.error?.message ?? (probe.stderr.trim().split("\n")[0] || `exit ${probe.status}, memory.max ${probe.stdout.trim()}`)}`);
	}
	return { kind: "none", reason: `no systemd scope enforced a memory limit (${failures.join("; ")})` };
}

// The probe runs before the run directory exists, so it gets the allowlist with the system temporary directory.
function childEnvForProbe() {
	return scrubbedEnvironment(process.env, tmpdir());
}

// Reads the host's memory and disk facts and checks the planned limits against them; read-only, so a dry run may call it.
function runPreflight(runnable, workParent, reserveBytes, minDiskBytes) {
	const meminfoPath = values.meminfo ?? (process.platform === "linux" ? "/proc/meminfo" : undefined);
	if (meminfoPath === undefined) return { checked: false, reason: `no /proc/meminfo on ${process.platform}`, problems: [], unreachable: [] };
	let meminfo;
	try {
		meminfo = parseMeminfo(readFileSync(meminfoPath, "utf8"));
	} catch (error) {
		return { checked: true, problems: [`cannot read ${meminfoPath}: ${error.message}`], unreachable: [] };
	}
	const existing = nearestExisting(workParent);
	let diskFreeBytes;
	try {
		const info = statfsSync(existing);
		diskFreeBytes = info.bavail * info.bsize;
	} catch {
		diskFreeBytes = undefined;
	}
	const stat = spawnSync("stat", ["-f", "-c", "%T", existing], { encoding: "utf8", timeout: 5000 });
	const fsType = stat.status === 0 ? stat.stdout.trim() : undefined;
	const { problems, unreachable } = checkPreflight({ cells: runnable, meminfo, reserveBytes, diskFreeBytes, minDiskBytes, fsType });
	return {
		checked: true,
		memTotalBytes: meminfo.memTotal,
		memAvailableBytes: meminfo.memAvailable,
		swapFreeBytes: meminfo.swapFree,
		reserveBytes,
		diskFreeBytes: diskFreeBytes ?? null,
		minDiskBytes,
		fsType: fsType ?? null,
		allowOvercommit: values["allow-overcommit"],
		problems,
		unreachable,
	};
}

// existsSync follows links, so a dangling symlink needs its own check.
function isLink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function nearestExisting(path) {
	let current = path;
	while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
	return current;
}

function hostFacts() {
	const commands = [
		["uname", ["-a"]],
		["lscpu", []],
		["free", ["-b"]],
		["swapon", ["--show"]],
		["df", ["-B1", runDir]],
		["findmnt", ["-T", runDir]],
		["stat", ["-fc", "%T", "/sys/fs/cgroup"]],
		["cat", ["/proc/meminfo"]],
		["cat", ["/proc/sys/vm/swappiness"]],
		["systemd-run", ["--version"]],
	];
	const facts = {
		platform: process.platform,
		arch: process.arch,
		release: release(),
		node: process.version,
		driverNodeExecPath: process.execPath,
		user: process.getuid?.() ?? null,
		commands: {},
	};
	for (const [name, args] of commands) {
		const result = spawnSync(name, args, { encoding: "utf8", timeout: 15_000, env: childEnv });
		facts.commands[[name, ...args].join(" ")] =
			result.error === undefined && result.status === 0
				? { ok: true, output: result.stdout.trim() }
				: { ok: false, error: result.error?.message ?? (result.stderr.trim().split("\n")[0] || `exit ${result.status}`) };
	}
	return facts;
}

// Root does not run git against a repository that its owner controls: repository config and hooks are code.
function gitFacts(uid) {
	if (uid === 0) return { sha: null, skipped: "running as root; the build hash identifies the code" };
	const run = (...args) => spawnSync("git", ["-C", scriptsDirectory, ...args], { encoding: "utf8", timeout: 15_000, env: childEnv });
	const sha = run("rev-parse", "HEAD");
	if (sha.status !== 0) return { sha: null, error: sha.stderr.trim().split("\n")[0] };
	const status = run("status", "--porcelain");
	return {
		sha: sha.stdout.trim(),
		branch: run("rev-parse", "--abbrev-ref", "HEAD").stdout.trim(),
		dirtyFiles: status.status === 0 ? status.stdout.split("\n").filter((line) => line !== "").length : null,
	};
}

// ---- small helpers -------------------------------------------------------------------------------------------

function hashFile(path) {
	try {
		return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
	} catch {
		return { path, sha256: null };
	}
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function tryRead(path) {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
}

function writeManifest() {
	writeAtomic(join(outDir, "manifest.json"), manifest);
}

// The temporary name is removed and then created exclusively, so a pre-planted symlink at that name is never followed.
function writeAtomic(path, document) {
	const temporary = `${path}.tmp`;
	rmSync(temporary, { force: true });
	writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	renameSync(temporary, path);
}

function usageError(message) {
	console.error(message);
	return 2;
}
