// Activates verified releases through a durable journal and an application-independent recovery core.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statfsSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	assertSafePath,
	installationPaths,
	ownedServiceUnit,
	readInstallation,
	trustedFile,
	trustedParents,
	validateRelease,
	withManagementLock,
	writeInstallation,
} from "./installation.mjs";

/** Derives update configuration, independent core, journal and boot recovery paths from installation identity. */
export function updatePaths(id, root = "/") {
	const installation = installationPaths(id, root);
	const configDirectory = join(installation.config, "update");
	const updaterRoot = join(resolve(root), "usr/lib/unit-001/updaters", id);
	return {
		configDirectory,
		config: join(configDirectory, "config.json"),
		trustRoot: join(configDirectory, "root.json"),
		token: join(configDirectory, "auth.token"),
		cache: join(resolve(root), "var/cache/unit-001/agents", id, "updates"),
		journal: join(configDirectory, "journal.json"),
		updaterRoot,
		cores: join(updaterRoot, "cores"),
		currentCore: join(updaterRoot, "current"),
		previousCore: join(updaterRoot, "previous"),
		recoveryCore: join(updaterRoot, "recovery"),
		prepareUnit: `unit-001-update-prepare@${id}.service`,
		finalizeUnit: `unit-001-update-recover@${id}.service`,
	};
}

/** Describes the exact owned timer and independent-core update service for one installation. */
export function updateScheduling(record, root = "/") {
	const paths = installationPaths(record.id, root);
	const prefix = `/usr/lib/unit-001/updaters/${record.id}/current`;
	return {
		serviceName: paths.updaterService,
		timerName: paths.updaterTimer,
		servicePath: join(resolve(root), "etc/systemd/system", paths.updaterService),
		timerPath: join(resolve(root), "etc/systemd/system", paths.updaterTimer),
		serviceContents: `[Unit]\nDescription=unit-001 authenticated update ${record.id}\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=${prefix}/runtime/bin/node ${prefix}/lib/update.mjs auto --id ${record.id}\n`,
		timerContents: `[Unit]\nDescription=unit-001 update schedule ${record.id}\n[Timer]\nOnCalendar=*-*-* 00,06,12,18:00:00\nRandomizedDelaySec=30m\nPersistent=true\nUnit=${paths.updaterService}\n[Install]\nWantedBy=timers.target\n`,
	};
}

/** Refuses to replace or remove unrelated scheduling units. */
export function assertUpdateSchedulingOwned(record, root = "/") {
	const scheduling = updateScheduling(record, root);
	for (const [path, contents] of [
		[scheduling.servicePath, scheduling.serviceContents],
		[scheduling.timerPath, scheduling.timerContents],
	]) {
		assertSafePath(path, root);
		if (existsSync(path)) {
			trustedFile(path, root);
			if (readFileSync(path, "utf8") !== contents) throw new Error("Preserving unexpected update scheduling unit.");
		}
	}
}

/** Removes only exact owned update service and timer files. */
export function removeUpdateScheduling(record, root = "/") {
	assertUpdateSchedulingOwned(record, root);
	const scheduling = updateScheduling(record, root);
	for (const path of [scheduling.servicePath, scheduling.timerPath]) rmSync(path, { force: true });
}

/** Restores scheduling after an explicit start only when its protected policy remains enabled. */
export async function restartUpdateScheduling(record, context) {
	const path = updatePaths(record.id, context.root).config;
	if (!existsSync(path)) return;
	trustedFile(path, context.root);
	const config = JSON.parse(readFileSync(path, "utf8"));
	if (config.schemaVersion !== 1 || config.id !== record.id || typeof config.enabled !== "boolean")
		throw new Error("Unsupported update policy.");
	if (!config.enabled) return;
	assertUpdateSchedulingOwned(record, context.root);
	const scheduling = updateScheduling(record, context.root);
	if (!existsSync(scheduling.timerPath) || !existsSync(scheduling.servicePath))
		throw new Error("Configured update scheduling units are missing.");
	await context.run("systemctl", ["enable", "--now", scheduling.timerName]);
}

function atomicJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o644);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function selectLink(path, target) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		requireSafeLink(path);
		try {
			requireSafeLink(temporary);
			rmSync(temporary, { force: true });
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		// rename replaces the link itself, never the directory it selects.
		symlinkSync(target, temporary);
		renameSync(temporary, path);
		syncDirectory(dirname(path));
	} finally {
		rmSync(temporary, { force: true });
	}
}

function requireSafeLink(path) {
	if (existsSync(path) && !lstatSync(path).isSymbolicLink()) throw new Error(`Unexpected managed pointer: ${path}`);
}

function syncDirectory(path) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function syncTree(path) {
	const info = lstatSync(path);
	if (info.isDirectory()) {
		for (const child of readdirSync(path)) syncTree(join(path, child));
		syncDirectory(path);
	} else if (info.isFile()) {
		const fd = openSync(path, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}

function stateBytes(path, prefix = "") {
	if (prefix === "control") return 0;
	const info = lstatSync(path);
	if (info.isDirectory())
		return readdirSync(path).reduce(
			(total, name) => total + stateBytes(join(path, name), prefix === "" ? name : `${prefix}/${name}`),
			0,
		);
	if (info.isSymbolicLink()) return Buffer.byteLength(readlinkSync(path));
	if (!info.isFile()) throw new Error("State contains a special file outside control; automatic update deferred.");
	return info.size;
}

/** Reads only protected root-owned journal metadata; its paths never come from application input. */
export function readUpdateJournal(id, root = "/") {
	const path = updatePaths(id, root).journal;
	assertSafePath(path, root);
	if (!existsSync(path)) return null;
	trustedFile(path, root);
	const info = lstatSync(path);
	if (
		!info.isFile() ||
		info.uid !== (resolve(root) === "/" ? 0 : process.getuid()) ||
		(info.mode & 0o022) !== 0 ||
		info.size > 65536
	)
		throw new Error("Untrusted update journal.");
	const journal = JSON.parse(readFileSync(path, "utf8"));
	if (
		journal.schemaVersion !== 1 ||
		journal.id !== id ||
		typeof journal.operationId !== "string" ||
		!["holding", "backed-up", "candidate", "committed", "restored", "complete"].includes(journal.phase)
	)
		throw new Error("Unsupported update journal.");
	return journal;
}

function normalizeTree(path) {
	const info = lstatSync(path);
	if (info.isDirectory()) {
		chmodSync(path, 0o755);
		for (const child of readdirSync(path)) normalizeTree(join(path, child));
	} else if (info.isFile()) chmodSync(path, 0o644);
	else throw new Error("Managed software must contain only regular files and directories.");
}

function coreFiles(directory, prefix = "") {
	return readdirSync(join(directory, prefix))
		.sort()
		.flatMap((name) => {
			const path = join(prefix, name);
			const info = lstatSync(join(directory, path));
			if (info.isDirectory()) return coreFiles(directory, path);
			if (!info.isFile()) throw new Error("Unexpected updater core path.");
			return path === "CORE-SHA256SUMS.json" ? [] : [path];
		});
}

function recoveryUnit(record, phase) {
	const prefix = `/usr/lib/unit-001/updaters/${record.id}/recovery`;
	const ordering = phase === "prepare" ? "Before" : "After";
	return `[Unit]\nDescription=unit-001 update ${phase} ${record.id}\n${ordering}=${installationPaths(record.id).unit}\n[Service]\nType=oneshot\nExecStart=${prefix}/runtime/bin/node ${prefix}/lib/update.mjs recover --id ${record.id} --phase ${phase}\n`;
}

/** Verifies every retained updater-core file and generated launch path before uninstall removes application entries. */
export function assertUpdateCoreOwned(record, root) {
	const paths = updatePaths(record.id, root);
	if (!existsSync(paths.updaterRoot)) return;
	assertSafePath(paths.updaterRoot, root);
	if (readdirSync(paths.updaterRoot).some((name) => !["cores", "current", "previous", "recovery"].includes(name)))
		throw new Error("Preserving unexpected updater root files.");
	for (const path of [paths.currentCore, paths.previousCore, paths.recoveryCore]) {
		try {
			if (
				!lstatSync(path).isSymbolicLink() ||
				!/^cores\/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(readlinkSync(path))
			)
				throw new Error("Preserving unexpected updater pointer.");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	for (const version of readdirSync(paths.cores)) {
		const core = join(paths.cores, version);
		const manifest = join(core, "CORE-SHA256SUMS.json");
		trustedFile(manifest, root);
		const expected = JSON.parse(readFileSync(manifest, "utf8"));
		if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(coreFiles(core).sort()))
			throw new Error("Preserving unexpected updater core inventory.");
		for (const [file, hash] of Object.entries(expected)) {
			if (
				createHash("sha256")
					.update(readFileSync(join(core, file)))
					.digest("hex") !== hash
			)
				throw new Error("Preserving modified updater core.");
		}
	}
	for (const [unit, phase] of [
		[paths.prepareUnit, "prepare"],
		[paths.finalizeUnit, "finalize"],
	]) {
		const path = join(resolve(root), "etc/systemd/system", unit);
		if (existsSync(path) && readFileSync(path, "utf8") !== recoveryUnit(record, phase))
			throw new Error("Preserving unexpected recovery unit.");
	}
	const dropin = join(resolve(root), "etc/systemd/system", `${installationPaths(record.id).unit}.d/update.conf`);
	const expected = `[Unit]\nRequires=${paths.prepareUnit}\nAfter=${paths.prepareUnit}\nWants=${paths.finalizeUnit}\n`;
	if (existsSync(dropin) && readFileSync(dropin, "utf8") !== expected)
		throw new Error("Preserving unexpected recovery drop-in.");
}

/** Removes only this installation's verified independent cores and exact generated recovery launch paths. */
export function removeUpdateCore(record, root) {
	assertUpdateCoreOwned(record, root);
	const paths = updatePaths(record.id, root);
	if (!existsSync(paths.updaterRoot)) return;
	for (const unit of [paths.prepareUnit, paths.finalizeUnit])
		rmSync(join(resolve(root), "etc/systemd/system", unit), { force: true });
	const dropin = join(resolve(root), "etc/systemd/system", `${installationPaths(record.id).unit}.d/update.conf`);
	const expected = `[Unit]\nRequires=${paths.prepareUnit}\nAfter=${paths.prepareUnit}\nWants=${paths.finalizeUnit}\n`;
	if (existsSync(dropin) && readFileSync(dropin, "utf8") !== expected)
		throw new Error("Preserving unexpected recovery drop-in.");
	rmSync(dropin, { force: true });
	rmSync(paths.updaterRoot, { recursive: true });
	const launcher = join(resolve(root), "usr/local/sbin/unit-001-update");
	if (readdirSync(dirname(paths.updaterRoot)).length === 0 && existsSync(launcher)) {
		trustedFile(launcher, root);
		if (readFileSync(launcher, "utf8") === updaterLauncher()) rmSync(launcher);
	}
}

function updaterLauncher() {
	return '#!/bin/sh\nset -eu\n[ "$#" -ge 1 ] || { echo "Usage: unit-001-update UUID command" >&2; exit 2; }\nid=$1\nshift\ncase "$id" in *[!a-f0-9-]*|\'\') echo \'Invalid installation ID\' >&2; exit 2;; esac\nunset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH\nexec "/usr/lib/unit-001/updaters/$id/current/runtime/bin/node" "/usr/lib/unit-001/updaters/$id/current/lib/update.mjs" --id "$id" "$@"\n';
}

/** Installs a versioned updater core without relying on the selected application's code or Node runtime. */
export function installUpdateCore(record, releasePath, context) {
	const { root } = context;
	const paths = updatePaths(record.id, root);
	if (!existsSync(join(releasePath, "updater"))) return false;
	validateRelease(releasePath, root);
	for (const path of [paths.updaterRoot, paths.cores, paths.configDirectory]) {
		assertSafePath(path, root);
		mkdirSync(path, { recursive: true, mode: 0o755 });
		trustedParents(join(path, ".check"), root);
	}
	const core = join(paths.cores, record.releaseVersion);
	if (!existsSync(core)) {
		const stage = mkdtempSync(join(paths.cores, ".stage-"));
		try {
			cpSync(join(releasePath, "updater"), stage, { recursive: true });
			normalizeTree(stage);
			chmodSync(join(stage, "runtime/bin/node"), 0o755);
			const manifest = Object.fromEntries(
				coreFiles(stage).map((file) => [
					file,
					createHash("sha256")
						.update(readFileSync(join(stage, file)))
						.digest("hex"),
				]),
			);
			writeFileSync(join(stage, "CORE-SHA256SUMS.json"), JSON.stringify(manifest), { mode: 0o644 });
			syncTree(stage);
			renameSync(stage, core);
			syncDirectory(paths.cores);
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	}
	trustedFile(join(core, "runtime/bin/node"), root);
	trustedFile(join(core, "lib/update.mjs"), root);
	if (!existsSync(paths.currentCore)) selectLink(paths.currentCore, `cores/${record.releaseVersion}`);
	if (!existsSync(paths.recoveryCore)) selectLink(paths.recoveryCore, `cores/${record.releaseVersion}`);
	const units = join(resolve(root), "etc/systemd/system");
	mkdirSync(units, { recursive: true });
	for (const [unit, phase] of [
		[paths.prepareUnit, "prepare"],
		[paths.finalizeUnit, "finalize"],
	]) {
		const destination = join(units, unit);
		assertSafePath(destination, root);
		if (existsSync(destination)) trustedFile(destination, root);
		if (existsSync(destination) && readFileSync(destination, "utf8") !== recoveryUnit(record, phase))
			throw new Error("Preserving unexpected recovery unit.");
		writeFileSync(destination, recoveryUnit(record, phase), { mode: 0o644 });
	}
	const dropin = join(units, `${installationPaths(record.id, root).unit}.d`);
	assertSafePath(join(dropin, "update.conf"), root);
	mkdirSync(dropin, { recursive: true });
	const dropinContents = `[Unit]\nRequires=${paths.prepareUnit}\nAfter=${paths.prepareUnit}\nWants=${paths.finalizeUnit}\n`;
	if (existsSync(join(dropin, "update.conf")) && readFileSync(join(dropin, "update.conf"), "utf8") !== dropinContents)
		throw new Error("Preserving unexpected recovery drop-in.");
	writeFileSync(join(dropin, "update.conf"), dropinContents, { mode: 0o644 });
	const launcher = join(resolve(root), "usr/local/sbin/unit-001-update");
	assertSafePath(launcher, root);
	mkdirSync(dirname(launcher), { recursive: true });
	trustedParents(launcher, root);
	const contents = updaterLauncher();
	if (existsSync(launcher) && readFileSync(launcher, "utf8") !== contents)
		throw new Error("Preserving unrelated updater launcher.");
	writeFileSync(launcher, contents, { mode: 0o755 });
	syncTree(paths.updaterRoot);
	syncDirectory(dirname(paths.updaterRoot));
	for (const path of [
		join(units, paths.prepareUnit),
		join(units, paths.finalizeUnit),
		join(dropin, "update.conf"),
		launcher,
	])
		syncTree(path);
	syncDirectory(units);
	syncDirectory(dropin);
	syncDirectory(dirname(launcher));
	return true;
}

/** Supplies bounded host commands and local controls without opening a second application storage owner. */
export function createUpdateContext(root = "/") {
	const run = (command, args, capture = false) =>
		execFileSync(command, args, {
			encoding: "utf8",
			timeout: 60000,
			maxBuffer: 1048576,
			env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
			stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		})?.trim();
	return {
		root,
		executingModule: fileURLToPath(import.meta.url),
		run,
		control(record, args, timeoutMs = args[0] === "maintenance-enter" ? 35000 : 2000) {
			const paths = installationPaths(record.id, root);
			return JSON.parse(
				run(
					"runuser",
					[
						"-u",
						record.account,
						"--",
						"timeout",
						"--signal=KILL",
						`${Math.max(1, timeoutMs) / 1000}s`,
						join(paths.current, "runtime/bin/node"),
						join(paths.current, "app/dist/named.js"),
						record.id,
						record.name,
						`/var/lib/unit-001/agents/${record.id}`,
						...args,
					],
					true,
				),
			);
		},
		async ready(record, operationId) {
			const deadline = performance.now() + 30000;
			let failure;
			do {
				try {
					const status = this.control(record, ["service-status"], Math.min(2000, deadline - performance.now()));
					if (status.inhibited && status.maintenance?.protocol === 1 && status.maintenance.state === "open") {
						this.control(record, ["maintenance-enter", "--operation-id", operationId, "--timeout-ms", "0"]);
						continue;
					}
					const pid = Number(
						run(
							"systemctl",
							["show", "--property=MainPID", "--value", installationPaths(record.id, root).unit],
							true,
						),
					);
					if (
						status.installationId !== record.id ||
						status.version !== record.releaseVersion ||
						status.pid !== pid ||
						!status.inhibited ||
						status.maintenance?.protocol !== 1 ||
						status.maintenance.state !== "held" ||
						status.maintenance.operationId !== operationId
					)
						throw new Error("Candidate failed inhibited readiness.");
					return;
				} catch (error) {
					failure = error;
				}
				await setTimeout(100);
			} while (performance.now() < deadline);
			throw failure;
		},
	};
}

function sessionLocks(record, context) {
	const directory = join(installationPaths(record.id, context.root).state, "sessions");
	if (!existsSync(directory)) return [];
	// The owner is stopped before this probe; never follow agent-controlled paths as root SQLite.
	assertSafePath(directory, context.root);
	if (!lstatSync(directory).isDirectory()) throw new Error("Session storage must be a real directory.");
	const files = readdirSync(directory);
	if (files.some((file) => file.endsWith(".sqlite") && file !== "default.sqlite"))
		throw new Error("Automatic updates require only the default managed session.");
	const locks = [];
	try {
		for (const name of files.filter((file) => file.endsWith(".lock"))) {
			const path = join(directory, name);
			if (!lstatSync(path).isFile()) throw new Error("Session ownership locks must be regular files, not symlinks.");
			const database = new DatabaseSync(path, { timeout: 0 });
			locks.push(database);
			database.exec("BEGIN EXCLUSIVE");
		}
		return locks;
	} catch (error) {
		for (const lock of locks) lock.close();
		throw error;
	}
}

function saveJournal(record, context, journal, phase) {
	journal.phase = phase;
	atomicJson(updatePaths(record.id, context.root).journal, journal);
	context.fault?.(phase);
}

function pruneCores(record, context) {
	const paths = updatePaths(record.id, context.root);
	try {
		assertUpdateCoreOwned(record, context.root);
		const keep = new Set(
			[paths.currentCore, paths.previousCore, paths.recoveryCore]
				.filter(existsSync)
				.map((path) => readlinkSync(path).slice("cores/".length)),
		);
		const journal = readUpdateJournal(record.id, context.root);
		if (journal && journal.phase !== "complete") {
			keep.add(journal.candidateVersion);
			if (journal.previousCore) keep.add(journal.previousCore.slice("cores/".length));
		}
		for (const version of readdirSync(paths.cores))
			if (!keep.has(version)) rmSync(join(paths.cores, version), { recursive: true });
		syncDirectory(paths.cores);
		return [];
	} catch (error) {
		return [`Updater cores were preserved: ${error.message}`];
	}
}

function executingCore(paths, context) {
	if (context.executingModule) {
		const module = realpathSync(context.executingModule);
		const local = relative(realpathSync(paths.cores), module);
		const match = /^(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\/lib\/update-activation\.mjs$/.exec(local);
		if (match) {
			trustedFile(join(paths.cores, local), context.root);
			trustedFile(join(paths.cores, match[1], "runtime/bin/node"), context.root);
			return `cores/${match[1]}`;
		}
	}
	return existsSync(paths.currentCore) ? readlinkSync(paths.currentCore) : null;
}

function stageRelease(candidate, context) {
	const destination = join(resolve(context.root), "opt/unit-001/releases", candidate.version);
	assertSafePath(destination, context.root);
	if (validateRelease(candidate.releasePath, context.root).version !== candidate.version)
		throw new Error("Verified candidate version does not match its payload.");
	if (!existsSync(destination)) {
		const stage = mkdtempSync(join(dirname(destination), ".update-"));
		try {
			cpSync(candidate.releasePath, stage, { recursive: true });
			normalizeTree(stage);
			for (const file of ["runtime/bin/node", "bin/agent", "install.sh"]) chmodSync(join(stage, file), 0o755);
			validateRelease(stage, context.root);
			syncTree(stage);
			renameSync(stage, destination);
			syncDirectory(dirname(destination));
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	}
	if (
		readFileSync(join(destination, "SHA256SUMS"), "utf8") !==
		readFileSync(join(candidate.releasePath, "SHA256SUMS"), "utf8")
	)
		throw new Error("A different release already uses this version.");
	validateRelease(destination, context.root);
	return destination;
}

function publishApplication(record, version, context) {
	const paths = installationPaths(record.id, context.root);
	const release = join(resolve(context.root), "opt/unit-001/releases", version);
	const journal = readUpdateJournal(record.id, context.root);
	// This one known rollback crosses the operator-unit migration. Its executing 0.0.7 core owns recovery.
	if (journal?.previousRecord.releaseVersion === "0.0.7" && journal.candidateVersion === "0.0.6") {
		ownedServiceUnit(journal.previousRecord, context.root);
		const template = readFileSync(join(release, "deploy/unit-001.service"), "utf8");
		const expected =
			version === "0.0.6"
				? "566fc74ff71df178eb6c773477ebf44d8ac9cf551aa01ab5214d126defc3b874"
				: "338be3844ce0bad92dfab8f55df482c1d062bf5795ec320441c7785cf68ccc8a";
		if (!["0.0.6", "0.0.7"].includes(version) || createHash("sha256").update(template).digest("hex") !== expected)
			throw new Error("Unsupported service policy transition; preserve the existing unit for administrator review.");
		const temporary = `${paths.unitFile}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temporary, "wx", 0o644);
			try {
				writeFileSync(fd, template.replaceAll("@ID@", record.id).replaceAll("@ACCOUNT@", record.account));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, paths.unitFile);
			syncDirectory(dirname(paths.unitFile));
		} finally {
			rmSync(temporary, { force: true });
		}
		context.fault?.("service-unit");
	}
	for (const file of ["agent-command.mjs", "installation.mjs", "lifecycle.mjs", "update-activation.mjs"]) {
		if (existsSync(join(release, "deploy", file)))
			cpSync(join(release, "deploy", file), join(paths.management, file));
	}
	selectLink(paths.current, `../../releases/${version}`);
	writeInstallation({ ...record, releaseVersion: version }, context.root);
	syncTree(paths.management);
	syncDirectory(dirname(paths.record));
}

async function waitForStatus(record, context) {
	const deadline = performance.now() + 30000;
	let failure;
	do {
		try {
			return await context.control(
				record,
				["service-status"],
				Math.min(2000, Math.max(1, deadline - performance.now())),
			);
		} catch (error) {
			failure = error;
		}
		await setTimeout(100);
	} while (performance.now() < deadline);
	throw failure;
}

async function startApplication(record, context, action = "start") {
	const unit = installationPaths(record.id, context.root).unit;
	try {
		// Controlled upgrades must not consume the crash-loop budget of the replacement process.
		await context.run("systemctl", ["reset-failed", unit]);
	} catch (error) {
		const loaded = await context.run("systemctl", ["show", "--property=LoadState", "--value", unit], true);
		if (loaded.trim() !== "not-found") throw error;
	}
	await context.run("systemctl", [action, ...(action === "enable" ? ["--now"] : []), unit]);
}

async function releaseGate(record, journal, context) {
	const current = readInstallation(record.id, context.root);
	if (current.desiredState !== "running") return;
	const status = await waitForStatus(current, context);
	if (status.maintenance?.state === "open" && !status.inhibited && journal.phase === "committed") return;
	if (status.maintenance?.state === "open")
		await context.control(current, ["maintenance-enter", "--operation-id", journal.operationId, "--timeout-ms", "0"]);
	await context.ready(current, journal.operationId);
	await context.control(current, ["maintenance-release", "--operation-id", journal.operationId]);
}

/** Activates only a compatible verified candidate; the commit journal precedes every execution release. */
export async function activateUpdate(record, candidate, context) {
	return withManagementLock(async () => {
		record = readInstallation(record.id, context.root);
		const admission = await context.admit?.(record, candidate);
		if (admission) return admission;
		if (record.desiredState !== "running") return { status: "deferred", reason: "Operator intent is stopped." };
		if (record.releaseVersion === "0.0.7" && candidate.version === "0.0.6") ownedServiceUnit(record, context.root);
		const sessions = join(installationPaths(record.id, context.root).state, "sessions");
		assertSafePath(sessions, context.root);
		if (existsSync(sessions) && !lstatSync(sessions).isDirectory())
			throw new Error("Session storage must be a real directory.");
		if (
			existsSync(sessions) &&
			readdirSync(sessions).some((file) => file.endsWith(".sqlite") && file !== "default.sqlite")
		)
			return { status: "deferred", reason: "Automatic updates require only the default managed session." };
		if (
			candidate.compatibility?.stateVersion !== 1 ||
			candidate.compatibility.minReaderVersion !== 1 ||
			candidate.compatibility.maintenanceProtocol !== 1
		)
			return { status: "incompatible", reason: "Unsupported state or maintenance compatibility." };
		const previousJournal = readUpdateJournal(record.id, context.root);
		if (previousJournal && previousJournal.phase !== "complete")
			return { status: "deferred", reason: "An update requires recovery." };
		let status;
		let closedRepair = false;
		try {
			status = await context.control(record, ["service-status"]);
		} catch {
			const state = await context.run(
				"systemctl",
				["show", "--property=ActiveState", "--value", installationPaths(record.id, context.root).unit],
				true,
			);
			if (!["failed", "inactive"].includes(state.trim()))
				return { status: "deferred", reason: "A live service is unreachable; refusing to bypass drain." };
			const metadata = JSON.parse(
				readFileSync(
					join(resolve(context.root), "opt/unit-001/releases", record.releaseVersion, "release.json"),
					"utf8",
				),
			);
			if (metadata.compatibility?.maintenanceProtocol !== 1)
				return { status: "incompatible", reason: "Closed-owner repair requires the maintenance-capable baseline." };
			closedRepair = true;
		}
		if (!closedRepair && status.maintenance?.protocol !== 1)
			return { status: "incompatible", reason: "Install the maintenance-capable baseline manually." };
		const paths = updatePaths(record.id, context.root);
		const state = installationPaths(record.id, context.root).state;
		let bytes;
		try {
			bytes = stateBytes(state);
		} catch (error) {
			return { status: "deferred", reason: error.message };
		}
		const required = 2 * bytes + 16 * 1024 * 1024;
		for (const directory of [paths.configDirectory, dirname(state)]) {
			const filesystem = statfsSync(directory);
			const available = context.availableBytes?.(directory) ?? Number(filesystem.bavail) * Number(filesystem.bsize);
			if (available < required)
				return { status: "deferred", reason: "Insufficient free space for backup and staged state recovery." };
		}
		const destination = stageRelease(candidate, context);
		const previousCore = executingCore(paths, context);
		if (previousCore) selectLink(paths.recoveryCore, previousCore);
		const operationId = randomUUID();
		const journal = {
			schemaVersion: 1,
			id: record.id,
			operationId,
			previousRecord: record,
			candidateVersion: candidate.version,
			compatibility: candidate.compatibility,
			phase: "holding",
			previousCore,
		};
		saveJournal(record, context, journal, "holding");
		try {
			const hold = closedRepair
				? { result: "drained" }
				: await context.control(record, [
						"maintenance-enter",
						"--operation-id",
						operationId,
						"--timeout-ms",
						"30000",
					]);
			if (hold.result !== "drained") {
				journal.liveDeferred = true;
				saveJournal(record, context, journal, "restored");
				await context.control(record, ["maintenance-release", "--operation-id", operationId]);
				saveJournal(record, context, journal, "complete");
				return { status: "deferred", reason: "Active work did not drain." };
			}
			await context.run("systemctl", ["stop", installationPaths(record.id, context.root).unit]);
			const locks = sessionLocks(record, context);
			try {
				const backup = join(paths.configDirectory, "backup");
				rmSync(backup, { recursive: true, force: true });
				const state = installationPaths(record.id, context.root).state;
				cpSync(state, backup, {
					recursive: true,
					verbatimSymlinks: true,
					filter: (source) => relative(state, source).split("/")[0] !== "control",
				});
				chmodSync(backup, 0o700);
				syncTree(backup);
				syncDirectory(dirname(backup));
				saveJournal(record, context, journal, "backed-up");
				installUpdateCore({ ...record, releaseVersion: candidate.version }, destination, context);
				await context.run(join(paths.cores, candidate.version, "runtime/bin/node"), [
					join(paths.cores, candidate.version, "lib/update.mjs"),
					"--help",
				]);
				publishApplication(record, candidate.version, context);
				saveJournal(record, context, journal, "candidate");
			} finally {
				for (const lock of locks) lock.close();
			}
			const updated = readInstallation(record.id, context.root);
			await context.run("systemctl", ["daemon-reload"]);
			await startApplication(record, context);
			await context.ready(updated, operationId);
			// After this publication no recovery path may restore historical state.
			saveJournal(record, context, journal, "committed");
			if (journal.previousCore) selectLink(paths.previousCore, journal.previousCore);
			selectLink(paths.currentCore, `cores/${candidate.version}`);
			await releaseGate(updated, journal, context);
			saveJournal(record, context, journal, "complete");
			const warnings = pruneCores(record, context);
			return { status: "updated", version: candidate.version, ...(warnings.length ? { warnings } : {}) };
		} catch (error) {
			if (journal.phase === "committed") throw error;
			await prepareRecovery(record, journal, context);
			await startApplication(record, context);
			await finalizeRecovery(record, journal, context);
			throw error;
		}
	}, context.root);
}

async function prepareRecovery(record, journal, context) {
	if (journal.phase === "complete" || journal.phase === "committed" || journal.phase === "restored") return;
	const paths = installationPaths(record.id, context.root);
	if (journal.phase === "holding" && !context.bootPrepare) {
		const state = await context.run("systemctl", ["show", "--property=ActiveState", "--value", paths.unit], true);
		if (state.trim() === "active") {
			const status = await context.control(record, ["service-status"]);
			if (status.version !== journal.previousRecord.releaseVersion || status.installationId !== record.id)
				throw new Error("Cannot reconcile an unexpected live owner.");
			journal.liveDeferred = true;
			saveJournal(record, context, journal, "restored");
			return;
		}
	}
	if (context.bootPrepare) {
		const state = await context.run("systemctl", ["show", "--property=ActiveState", "--value", paths.unit], true);
		if (!["inactive", "failed"].includes(state.trim()))
			throw new Error("Boot recovery requires a closed application owner.");
	} else await context.run("systemctl", ["stop", paths.unit]);
	if (journal.phase !== "holding") {
		const backup = join(updatePaths(record.id, context.root).configDirectory, "backup");
		if (!existsSync(backup)) throw new Error("Update recovery backup is missing; refusing to resume.");
		const locks = sessionLocks(record, context);
		const prepared = `${paths.state}.restore-${journal.operationId}`;
		const previous = `${paths.state}.previous-${journal.operationId}`;
		assertSafePath(prepared, context.root);
		assertSafePath(previous, context.root);
		try {
			rmSync(prepared, { recursive: true, force: true });
			cpSync(backup, prepared, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
			await context.run("chown", ["--no-dereference", "-R", `${record.account}:${record.account}`, prepared]);
			syncTree(prepared);
			syncDirectory(dirname(prepared));
			if (existsSync(previous)) rmSync(paths.state, { recursive: true, force: true });
			else if (existsSync(paths.state)) renameSync(paths.state, previous);
			syncDirectory(dirname(paths.state));
			context.fault?.("restore-quarantined");
			renameSync(prepared, paths.state);
			syncDirectory(dirname(paths.state));
		} finally {
			for (const lock of locks) lock.close();
		}
	}
	const current = readInstallation(record.id, context.root);
	publishApplication(
		{ ...journal.previousRecord, desiredState: current.desiredState },
		journal.previousRecord.releaseVersion,
		context,
	);
	const core = updatePaths(record.id, context.root);
	if (journal.previousCore) selectLink(core.currentCore, journal.previousCore);
	saveJournal(record, context, journal, "restored");
	rmSync(`${paths.state}.previous-${journal.operationId}`, { recursive: true, force: true });
	syncDirectory(dirname(paths.state));
	await context.run("systemctl", ["daemon-reload"]);
}

async function finalizeRecovery(record, journal, context) {
	if (journal.phase === "complete") return { status: "recovered" };
	if (readInstallation(record.id, context.root).desiredState !== "running")
		return { status: "deferred", reason: "Operator intent is stopped." };
	if (journal.phase === "committed") {
		const paths = updatePaths(record.id, context.root);
		if (journal.previousCore) selectLink(paths.previousCore, journal.previousCore);
		selectLink(paths.currentCore, `cores/${journal.candidateVersion}`);
	}
	if (journal.liveDeferred) {
		const current = readInstallation(record.id, context.root);
		const status = await waitForStatus(current, context);
		if (status.inhibited) await releaseGate(record, journal, context);
		else if (status.maintenance?.state === "held")
			await context.control(current, ["maintenance-release", "--operation-id", journal.operationId]);
	} else await releaseGate(record, journal, context);
	saveJournal(record, context, journal, "complete");
	const warnings = pruneCores(record, context);
	return { status: "recovered", ...(warnings.length ? { warnings } : {}) };
}

/** Repairs files before boot startup, then verifies/releases after startup without dependency cycles. */
export async function recoverUpdate(record, context, options = { phase: "all" }) {
	const phase = options.phase ?? "all";
	if (options.start === true && phase !== "all")
		throw new Error("Explicit recovery start cannot run as a boot phase.");
	const journal = readUpdateJournal(record.id, context.root);
	if (!journal || journal.phase === "complete") return { status: "idle" };
	try {
		return await withManagementLock(async () => {
			if (phase !== "finalize")
				await prepareRecovery(record, journal, { ...context, bootPrepare: phase === "prepare" });
			if (options.start === true)
				writeInstallation({ ...readInstallation(record.id, context.root), desiredState: "running" }, context.root);
			if (phase === "prepare") return { status: "prepared" };
			if (phase === "all" && readInstallation(record.id, context.root).desiredState === "running")
				await startApplication(record, context, options.start === true ? "enable" : "start");
			const result = await finalizeRecovery(record, journal, context);
			if (options.start === true && result.status === "recovered") await restartUpdateScheduling(record, context);
			return result;
		}, context.root);
	} catch (error) {
		// The orchestrator holds the same lock while starting its inhibited candidate; boot hooks must not deadlock it.
		if (phase !== "all" && error.message === "Another install, update, or lifecycle operation is running.")
			return { status: "orchestrated" };
		throw error;
	}
}

/** Rolls code back only after a new drain, preserving state written after the prior committed update. */
export async function rollbackUpdate(record, context) {
	const journal = readUpdateJournal(record.id, context.root);
	if (!journal || journal.phase !== "complete" || !journal.previousRecord)
		return { status: "incompatible", reason: "No completed update is available for rollback." };
	if (
		journal.candidateVersion !== record.releaseVersion ||
		journal.previousRecord.releaseVersion === record.releaseVersion
	)
		return { status: "incompatible", reason: "The prior update did not commit a different current release." };
	const releasePath = join(resolve(context.root), "opt/unit-001/releases", journal.previousRecord.releaseVersion);
	validateRelease(releasePath, context.root);
	const metadata = JSON.parse(readFileSync(join(releasePath, "release.json"), "utf8"));
	return activateUpdate(
		record,
		{
			releasePath,
			version: journal.previousRecord.releaseVersion,
			compatibility: metadata.compatibility,
		},
		context,
	);
}
