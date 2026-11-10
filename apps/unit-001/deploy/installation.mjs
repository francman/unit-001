// Validates named installation records and provides shared identity, command ownership, and management locking.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	cpSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	assertUpdateSchedulingOwned,
	createUpdateContext,
	installUpdateCore,
	restartUpdateScheduling,
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

function atomicFile(path, contents, mode, root) {
	assertSafePath(path, root);
	mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	trustedParents(path, root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", mode);
	try {
		writeFileSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
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

/** Atomically publishes an administrator-owned record. */
export function writeInstallation(record, root = "/") {
	validateRecord(record);
	atomicFile(installationPaths(record.id, root).record, `${JSON.stringify(record, null, "\t")}\n`, 0o644, root);
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
	atomicFile(installationPaths(record.id, root).wrapper(record.name), commandContents(record), 0o755, root);
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

function releaseInventory(directory) {
	const files = [];
	const visit = (path) => {
		for (const name of readdirSync(path).sort()) {
			const child = join(path, name);
			const info = lstatSync(child);
			if (info.isDirectory()) visit(child);
			else if (info.isFile()) files.push(relative(directory, child));
			else throw new Error("Release must contain only regular files and directories.");
		}
	};
	visit(directory);
	return files.filter((path) => path !== "SHA256SUMS");
}

function verifyCopiedRelease(directory, manifest) {
	const expected = manifest
		.trimEnd()
		.split("\n")
		.map((line) => {
			const match = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
			if (!match || match[2].split("/").some((part) => part === ".." || part === "."))
				throw new Error("Unsafe release manifest.");
			return { hash: match[1], path: match[2] };
		});
	if (JSON.stringify(expected.map(({ path }) => path).sort()) !== JSON.stringify(releaseInventory(directory).sort()))
		throw new Error("Copied release inventory differs from its verified manifest.");
	for (const { hash, path } of expected) {
		if (
			createHash("sha256")
				.update(readFileSync(join(directory, path)))
				.digest("hex") !== hash
		)
			throw new Error(`Copied release checksum failed: ${path}`);
	}
}

/** Verifies an administrator-owned release inventory before software removal. */
export function validateRelease(directory, root = "/") {
	trustedFile(join(directory, "SHA256SUMS"), root);
	const manifest = readFileSync(join(directory, "SHA256SUMS"), "utf8");
	verifyCopiedRelease(directory, manifest);
	return {
		version: readFileSync(join(directory, "VERSION"), "utf8").trim(),
		files: ["SHA256SUMS", ...releaseInventory(directory)],
	};
}

/** Removes only the selected verified release when no other installed instance references it. */
export function removeUnusedRelease(record, root = "/") {
	validateRecord(record);
	if (
		listInstallations(root).some(
			(other) =>
				other.id !== record.id &&
				other.desiredState !== "uninstalled" &&
				other.releaseVersion === record.releaseVersion,
		)
	)
		return false;
	const directory = join(resolve(root || "/"), "opt/unit-001/releases", record.releaseVersion);
	assertSafePath(directory, root);
	if (!existsSync(directory)) return false;
	if (validateRelease(directory, root).version !== record.releaseVersion)
		throw new Error("Preserving release with unexpected version metadata.");
	rmSync(directory, { recursive: true });
	return true;
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
		const manifest = readFileSync(join(source, "SHA256SUMS"), "utf8");
		for (const path of directories) mkdirSync(join(root, path), { recursive: true, mode: 0o755 });
		const destination = join(root, "opt/unit-001/releases", version);
		assertSafePath(destination, root);
		if (existsSync(destination)) {
			if (readFileSync(join(destination, "SHA256SUMS"), "utf8") !== manifest)
				throw new Error("This release version already has different contents.");
			verifyCopiedRelease(destination, manifest);
		} else {
			const staged = mkdtempSync(join(dirname(destination), `.${version}.`));
			try {
				cpSync(source, staged, { recursive: true });
				for (const file of releaseInventory(staged)) chmodSync(join(staged, file), 0o644);
				const chmodDirectories = (path) => {
					chmodSync(path, 0o755);
					for (const child of readdirSync(path))
						if (lstatSync(join(path, child)).isDirectory()) chmodDirectories(join(path, child));
				};
				chmodDirectories(staged);
				for (const file of ["install.sh", "runtime/bin/node", "bin/agent"]) chmodSync(join(staged, file), 0o755);
				verifyCopiedRelease(staged, manifest);
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
		installUpdateCore(record, destination, createUpdateContext(root));
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
