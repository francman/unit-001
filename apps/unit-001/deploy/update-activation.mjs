// Activates verified releases through a durable journal and an application-independent recovery core.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	fchmodSync,
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
		priorJournal: join(configDirectory, "journal-prior.json"),
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

// Every retained core reads journals up to this size; activation keeps headroom for fields later phases add.
const MAX_JOURNAL_BYTES = 65536;
const JOURNAL_HEADROOM_BYTES = 4096;

/** Reads only protected root-owned journal metadata; its paths never come from application input. */
export function readUpdateJournal(id, root = "/") {
	const journal = readProtectedJson(updatePaths(id, root).journal, root, MAX_JOURNAL_BYTES);
	if (journal === null) return null;
	if (
		journal.schemaVersion !== 1 ||
		journal.id !== id ||
		typeof journal.operationId !== "string" ||
		!["holding", "backed-up", "candidate", "committed", "restored", "complete"].includes(journal.phase)
	)
		throw new Error("Unsupported update journal.");
	return journal;
}

function readProtectedJson(path, root, limit) {
	assertSafePath(path, root);
	if (!existsSync(path)) return null;
	trustedFile(path, root);
	const info = lstatSync(path);
	if (
		!info.isFile() ||
		info.uid !== (resolve(root) === "/" ? 0 : process.getuid()) ||
		(info.mode & 0o022) !== 0 ||
		info.size > limit
	)
		throw new Error("Untrusted update journal.");
	return JSON.parse(readFileSync(path, "utf8"));
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
						process.execPath,
						fileURLToPath(new URL("./control.mjs", import.meta.url)),
						record.id,
						String(Math.max(1, Math.floor(timeoutMs))),
						...args,
					],
					true,
				),
			);
		},
		// The running release's own client asks its owner, exactly as the account's `mission status --json` would.
		missionStatus(record) {
			const release = join(resolve(root), "opt/unit-001/releases", record.releaseVersion);
			return JSON.parse(
				run(
					"runuser",
					[
						"-u",
						record.account,
						"--",
						"timeout",
						"--signal=KILL",
						"10s",
						join(release, "runtime/bin/node"),
						join(release, "app/dist/named.js"),
						record.id,
						record.name,
						`/var/lib/unit-001/agents/${record.id}`,
						"mission",
						"status",
						"--json",
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

// The template shipped through 0.0.6; lifecycle commands accept its unit and operators migrate it explicitly.
const LEGACY_TEMPLATE_SHA256 = "566fc74ff71df178eb6c773477ebf44d8ac9cf551aa01ab5214d126defc3b874";

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
				? LEGACY_TEMPLATE_SHA256
				: "338be3844ce0bad92dfab8f55df482c1d062bf5795ec320441c7785cf68ccc8a";
		if (!["0.0.6", "0.0.7"].includes(version) || createHash("sha256").update(template).digest("hex") !== expected)
			throw new Error("Unsupported service policy transition; preserve the existing unit for administrator review.");
		writeServiceUnit(paths.unitFile, renderUnit(template, record), context);
	} else if (journal?.serviceUnit) {
		// The journal holds the exact bytes approved before downtime; recovery reverses the same transition.
		const { previous, candidate } = journal.serviceUnit;
		const [from, to] = version === journal.candidateVersion ? [previous, candidate] : [candidate, previous];
		trustedFile(paths.unitFile, context.root);
		const installed = readFileSync(paths.unitFile, "utf8");
		if (installed !== to) {
			if (installed !== from) throw new Error("Refusing to change an unowned service unit.");
			writeServiceUnit(paths.unitFile, to, context);
		}
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

function renderUnit(template, record) {
	return template.replaceAll("@ID@", record.id).replaceAll("@ACCOUNT@", record.account);
}

function writeServiceUnit(path, contents, context) {
	// Keep the administrator's mode; a new file's mode would otherwise follow the process umask.
	const mode = lstatSync(path).mode & 0o7777;
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		try {
			fchmodSync(fd, mode);
			writeFileSync(fd, contents);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		syncDirectory(dirname(path));
	} finally {
		rmSync(temporary, { force: true });
	}
	context.fault?.("service-unit");
}

/** Decides before downtime whether the candidate's service template is kept, applied, or refused. */
function serviceUnitPlan(record, candidate, destination, previousJournal, context) {
	const releases = join(resolve(context.root), "opt/unit-001/releases");
	const current = releaseTemplate(join(releases, record.releaseVersion), context.root);
	const next = releaseTemplate(destination, context.root);
	const paths = installationPaths(record.id, context.root);
	trustedFile(paths.unitFile, context.root);
	const installed = reviewableText(readFileSync(paths.unitFile));
	const target = next.text === null ? null : renderUnit(next.text, record);
	const reviewed = `${candidate.version} declares service template ${next.version}`;
	const identical = current.bytes.equals(next.bytes);
	if (identical && current.version !== undefined && next.version !== undefined && current.version !== next.version)
		return refusal("incompatible", "Identical service templates declare different versions.");
	// Explicit rollback may return to the exact unit the rolled-back update replaced; it grants nothing new. This runs
	// before the unchanged-template case: a skipped-release migration replaces the unit between identical templates.
	const replaced = previousJournal?.serviceUnit;
	if (
		candidate.operation === "rollback" &&
		previousJournal?.candidateVersion === record.releaseVersion &&
		previousJournal.previousRecord.releaseVersion === candidate.version &&
		replaced?.candidate === installed &&
		replaced.candidateTemplate === current.version
	)
		return unitReplacement(
			record,
			{
				previous: installed,
				candidate: replaced.previous,
				previousTemplate: current.version,
				candidateTemplate: next.version,
				// A restored kept unit stays recognizable, so the next update can migrate it again.
				...keptReleases(replaced.candidateKeptRelease, replaced.previousKeptRelease),
			},
			context,
		);
	if (identical) {
		// Unchanged templates keep the installed unit, including administrator edits and the legacy unit.
		const skipped = installed === target ? undefined : skippedTemplate(record, previousJournal, installed, context);
		if (skipped === undefined) return { action: "keep" };
		return templateChange(record, { from: skipped, next, installed, target, reviewed }, context);
	}
	// Forward updates only raise the version; a lower one is reserved for the journal-matched rollback above.
	if (current.version === undefined || !(next.version > current.version))
		return refusal("incompatible", "A changed service template must declare a new, higher template version.");
	const from =
		installed !== null && current.text !== null && installed === renderUnit(current.text, record)
			? { ...current, release: record.releaseVersion }
			: skippedTemplate(record, previousJournal, installed, context);
	if (from === undefined)
		return refusal(
			"held",
			`Release ${reviewed}, but the installed unit is not release ${record.releaseVersion}'s template; an administrator must review the change.`,
		);
	return templateChange(record, { from, next, installed, target, reviewed }, context);
}

function refusal(status, reason) {
	return { action: "refuse", result: { status, reason } };
}

// Names the release whose exact template an older updater kept, for each side of a journaled unit replacement.
function keptReleases(previous, candidate) {
	return {
		...(previous === undefined ? {} : { previousKeptRelease: previous }),
		...(candidate === undefined ? {} : { candidateKeptRelease: candidate }),
	};
}

function releaseTemplate(release, root) {
	const template = join(release, "deploy/unit-001.service");
	const metadata = join(release, "release.json");
	trustedFile(template, root);
	trustedFile(metadata, root);
	const version = JSON.parse(readFileSync(metadata, "utf8")).compatibility?.serviceTemplate;
	const bytes = readFileSync(template);
	return {
		bytes,
		text: reviewableText(bytes),
		// Releases before template versioning declare nothing; they may only keep an unchanged template.
		version: Number.isSafeInteger(version) && version >= 1 ? version : undefined,
	};
}

// Units are reviewed only as printable ASCII lines: decoding is lossless, and JavaScript and systemd agree on every
// whitespace byte. Anything else, such as a no-break space after a hardening value, is refused before comparison.
function reviewableText(bytes) {
	return bytes.every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)) ? bytes.toString("latin1") : null;
}

/**
 * Finds the exact unit an updater before template versioning kept while it selected the current release.
 * The last journal names the release that unit came from: the older updater's journal has no unit entry, and an
 * explicit rollback of a migration records the kept release it restored. Without that evidence the unit counts as
 * edited.
 */
function skippedTemplate(record, previousJournal, installed, context) {
	if (installed === null || previousJournal?.candidateVersion !== record.releaseVersion) return undefined;
	const unit = previousJournal.serviceUnit;
	const release =
		unit === undefined
			? previousJournal.previousRecord.releaseVersion
			: unit.candidate === installed
				? unit.candidateKeptRelease
				: undefined;
	if (release === undefined || release === record.releaseVersion) return undefined;
	const path = join(resolve(context.root), "opt/unit-001/releases", release);
	if (!existsSync(path)) return undefined;
	const template = releaseTemplate(path, context.root);
	// The legacy unit keeps its documented operator migration.
	if (
		template.text === null ||
		createHash("sha256").update(template.bytes).digest("hex") === LEGACY_TEMPLATE_SHA256 ||
		renderUnit(template.text, record) !== installed
	)
		return undefined;
	return { ...template, release };
}

function templateChange(record, change, context) {
	const expansions =
		change.target === null ? ["unreviewable unit syntax"] : serviceUnitExpansions(change.installed, change.target);
	const kept =
		change.from.release === record.releaseVersion
			? ""
			: `Release ${record.releaseVersion} runs with release ${change.from.release}'s service unit, which an older updater kept. `;
	if (expansions.length > 0)
		return refusal(
			"held",
			`${kept}Release ${change.reviewed}, which changes privileged settings (${expansions.join(", ")}); an administrator must review and install it explicitly.`,
		);
	return unitReplacement(
		record,
		{
			previous: change.installed,
			candidate: change.target,
			previousTemplate: change.from.version,
			candidateTemplate: change.next.version,
			...keptReleases(change.from.release === record.releaseVersion ? undefined : change.from.release, undefined),
		},
		context,
	);
}

function unitReplacement(record, serviceUnit, context) {
	const overrides = unitPolicyOverrides(record, context.root);
	if (overrides.length > 0)
		return refusal(
			"held",
			`Other systemd files also configure ${installationPaths(record.id).unit} (${overrides.join(", ")}); an administrator must review the service template change.`,
		);
	return { action: "replace", serviceUnit };
}

// The system manager's unit search path, highest priority first (systemd.unit(5)), relative to the root.
const UNIT_SEARCH_PATHS = [
	"etc/systemd/system.control",
	"run/systemd/system.control",
	"run/systemd/transient",
	"run/systemd/generator.early",
	"etc/systemd/system",
	"etc/systemd/system.attached",
	"run/systemd/system",
	"run/systemd/system.attached",
	"run/systemd/generator",
	"usr/local/lib/systemd/system",
	"usr/lib/systemd/system",
	"lib/systemd/system",
	"run/systemd/generator.late",
];

/**
 * Lists unit files and drop-ins, other than the managed unit and the updater's recovery drop-in, that systemd would
 * merge into the effective service. A reviewed template change means nothing while any of them can override it.
 */
function unitPolicyOverrides(record, root) {
	const unit = installationPaths(record.id).unit;
	const template = unit.replace(/@[^.]*\./, "@.");
	const units = join(resolve(root), "etc/systemd/system");
	const recovery = join(units, `${unit}.d/update.conf`);
	const overrides = [];
	for (const directory of UNIT_SEARCH_PATHS.map((path) => join(resolve(root), path))) {
		if (!existsSync(directory)) continue;
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			if ((name === unit || name === template) && path !== join(units, unit)) overrides.push(path);
			if (!name.endsWith(".d") || !dropinApplies(name.slice(0, -2), unit, template)) continue;
			if (!lstatSync(path).isDirectory()) {
				overrides.push(path);
				continue;
			}
			for (const entry of readdirSync(path)) {
				const file = join(path, entry);
				if (entry.endsWith(".conf") && (file !== recovery || !ownRecoveryDropin(record, file))) overrides.push(file);
			}
		}
	}
	return overrides;
}

// Systemd merges drop-ins for the unit, its template, each dash-terminated name prefix, and every service.
function dropinApplies(name, unit, template) {
	if (name === "service" || name === unit || name === template) return true;
	const prefix = name.slice(0, -".service".length);
	return name.endsWith("-.service") && (unit.startsWith(prefix) || template.startsWith(prefix));
}

function ownRecoveryDropin(record, path) {
	const paths = updatePaths(record.id);
	return (
		lstatSync(path).isFile() &&
		readFileSync(path, "utf8") ===
			`[Unit]\nRequires=${paths.prepareUnit}\nAfter=${paths.prepareUnit}\nWants=${paths.finalizeUnit}\n`
	);
}

/** Confirms after daemon-reload that systemd loaded only the managed unit file and the updater's own drop-in. */
async function assertLoadedUnit(record, context) {
	const unit = installationPaths(record.id).unit;
	const fragment = `/etc/systemd/system/${unit}`;
	const show = async (property) =>
		String((await context.run("systemctl", ["show", `--property=${property}`, "--value", unit], true)) ?? "").trim();
	const dropins = (await show("DropInPaths")).split(/\s+/).filter((path) => path !== "");
	if ((await show("FragmentPath")) !== fragment || dropins.some((path) => path !== `${fragment}.d/update.conf`))
		throw new Error("systemd loaded service policy beyond the reviewed unit.");
}

// Changes to these cannot grant the service new access: names, ordering, restart pacing and the log tag.
// Output destinations are absent on purpose: a file or socket destination is opened with manager privileges.
const NEUTRAL_DIRECTIVES = new Set([
	"Unit.Description",
	"Unit.Documentation",
	"Unit.After",
	"Unit.Before",
	"Unit.StartLimitIntervalSec",
	"Unit.StartLimitBurst",
	"Service.Restart",
	"Service.RestartSec",
	"Service.TimeoutStartSec",
	"Service.TimeoutStopSec",
	"Service.SyslogIdentifier",
]);

// Restriction settings, weakest value first; an absent setting counts as its weakest value.
const SWITCH = ["no", "yes"];
const RESTRICTION_LEVELS = new Map([
	["Service.NoNewPrivileges", SWITCH],
	["Service.PrivateTmp", SWITCH],
	["Service.PrivateDevices", SWITCH],
	["Service.ProtectKernelTunables", SWITCH],
	["Service.ProtectKernelModules", SWITCH],
	["Service.ProtectKernelLogs", SWITCH],
	["Service.ProtectControlGroups", SWITCH],
	["Service.ProtectClock", SWITCH],
	["Service.ProtectHostname", SWITCH],
	["Service.RestrictSUIDSGID", SWITCH],
	["Service.RestrictRealtime", SWITCH],
	["Service.LockPersonality", SWITCH],
	["Service.MemoryDenyWriteExecute", SWITCH],
	["Service.RemoveIPC", SWITCH],
	["Service.ProtectSystem", ["no", "yes", "full", "strict"]],
	["Service.ProtectHome", ["no", "read-only", "yes"]],
]);

// Space-separated sets with a plain entry grammar: grants may only shrink, restrictions may only grow. Quotes,
// "-" or "+" prefixes, "~" exclusions and empty resets fall outside the grammar, so changes to them are held.
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]*$/;
const MANAGED_DIRECTORY = /^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/;
const LISTS = new Map([
	["Service.ReadWritePaths", { effect: "grant", entry: ABSOLUTE_PATH }],
	["Service.SupplementaryGroups", { effect: "grant", entry: /^[a-z_][a-z0-9_-]*$/ }],
	["Service.AmbientCapabilities", { effect: "grant", entry: /^CAP_[A-Z_]+$/ }],
	["Service.RuntimeDirectory", { effect: "grant", entry: MANAGED_DIRECTORY }],
	["Service.StateDirectory", { effect: "grant", entry: MANAGED_DIRECTORY }],
	["Service.CacheDirectory", { effect: "grant", entry: MANAGED_DIRECTORY }],
	["Service.LogsDirectory", { effect: "grant", entry: MANAGED_DIRECTORY }],
	["Service.ConfigurationDirectory", { effect: "grant", entry: MANAGED_DIRECTORY }],
	["Service.ReadOnlyPaths", { effect: "restrict", entry: ABSOLUTE_PATH }],
	["Service.InaccessiblePaths", { effect: "restrict", entry: ABSOLUTE_PATH }],
]);

/** Lists changed directives not provably free of privilege expansion; empty means only neutral or narrowing changes. */
export function serviceUnitExpansions(from, to) {
	const before = unitDirectives(from);
	const after = unitDirectives(to);
	if (before === null || after === null) return ["unreviewable unit syntax"];
	const expansions = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const old = before.get(key);
		const next = after.get(key);
		if (old === next || NEUTRAL_DIRECTIVES.has(key) || narrows(key, old, next)) continue;
		const [section, name] = key.split(".");
		expansions.push(`[${section}] ${name}`);
	}
	return expansions;
}

// Sections the classifier models; systemd ignores other sections, which would silently drop their settings.
const SECTIONS = new Set(["Unit", "Service", "Install"]);

/** Parses the reviewed unit subset into one value per directive; null means the unit needs administrator review. */
function unitDirectives(text) {
	if (!/^[\n\x20-\x7e]*$/.test(text)) return null;
	const directives = new Map();
	let section = null;
	for (const line of text.split("\n")) {
		// Continuations (including after comments), padding and specifiers change meaning outside a line diff.
		if (line.endsWith("\\") || line.startsWith(" ") || line.endsWith(" ")) return null;
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.includes("%")) return null;
		const header = /^\[([A-Za-z]+)\]$/.exec(line);
		if (header !== null) {
			if (!SECTIONS.has(header[1])) return null;
			section = header[1];
			continue;
		}
		const match = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
		if (section === null || match === null || match[2].startsWith(" ")) return null;
		const key = `${section}.${match[1]}`;
		// Repeated assignments merge or reset in order; one assignment per directive keeps the comparison exact.
		if (directives.has(key)) return null;
		directives.set(key, match[2]);
	}
	return directives;
}

function narrows(key, old, next) {
	const levels = RESTRICTION_LEVELS.get(key);
	if (levels !== undefined) {
		const before = levels.indexOf(old ?? levels[0]);
		const after = levels.indexOf(next);
		return before !== -1 && after !== -1 && after >= before;
	}
	const list = LISTS.get(key);
	if (list === undefined) return false;
	const oldEntries = listEntries(old, list.entry);
	const nextEntries = listEntries(next, list.entry);
	if (oldEntries === null || nextEntries === null) return false;
	return list.effect === "grant"
		? nextEntries.every((entry) => oldEntries.includes(entry))
		: oldEntries.every((entry) => nextEntries.includes(entry));
}

function listEntries(value, grammar) {
	if (value === undefined) return [];
	const entries = value.split(" ");
	return entries.every((entry) => grammar.test(entry) && !entry.split("/").some((part) => part === "." || part === ".."))
		? entries
		: null;
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
	// Controlled upgrades must not consume the crash-loop budget of the replacement process. Only a failed unit holds
	// one; a cold inactive unit may be unloaded, and reset-failed refuses it even after `show` reports it loaded.
	const state = await context.run("systemctl", ["show", "--property=ActiveState", "--value", unit], true);
	if (state.trim() === "failed") await context.run("systemctl", ["reset-failed", unit]);
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
		const legacyRollback = record.releaseVersion === "0.0.7" && candidate.version === "0.0.6";
		if (legacyRollback) ownedServiceUnit(record, context.root);
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
		// The signed descriptor's features decide the guard below, so the verified payload must declare the same ones.
		const features = releaseFeatures(candidate.version, context.root);
		if (!sameFeatures(features, candidate.compatibility.features))
			return {
				status: "incompatible",
				reason: "The release's features differ from its signed descriptor.",
				version: candidate.version,
			};
		// A loop-capable predecessor can replay Open while ignoring its plan binding.
		const currentFeatures = releaseFeatures(record.releaseVersion, context.root);
		const dropsPlan = currentFeatures.includes("mission-plan-gate") && !features.includes("mission-plan-gate");
		const dropsLoop = currentFeatures.includes("mission-loop") && !features.includes("mission-loop");
		const dropsReview = currentFeatures.includes("mission-review-turn") && !features.includes("mission-review-turn");
		const guarded = dropsPlan || dropsLoop || dropsReview;
		const boundHold = dropsPlan || dropsReview;
		if (guarded && closedRepair)
			return {
				status: "incompatible",
				reason: boundHold
					? "The running owner must confirm settled mission work before dropping a mission capability."
					: `The target release cannot run a mission loop. Start ${record.name}, run sudo ${record.name} mission operate close until mission status shows no live loop, then retry.`,
			};
		if (boundHold && (status.installationId !== record.id || status.version !== record.releaseVersion))
			return { status: "deferred", reason: "Cannot verify the current installation owner for mission downgrade." };
		// Asked before the journal, so the common refusal never holds admissions or touches the journal.
		const guard = { dropsPlan, dropsReview, dropsLoop };
		const refusal = await missionDowngradeRefusal(guard, record, context, "before-hold");
		if (refusal) return { status: "deferred", reason: refusal };
		const unitPlan = legacyRollback
			? { action: "keep" }
			: serviceUnitPlan(record, candidate, destination, previousJournal, context);
		if (unitPlan.action === "refuse") return { ...unitPlan.result, version: candidate.version };
		const previousCore = executingCore(paths, context);
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
			...(unitPlan.action === "replace" ? { serviceUnit: unitPlan.serviceUnit } : {}),
		};
		// JSON escaping can double unit bytes; every phase must stay readable by the retained recovery core.
		if (Buffer.byteLength(`${JSON.stringify(journal)}\n`) + JOURNAL_HEADROOM_BYTES > MAX_JOURNAL_BYTES)
			return {
				status: "incompatible",
				reason: "The update journal would exceed its size limit; the service unit is too large.",
				version: candidate.version,
			};
		if (previousCore) selectLink(paths.recoveryCore, previousCore);
		// Kept for a deferral, which must leave the committed update's journal current for rollback and migration.
		atomicJson(paths.priorJournal, { operationId, journal: previousJournal });
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
			// Asked again under the hold, where no operation can open a loop before the stop: this closes the race with
			// an open issued after the first answer.
			const held = !boundHold || (hold.protocol === 1 && hold.state === "held" && hold.operationId === operationId);
			const reason =
				hold.result === "drained" && held
					? await missionDowngradeRefusal(guard, record, context, "held")
					: "Active work did not drain.";
			if (reason) {
				journal.liveDeferred = true;
				saveJournal(record, context, journal, "restored");
				await context.control(record, ["maintenance-release", "--operation-id", operationId]);
				completeDeferral(record, journal, context);
				return { status: "deferred", reason };
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
			if (journal.serviceUnit) await assertLoadedUnit(record, context);
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

// Releases before feature flags declare none: they cannot have written a mission loop.
function releaseFeatures(version, root) {
	const metadata = join(resolve(root), "opt/unit-001/releases", version, "release.json");
	trustedFile(metadata, root);
	const features = JSON.parse(readFileSync(metadata, "utf8")).compatibility?.features;
	return Array.isArray(features) ? features : [];
}

// Exact set equality: a duplicate entry could otherwise pad a list to equal length, so ["a", "a"] would match
// ["a", "mission-loop"]. Either list with a duplicate is refused.
function sameFeatures(declared, signed) {
	const list = Array.isArray(signed) ? signed : [];
	const names = new Set(declared);
	return (
		names.size === declared.length &&
		new Set(list).size === list.length &&
		names.size === list.length &&
		list.every((feature) => names.has(feature))
	);
}

// The owner inspects tasks and reconciled state. Only the administrator-owned file can attest which intent a
// predecessor would read at startup. The management lock serializes its writer with both downgrade checks.
async function missionDowngradeRefusal({ dropsPlan, dropsReview, dropsLoop }, record, context, phase) {
	if (!dropsPlan && !dropsReview && !dropsLoop) return null;
	try {
		const view = await context.missionStatus(record);
		// A matched hold ends a parked review task. Before the hold, accept that task's presence only with
		// affirmative review status and a restricted purpose. Under the hold all tasks and drains must be gone.
		const allowParkedReview = dropsReview && phase === "before-hold";
		if (view?.loopRollback === "no-live-loop" || (allowParkedReview && view?.loopRollback === "live-loop")) {
			if (!dropsPlan && !dropsReview) return null;
			const path = join(installationPaths(record.id, context.root).config, "mission-authority.json");
			const authority = readProtectedJson(path, context.root, 65536);
			const protectedAuthority =
				view.authority === "managed-administrator" &&
				view.authorityError === null &&
				authority?.schemaVersion === 1 &&
				authority.installationId === record.id &&
				authority.session === "default";
			const restricted = protectedAuthority && appliedRestriction(authority, view.purpose, allowParkedReview);
			const noPurpose =
				dropsReview &&
				(view.purpose === null ||
					(view.purpose?.missionId === null &&
						view.purpose.revision === null &&
						view.purpose.appliedSequence === 0 &&
						view.purpose.operation === "closed")) &&
				((protectedAuthority && authority.operationIntent == null) ||
					(authority === null && view.authority === "unconfigured" && view.authorityError === null));
			if (view.purposeError === null && (restricted || noPurpose) && (!dropsReview || settledReview(view))) return null;
		}
	} catch {
		// Unavailable status or untrusted protected metadata cannot establish rollback safety.
	}
	if (dropsReview)
		return `The target cannot run mission reviews. Confirm no active or unresolved review and a closed or suspended purpose with ${record.name} mission status before retrying.`;
	if (dropsPlan)
		return `The target lacks the mission plan gate. Confirm a protected close or completed suspend and no live loop with ${record.name} mission status before retrying.`;
	return `A mission loop is live and the target release cannot run it. Run sudo ${record.name} mission operate close until mission status shows no live loop, then retry.`;
}

function settledReview(view) {
	return (
		view.planError === null &&
		(view.plan === null ||
			(view.plan?.blocker === null &&
				Array.isArray(view.plan.turns) &&
				view.plan.turns.every((turn) => turn.state === "done" || turn.state === "skipped" || turn.state === "blocked")))
	);
}

function appliedRestriction(authority, purpose, allowParkedReview) {
	const intent = authority.operationIntent;
	if (!intent || !purpose || (purpose.rollback !== "no-live-loop" && !(allowParkedReview && purpose.rollback === "live-loop")))
		return false;
	// Status parsed the protected authority. Bind its applied state to the same restrictive command, even if a
	// subsequent purpose amendment changed the newest agreement while the operation remained closed.
	return (
		Number.isSafeInteger(authority.revision) &&
		authority.revision > 0 &&
		intent.authorityRevision === authority.revision &&
		typeof intent.missionId === "string" &&
		intent.missionId.length > 0 &&
		purpose.missionId === intent.missionId &&
		Number.isSafeInteger(intent.sequence) &&
		intent.sequence > 0 &&
		purpose.appliedSequence === intent.sequence &&
		Number.isSafeInteger(intent.expectedOperationRevision) &&
		intent.expectedOperationRevision >= 0 &&
		purpose.operationRevision === intent.expectedOperationRevision + 1 &&
		((intent.action === "close" && purpose.operation === "closed") ||
			(intent.action === "suspend" && purpose.operation === "suspended"))
	);
}

/**
 * Ends an attempt that changed nothing: it deferred under the hold, or was interrupted at "holding", before any backup
 * or publication. The journal it displaced becomes current again:
 * a completed attempt journal would name the unchanged release as the update's result, and rollback would refuse every
 * retry. A journal from a core without the prior record completes as before.
 */
function completeDeferral(record, journal, context) {
	const paths = updatePaths(record.id, context.root);
	// The prior record is at most a journal plus its operation ID.
	const prior = readProtectedJson(paths.priorJournal, context.root, MAX_JOURNAL_BYTES + 1024);
	if (prior?.operationId !== journal.operationId) return saveJournal(record, context, journal, "complete");
	if (prior.journal === null) rmSync(paths.journal, { force: true });
	else atomicJson(paths.journal, prior.journal);
	rmSync(paths.priorJournal, { force: true });
	syncDirectory(paths.configDirectory);
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
	// "holding" precedes the backup and every publication, so the attempt changed nothing even when power failed or the
	// owner was stopped: like a deferral, it puts back the journal it displaced. Finalizing it as an update instead would
	// name the unchanged release as the result, and rollback would refuse every retry.
	if (journal.phase === "holding") journal.liveDeferred = true;
	else {
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
	// A retry after "restored" skips this preparation, so systemd must drop the candidate's cached unit first.
	await context.run("systemctl", ["daemon-reload"]);
	saveJournal(record, context, journal, "restored");
	rmSync(`${paths.state}.previous-${journal.operationId}`, { recursive: true, force: true });
	syncDirectory(dirname(paths.state));
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
	if (journal.liveDeferred) completeDeferral(record, journal, context);
	else saveJournal(record, context, journal, "complete");
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
			// Only this operation may lower the service template version, and only to the journal's exact unit.
			operation: "rollback",
		},
		context,
	);
}
