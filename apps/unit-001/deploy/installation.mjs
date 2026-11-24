// Validates named installation records and provides shared identity, command ownership, and management locking.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	cpSync,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	assertUpdateSchedulingOwned,
	createUpdateContext,
	installUpdateCore,
	readUpdateJournal,
	recoveryUnit,
	restartUpdateScheduling,
	smokeCandidateWebCore,
	updatePaths,
	updateScheduling,
} from "./update-activation.mjs";

/** Validates the stable UUID namespace used by every installation-owned resource. */
export function validateId(id) {
	if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
		throw new Error("Installation ID must be a canonical UUID v4.");
	return id;
}

/** Validates a conservative command name without silently changing the operator's choice. */
export function validateName(name) {
	if (typeof name !== "string" || !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name))
		throw new Error(
			"Agent name must be 1–32 lowercase letters, digits, or internal hyphens, starting with a letter.",
		);
	return name;
}

/** Derives the short dedicated account name from the immutable installation UUID. */
export function accountFor(id) {
	return `ua-${validateId(id).replaceAll("-", "").slice(0, 24)}`;
}

/** Derives fixed installation paths; records never supply executable or state paths. */
export function installationPaths(id, root = "/") {
	validateId(id);
	const filesystem = resolve(root || "/");
	const config = join(filesystem, "etc/unit-001/agents", id);
	const agentRoot = join(filesystem, "opt/unit-001/agents", id);
	const unit = `unit-001@${id}.service`;
	return {
		record: join(config, "installation.json"),
		config,
		agentRoot,
		state: join(filesystem, "var/lib/unit-001/agents", id),
		environment: join(config, "environment"),
		current: join(agentRoot, "current"),
		management: join(filesystem, "usr/lib/unit-001/agents", id),
		unit,
		unitFile: join(filesystem, "etc/systemd/system", unit),
		updaterService: `unit-001-update@${id}.service`,
		updaterTimer: `unit-001-update@${id}.timer`,
		updaterRecovery: `unit-001-update-recover@${id}.service`,
		lock: join(filesystem, "run/unit-001/management.lock"),
		wrapper: (name) => join(filesystem, "usr/local/bin", validateName(name)),
	};
}

function validateRecord(record) {
	if (typeof record !== "object" || record === null || record.schemaVersion !== 1)
		throw new Error("Unsupported installation record.");
	validateId(record.id);
	validateName(record.name);
	if (
		record.account !== accountFor(record.id) ||
		typeof record.releaseVersion !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(record.releaseVersion) ||
		!["stopped", "running", "uninstalled"].includes(record.desiredState)
	)
		throw new Error("Invalid installation ownership, release, or desired state.");
	return record;
}

/** Rejects symlink ancestors and non-directory parents before writing an installation-owned path. */
export function assertSafePath(path, root = "/") {
	const filesystem = resolve(root || "/");
	const destination = resolve(path);
	const suffix = relative(filesystem, destination);
	if (suffix === ".." || suffix.startsWith("../") || suffix.startsWith("/"))
		throw new Error("Path escapes installation root.");
	let cursor = filesystem;
	for (const component of suffix.split("/").filter(Boolean)) {
		cursor = join(cursor, component);
		let info;
		try {
			info = lstatSync(cursor);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (info.isSymbolicLink() || (cursor !== destination && !info.isDirectory()))
			throw new Error(`Unsafe installation path: ${cursor}`);
	}
}

export function trustedParents(path, root) {
	const owner = resolve(root || "/") === "/" ? 0 : process.getuid();
	let directory = dirname(path);
	const filesystem = resolve(root || "/");
	while (directory !== filesystem && directory.startsWith(`${filesystem === "/" ? "" : filesystem}/`)) {
		const parent = lstatSync(directory);
		if (parent.uid !== owner || (parent.mode & 0o022) !== 0)
			throw new Error(`Untrusted installation directory: ${directory}`);
		directory = dirname(directory);
	}
}

export function trustedFile(path, root) {
	assertSafePath(path, root);
	const info = lstatSync(path);
	const owner = resolve(root || "/") === "/" ? 0 : process.getuid();
	if (!info.isFile() || info.uid !== owner || (info.mode & 0o022) !== 0)
		throw new Error(`Installation file is not owned and protected by its administrator: ${path}`);
	trustedParents(path, root);
	return info;
}

/** Reads one administrator-owned record and rejects forged identities or writable metadata. */
export function readInstallation(id, root = "/") {
	const path = installationPaths(id, root).record;
	trustedFile(path, root);
	const record = validateRecord(JSON.parse(readFileSync(path, "utf8")));
	if (record.id !== id) throw new Error("Installation record does not match its directory.");
	return record;
}

/** Lists valid installation records, including preserved records from uninstall. */
export function listInstallations(root = "/") {
	const directory = join(resolve(root || "/"), "etc/unit-001/agents");
	assertSafePath(directory, root);
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.sort()
		.map((id) => readInstallation(validateId(id), root));
}

function atomicFile(path, contents, mode, root, { exactMode = false } = {}) {
	assertSafePath(path, root);
	mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	trustedParents(path, root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", exactMode ? 0o600 : mode);
	try {
		try {
			writeFileSync(fd, contents);
			if (exactMode) fchmodSync(fd, mode);
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
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Atomically publishes an administrator-owned record readable by the service account. */
export function writeInstallation(record, root = "/") {
	validateRecord(record);
	atomicFile(installationPaths(record.id, root).record, `${JSON.stringify(record, null, "\t")}\n`, 0o644, root, {
		exactMode: true,
	});
}

const WEB_FEATURE = "web-socket-activation";
const WEB_APPLICATION_CAPABILITY = "deploy/release-compatibility.json";
const WEB_CORE_CAPABILITY = "updater/lib/release-compatibility.json";
const WEB_ASSETS = ["app/web-dist/index.html", "app/web-dist/bootstrap.js", "app/web-dist/style.css"];
const WEB_APPLICATION_FILES = [
	"VERSION",
	"app/package.json",
	"app/dist/bin.js",
	"app/dist/cli.js",
	"app/dist/named.js",
	"app/dist/web/contract.js",
	"app/dist/web/gateway.js",
	"app/dist/web/inherited-listener.js",
	"app/dist/web/launcher.js",
	"app/dist/web/listener-lock.js",
	"app/dist/web/listener-residue.js",
	"app/dist/web/post-response.js",
	...WEB_ASSETS,
];
const WEB_MANAGEMENT_MODULES = ["installation.mjs", "agent-command.mjs", "lifecycle.mjs", "update-activation.mjs"];
// The local import closure of lib/update.mjs, plus the control entrypoint it launches as the owner.
const WEB_UPDATER_MODULES = [
	"update.mjs",
	"installation.mjs",
	"update-activation.mjs",
	"release-version.mjs",
	"update-trust.mjs",
	"control.mjs",
];
// The updater builder copies these direct packages at the core's node_modules root.
const WEB_UPDATER_PACKAGES = ["@tufjs/models", "tuf-js"];
const WEB_UPDATER_FILES = [
	...WEB_UPDATER_MODULES.map((name) => `lib/${name}`),
	...WEB_UPDATER_PACKAGES.flatMap((name) => [
		`node_modules/${name}/package.json`,
		`node_modules/${name}/dist/index.js`,
	]),
	"node_modules/tuf-js/dist/error.js",
];
const WEB_OPERATOR = /^[a-z_][a-z0-9_-]{0,253}\$?$/i;

/** Reads the protected selection, including interrupted operations that must still block incompatible releases. */
export function readWebActivation(record, root = "/") {
	const path = webPaths(record, root).config;
	if (!protectedWebPath(path, root)) return null;
	const info = trustedWebFile(path, root);
	if (info.size > 4096) throw new Error("Invalid persistent web configuration.");
	const config = JSON.parse(readFileSync(path, "utf8"));
	if (
		config === null ||
		Object.keys(config).length !== 5 ||
		config.schemaVersion !== 1 ||
		config.id !== record.id ||
		typeof config.operator !== "string" ||
		!WEB_OPERATOR.test(config.operator) ||
		!validWebUid(config.uid) ||
		!["provisioning", "configured", "revoking"].includes(config.state)
	)
		throw new Error("Invalid persistent web configuration.");
	return config;
}

/** Checks that an exact release and its bundled updater core both support persistent web. */
export function webActivationReleaseSupported(release, root) {
	try {
		const manifest = readFileSync(webReleaseFile(release, "SHA256SUMS", root), "utf8");
		return webReleaseSupportsActivation(release, root, manifest);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return false;
	}
}

function webReleaseSupportsActivation(release, root, manifest) {
	const capabilities = [WEB_APPLICATION_CAPABILITY, WEB_CORE_CAPABILITY];
	const files = [
		...capabilities,
		...WEB_APPLICATION_FILES,
		"runtime/bin/node",
		...WEB_MANAGEMENT_MODULES.map((name) => `deploy/${name}`),
		...WEB_UPDATER_FILES.map((name) => `updater/${name}`),
		"updater/runtime/bin/node",
	];
	try {
		const entries = manifest.trimEnd().split("\n");
		const buffer = Buffer.allocUnsafe(128 * 1024);
		let supported = true;
		for (const name of files) {
			const path = webReleaseFile(release, name, root);
			const suffix = `  ./${name}`;
			const matches = entries.filter((line) => line.endsWith(suffix));
			const capability = capabilities.includes(name) ? readFileSync(path) : null;
			const hash = capability === null ? hashWebFile(path, buffer) : webSha256(capability);
			if (matches.length !== 1 || matches[0] !== hash + suffix)
				throw new Error(`Persistent web release checksum failed: ${name}`);
			if (capability !== null && !hasWebCapability(capability)) supported = false;
		}
		for (const name of WEB_UPDATER_PACKAGES) {
			const path = webReleaseFile(release, `updater/node_modules/${name}/package.json`, root);
			if (lstatSync(path).size > 65536) throw new Error(`Unexpected persistent web updater package metadata: ${name}`);
			const metadata = JSON.parse(readFileSync(path, "utf8"));
			if (metadata?.name !== name || metadata.main !== "dist/index.js" || Object.hasOwn(metadata, "exports"))
				throw new Error(`Unexpected persistent web updater package entrypoint: ${name}`);
		}
		return supported;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return false;
	}
}

function webReleaseFile(release, name, root) {
	const path = join(release, name);
	if (root !== undefined) trustedFile(path, root);
	else {
		assertSafePath(path, release);
		if (!lstatSync(path).isFile()) throw new Error(`Expected a regular release file: ${name}`);
	}
	return path;
}

function assertWebTraversable(path, root) {
	const filesystem = resolve(root || "/");
	for (let directory = dirname(path); directory !== filesystem; directory = dirname(directory)) {
		// A service account may match the file's group or fall through to other permissions.
		if ((lstatSync(directory).mode & 0o011) !== 0o011)
			throw new Error(`Persistent web directory must be searchable by non-root accounts: ${directory}`);
	}
}

function assertWebReadable(path, root) {
	if ((trustedFile(path, root).mode & 0o044) !== 0o044)
		throw new Error(`Persistent web file must be readable by non-root accounts: ${path}`);
	assertWebTraversable(path, root);
}

function assertWebExecutable(path, root) {
	if ((trustedFile(path, root).mode & 0o7777) !== 0o755)
		throw new Error(`Expected installed persistent web executable mode 0755: ${path}`);
	assertWebTraversable(path, root);
}

/** Checks the installed application runtime and assets used by the owner and operator. */
export function assertWebApplicationUsable(release, root) {
	assertWebExecutable(join(release, "runtime/bin/node"), root);
	assertWebReadable(join(release, WEB_APPLICATION_CAPABILITY), root);
	for (const name of WEB_APPLICATION_FILES) assertWebReadable(join(release, name), root);
	for (const name of WEB_MANAGEMENT_MODULES) assertWebReadable(join(release, "deploy", name), root);
}

/** Checks the installed core runtime and modules, including the owner-side control client. */
export function assertWebCoreUsable(core, root) {
	assertWebExecutable(join(core, "runtime/bin/node"), root);
	for (const name of WEB_UPDATER_FILES) assertWebReadable(join(core, name), root);
}

/** Exercises the actual named entrypoint and browser assets without starting an owner or a listener. */
export async function smokeWebApplication(record, uid, release, context) {
	assertWebApplicationUsable(release, context.root);
	const assets = WEB_ASSETS.map((name) => join(release, name));
	const readAssets = `import { readFileSync } from "node:fs"; for (const file of ${JSON.stringify(assets)}) readFileSync(file);`;
	const entry = join(release, "app/dist/named.js");
	const args = [entry, record.id, record.name, `/var/lib/unit-001/agents/${record.id}`, "--operator", "--version"];
	await runWebSmoke(record.account, release, [], args, context);
	await runWebSmoke(uid, release, [`--import=data:text/javascript,${encodeURIComponent(readAssets)}`], args, context);
}

/** Loads the actual updater and owner-side control entrypoints without opening update policy or the owner. */
export async function smokeWebCore(record, core, context) {
	assertWebCoreUsable(core, context.root);
	await runWebSmoke(
		record.account,
		core,
		[`--import=${pathToFileURL(join(core, "lib/control.mjs")).href}`],
		[join(core, "lib/update.mjs"), "--help"],
		context,
	);
}

async function runWebSmoke(user, directory, flags, args, { root, run }) {
	const node = join(directory, "runtime/bin/node");
	const nodeArgs = ["--no-global-search-paths", "--permission", `--allow-fs-read=${directory}`, ...flags, ...args];
	try {
		if (root === "/") {
			const uid = typeof user === "number" ? user : Number(await run("id", ["-u", "--", user], true));
			if (!validWebUid(uid)) throw new Error("Expected an unprivileged smoke identity.");
			// Keep the short-lived probe outside the owner's service, with no sockets or writable installation paths.
			await run(
				"systemd-run",
				[
					"--wait",
					"--pipe",
					"--collect",
					"--quiet",
					`--uid=${uid}`,
					"--property=WorkingDirectory=/",
					"--property=RuntimeMaxSec=15s",
					"--property=NoNewPrivileges=yes",
					"--property=CapabilityBoundingSet=",
					"--property=ProtectSystem=strict",
					"--property=ProtectHome=yes",
					"--property=PrivateTmp=yes",
					"--property=InaccessiblePaths=-/var/lib/unit-001 -/etc/unit-001",
					"--property=SystemCallFilter=~socket connect bind listen accept accept4",
					"--property=UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH",
					"/usr/bin/env",
					"-i",
					"HOME=/nonexistent",
					"PATH=/usr/bin:/bin",
					"LANG=C.UTF-8",
					node,
					...nodeArgs,
				],
				true,
			);
		} else {
			if (process.geteuid?.() === 0) throw new Error("Stage a persistent web image as a non-root user.");
			await run("/usr/bin/env", ["-i", "HOME=/nonexistent", process.execPath, ...nodeArgs], true);
		}
	} catch (error) {
		throw new Error(`Persistent web package smoke failed for ${user}: ${args[0]}. ${error.message}`, { cause: error });
	}
}

/** Selects one installed OS operator under the caller's management lock. */
export async function configureWebActivation(record, username, context) {
	const { root, run } = context;
	if (record.desiredState === "uninstalled") throw new Error("Install this agent before enabling persistent web.");
	const release = qualifiedWebRelease(record, root);
	const cores = assertWebSelectedCores(record, root);
	const uid = await eligibleWebOperator(record, username, run);
	await assertWebManagement(record, release, context);
	const previous = readWebActivation(record, root);
	if (previous?.state === "revoking") throw new Error("Finish disabling persistent web before enabling it again.");
	if (previous && (previous.operator !== username || previous.uid !== uid))
		throw new Error("Disable persistent web before changing the selected operator.");
	validateRelease(release, root, { protectedContents: true });
	await smokeWebApplication(record, uid, release, context);
	for (const core of cores) await smokeWebCore(record, core, context);

	const config = { schemaVersion: 1, id: record.id, operator: username, uid, state: "provisioning" };
	const paths = webPaths(record, root);
	const units = webUnits(record, uid, paths);
	const owned = inspectWebFiles(paths, units, previous, root);
	const socketState = await webUnitStartState(units[0], context);
	const serviceState = await webUnitStartState(units[1], context);
	if ((!owned.units[0] && socketState !== null) || (!owned.units[1] && serviceState !== null))
		throw new Error("Preserving unexpected loaded persistent web unit.");
	checkWebListener(paths, config, socketState, root);
	if (previous?.state === "configured" && owned.link && owned.units.every(Boolean) && socketState && serviceState) {
		if (record.desiredState === "running" && socketState !== "active") {
			await startWebSocket(record, units[0], await reloadWebUnits(record, uid, context), context);
		}
		return previous;
	}

	// The service condition stays closed until both unit files and their only enablement link are durable.
	atomicFile(paths.config, `${JSON.stringify(config)}\n`, 0o644, root, { exactMode: true });
	for (const [index, unit] of units.entries()) {
		if (!owned.units[index]) atomicFile(unit.path, unit.bytes, 0o644, root, { exactMode: true });
	}
	if (!owned.link) {
		mkdirSync(dirname(paths.wants), { recursive: true, mode: 0o755 });
		trustedParents(paths.wants, root);
		symlinkSync(units[0].target, paths.wants);
		syncWebParent(paths.wants);
		syncWebParent(dirname(paths.wants));
	}
	await startWebSocket(record, units[0], await reloadWebUnits(record, uid, context), context);
	const configured = { ...config, state: "configured" };
	atomicFile(paths.config, `${JSON.stringify(configured)}\n`, 0o644, root, { exactMode: true });
	return configured;
}

/** Disables and fully stops the pair before removing its protected selection under the caller's lock. */
export async function removeWebActivation(record, context) {
	const { root, run } = context;
	const paths = webPaths(record, root);
	const config = readWebActivation(record, root);
	const units = webUnits(record, config?.uid, paths);
	if (config === null) {
		inspectWebFiles(paths, units, null, root);
		checkWebListener(paths, null, null, root);
		return;
	}
	if (config.state !== "revoking") {
		atomicFile(paths.config, `${JSON.stringify({ ...config, state: "revoking" })}\n`, 0o644, root, {
			exactMode: true,
		});
	}
	const owned = inspectWebFiles(paths, units, config, root);
	if (owned.units.some((exists) => !exists)) await run("systemctl", ["daemon-reload"]);
	const socket = await webUnitDetails(units[0], context, true);
	await webUnitDetails(units[1], context, true);
	checkWebListener(paths, config, socket?.state, root);
	if (owned.link) {
		rmSync(paths.wants);
		syncWebParent(paths.wants);
	}
	await run("systemctl", ["daemon-reload"]);
	await stopOwnedWebUnits(paths, units, config, context);
	for (const unit of units) {
		const state = await webUnitDetails(unit, context, true);
		assertWebUnitQuiescent(state, context);
		if (state?.state === "failed") {
			try {
				await run("systemctl", ["reset-failed", unit.name]);
			} catch (error) {
				if ((await webUnitDetails(unit, context, true)) !== null) throw error;
			}
			if ((await webUnitDetails(unit, context, true))?.state === "failed")
				throw new Error("Persistent web failed state did not clear.");
		}
	}
	// Keep the revoking record until the manager and filesystem no longer have either unit.
	const stopped = inspectWebFiles(paths, units, config, root);
	if (stopped.link) throw new Error("Persistent web was re-enabled during removal.");
	for (const [index, unit] of units.entries()) {
		if (stopped.units[index]) rmSync(unit.path);
	}
	if (stopped.units.some(Boolean)) syncWebParent(units[0].path);
	await run("systemctl", ["daemon-reload"]);
	for (const unit of units) {
		if ((await webUnitDetails(unit, context)) !== null) throw new Error("Persistent web units remain loaded.");
	}
	rmSync(paths.config);
	syncWebParent(paths.config);
}

// The shell installer calls this after the owner stop, under its existing management lock.
async function quiesceWebActivation(record, context) {
	const { root } = context;
	const config = readWebActivation(record, root);
	if (config === null) return;
	const paths = webPaths(record, root);
	const units = webUnits(record, config.uid, paths);
	await stopOwnedWebUnits(paths, units, config, context);
}

async function stopOwnedWebUnits(paths, units, config, context) {
	const { root, run } = context;
	const { units: owned } = inspectWebFiles(paths, units, config, root);
	const loaded = [];
	for (const [index, unit] of units.entries()) {
		const details = await webUnitDetails(unit, context, true);
		if (!details?.loaded) continue;
		if (!owned[index] || details.fields.NeedDaemonReload !== "no")
			throw new Error(`Cannot prove ownership of loaded persistent web unit: ${unit.name}`);
		loaded.push(unit.name);
	}
	// Foreign Requires edges can propagate a normal stop to other units, including the owner.
	if (loaded.length) await run("systemctl", ["stop", "--job-mode=ignore-dependencies", ...loaded]);
	for (const unit of units) assertWebUnitQuiescent(await webUnitDetails(unit, context, true), context);
	checkWebListener(paths, null, null, root);
}

function webPaths(record, root) {
	const paths = installationPaths(record.id, root);
	const base = `unit-001-web@${record.id}`;
	const listener = `/run/unit-001-web/${record.id}.sock`;
	return {
		config: join(paths.config, "web-activation.json"),
		listener,
		listenerPath: join(resolve(root || "/"), listener),
		unitDirectory: dirname(paths.unitFile),
		wants: join(dirname(paths.unitFile), `${paths.unit}.wants`, `${base}.socket`),
		owner: paths.unit,
		socket: `${base}.socket`,
		service: `${base}.service`,
	};
}

// Configuration schemaVersion 1 fixes these generated bytes. Keep this renderer for teardown when adding a later layout.
function webUnits(record, uid, paths) {
	const { id } = record;
	const current = `/opt/unit-001/agents/${id}/current`;
	const core = `/usr/lib/unit-001/updaters/${id}/recovery`;
	const helper = `/usr/lib/unit-001/agents/${id}/installation.mjs`;
	const check = `${core}/runtime/bin/node ${helper} web-check ${id} ${uid}`;
	// Failed starts during an owner hold must drop pending connections and keep activation available for a fresh retry.
	const socket = `[Unit]
Description=unit-001 web listener ${id}
DefaultDependencies=no
After=${paths.owner}
Requisite=${paths.owner}
PartOf=${paths.owner}
Before=shutdown.target
Conflicts=shutdown.target

[Socket]
ListenStream=${paths.listener}
Accept=no
Service=${paths.service}
FileDescriptorName=unit-001-web
FlushPending=yes
TriggerLimitIntervalSec=0
PollLimitIntervalSec=2s
PollLimitBurst=5
SocketUser=${uid}
SocketMode=0600
DirectoryMode=0755
RemoveOnStop=yes
ExecStartPre=${check} socket

[Install]
WantedBy=${paths.owner}
`;
	const service = `[Unit]
Description=unit-001 web gateway ${id}
After=${paths.socket}
Requisite=${paths.owner} ${paths.socket}
PartOf=${paths.socket}
StartLimitIntervalSec=0

[Service]
Type=exec
User=${uid}
ExecCondition=${check}
ExecStart=${current}/runtime/bin/node ${current}/app/dist/named.js ${id} web /var/lib/unit-001/agents/${id} --web-service
KillMode=control-group
TimeoutStartSec=15s
TimeoutStopSec=10s
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX
SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register
SystemCallErrorNumber=EPERM
UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
StandardOutput=journal
StandardError=journal
`;
	return [
		{ name: paths.socket, bytes: socket },
		{ name: paths.service, bytes: service },
	].map((unit) => ({ ...unit, path: join(paths.unitDirectory, unit.name), target: `/etc/systemd/system/${unit.name}` }));
}

function protectedWebPath(path, root) {
	assertSafePath(dirname(path), root);
	try {
		const info = lstatSync(path);
		trustedParents(path, root);
		return info;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		// An absent leaf is meaningful only if an untrusted directory could not have hidden it.
		for (let parent = dirname(path); parent !== resolve(root || "/"); parent = dirname(parent)) {
			if (existsSync(parent)) {
				trustedParents(join(parent, ".check"), root);
				break;
			}
		}
		return null;
	}
}

function trustedWebFile(path, root) {
	trustedFile(path, root);
	const info = lstatSync(path);
	if (info.nlink !== 1 || (info.mode & 0o7777) !== 0o644)
		throw new Error(`Unexpected mode or links on persistent web file: ${path}`);
	return info;
}

function inspectWebFiles(paths, units, config, root) {
	const entries = units.map((unit) => {
		if (!protectedWebPath(unit.path, root)) return false;
		if (config === null) throw new Error(`Preserving unregistered persistent web unit: ${unit.path}`);
		trustedWebFile(unit.path, root);
		if (!readFileSync(unit.path).equals(Buffer.from(unit.bytes)))
			throw new Error(`Preserving unexpected persistent web unit: ${unit.path}`);
		return true;
	});
	const link = protectedWebPath(paths.wants, root);
	if (
		link &&
		(config === null ||
			!link.isSymbolicLink() ||
			link.uid !== webRootUid(root) ||
			readlinkSync(paths.wants) !== units[0].target)
	)
		throw new Error(`Preserving unexpected persistent web enablement: ${paths.wants}`);
	return { units: entries, link: link !== null };
}

function checkWebListener(paths, config, socketState, root) {
	const directory = dirname(paths.listenerPath);
	const parent = protectedWebPath(directory, root);
	if (parent && (!parent.isDirectory() || parent.uid !== webRootUid(root) || (parent.mode & 0o7777) !== 0o755))
		throw new Error(`Preserving unexpected persistent web directory: ${directory}`);
	const info = protectedWebPath(paths.listenerPath, root);
	// The operator can chmod their own socket, but only the administrator can replace it in this directory.
	if (
		info &&
		(!config || !["active", "activating", "deactivating"].includes(socketState) || !info.isSocket() || info.uid !== config.uid)
	)
		throw new Error(`Preserving unexpected persistent web listener: ${paths.listenerPath}`);
}

async function webUnitStartState(unit, context) {
	const details = await webUnitDetails(unit, context);
	if (details === null) return null;
	if (details.fields.NeedDaemonReload !== "no" || details.fields.DropInPaths !== "")
		throw new Error(`Unexpected loaded configuration for starting persistent web unit: ${unit.name}`);
	return details.state;
}

async function webUnitDetails(unit, context, allowUnlinkedFailed = false) {
	const fields = await readWebUnitProperties(
		unit.name,
		"LoadState,ActiveState,FragmentPath,DropInPaths,NeedDaemonReload,Job,MainPID,ControlPID,ControlGroup",
		context,
	);
	const details = { state: fields.ActiveState, loaded: fields.LoadState === "loaded", fields };
	if (fields.LoadState === "not-found" && fields.FragmentPath === "") {
		assertWebUnitQuiescent(details, context);
		if (details.state === "inactive") return null;
		if (allowUnlinkedFailed && details.state === "failed" && fields.DropInPaths === "") return details;
	}
	// Drop-ins can change the transaction while the primary fragment still identifies the owned unit.
	if (!details.loaded || fields.FragmentPath !== unit.target || !details.state)
		throw new Error(`Preserving unexpected loaded persistent web unit: ${unit.name}`);
	return details;
}

async function readWebUnitProperties(name, keys, { run }) {
	const output = await run("systemctl", ["show", "--all", `--property=${keys}`, name], true);
	return Object.fromEntries(output.trim().split("\n").map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
}

function assertWebUnitQuiescent(details, { root }) {
	if (details === null) return;
	const { fields, state } = details;
	if (
		!["inactive", "failed"].includes(state) ||
		![fields.Job, fields.MainPID, fields.ControlPID].every((value) => value === undefined || value === "" || value === "0")
	)
		throw new Error("Persistent web units have not stopped.");
	if (!fields.ControlGroup) return;
	if (!fields.ControlGroup.startsWith("/") || fields.ControlGroup.split("/").includes(".."))
		throw new Error("Unexpected persistent web control group.");
	const events = join(resolve(root || "/"), "sys/fs/cgroup", fields.ControlGroup, "cgroup.events");
	try {
		if (!readFileSync(events, "utf8").split("\n").includes("populated 0"))
			throw new Error("Persistent web control group has not emptied.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

async function reloadWebUnits(record, uid, context) {
	await context.run("systemctl", ["daemon-reload"]);
	return assertWebUnitsReady(record, uid, context);
}

async function assertWebUnitsReady(record, uid, context) {
	// Cold activation follows the shipped relations. Administrator dependency customizations can change the transaction.
	const paths = webPaths(record, context.root);
	const [socket, service] = webUnits(record, uid, paths);
	const state = await webUnitStartState(socket, context);
	if (state === null || (await webUnitStartState(service, context)) === null)
		throw new Error("Persistent web units were not loaded.");
	return state;
}

async function startWebSocket(record, socket, socketState, { root, run }) {
	if (record.desiredState !== "running" || socketState === "active") return;
	const owner = installationPaths(record.id, root).unit;
	const active = await run("systemctl", ["show", "--property=ActiveState", "--value", owner], true);
	if (active.trim() === "active") await run("systemctl", ["start", socket.name]);
}

function syncWebParent(path) {
	const fd = openSync(dirname(path), "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function webRootUid(root) {
	return resolve(root || "/") === "/" ? 0 : process.getuid();
}

function webSha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function hasWebCapability(bytes) {
	const features = JSON.parse(bytes.toString("utf8"))?.features;
	return Array.isArray(features) && features.includes(WEB_FEATURE);
}

function validWebUid(uid) {
	return Number.isInteger(uid) && uid > 0 && uid < 4294967295 && uid !== 65535;
}

async function eligibleWebOperator(record, username, run) {
	if (typeof username !== "string" || !WEB_OPERATOR.test(username) || username === record.account)
		throw new Error("Select an eligible non-root operator account.");
	const account = async (key) => {
		const entry = (await run("getent", ["passwd", String(key)], true)).trim();
		const fields = entry.split(":");
		if (entry.includes("\n") || fields.length !== 7 || !/^[1-9]\d*$/.test(fields[2]) || !/^[1-9]\d*$/.test(fields[3]))
			throw new Error("Invalid OS account for persistent web.");
		return { name: fields[0], uid: Number(fields[2]), gid: Number(fields[3]) };
	};
	const operator = await account(username);
	const owner = await account(record.account);
	if (
		operator.name !== username ||
		!validWebUid(operator.uid) ||
		owner.name !== record.account ||
		!validWebUid(owner.uid) ||
		operator.uid === owner.uid
	)
		throw new Error("Select an eligible non-root operator account distinct from the installation account.");
	const byUid = await account(operator.uid);
	if (byUid.name !== username || byUid.uid !== operator.uid)
		throw new Error("The persistent web account does not resolve by numeric UID.");
	const groups = (await run("id", ["-G", "--", username], true)).trim().split(/\s+/);
	if (!groups.includes(String(owner.gid))) throw new Error("The selected account is not an installation operator.");
	return operator.uid;
}

function selectedWebRelease(record, root) {
	const paths = installationPaths(record.id, root);
	const current = protectedWebPath(paths.current, root);
	if (
		!current?.isSymbolicLink() ||
		current.uid !== webRootUid(root) ||
		readlinkSync(paths.current) !== `../../releases/${record.releaseVersion}`
	)
		throw new Error("Unexpected current application pointer for persistent web.");
	// The service reaches the release through this selector, whose ancestry is independent of the target.
	assertWebTraversable(paths.current, root);
	assertWebReadable(paths.record, root);
	const release = join(resolve(root || "/"), "opt/unit-001/releases", record.releaseVersion);
	assertWebApplicationUsable(release, root);
	if (
		readFileSync(join(release, "VERSION"), "utf8").trim() !== record.releaseVersion ||
		!hasWebCapability(readFileSync(join(release, WEB_APPLICATION_CAPABILITY)))
	)
		throw new Error("The selected application release does not support persistent web.");
	return release;
}

function selectedWebCore(record, selection, root) {
	const path = join(updatePaths(record.id, root).updaterRoot, selection);
	const pointer = protectedWebPath(path, root);
	const target = pointer?.isSymbolicLink() && pointer.uid === webRootUid(root) && readlinkSync(path);
	if (!target || !/^cores\/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(target))
		throw new Error(`The selected ${selection} updater core is missing or unexpected.`);
	return join(dirname(path), target);
}

function qualifiedWebRelease(record, root) {
	const release = selectedWebRelease(record, root);
	if (!webActivationReleaseSupported(release, root))
		throw new Error("The selected application release does not support persistent web.");
	return release;
}

function assertWebSelectedCores(record, root) {
	const { cores } = updatePaths(record.id, root);
	const verified = new Set();
	for (const selection of ["current", "recovery"]) {
		const core = selectedWebCore(record, selection, root);
		if (verified.has(core)) continue;
		const release = join(resolve(root || "/"), "opt/unit-001/releases", relative(cores, core));
		try {
			assertWebCoreMatchesRelease(core, release, root);
		} catch (error) {
			throw new Error(`The selected ${selection} updater core does not have verified persistent web support. ${error.message}`, {
				cause: error,
			});
		}
		verified.add(core);
	}
	return verified;
}

/** Qualifies the selected application, management paths, and cores before a release switch. */
export function assertWebSelectedRuntime(record, root) {
	qualifiedWebRelease(record, root);
	const paths = installationPaths(record.id, root);
	assertWebExecutable(paths.wrapper(record.name), root);
	for (const name of WEB_MANAGEMENT_MODULES) assertWebReadable(join(paths.management, name), root);
	assertWebSelectedCores(record, root);
}

async function assertWebManagement(record, release, context) {
	const { root } = context;
	const paths = installationPaths(record.id, root);
	const wrapper = paths.wrapper(record.name);
	if (!isOwnedCommand(wrapper, record, root))
		throw new Error("The installed named command does not match the persistent web release.");
	assertWebExecutable(wrapper, root);
	const inventory = readFileSync(webReleaseFile(release, "SHA256SUMS", root), "utf8").trimEnd().split("\n");
	for (const name of WEB_MANAGEMENT_MODULES) {
		const installed = join(paths.management, name);
		assertWebReadable(installed, root);
		const rows = inventory.filter((row) => row.endsWith(`  ./deploy/${name}`));
		if (rows.length !== 1 || rows[0] !== `${hashWebFile(installed)}  ./deploy/${name}`)
			throw new Error(`Installed persistent web management helper differs from its release: ${name}`);
	}
	const updates = updatePaths(record.id, root);
	const directory = dirname(paths.unitFile);
	const recoveryDropIn = join(directory, `${paths.unit}.d/update.conf`);
	const dropInBytes = `[Unit]\nRequires=${updates.prepareUnit}\nAfter=${updates.prepareUnit}\nWants=${updates.finalizeUnit}\n`;
	trustedFile(recoveryDropIn, root);
	if (readFileSync(recoveryDropIn, "utf8") !== dropInBytes)
		throw new Error("Unexpected persistent web recovery drop-in.");
	const owner = ownedServiceUnit(record, root);
	if (owner.installed !== owner.selected) throw new Error("Persistent web requires the current operator-capable owner unit.");
	await assertWebRegistration(paths.unit, `${paths.unit}.d/update.conf`, context);
	for (const [name, phase] of [[updates.prepareUnit, "prepare"], [updates.finalizeUnit, "finalize"]]) {
		const file = join(directory, name);
		trustedFile(file, root);
		if (readFileSync(file, "utf8") !== recoveryUnit(record, phase))
			throw new Error(`Unexpected persistent web recovery unit: ${name}`);
		await assertWebRegistration(name, "", context);
	}
	const schedule = updateScheduling(record, root);
	let schedulingEnabled = false;
	if (protectedWebPath(updates.config, root)) {
		trustedFile(updates.config, root);
		const policy = JSON.parse(readFileSync(updates.config, "utf8"));
		if (policy?.schemaVersion !== 1 || policy.id !== record.id || typeof policy.enabled !== "boolean")
			throw new Error("Unexpected update policy for persistent web.");
		schedulingEnabled = policy.enabled;
	}
	if (schedulingEnabled || protectedWebPath(schedule.servicePath, root) || protectedWebPath(schedule.timerPath, root)) {
		for (const [name, path] of [[schedule.serviceName, schedule.servicePath], [schedule.timerName, schedule.timerPath]]) {
			trustedFile(path, root);
			await assertWebRegistration(name, "", context);
		}
		assertUpdateSchedulingOwned(record, root);
	}
}

async function assertWebRegistration(name, dropIn, context) {
	const path = `/etc/systemd/system/${name}`;
	const fields = await readWebUnitProperties(name, "LoadState,FragmentPath,DropInPaths,NeedDaemonReload", context);
	if (
		fields.LoadState !== "loaded" ||
		fields.FragmentPath !== path ||
		fields.DropInPaths !== (dropIn ? `/etc/systemd/system/${dropIn}` : "") ||
		fields.NeedDaemonReload !== "no"
	)
		throw new Error(`Unexpected loaded persistent web dependency: ${name}`);
}

/** Compares an installed web-capable core to the updater inventory of its retained, verified release. */
export function assertWebCoreMatchesRelease(core, release, root, releaseRoot = root) {
	const manifest = join(core, "CORE-SHA256SUMS.json");
	trustedFile(manifest, root);
	assertWebCoreUsable(core, root);
	if (!webActivationReleaseSupported(release, releaseRoot ?? undefined))
		throw new Error("The retained qualifying release does not support persistent web.");
	const expected = JSON.parse(readFileSync(manifest, "utf8"));
	const rows = readFileSync(webReleaseFile(release, "SHA256SUMS", releaseRoot ?? undefined), "utf8").trimEnd().split("\n");
	const releaseCore = new Map(rows.flatMap((row) => {
		const match = /^([0-9a-f]{64})  \.\/updater\/(.+)$/.exec(row);
		return match ? [[match[2], match[1]]] : [];
	}));
	const installed = releaseInventory(core, "CORE-SHA256SUMS.json");
	if (installed.length !== releaseCore.size || installed.length !== Object.keys(expected).length)
		throw new Error("Persistent web updater inventory differs from its retained release.");
	const buffer = Buffer.allocUnsafe(128 * 1024);
	for (const name of installed) {
		const file = join(core, name);
		trustedFile(file, root);
		const hash = hashWebFile(file, buffer);
		if (hash !== expected[name] || hash !== releaseCore.get(name))
			throw new Error(`Persistent web updater bytes differ from the retained release: ${name}`);
	}
}

function hashWebFile(path, buffer = Buffer.allocUnsafe(128 * 1024)) {
	const hash = createHash("sha256");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		for (let bytes = readSync(fd, buffer); bytes > 0; bytes = readSync(fd, buffer))
			hash.update(buffer.subarray(0, bytes));
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

async function webCheck(id, expectedUid, role) {
	const uid = Number(expectedUid);
	const socket = role === "socket";
	if (!validWebUid(uid) || String(uid) !== expectedUid || process.getuid() !== (socket ? 0 : uid))
		throw new Error("Unexpected persistent web launch identity.");
	const context = createUpdateContext();
	const record = readInstallation(id);
	const config = readWebActivation(record);
	if (
		record.desiredState !== "running" ||
		config?.uid !== uid ||
		(config.state !== "configured" && (!socket || config.state !== "provisioning"))
	)
		throw new Error("Persistent web is not available for this installation.");
	selectedWebRelease(record, context.root);
	if ((await eligibleWebOperator(record, config.operator, context.run)) !== uid)
		throw new Error("The selected persistent web account changed.");
	await assertWebUnitsReady(record, uid, context);
	if (socket) checkWebListener(webPaths(record, context.root), null, null, context.root);
}

// Exact service template shipped in 0.0.6 (d002562a); signed old updaters retain it during application updates.
const LEGACY_SERVICE_UNIT = `# Runs the headless agent under its dedicated account with persistent local state.
[Unit]
Description=unit-001 durable agent @ID@
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=@ACCOUNT@
Group=@ACCOUNT@
WorkingDirectory=/var/lib/unit-001/agents/@ID@/workspace
Environment=HOME=/var/lib/unit-001/agents/@ID@
EnvironmentFile=-/etc/unit-001/agents/@ID@/environment
ExecStart=/opt/unit-001/agents/@ID@/current/runtime/bin/node /usr/lib/unit-001/agents/@ID@/agent-command.mjs @ID@ --service
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillMode=control-group
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/unit-001/agents/@ID@
PrivateTmp=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;

/** Recognizes only the selected verified unit or the exact legacy 0.0.6 unit retained by old updaters. */
export function ownedServiceUnit(record, root = "/") {
	const paths = installationPaths(record.id, root);
	const release = join(resolve(root), "opt/unit-001/releases", record.releaseVersion);
	if (validateRelease(release, root).version !== record.releaseVersion)
		throw new Error("Service release version mismatch.");
	const render = (text) => text.replaceAll("@ID@", record.id).replaceAll("@ACCOUNT@", record.account);
	const selected = render(readFileSync(join(release, "deploy/unit-001.service"), "utf8"));
	trustedFile(paths.unitFile, root);
	const installed = readFileSync(paths.unitFile, "utf8");
	if (installed !== selected && installed !== render(LEGACY_SERVICE_UNIT))
		throw new Error("Refusing to change an unowned service unit.");
	return { installed, selected };
}

/** Enables operator runtime provisioning only while a legacy-unit installation is explicitly stopped. */
export async function configureOperatorService(record, context) {
	const { installed, selected } = ownedServiceUnit(record, context.root);
	if (installed === selected) return false;
	if (
		record.desiredState !== "stopped" ||
		(await context.unitRunning(installationPaths(record.id, context.root).unit))
	)
		throw new Error(`Stop ${record.name} first with sudo ${record.name} stop, then retry operator add and start it.`);
	const path = installationPaths(record.id, context.root).unitFile;
	atomicFile(path, selected, 0o644, context.root);
	try {
		await context.run("systemctl", ["daemon-reload"]);
	} catch (error) {
		atomicFile(path, installed, 0o644, context.root);
		await context.run("systemctl", ["daemon-reload"]);
		throw error;
	}
	return true;
}

/** Reads bounded release bootstrap metadata without requiring administrator ownership or changing the host. */
export function readReleaseUpdateBootstrap(release) {
	try {
		const directory = lstatSync(join(release, "deploy"));
		if (!directory.isDirectory() || directory.isSymbolicLink())
			throw new Error("Bundled update bootstrap must not traverse a symlink.");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	const sourceRoot = join(release, "deploy/update-root.json");
	const sourceFeed = join(release, "deploy/update-feed.json");
	let present = false;
	for (const [path, limit] of [
		[sourceRoot, 4 * 1024 * 1024],
		[sourceFeed, 8192],
	]) {
		let info;
		try {
			info = lstatSync(path);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (info === undefined) continue;
		present = true;
		if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
			throw new Error("Bundled update bootstrap must contain bounded regular files.");
	}
	if (!present) return null;
	const bytes = readFileSync(sourceRoot);
	const metadata = JSON.parse(bytes);
	const feed = JSON.parse(readFileSync(sourceFeed));
	// Preflight checks shape and expiry before privileged setup; the builder verifies approved root signatures.
	if (
		metadata.signed?._type !== "root" ||
		metadata.signed.consistent_snapshot !== true ||
		!Number.isSafeInteger(metadata.signed.version) ||
		metadata.signed.version < 1 ||
		!Number.isFinite(Date.parse(metadata.signed.expires)) ||
		Date.parse(metadata.signed.expires) <= Date.now() ||
		feed.schemaVersion !== 1 ||
		feed.repository !== "francman/unit-001-releases" ||
		feed.channel !== "stable" ||
		Object.keys(feed).some((key) => !["schemaVersion", "repository", "channel"].includes(key))
	)
		throw new Error("Unsupported bundled public update trust.");
	return { rootBytes: bytes, feed };
}

/** Seeds bundled public trust once; existing operator trust and update policy always remain authoritative. */
export function bootstrapReleaseUpdates(record, release, root = "/") {
	const bootstrap = readReleaseUpdateBootstrap(release);
	if (bootstrap === null) return false;
	// Bootstrap trusts only the protected release whose complete inventory the installer already verified.
	for (const path of ["update-root.json", "update-feed.json"]) trustedFile(join(release, "deploy", path), root);
	const { rootBytes: bytes, feed } = bootstrap;
	const paths = updatePaths(record.id, root);
	const receipt = join(paths.configDirectory, "bootstrap.json");
	for (const path of [paths.config, paths.trustRoot, receipt]) {
		assertSafePath(path, root);
		if (existsSync(path)) trustedFile(path, root);
	}
	if (existsSync(paths.config)) return false;
	const expectedReceipt = `${JSON.stringify({ schemaVersion: 1, rootSha256: createHash("sha256").update(bytes).digest("hex"), repository: feed.repository, channel: feed.channel })}\n`;
	if (existsSync(paths.trustRoot) && (!existsSync(receipt) || readFileSync(receipt, "utf8") !== expectedReceipt))
		return false;
	if (existsSync(paths.trustRoot) && !readFileSync(paths.trustRoot).equals(bytes))
		throw new Error("Bundled trust does not match the interrupted public bootstrap.");
	assertUpdateSchedulingOwned(record, root);
	mkdirSync(paths.configDirectory, { recursive: true, mode: 0o755 });
	trustedParents(join(paths.configDirectory, ".check"), root);
	const schedule = updateScheduling(record, root);
	for (const [path, contents] of [
		[schedule.servicePath, schedule.serviceContents],
		[schedule.timerPath, schedule.timerContents],
	])
		atomicFile(path, contents, 0o644, root);
	atomicFile(receipt, expectedReceipt, 0o600, root);
	atomicFile(paths.trustRoot, bytes, 0o644, root);
	atomicFile(
		paths.config,
		`${JSON.stringify({ schemaVersion: 1, id: record.id, enabled: true, pin: null, repository: feed.repository, channel: feed.channel })}\n`,
		0o600,
		root,
	);
	rmSync(receipt);
	const directory = openSync(paths.configDirectory, "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
	return true;
}

function commandContents(record) {
	return `#!/bin/sh\n# unit-001 managed command ${record.id} ${record.name}\nunset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH\nexec '/opt/unit-001/agents/${record.id}/current/runtime/bin/node' '/usr/lib/unit-001/agents/${record.id}/agent-command.mjs' '${record.id}' '${record.name}' "$@"\n`;
}

function isOwnedCommand(path, record, root) {
	try {
		trustedFile(path, root);
		return readFileSync(path, "utf8") === commandContents(record);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function commandDirectories(root) {
	const standard = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/snap/bin"];
	if (resolve(root || "/") !== "/") return standard.map((path) => join(root, path));
	let configured = "";
	try {
		configured =
			execFileSync("sudo", ["-V"], {
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C" },
				stdio: ["ignore", "pipe", "pipe"],
			})
				.split("\n")
				.find((line) => line.startsWith("Value to override user's $PATH with:"))
				?.split(": ")[1] ?? "";
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return [
		...new Set(
			[...standard, ...configured.split(":"), ...(process.env.PATH ?? "").split(":")].filter((path) =>
				path.startsWith("/"),
			),
		),
	];
}

/** Refuses managed-name and sudo/PATH command collisions without overwriting unrelated entries. */
export function assertNameAvailable(name, id, root = "/") {
	validateName(name);
	if (id !== undefined) validateId(id);
	for (const record of listInstallations(root)) {
		if (record.name === name && record.id !== id) throw new Error(`Agent name is already registered: ${name}`);
	}
	for (const directory of commandDirectories(root)) {
		const path = join(directory, name);
		let info;
		try {
			info = lstatSync(path);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (id !== undefined && path === installationPaths(id, root).wrapper(name) && info.isFile()) {
			const record = { id, name };
			if (isOwnedCommand(path, record, root)) continue;
		}
		throw new Error(`Agent command collides with an existing path: ${path}`);
	}
}

/** Creates or refreshes only this installation's exact command wrapper. */
export function writeAgentCommand(record, root = "/") {
	validateRecord(record);
	assertNameAvailable(record.name, record.id, root);
	atomicFile(installationPaths(record.id, root).wrapper(record.name), commandContents(record), 0o755, root, {
		exactMode: true,
	});
}

/** Removes a command only when its contents and administrative ownership identify this installation. */
export function removeOwnedAgentCommand(record, root = "/") {
	validateRecord(record);
	const path = installationPaths(record.id, root).wrapper(record.name);
	if (!existsSync(path)) return;
	if (!isOwnedCommand(path, record, root)) throw new Error(`Preserving unexpected command: ${path}`);
	rmSync(path);
}

/** Serializes install/update/lifecycle operations with a kernel-released lock outside removable installations. */
export async function withManagementLock(callback, root = "/") {
	const path = join(resolve(root || "/"), "run/unit-001/management.lock");
	assertSafePath(path, root);
	// /run/lock is world-writable on Ubuntu; only the administrator may create this directory or lock.
	mkdirSync(dirname(dirname(path)), { recursive: true, mode: 0o755 });
	trustedParents(dirname(path), root);
	mkdirSync(dirname(path), { mode: 0o700, recursive: true });
	trustedParents(path, root);
	const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	const lock = fstatSync(fd);
	if (
		!lock.isFile() ||
		lock.uid !== (resolve(root || "/") === "/" ? 0 : process.getuid()) ||
		(lock.mode & 0o022) !== 0
	) {
		closeSync(fd);
		throw new Error("Management lock is not owned and protected by its administrator.");
	}
	if (process.platform === "linux") {
		try {
			try {
				execFileSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", fd] });
			} catch (error) {
				if (error.status === 1) throw new Error("Another install, update, or lifecycle operation is running.");
				throw error;
			}
			return await callback(fd);
		} finally {
			closeSync(fd);
		}
	}
	closeSync(fd);
	if (process.platform !== "darwin")
		throw new Error("Management locking requires Linux; macOS supports filesystem staging only.");
	const holder = spawn("lockf", ["-k", "-t", "0", path, "sh", "-c", "printf 'LOCKED\\n'; cat >/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let acquired = false;
	const exited = new Promise((resolveExit) => holder.once("exit", resolveExit));
	try {
		await new Promise((ready, reject) => {
			holder.once("error", reject);
			holder.stdout.once("data", () => {
				acquired = true;
				ready();
			});
			holder.once("exit", () => {
				if (!acquired) reject(new Error("Another install, update, or lifecycle operation is running."));
			});
		});
		return await callback(undefined);
	} finally {
		holder.stdin.end();
		await exited;
	}
}

function releaseInventory(directory, manifest = "SHA256SUMS", root) {
	const files = [];
	const visit = (path) => {
		for (const name of readdirSync(path).sort()) {
			const child = join(path, name);
			const info = lstatSync(child);
			if (root !== undefined && (info.uid !== webRootUid(root) || (info.mode & 0o022) !== 0))
				throw new Error(`Untrusted release path: ${child}`);
			if (info.isDirectory()) visit(child);
			else if (info.isFile()) files.push(relative(directory, child));
			else throw new Error("Release must contain only regular files and directories.");
		}
	};
	visit(directory);
	return files.filter((path) => path !== manifest);
}

function verifyCopiedRelease(directory, manifest, root) {
	const expected = manifest
		.trimEnd()
		.split("\n")
		.map((line) => {
			const match = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
			if (!match || match[2].split("/").some((part) => part === ".." || part === "."))
				throw new Error("Unsafe release manifest.");
			return { hash: match[1], path: match[2] };
		});
	if (JSON.stringify(expected.map(({ path }) => path).sort()) !== JSON.stringify(releaseInventory(directory, "SHA256SUMS", root).sort()))
		throw new Error("Copied release inventory differs from its verified manifest.");
	const buffer = Buffer.allocUnsafe(128 * 1024);
	for (const { hash, path } of expected) {
		if (hashWebFile(join(directory, path), buffer) !== hash)
			throw new Error(`Copied release checksum failed: ${path}`);
	}
}

/** Verifies a release inventory and optionally checks descendant ownership before loading code. */
export function validateRelease(directory, root = "/", { protectedContents = false } = {}) {
	trustedFile(join(directory, "SHA256SUMS"), root);
	const manifest = readFileSync(join(directory, "SHA256SUMS"), "utf8");
	verifyCopiedRelease(directory, manifest, protectedContents ? root : undefined);
	return {
		version: readFileSync(join(directory, "VERSION"), "utf8").trim(),
		files: ["SHA256SUMS", ...releaseInventory(directory)],
	};
}

/** Removes the verified release only when no other installation may need its inventory. */
export function removeUnusedRelease(record, root = "/") {
	validateRecord(record);
	root = resolve(root || "/");
	if (
		listInstallations(root).some(
			(other) =>
				other.id !== record.id &&
				other.desiredState !== "uninstalled" &&
				(other.releaseVersion === record.releaseVersion || updateMayNeedRelease(other, record.releaseVersion, root)),
		)
	)
		return false;
	const directory = join(root, "opt/unit-001/releases", record.releaseVersion);
	assertSafePath(directory, root);
	if (!existsSync(directory)) return false;
	if (validateRelease(directory, root).version !== record.releaseVersion)
		throw new Error("Preserving release with unexpected version metadata.");
	rmSync(directory, { recursive: true });
	return true;
}

function updateMayNeedRelease(record, version, root) {
	const paths = updatePaths(record.id, root);
	try {
		return selectedCoreMayNeedRelease(paths, version, root) || journalMayNeedRelease(record, paths, version, root);
	} catch {
		// Uninstall has already removed its retry entry points. Preserve the archive on an ambiguous read.
		return true;
	}
}

function selectedCoreMayNeedRelease({ currentCore, recoveryCore, cores }, version, root) {
	const owner = root === "/" ? 0 : process.getuid();
	for (const path of [currentCore, recoveryCore]) {
		const selector = protectedWebPath(path, root);
		if (selector === null) continue;
		if (!selector.isSymbolicLink() || selector.uid !== owner) return true;
		const selectedVersion = /^cores\/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.exec(readlinkSync(path))?.[1];
		if (!selectedVersion || selectedVersion === version) return true;
		const core = protectedWebPath(join(cores, selectedVersion), root);
		if (!core?.isDirectory() || core.uid !== owner || (core.mode & 0o022) !== 0) return true;
	}
	return false;
}

function journalMayNeedRelease(record, paths, version, root) {
	const journal = readUpdateJournal(record.id, root);
	// The reader also returns null for a file containing JSON null. Only protected absence permits cleanup.
	if (journal === null) return protectedWebPath(paths.journal, root) !== null;
	const previousVersion = journalPreviousVersion(journal, record.id);
	if (journal.phase === "complete") {
		// Explicit rollback is available only when the completed candidate is still the selected application.
		return journal.candidateVersion === record.releaseVersion && previousVersion === version;
	}
	if (record.releaseVersion !== previousVersion && record.releaseVersion !== journal.candidateVersion) return true;
	if (previousVersion === version || journal.candidateVersion === version) return true;
	// Any precommit attempt can make the displaced rollback receipt current again.
	if (journal.phase === "committed") return false;
	if (!protectedWebPath(paths.priorJournal, root)) return false;
	// Match completeDeferral's bound: a journal plus room for its operation ID and envelope.
	if (trustedFile(paths.priorJournal, root).size > 65536 + 1024) return true;
	const prior = JSON.parse(readFileSync(paths.priorJournal, "utf8"));
	if (validateId(prior?.operationId) !== journal.operationId || prior.journal === null) return false;
	if (prior.journal?.phase !== "complete") return true;
	const rollbackVersion = journalPreviousVersion(prior.journal, record.id);
	return prior.journal.candidateVersion === previousVersion && rollbackVersion === version;
}

function journalPreviousVersion(journal, id) {
	validateId(journal.operationId);
	const previous = validateRecord(journal.previousRecord);
	if (
		journal.schemaVersion !== 1 ||
		journal.id !== id ||
		previous.id !== id ||
		typeof journal.candidateVersion !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(journal.candidateVersion) ||
		(journal.liveDeferred !== undefined && typeof journal.liveDeferred !== "boolean") ||
		(journal.liveDeferred === true && journal.phase !== "restored" && journal.phase !== "complete")
	)
		throw new Error("Invalid update journal release reference.");
	return previous.releaseVersion;
}

async function installRelease(source, root, name, dryRun) {
	root = resolve(root || "/");
	readReleaseUpdateBootstrap(source);
	validateName(name);
	const version = readFileSync(join(source, "VERSION"), "utf8").trim();
	const old = listInstallations(root).find((record) => record.name === name);
	const id = old?.id ?? randomUUID();
	let record = validateRecord({
		schemaVersion: 1,
		id,
		name,
		account: accountFor(id),
		releaseVersion: version,
		desiredState: old?.desiredState === "running" ? "running" : "stopped",
	});
	const paths = installationPaths(id, root);
	const directories = [
		"opt/unit-001/releases",
		"opt/unit-001/agents",
		"etc/unit-001/agents",
		"var/lib/unit-001/agents",
		"usr/lib/unit-001/agents",
		"usr/local/bin",
		"etc/systemd/system",
		"run/unit-001",
	];
	const targetDirectories = [
		...directories.map((path) => join(root, path)),
		paths.config,
		paths.state,
		join(paths.state, "workspace"),
		paths.agentRoot,
		paths.management,
	];
	for (const path of [...targetDirectories, paths.environment, paths.unitFile]) assertSafePath(path, root);
	for (const path of targetDirectories)
		if (existsSync(path) && !lstatSync(path).isDirectory())
			throw new Error(`Expected installation directory: ${path}`);
	assertNameAvailable(name, old?.id, root);
	if (dryRun) {
		console.log(`Plan: command ${name}; installation ${id}; state ${paths.state}; no host changes.`);
		return;
	}
	if (root === "/" && process.getuid() !== 0) throw new Error("Live installation requires root.");
	let installingOperator;
	if (root === "/" && old === undefined && process.env.SUDO_UID !== undefined && process.env.SUDO_UID !== "0") {
		const uid = process.env.SUDO_UID;
		if (!/^[1-9][0-9]*$/.test(uid)) throw new Error("Invalid installing operator UID.");
		const fields = execFileSync("getent", ["passwd", uid], { encoding: "utf8" }).trim().split(":");
		if (fields[2] !== uid || fields[0] !== process.env.SUDO_USER)
			throw new Error("Installing operator does not match its OS account.");
		installingOperator = fields[0];
	}
	await withManagementLock(async (fd) => {
		const latest = listInstallations(root).find((current) => current.name === name);
		if (latest?.id !== old?.id)
			throw new Error("Installation identity changed while acquiring the management lock; retry.");
		record = { ...record, desiredState: latest?.desiredState === "running" ? "running" : "stopped" };
		assertNameAvailable(name, old?.id, root);
		const manifest = readFileSync(join(source, "SHA256SUMS"), "utf8");
		const destination = join(root, "opt/unit-001/releases", version);
		assertSafePath(destination, root);
		const context = createUpdateContext(root);
		const web = latest ? readWebActivation(latest, root) : null;
		if (web) {
			if (!webReleaseSupportsActivation(source, undefined, manifest))
				throw new Error(`Disable persistent web with sudo ${name} web disable before selecting this release.`);
			assertWebSelectedRuntime(latest, root);
			if (existsSync(destination)) assertWebApplicationUsable(destination, root);
			const core = join(updatePaths(latest.id, root).cores, version);
			if (protectedWebPath(core, root)) assertWebCoreMatchesRelease(core, source, root, null);
		}
		let account;
		if (root === "/") {
			try {
				account = execFileSync("getent", ["passwd", record.account], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				}).trim();
			} catch (error) {
				if (error.status !== 2) throw error;
			}
			if (!old && account) throw new Error("Generated agent account already exists; refusing to reuse it.");
			if (account) {
				const fields = account.split(":");
				if (fields[2] === "0" || fields[5] !== paths.state)
					throw new Error("Existing agent account does not match its installation.");
			}
		}
		for (const path of directories) mkdirSync(join(root, path), { recursive: true, mode: 0o755 });
		if (existsSync(destination)) {
			if (readFileSync(join(destination, "SHA256SUMS"), "utf8") !== manifest)
				throw new Error("This release version already has different contents.");
			validateRelease(destination, root, { protectedContents: web !== null });
			if (web) {
				await smokeWebApplication(record, web.uid, destination, context);
				await smokeCandidateWebCore(record, version, destination, context);
			}
		} else {
			const staged = mkdtempSync(join(dirname(destination), `.${version}.`));
			try {
				cpSync(source, staged, { recursive: true });
				for (const file of ["SHA256SUMS", ...releaseInventory(staged)]) chmodSync(join(staged, file), 0o644);
				const chmodDirectories = (path) => {
					chmodSync(path, 0o755);
					for (const child of readdirSync(path))
						if (lstatSync(join(path, child)).isDirectory()) chmodDirectories(join(path, child));
				};
				chmodDirectories(staged);
				for (const file of ["install.sh", "runtime/bin/node", "bin/agent"]) chmodSync(join(staged, file), 0o755);
				verifyCopiedRelease(staged, manifest, web ? root : undefined);
				if (web) {
					trustedFile(join(staged, "SHA256SUMS"), root);
					await smokeWebApplication(record, web.uid, staged, context);
					await smokeCandidateWebCore(record, version, staged, context);
				}
				renameSync(staged, destination);
			} finally {
				rmSync(staged, { recursive: true, force: true });
			}
		}
		// Reserve identity before creating an account or private state. Activation rollback keeps this stopped record.
		if (latest === undefined) writeInstallation(record, root);
		if (root === "/") {
			if (!account)
				execFileSync(
					"useradd",
					[
						"--system",
						"--user-group",
						"--home-dir",
						paths.state,
						"--create-home",
						"--shell",
						"/usr/sbin/nologin",
						record.account,
					],
					{ stdio: "inherit" },
				);
		}
		for (const path of [
			paths.config,
			paths.state,
			join(paths.state, "workspace"),
			paths.agentRoot,
			dirname(paths.management),
		])
			mkdirSync(path, { recursive: true, mode: 0o755 });
		chmodSync(paths.state, 0o700);
		chmodSync(join(paths.state, "workspace"), 0o700);
		if (root === "/")
			execFileSync("chown", [`${record.account}:${record.account}`, paths.state, join(paths.state, "workspace")], {
				stdio: "inherit",
			});
		if (!existsSync(paths.environment))
			atomicFile(paths.environment, "# Optional provider keys and UNIT_001_MODEL.\n", 0o600, root);
		const plan = mkdtempSync(join(tmpdir(), "unit-001-install-"));
		installUpdateCore(record, destination, context);
		const updatesConfigured = bootstrapReleaseUpdates(record, destination, root);
		try {
			writeFileSync(join(plan, "record.json"), `${JSON.stringify(record, null, "\t")}\n`);
			writeFileSync(join(plan, "command"), commandContents(record));
			const unit = readFileSync(join(destination, "deploy/unit-001.service"), "utf8")
				.replaceAll("@ID@", id)
				.replaceAll("@ACCOUNT@", record.account);
			writeFileSync(join(plan, "unit"), unit);
			execFileSync(
				"bash",
				[
					join(destination, "deploy/activate.sh"),
					root,
					id,
					version,
					name,
					record.desiredState,
					plan,
					"30000",
					root === "/" ? "manage" : "stage",
				],
				{
					stdio: fd === undefined ? "inherit" : ["inherit", "inherit", "inherit", fd],
				},
			);
		} finally {
			rmSync(plan, { recursive: true, force: true });
		}
		if (root === "/" && record.desiredState === "running") {
			try {
				await restartUpdateScheduling(record, createUpdateContext(root));
			} catch (error) {
				process.stderr.write(
					`Agent is running, but automatic update scheduling failed: ${error.message}. Inspect sudo ${name} update status.\n`,
				);
			}
		}
		console.log(
			`Installed ${name} (${id}). Provider environment: ${paths.environment}. Configure credentials with sudo ${name} login, then run sudo ${name} start.`,
		);
		if (updatesConfigured)
			console.log(`Signed public updates are configured automatically and run while ${name} is started.`);
		if (installingOperator !== undefined) {
			try {
				execFileSync("usermod", ["--append", "--groups", record.account, installingOperator], { stdio: "inherit" });
				console.log(
					`Operator access granted to ${installingOperator}. Reconnect SSH or log out and back in to refresh groups.`,
				);
			} catch {
				process.stderr.write(
					`Installation succeeded, but operator access was not granted. Retry sudo ${name} operator add ${installingOperator}.\n`,
				);
			}
		}
	}, root);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	const [command, source, root, name, dryRun] = process.argv.slice(2);
	if (command === "preflight") {
		if (!source || process.argv.length !== 4) throw new Error("Invalid bootstrap preflight invocation.");
		readReleaseUpdateBootstrap(realpathSync(source));
		console.log("Public update trust verified.");
	} else if (command === "web-quiesce") {
		if (!source || root !== undefined || process.getuid() !== 0)
			throw new Error("Invalid persistent web quiescence invocation.");
		await quiesceWebActivation(readInstallation(source), createUpdateContext());
	} else if (command === "web-check") {
		if (!source || root === undefined || (name !== undefined && name !== "socket") || dryRun !== undefined)
			throw new Error("Invalid persistent web check invocation.");
		try {
			await webCheck(source, root, name);
		} catch (error) {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
		}
	} else {
		if (command !== "install" || !source || root === undefined || !name)
			throw new Error("Invalid installer invocation.");
		if (resolve(root || "/") === "/") {
			if (process.getuid() !== 0 || process.platform !== "linux")
				throw new Error("Live named installation requires Linux root privileges.");
			process.env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/bin";
		}
		await installRelease(realpathSync(source), root, name, dryRun === "true");
	}
}
