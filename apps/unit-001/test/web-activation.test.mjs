import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchAgent } from "../deploy/agent-command.mjs";
import {
	accountFor,
	configureWebActivation,
	installationPaths,
	readWebActivation,
	removeWebActivation,
	webActivationReleaseSupported,
	writeAgentCommand,
	writeInstallation,
} from "../deploy/installation.mjs";
import { recoveryUnit, updatePaths } from "../deploy/update-activation.mjs";
import { webApplicationFiles, webUpdaterPackages } from "./fixtures/web-release-artifacts.mjs";

const id = "f0b49640-bbcd-4d83-9803-0f5b5c24084a";
const uid = 1200;
const username = "alice";
const account = accountFor(id);
const owner = `unit-001@${id}.service`;
const socket = `unit-001-web@${id}.socket`;
const service = `unit-001-web@${id}.service`;
const feature = "web-socket-activation";
const installer = fileURLToPath(new URL("../deploy/installation.mjs", import.meta.url));
const ownerTemplate = readFileSync(new URL("../deploy/unit-001.service", import.meta.url), "utf8");

function write(path, bytes, mode = 0o644) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	chmodSync(path, mode);
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function coreFiles(features) {
	return {
		"lib/release-compatibility.json": JSON.stringify({ features }),
		"lib/update-activation.mjs": "// verified updater lifecycle guard\n",
		"lib/installation.mjs": "// verified installation guard\n",
		"lib/update.mjs": 'import { Metadata } from "@tufjs/models"; if (!Metadata || process.getuid() === 0 || process.argv[2] !== "--help") throw new Error("Invalid updater smoke invocation.");\n',
		"lib/release-version.mjs": "// release version comparison\n",
		"lib/update-trust.mjs": "// authenticated download\n",
		"lib/control.mjs": "// owner control entrypoint\n",
		"runtime/bin/node": "# verified updater runtime\n",
		...webUpdaterPackages,
	};
}

function writeCore(path, features) {
	const files = coreFiles(features);
	for (const [name, bytes] of Object.entries(files))
		write(join(path, name), bytes, name === "runtime/bin/node" ? 0o755 : 0o644);
	write(join(path, "CORE-SHA256SUMS.json"), JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)]))));
}

function writeRelease(path, version, appFeatures = [feature], coreFeatures = [feature], extraFiles = {}) {
	const files = {
		VERSION: `${version}\n`,
		"deploy/release-compatibility.json": JSON.stringify({ features: appFeatures }),
		"deploy/installation.mjs": "// installer\n",
		"deploy/agent-command.mjs": "// named command\n",
		"deploy/lifecycle.mjs": "// lifecycle\n",
		"deploy/update-activation.mjs": "// activation\n",
		"deploy/unit-001.service": ownerTemplate,
		...webApplicationFiles,
		"runtime/bin/node": "# application runtime\n",
		...Object.fromEntries(Object.entries(coreFiles(coreFeatures)).map(([name, bytes]) => [`updater/${name}`, bytes])),
		...extraFiles,
	};
	for (const [name, bytes] of Object.entries(files)) write(join(path, name), bytes);
	write(join(path, "SHA256SUMS"), Object.entries(files).map(([name, bytes]) => `${digest(bytes)}  ./${name}\n`).join(""));
}

function fixture(t, desiredState = "running") {
	const scratch = mkdtempSync(join(realpathSync(tmpdir()), "unit-001-web-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const root = join(scratch, "root");
	const record = { schemaVersion: 1, id, name: "original-agent", account, releaseVersion: "1.2.3", desiredState };
	const install = installationPaths(id, root);
	const release = join(root, "opt/unit-001/releases", record.releaseVersion);
	const updater = join(root, "usr/lib/unit-001/updaters", id);
	const config = join(install.config, "web-activation.json");
	const unitDirectory = dirname(install.unitFile);
	const wants = join(unitDirectory, `${owner}.wants`, socket);
	const listener = join(root, "run/unit-001-web", `${id}.sock`);
	writeInstallation(record, root);
	writeRelease(release, record.releaseVersion);
	chmodSync(join(release, "runtime/bin/node"), 0o755);
	writeAgentCommand(record, root);
	for (const name of ["installation.mjs", "agent-command.mjs", "lifecycle.mjs", "update-activation.mjs"])
		write(join(install.management, name), readFileSync(join(release, "deploy", name)));
	write(install.unitFile, ownerTemplate.replaceAll("@ID@", id).replaceAll("@ACCOUNT@", account));
	const { prepareUnit, finalizeUnit } = updatePaths(id, root);
	write(join(unitDirectory, prepareUnit), recoveryUnit(record, "prepare"));
	write(join(unitDirectory, finalizeUnit), recoveryUnit(record, "finalize"));
	const ownerDropIn = `${owner}.d/update.conf`;
	write(join(unitDirectory, ownerDropIn), `[Unit]\nRequires=${prepareUnit}\nAfter=${prepareUnit}\nWants=${finalizeUnit}\n`);
	mkdirSync(install.agentRoot, { recursive: true });
	symlinkSync(`../../releases/${record.releaseVersion}`, install.current);
	writeCore(join(updater, "cores/2.0.0"), [feature]);
	writeCore(join(updater, "cores/2.0.1"), [feature]);
	for (const version of ["2.0.0", "2.0.1"]) writeRelease(join(root, "opt/unit-001/releases", version), version);
	symlinkSync("cores/2.0.0", join(updater, "current"));
	symlinkSync("cores/2.0.1", join(updater, "recovery"));
	const calls = [];
	const states = new Map([[owner, desiredState === "running" ? "active" : "inactive"]]);
	const controls = { groups: "1200 980", operatorUid: uid, fail: undefined, failStops: false };
	const show = (unit) => {
		const state = states.get(unit) ?? "inactive";
		const loaded = existsSync(join(unitDirectory, unit)) || controls.loadedUnit === unit;
		const dropInDirectory = join(unitDirectory, `${unit}.d`);
		const dropIns = existsSync(dropInDirectory)
			? readdirSync(dropInDirectory).map((file) => `/etc/systemd/system/${unit}.d/${file}`).join(" ")
			: "";
		return [
			`LoadState=${loaded ? "loaded" : "not-found"}`,
			`ActiveState=${state}`,
			`FragmentPath=${loaded ? controls.fragments?.get(unit) ?? `/etc/systemd/system/${unit}` : ""}`,
			`DropInPaths=${dropIns}`,
			"NeedDaemonReload=no",
			`Job=${controls.job ?? ""}`,
			`MainPID=${controls.mainPid ?? (unit === service && state === "active" ? "72" : "0")}`,
			"ControlPID=0",
			`ControlGroup=${unit === service ? controls.serviceCgroup ?? "" : ""}`,
		].join("\n");
	};
	const context = {
		root,
		uid: 0,
		account(user) {
			assert.equal(user, username);
			return { uid, gid: uid };
		},
		notice() {},
		async run(command, args) {
			if (command === "/usr/bin/env")
				return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
			calls.push([command, ...args]);
			if (command === "getent") {
				assert.equal(args[0], "passwd");
				if (args[1] === account) return `${account}:x:979:980::/var/lib/agent:/usr/sbin/nologin`;
				assert.ok([username, String(controls.operatorUid)].includes(args[1]));
				return `${username}:x:${controls.operatorUid}:1200::/home/${username}:/bin/sh`;
			}
			if (command === "id") {
				assert.deepEqual(args, ["-G", "--", username]);
				return controls.groups;
			}
			if (command === "gpasswd") {
				assert.deepEqual(args, ["--delete", username, account]);
				assert.equal(readWebActivation(record, root), null);
				assert.equal(states.get(socket), "inactive");
				assert.equal(states.get(service), "inactive");
				controls.groups = "1200";
				return;
			}
			assert.equal(command, "systemctl");
			controls.fail?.(args);
			const [action, ...rest] = args;
			if (action === "daemon-reload") return;
			if (action === "show") {
				const unit = args.at(-1);
				if (unit === owner && args.includes("--property=ActiveState")) return states.get(unit);
				return show(unit);
			}
			if (action === "start") {
				assert.deepEqual(rest, [socket]);
				assert.equal(states.get(owner), "active");
				states.set(socket, "active");
			} else if (action === "stop") {
				assert.equal(readWebActivation(record, root).state, "revoking");
				assert.throws(() => lstatSync(wants), { code: "ENOENT" });
				const [mode, ...units] = rest;
				assert.equal(mode, "--job-mode=ignore-dependencies");
				if (!controls.failStops) for (const unit of units) states.set(unit, "inactive");
			} else if (action === "reset-failed") {
				for (const unit of rest) states.set(unit, "inactive");
			} else assert.fail(`Unexpected systemctl action ${action}`);
		},
	};
	return { scratch, root, record, install, release, updater, config, unitDirectory, wants, listener, calls, states, controls, context, show };
}

test("renders an exact socket and an unprivileged service with one-way owner activation across rename", async (t) => {
	const f = fixture(t);
	assert.equal(readWebActivation(f.record, f.root), null);
	const configured = await configureWebActivation(f.record, username, f.context);
	assert.deepEqual(configured, { schemaVersion: 1, id, operator: username, uid, state: "configured" });
	assert.deepEqual(readWebActivation(f.record, f.root), configured);
	assert.equal(lstatSync(f.config).mode & 0o777, 0o644);
	assert.equal(readlinkSync(f.wants), `/etc/systemd/system/${socket}`);
	const script = `/usr/lib/unit-001/updaters/${id}/recovery/runtime/bin/node /usr/lib/unit-001/agents/${id}/installation.mjs web-check ${id} ${uid}`;
	const socketBytes = readFileSync(join(f.unitDirectory, socket), "utf8");
	const serviceBytes = readFileSync(join(f.unitDirectory, service), "utf8");
	// Schema version 1 must remain readable and removable after a later layout is introduced.
	assert.equal(digest(socketBytes), "6cddbd24675bb1b5b5284faed23d4cae29fbd5f5a5290f9aa273ba5dba8d87c4");
	assert.equal(digest(serviceBytes), "0b611fae62478767ec2df4ae795f54319d493f725e6fd77226ef5a5e72a69381");
	assert.match(socketBytes, /^DefaultDependencies=no$/m);
	for (const entry of [
		`WantedBy=${owner}`,
		`After=${owner}`,
		`PartOf=${owner}`,
		`Requisite=${owner}`,
		`ListenStream=/run/unit-001-web/${id}.sock`,
		"SocketMode=0600",
		"DirectoryMode=0755",
		`SocketUser=${uid}`,
		"FileDescriptorName=unit-001-web",
		"RemoveOnStop=yes",
		"FlushPending=yes",
		"TriggerLimitIntervalSec=0",
		"PollLimitIntervalSec=2s",
		"PollLimitBurst=5",
		`ExecStartPre=${script} socket`,
	])
		assert.ok(socketBytes.split("\n").includes(entry), entry);
	const current = `/opt/unit-001/agents/${id}/current`;
	for (const entry of [
		`After=${socket}`,
		`PartOf=${socket}`,
		`Requisite=${owner} ${socket}`,
		`User=${uid}`,
		`ExecCondition=${script}`,
		`ExecStart=${current}/runtime/bin/node ${current}/app/dist/named.js ${id} web /var/lib/unit-001/agents/${id} --web-service`,
		"KillMode=control-group",
		"StartLimitIntervalSec=0",
		"RestrictAddressFamilies=AF_UNIX",
		"SystemCallErrorNumber=EPERM",
	])
		assert.ok(serviceBytes.split("\n").includes(entry), entry);
	assert.doesNotMatch(socketBytes + serviceBytes, /^\s*(?:Wants|Requires|BindsTo|Upholds|Sockets|EnvironmentFile)=/m);
	assert.doesNotMatch(socketBytes + serviceBytes, /original-agent/);
	assert.deepEqual(f.calls.filter((call) => call[1] === "start"), [["systemctl", "start", socket]]);
	const renamed = { ...f.record, name: "renamed" };
	writeInstallation(renamed, f.root);
	writeAgentCommand(renamed, f.root);
	assert.deepEqual(await configureWebActivation(renamed, username, f.context), configured);
	assert.equal(readFileSync(join(f.unitDirectory, service), "utf8"), serviceBytes);
	await removeWebActivation(renamed, f.context);
	assert.equal(readWebActivation(renamed, f.root), null);
});

test("a cold owner has the shipped prepare and listener dependencies without a gateway start dependency", async (t) => {
	const f = fixture(t);
	f.states.set(owner, "inactive");
	await configureWebActivation(f.record, username, f.context);
	assert.equal(readWebActivation(f.record, f.root).state, "configured");
	assert.equal(f.calls.some((call) => call[1] === "start"), false);
	assert.equal(readlinkSync(f.wants), `/etc/systemd/system/${socket}`);
	const { prepareUnit, finalizeUnit } = updatePaths(id, f.root);
	const ownerDropIn = readFileSync(join(f.unitDirectory, `${owner}.d/update.conf`), "utf8");
	const prepare = readFileSync(join(f.unitDirectory, prepareUnit), "utf8");
	const finalize = readFileSync(join(f.unitDirectory, finalizeUnit), "utf8");
	const listener = readFileSync(join(f.unitDirectory, socket), "utf8");
	assert.equal(ownerDropIn, `[Unit]\nRequires=${prepareUnit}\nAfter=${prepareUnit}\nWants=${finalizeUnit}\n`);
	assert.ok(prepare.split("\n").includes(`Before=${owner}`));
	assert.ok(prepare.split("\n").includes("Type=oneshot"));
	assert.ok(listener.split("\n").includes(`After=${owner}`));
	assert.ok(listener.split("\n").includes(`Service=${service}`));
	for (const bytes of [readFileSync(f.install.unitFile, "utf8"), prepare, finalize, listener])
		assert.doesNotMatch(bytes, new RegExp(`^\\s*(?:Wants|Requires|BindsTo|Upholds)=.*${service.replaceAll(".", "\\.")}`, "m"));
});

test("checks the application pointer, both selected cores, and current numeric membership before writes", async (t) => {
	const f = fixture(t);
	const assertPristine = () => {
		assert.equal(readWebActivation(f.record, f.root), null);
		assert.equal(f.calls.some(([cmd]) => cmd === "systemctl"), false);
	};
	rmSync(f.install.current);
	symlinkSync("../../releases/1.2.4", f.install.current);
	await assert.rejects(configureWebActivation(f.record, username, f.context), /current application pointer/);
	assertPristine();
	rmSync(f.install.current);
	symlinkSync("../../releases/1.2.3", f.install.current);
	writeCore(join(f.updater, "cores/1.0.0"), []);
	for (const [selection, supported] of [["current", "2.0.0"], ["recovery", "2.0.1"]]) {
		const pointer = join(f.updater, selection);
		rmSync(pointer);
		symlinkSync("cores/1.0.0", pointer);
		await assert.rejects(configureWebActivation(f.record, username, f.context), new RegExp(`selected ${selection} updater core`));
		assertPristine();
		rmSync(pointer);
		symlinkSync(`cores/${supported}`, pointer);
	}
	const guard = join(f.updater, "cores/2.0.1/lib/update-activation.mjs");
	const old = readFileSync(guard);
	write(guard, "changed guard");
	await assert.rejects(configureWebActivation(f.record, username, f.context), /selected recovery updater core/);
	assertPristine();
	write(guard, old);
	f.controls.operatorUid = 0;
	await assert.rejects(configureWebActivation(f.record, username, f.context), /Invalid OS account/);
	assertPristine();
	f.controls.operatorUid = 979;
	await assert.rejects(configureWebActivation(f.record, username, f.context), /distinct from the installation account/);
	assertPristine();
	f.controls.operatorUid = uid;
	f.controls.groups = "1200 9800";
	await assert.rejects(configureWebActivation(f.record, username, f.context), /not an installation operator/);
	assertPristine();
});

test("binds exact candidate application and bundled core support to the release manifest", (t) => {
	const f = fixture(t);
	assert.equal(webActivationReleaseSupported(f.release, f.root), true);
	writeRelease(f.release, f.record.releaseVersion, [feature], []);
	assert.equal(webActivationReleaseSupported(f.release, f.root), false);
	writeRelease(f.release, f.record.releaseVersion, [feature], [feature]);
	write(join(f.release, "updater/lib/update-activation.mjs"), "other guard");
	assert.throws(() => webActivationReleaseSupported(f.release, f.root), /checksum failed/);
	rmSync(join(f.release, "app/dist/named.js"));
	assert.equal(webActivationReleaseSupported(f.release, f.root), false);
});

test("a checksum-consistent release cannot redirect a packaged updater entrypoint", (t) => {
	const f = fixture(t);
	writeRelease(f.release, f.record.releaseVersion, [feature], [feature], {
		"updater/node_modules/tuf-js/package.json": JSON.stringify({
			name: "tuf-js",
			main: "dist/index.js",
			exports: "./different-entry.js",
		}),
	});
	assert.throws(() => webActivationReleaseSupported(f.release, f.root), /Unexpected persistent web updater package entrypoint/);
});

test("provisioning refuses a required module missing from both retained core and release inventories", async (t) => {
	const f = fixture(t);
	const core = join(f.updater, "cores/2.0.1");
	const archived = join(f.root, "opt/unit-001/releases/2.0.1");
	const name = "lib/release-version.mjs";
	rmSync(join(core, name));
	const coreManifest = join(core, "CORE-SHA256SUMS.json");
	const coreRows = JSON.parse(readFileSync(coreManifest, "utf8"));
	delete coreRows[name];
	write(coreManifest, JSON.stringify(coreRows));
	rmSync(join(archived, "updater", name));
	const archiveManifest = join(archived, "SHA256SUMS");
	const archiveRows = readFileSync(archiveManifest, "utf8").split("\n");
	write(archiveManifest, archiveRows.filter((row) => !row.endsWith(`  ./updater/${name}`)).join("\n"));
	await assert.rejects(configureWebActivation(f.record, username, f.context), /selected recovery updater core.*release-version/);
	assert.equal(readWebActivation(f.record, f.root), null);
	assert.equal(existsSync(f.wants), false);
	assert.equal(f.calls.some(([command]) => command === "systemctl"), false);
});

test("persistent web provisioning rejects executables without the installed mode before any writes", async (t) => {
	const f = fixture(t);
	const previousUmask = process.umask(0o077);
	try {
		writeAgentCommand(f.record, f.root);
	} finally {
		process.umask(previousUmask);
	}
	assert.equal(lstatSync(f.install.wrapper(f.record.name)).mode & 0o777, 0o755);
	for (const [path, error] of [
		[join(f.release, "runtime/bin/node"), /executable mode 0755/],
		[f.install.wrapper(f.record.name), /executable mode 0755/],
		[join(f.updater, "cores/2.0.0/runtime/bin/node"), /selected current updater core/],
		[join(f.updater, "cores/2.0.1/runtime/bin/node"), /selected recovery updater core/],
	]) {
		for (const mode of [0o644, 0o744]) {
			chmodSync(path, mode);
			await assert.rejects(configureWebActivation(f.record, username, f.context), error);
			assert.equal(lstatSync(path).mode & 0o777, mode);
			assert.equal(readWebActivation(f.record, f.root), null);
			assert.equal(existsSync(f.wants), false);
			assert.equal(existsSync(join(f.unitDirectory, socket)), false);
			assert.equal(existsSync(join(f.unitDirectory, service)), false);
			assert.equal(f.calls.some(([command]) => command === "systemctl"), false);
		}
		chmodSync(path, 0o755);
	}
	await configureWebActivation(f.record, username, f.context);
});

test("persistent web provisioning rejects unreadable or unsearchable installed paths before any writes", async (t) => {
	const f = fixture(t);
	for (const [path, mode] of [
		[f.install.agentRoot, 0o700],
		[f.install.config, 0o700],
		[f.install.record, 0o600],
		[f.install.management, 0o700],
		[join(f.release, "runtime"), 0o700],
		[join(f.release, "app/dist/web"), 0o700],
		[join(f.release, "app/web-dist/style.css"), 0o600],
		[join(f.updater, "cores/2.0.1/runtime"), 0o700],
		[join(f.updater, "cores/2.0.1/lib/control.mjs"), 0o600],
		[join(f.updater, "cores/2.0.0/node_modules/@tufjs/models/dist/index.js"), 0o600],
	]) {
		const originalMode = lstatSync(path).mode & 0o777;
		chmodSync(path, mode);
		await assert.rejects(configureWebActivation(f.record, username, f.context), (error) => {
			assert.match(error.message, /must be (searchable|readable) by non-root accounts/);
			assert.ok(error.message.includes(path));
			return true;
		});
		assert.equal(lstatSync(path).mode & 0o777, mode);
		assert.equal(readWebActivation(f.record, f.root), null);
		assert.equal(existsSync(f.wants), false);
		assert.equal(existsSync(join(f.unitDirectory, socket)), false);
		assert.equal(existsSync(join(f.unitDirectory, service)), false);
		assert.equal(f.calls.some(([command]) => command === "systemctl"), false);
		chmodSync(path, originalMode);
	}
});

test("#80 web enable loads the retained named entrypoint through transitive gateway imports", async (t) => {
	const f = fixture(t);
	const file = "app/dist/service-client.js";
	const manifest = join(f.release, "SHA256SUMS");
	rmSync(join(f.release, file));
	write(manifest, readFileSync(manifest, "utf8").split("\n").filter((line) => !line.endsWith(`  ./${file}`)).join("\n"));
	await assert.rejects(configureWebActivation(f.record, username, f.context), /package smoke failed.*named\.js/s);
	assert.equal(readWebActivation(f.record, f.root), null);
	assert.equal(existsSync(f.wants), false);
	assert.equal(f.calls.some(([command, action]) => command === "systemctl" && action !== "show"), false);
});

test("resumes an interrupted provision only for the same operator and verifies files on retry", async (t) => {
	const f = fixture(t);
	f.controls.fail = ([action]) => {
		if (action === "start") throw new Error("interrupted start");
	};
	await assert.rejects(configureWebActivation(f.record, username, f.context), /interrupted start/);
	assert.equal(readWebActivation(f.record, f.root).state, "provisioning");
	f.controls.fail = undefined;
	f.controls.operatorUid = uid + 1;
	await assert.rejects(configureWebActivation(f.record, username, f.context), /changing the selected operator/);
	f.controls.operatorUid = uid;
	const servicePath = join(f.unitDirectory, service);
	const bytes = readFileSync(servicePath);
	write(servicePath, "unrelated service");
	await assert.rejects(configureWebActivation(f.record, username, f.context), /Preserving unexpected persistent web unit/);
	assert.equal(readFileSync(servicePath, "utf8"), "unrelated service");
	write(servicePath, bytes);
	await configureWebActivation(f.record, username, f.context);
	assert.equal(readWebActivation(f.record, f.root).state, "configured");
});

test("keeps revocation in effect through failed stops and reloads until both units finish stopping", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	f.states.set(service, "active");
	f.controls.failStops = true;
	await assert.rejects(removeWebActivation(f.record, f.context), /units have not stopped/);
	assert.equal(readWebActivation(f.record, f.root).state, "revoking");
	assert.equal(existsSync(join(f.unitDirectory, service)), true);
	assert.deepEqual(f.calls.find((call) => call[1] === "stop"), ["systemctl", "stop", "--job-mode=ignore-dependencies", socket, service]);
	await assert.rejects(configureWebActivation(f.record, username, f.context), /Finish disabling/);
	f.controls.failStops = false;
	f.controls.fail = ([action]) => {
		if (action === "daemon-reload" && !existsSync(join(f.unitDirectory, service))) throw new Error("interrupted final reload");
	};
	await assert.rejects(removeWebActivation(f.record, f.context), /interrupted final reload/);
	assert.equal(f.states.get(service), "inactive");
	assert.equal(f.states.get(socket), "inactive");
	assert.equal(readWebActivation(f.record, f.root).state, "revoking");
	f.controls.fail = undefined;
	await removeWebActivation(f.record, f.context);
	assert.equal(readWebActivation(f.record, f.root), null);
	assert.equal(existsSync(join(f.unitDirectory, socket)), false);
	await removeWebActivation(f.record, f.context);
});

test("resumes an unlinked failed unit only after proving no job, process, override or listener remains", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	write(f.config, JSON.stringify({ ...readWebActivation(f.record, f.root), state: "revoking" }));
	rmSync(f.wants);
	for (const unit of [socket, service]) rmSync(join(f.unitDirectory, unit));
	f.states.set(socket, "failed");
	f.states.set(service, "failed");
	f.controls.job = "9";
	await assert.rejects(removeWebActivation(f.record, f.context), /have not stopped/);
	f.controls.job = "";
	f.controls.mainPid = "72";
	await assert.rejects(removeWebActivation(f.record, f.context), /have not stopped/);
	f.controls.mainPid = "0";
	const dropIn = join(f.unitDirectory, `${socket}.d/admin.conf`);
	write(dropIn, "[Unit]\nAfter=network-online.target\n");
	await assert.rejects(removeWebActivation(f.record, f.context), /unexpected loaded/);
	rmSync(dropIn);
	write(f.listener, "unexpected");
	await assert.rejects(removeWebActivation(f.record, f.context), /unexpected persistent web listener/);
	assert.equal(readFileSync(f.listener, "utf8"), "unexpected");
	assert.equal(f.calls.some((call) => call[1] === "reset-failed"), false);
	rmSync(f.listener);
	await removeWebActivation(f.record, f.context);
	assert.equal(readWebActivation(f.record, f.root), null);
	assert.deepEqual(
		f.calls.filter((call) => call[1] === "reset-failed"),
		[["systemctl", "reset-failed", socket], ["systemctl", "reset-failed", service]],
	);
});

test("refuses a self-consistent core substitution and a mismatched installed management or boot path", async (t) => {
	const f = fixture(t);
	const core = join(f.updater, "cores/2.0.0");
	const manifest = join(core, "CORE-SHA256SUMS.json");
	const checksums = JSON.parse(readFileSync(manifest, "utf8"));
	const guard = join(core, "lib/update-activation.mjs");
	const original = readFileSync(guard);
	const stub = "// replacement that ignores the web guard";
	write(guard, stub);
	write(manifest, JSON.stringify({ ...checksums, "lib/update-activation.mjs": digest(stub) }));
	await assert.rejects(configureWebActivation(f.record, username, f.context), /current updater core/);
	write(guard, original);
	write(manifest, JSON.stringify(checksums));
	const management = join(f.install.management, "agent-command.mjs");
	const helper = readFileSync(management);
	write(management, stub);
	await assert.rejects(configureWebActivation(f.record, username, f.context), /management helper differs/);
	write(management, helper);
	write(join(f.unitDirectory, updatePaths(id, f.root).prepareUnit), stub);
	await assert.rejects(configureWebActivation(f.record, username, f.context), /Unexpected persistent web recovery unit/);
	assert.equal(readWebActivation(f.record, f.root), null);
});

test("disable and operator removal stop the owned serving pair with loaded dependency drop-ins", async (t) => {
	for (const [action, unit, dependency] of [
		[["web", "disable"], socket, `Wants=${service}`],
		[["operator", "remove", username], service, "After=network-online.target"],
	]) {
		await t.test(action.join(" "), async (t) => {
			const f = fixture(t);
			const config = await configureWebActivation(f.record, username, f.context);
			f.states.set(service, "active");
			const dropIn = join(f.unitDirectory, `${unit}.d/admin.conf`);
			const bytes = `[Unit]\n${dependency}\n`;
			write(dropIn, bytes);
			await f.context.run("systemctl", ["daemon-reload"]);
			assert.ok(f.show(unit).includes(`DropInPaths=/etc/systemd/system/${unit}.d/admin.conf`));
			assert.equal(f.states.get(socket), "active");
			assert.match(f.show(service), /^MainPID=72$/m);
			await assert.rejects(configureWebActivation(f.record, username, f.context), /loaded configuration for starting/);
			assert.deepEqual(readWebActivation(f.record, f.root), config);
			assert.equal(await dispatchAgent(id, f.record.name, action, f.context), 0);
			assert.deepEqual(f.calls.find(([, command]) => command === "stop"), [
				"systemctl", "stop", "--job-mode=ignore-dependencies", socket, service,
			]);
			assert.equal(f.states.get(owner), "active");
			assert.equal(f.states.get(socket), "inactive");
			assert.equal(f.states.get(service), "inactive");
			assert.equal(readWebActivation(f.record, f.root), null);
			assert.throws(() => lstatSync(f.wants), { code: "ENOENT" });
			for (const unit of [socket, service]) assert.equal(existsSync(join(f.unitDirectory, unit)), false);
			assert.equal(readFileSync(dropIn, "utf8"), bytes);
			await removeWebActivation(f.record, f.context);
			assert.equal(readFileSync(dropIn, "utf8"), bytes);
		});
	}
});

test("web disable stops a serving pair despite a foreign socket wants link", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	f.states.set(service, "active");
	const link = join(f.unitDirectory, `${socket}.wants`, service);
	const destination = `/etc/systemd/system/${service}`;
	mkdirSync(dirname(link));
	symlinkSync(destination, link);
	assert.equal(f.states.get(socket), "active");
	assert.match(f.show(service), /^MainPID=72$/m);
	assert.equal(await dispatchAgent(id, f.record.name, ["web", "disable"], f.context), 0);
	assert.equal(f.states.get(owner), "active");
	assert.equal(f.states.get(socket), "inactive");
	assert.equal(f.states.get(service), "inactive");
	assert.equal(readWebActivation(f.record, f.root), null);
	assert.throws(() => lstatSync(f.wants), { code: "ENOENT" });
	for (const unit of [socket, service]) assert.equal(existsSync(join(f.unitDirectory, unit)), false);
	assert.equal(readlinkSync(link), destination);
});

test("selected operator removal preserves a foreign owner requires link and waits for the gateway cgroup", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	f.states.set(service, "active");
	assert.equal(f.states.get(socket), "active");
	assert.match(f.show(service), /^MainPID=72$/m);
	const link = join(f.unitDirectory, `${owner}.requires`, service);
	const destination = `/etc/systemd/system/${service}`;
	mkdirSync(dirname(link));
	symlinkSync(destination, link);
	f.controls.serviceCgroup = `/system.slice/${service}`;
	const events = join(f.root, "sys/fs/cgroup", f.controls.serviceCgroup, "cgroup.events");
	write(events, "populated 1\n");
	const remove = () => dispatchAgent(id, f.record.name, ["operator", "remove", username], f.context);
	await assert.rejects(remove(), /control group has not emptied/);
	assert.equal(f.calls.some(([command]) => command === "gpasswd"), false);
	assert.equal(readWebActivation(f.record, f.root).state, "revoking");
	assert.equal(existsSync(join(f.unitDirectory, service)), true);
	assert.equal(readlinkSync(link), destination);
	write(events, "populated 0\n");
	assert.equal(await remove(), 0);
	assert.equal(f.states.get(owner), "active");
	assert.equal(readWebActivation(f.record, f.root), null);
	assert.equal(f.controls.groups, "1200");
	assert.equal(readlinkSync(link), destination);
});

test("web disable requires exact primary fragments both on disk and in the manager", async (t) => {
	for (const location of ["disk", "manager"]) {
		await t.test(location, async (t) => {
			const f = fixture(t);
			await configureWebActivation(f.record, username, f.context);
			f.states.set(service, "active");
			if (location === "disk") {
				rmSync(join(f.unitDirectory, service));
				f.controls.loadedUnit = service;
			} else {
				f.controls.fragments = new Map([[service, `/run/systemd/system/${service}`]]);
			}
			await assert.rejects(
				dispatchAgent(id, f.record.name, ["web", "disable"], f.context),
				location === "disk" ? /Cannot prove ownership/ : /unexpected loaded persistent web unit/,
			);
			assert.equal(f.calls.some(([, action]) => action === "stop"), false);
			assert.equal(f.states.get(service), "active");
			assert.equal(readWebActivation(f.record, f.root).state, "revoking");
		});
	}
});

test("an enabled update policy requires the installed scheduler pair", async (t) => {
	const f = fixture(t);
	write(updatePaths(id, f.root).config, JSON.stringify({ schemaVersion: 1, id, enabled: true }), 0o600);
	await assert.rejects(configureWebActivation(f.record, username, f.context), /unit-001-update/);
	assert.equal(readWebActivation(f.record, f.root), null);
});

test("preserves foreign units, enablement, and socket paths", async (t) => {
	const f = fixture(t);
	const unitPath = join(f.unitDirectory, socket);
	write(unitPath, "foreign unit");
	await assert.rejects(configureWebActivation(f.record, username, f.context), /unregistered persistent web unit/);
	assert.equal(readFileSync(unitPath, "utf8"), "foreign unit");
	rmSync(unitPath);
	write(f.listener, "foreign listener");
	chmodSync(dirname(f.listener), 0o700);
	await assert.rejects(configureWebActivation(f.record, username, f.context), /unexpected persistent web directory/);
	assert.equal(lstatSync(dirname(f.listener)).mode & 0o777, 0o700);
	chmodSync(dirname(f.listener), 0o755);
	await assert.rejects(configureWebActivation(f.record, username, f.context), /unexpected persistent web listener/);
	assert.equal(readFileSync(f.listener, "utf8"), "foreign listener");
	rmSync(f.listener);
	await configureWebActivation(f.record, username, f.context);
	rmSync(f.wants);
	symlinkSync("/foreign", f.wants);
	await assert.rejects(removeWebActivation(f.record, f.context), /unexpected persistent web enablement/);
	assert.equal(readlinkSync(f.wants), "/foreign");
	assert.equal(f.calls.some((call) => call[1] === "stop"), false);
});

test("rejects writable, symbolic, or malformed protected metadata", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	chmodSync(f.config, 0o664);
	assert.throws(() => readWebActivation(f.record, f.root), /owned and protected/);
	rmSync(f.config);
	symlinkSync("missing", f.config);
	assert.throws(() => readWebActivation(f.record, f.root), /Unsafe installation path/);
	rmSync(f.config);
	write(f.config, JSON.stringify({ schemaVersion: 1, id, operator: username, uid, state: "surprise" }));
	assert.throws(() => readWebActivation(f.record, f.root), /Invalid persistent web configuration/);
});

test("manual installer refuses an incompatible candidate with pending revocation before staging anything", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	f.controls.failStops = true;
	await assert.rejects(removeWebActivation(f.record, f.context), /units have not stopped/);
	const source = join(f.scratch, "candidate");
	writeRelease(source, "1.2.4", [feature], []);
	const before = readFileSync(f.install.record);
	const result = spawnSync(process.execPath, [installer, "install", source, f.root, f.record.name, "false"], { encoding: "utf8" });
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /Disable persistent web .* before selecting this release/);
	assert.equal(readlinkSync(f.install.current), "../../releases/1.2.3");
	assert.deepEqual(readFileSync(f.install.record), before);
	assert.equal(existsSync(join(f.root, "opt/unit-001/releases/1.2.4")), false);
	assert.equal(readWebActivation(f.record, f.root).state, "revoking");
});

test("manual installer selects a compatible release without replacing the web pair or core pointers", async (t) => {
	const f = fixture(t, "stopped");
	const config = await configureWebActivation(f.record, username, f.context);
	const before = readFileSync(join(f.unitDirectory, service));
	const source = join(f.scratch, "candidate");
	writeRelease(source, "1.2.4", [feature], [feature], {
		"bin/agent": "# app launcher\n",
		"install.sh": "# archive installer\n",
		...Object.fromEntries(
			["activate.sh", "agent-command.mjs", "installation.mjs", "lifecycle.mjs", "unit-001.service", "update-activation.mjs"].map(
				(name) => [`deploy/${name}`, readFileSync(new URL(`../deploy/${name}`, import.meta.url))],
			),
		),
	});
	chmodSync(join(source, "app/web-dist"), 0o700);
	chmodSync(join(source, "app/web-dist/index.html"), 0o600);
	chmodSync(join(source, "updater/lib/release-version.mjs"), 0o600);
	const result = spawnSync(process.execPath, [installer, "install", source, f.root, f.record.name, "false"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readlinkSync(f.install.current), "../../releases/1.2.4");
	assert.equal(lstatSync(join(source, "runtime/bin/node")).mode & 0o777, 0o644);
	assert.equal(lstatSync(join(f.install.current, "runtime/bin/node")).mode & 0o777, 0o755);
	assert.equal(lstatSync(join(f.install.current, "install.sh")).mode & 0o777, 0o755);
	assert.equal(lstatSync(join(f.install.current, "app/web-dist")).mode & 0o777, 0o755);
	assert.equal(lstatSync(join(f.install.current, "app/web-dist/index.html")).mode & 0o777, 0o644);
	assert.equal(lstatSync(join(f.updater, "cores/1.2.4/runtime/bin/node")).mode & 0o777, 0o755);
	assert.equal(lstatSync(join(f.updater, "cores/1.2.4/lib/release-version.mjs")).mode & 0o777, 0o644);
	assert.equal(readlinkSync(join(f.updater, "current")), "cores/2.0.0");
	assert.equal(readlinkSync(join(f.updater, "recovery")), "cores/2.0.1");
	assert.deepEqual(readWebActivation(f.record, f.root), config);
	assert.deepEqual(readFileSync(join(f.unitDirectory, service)), before);
});

test("#80 full install rejects a checksum-valid staged updater with a missing transitive module", async (t) => {
	const f = fixture(t, "stopped");
	const config = await configureWebActivation(f.record, username, f.context);
	const source = join(f.scratch, "candidate");
	const version = "1.2.4";
	writeRelease(source, version, [feature], [feature], {
		"bin/agent": "# app launcher\n",
		"install.sh": "# archive installer\n",
	});
	const file = "updater/node_modules/@tufjs/models/dist/base.js";
	const manifest = join(source, "SHA256SUMS");
	rmSync(join(source, file));
	write(manifest, readFileSync(manifest, "utf8").split("\n").filter((line) => !line.endsWith(`  ./${file}`)).join("\n"));
	const result = spawnSync(process.execPath, [installer, "install", source, f.root, f.record.name, "false"], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /package smoke failed.*update\.mjs/s);
	assert.match(result.stderr, /Cannot find module '\.\/base\.js'/);
	assert.deepEqual(readdirSync(dirname(f.release)).sort(), ["1.2.3", "2.0.0", "2.0.1"]);
	assert.deepEqual(readdirSync(join(f.updater, "cores")).sort(), ["2.0.0", "2.0.1"]);
	assert.equal(readlinkSync(f.install.current), "../../releases/1.2.3");
	assert.deepEqual(readWebActivation(f.record, f.root), config);
});

test("manual installer refuses an exact but incomplete persistent web inventory before selecting or staging", async (t) => {
	const f = fixture(t, "stopped");
	await configureWebActivation(f.record, username, f.context);
	const source = join(f.scratch, "candidate");
	const destination = join(f.root, "opt/unit-001/releases/1.2.4");
	const update = updatePaths(id, f.root);
	const state = join(f.install.state, "marker");
	write(state, "private state\n", 0o600);
	write(update.config, "{\"enabled\":false}\n", 0o600);
	const protectedFiles = [f.install.record, f.config, state, update.config, join(f.unitDirectory, service)];
	const before = protectedFiles.map((file) => readFileSync(file));
	const manifest = join(source, "SHA256SUMS");
	for (const name of [
		"app/dist/named.js",
		"app/web-dist/index.html",
		"app/web-dist/bootstrap.js",
		"app/web-dist/style.css",
		"runtime/bin/node",
		"updater/runtime/bin/node",
		"updater/lib/release-version.mjs",
		"updater/lib/update-trust.mjs",
		"updater/lib/control.mjs",
		"updater/node_modules/@tufjs/models/package.json",
		"updater/node_modules/tuf-js/dist/index.js",
		"updater/node_modules/tuf-js/dist/error.js",
	]) {
		writeRelease(source, "1.2.4");
		rmSync(join(source, name));
		const rows = readFileSync(manifest, "utf8").split("\n").filter((row) => !row.endsWith(`  ./${name}`));
		write(manifest, rows.join("\n"));
		const result = spawnSync(process.execPath, [installer, "install", source, f.root, f.record.name, "false"], { encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Disable persistent web .* before selecting this release/);
		assert.equal(existsSync(destination), false);
		assert.equal(existsSync(join(update.cores, "1.2.4")), false);
		assert.deepEqual(protectedFiles.map((file) => readFileSync(file)), before);
		assert.equal(readlinkSync(f.install.current), "../../releases/1.2.3");
	}
});

test("manual installer refuses to reuse retained runtime paths with the wrong installed mode", async (t) => {
	const f = fixture(t, "stopped");
	await configureWebActivation(f.record, username, f.context);
	const source = join(f.scratch, "candidate");
	const destination = join(f.root, "opt/unit-001/releases/1.2.4");
	const core = join(f.updater, "cores/1.2.4");
	writeRelease(source, "1.2.4");
	writeRelease(destination, "1.2.4");
	writeCore(core, [feature]);
	const current = readlinkSync(f.install.current);
	const before = readFileSync(f.install.record);
	chmodSync(join(destination, "runtime/bin/node"), 0o755);
	for (const [path, mode, error] of [
		[join(destination, "runtime/bin/node"), 0o744, "executable mode 0755"],
		[join(core, "runtime/bin/node"), 0o744, "executable mode 0755"],
		[join(destination, "app/web-dist"), 0o700, "searchable by non-root accounts"],
		[join(destination, "app/web-dist/index.html"), 0o600, "readable by non-root accounts"],
		[join(core, "lib/release-version.mjs"), 0o600, "readable by non-root accounts"],
	]) {
		const originalMode = lstatSync(path).mode & 0o777;
		chmodSync(path, mode);
		const result = spawnSync(process.execPath, [installer, "install", source, f.root, f.record.name, "false"], { encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		assert.ok(result.stderr.includes(`${error}: ${path}`));
		assert.equal(lstatSync(path).mode & 0o777, mode);
		assert.deepEqual(readFileSync(f.install.record), before);
		assert.equal(readlinkSync(f.install.current), current);
		chmodSync(path, originalMode);
	}
});

test("manual installer rejects a substituted reused core before publishing or staging a release", async (t) => {
	const f = fixture(t, "stopped");
	await configureWebActivation(f.record, username, f.context);
	const source = join(f.scratch, "candidate");
	writeRelease(source, "1.2.4");
	const core = join(f.updater, "cores/1.2.4");
	writeCore(core, [feature]);
	const manifest = join(core, "CORE-SHA256SUMS.json");
	const checksums = JSON.parse(readFileSync(manifest, "utf8"));
	const guard = "// substituted candidate guard";
	write(join(core, "lib/update-activation.mjs"), guard);
	write(manifest, JSON.stringify({ ...checksums, "lib/update-activation.mjs": digest(guard) }));
	const result = spawnSync(process.execPath, [installer, "install", source, f.root, f.record.name, "false"], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /updater bytes differ from the retained release/);
	assert.equal(existsSync(join(f.root, "opt/unit-001/releases/1.2.4")), false);
	assert.equal(readlinkSync(f.install.current), "../../releases/1.2.3");
});

function webCheckFixture(f) {
	const preload = join(f.scratch, "web-check-fixture.mjs");
	// Exercise the CLI with a fixture filesystem, NSS, UID, and manager state.
	write(preload, `
import fs from "node:fs";
import child from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const stagedRoot = ${JSON.stringify(f.root)};
const mapPath = (path) => typeof path === "string" && (/^\\/(etc|opt|run)(\\/|$)/).test(path)
	? join(stagedRoot, path) : path;
const { existsSync, lstatSync, readFileSync, readlinkSync } = fs;
const fixtureUid = process.getuid();
process.getuid = () => process.argv.includes("socket") ? 0 : ${uid};
fs.existsSync = (path) => existsSync(mapPath(path));
fs.lstatSync = (path, ...args) => {
	const staged = mapPath(path);
	const result = lstatSync(staged, ...args);
	if (staged !== path && result.uid === fixtureUid) result.uid = 0;
	return result;
};
fs.readFileSync = (path, ...args) => {
	if (typeof path === "string" && path.endsWith("/update/journal.json")) throw new Error("Journal is private.");
	return readFileSync(mapPath(path), ...args);
};
fs.readlinkSync = (path, ...args) => readlinkSync(mapPath(path), ...args);
child.execFileSync = (command, args) => {
	if (command === "systemctl" && args[0] === "show") {
		const properties = JSON.parse(process.env.WEB_TEST_UNIT_PROPERTIES)[args.at(-1)];
		if (properties !== undefined) return properties;
	}
	if (command === "id") return process.env.WEB_TEST_GROUPS;
	if (command === "getent" && args[1] === ${JSON.stringify(account)})
		return ${JSON.stringify(`${account}:x:979:980::/var/lib/agent:/usr/sbin/nologin`)};
	if (command === "getent" && [${JSON.stringify(username)}, "${uid}"].includes(args[1]))
		return ${JSON.stringify(`${username}:x:${uid}:1200::/home/${username}:/bin/sh`)};
	throw new Error("Unexpected host command: " + command);
};
syncBuiltinESMExports();
`);
	return (groups, ...role) => {
		const properties = Object.fromEntries([owner, socket, service].map((unit) => [unit, f.show(unit)]));
		return spawnSync(process.execPath, ["--import", preload, installer, "web-check", id, String(uid), ...role], {
			encoding: "utf8",
			timeout: 5000,
			env: { ...process.env, WEB_TEST_GROUPS: groups, WEB_TEST_UNIT_PROPERTIES: JSON.stringify(properties) },
		});
	};
}

test("web-check refuses loaded overrides on either web unit in both activation roles", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	const check = webCheckFixture(f);
	assert.equal(f.states.get(service) ?? "inactive", "inactive");
	for (const unit of [socket, service]) {
		const dropIn = join(f.unitDirectory, `${unit}.d/admin.conf`);
		write(dropIn, "[Unit]\nAfter=network-online.target\n");
		for (const role of [["socket"], []]) {
			const checkResult = check("1200 980", ...role);
			assert.equal(checkResult.status, 1, checkResult.stderr);
			assert.match(checkResult.stderr, /loaded configuration for starting/);
		}
		rmSync(dropIn);
	}
	for (const role of [["socket"], []]) {
		const checkResult = check("1200 980", ...role);
		assert.equal(checkResult.status, 0, checkResult.stderr);
	}
	assert.equal(f.states.get(service) ?? "inactive", "inactive");
});

test("web-check validates the new selected version as the operator without reading the private update journal", async (t) => {
	const f = fixture(t);
	await configureWebActivation(f.record, username, f.context);
	const next = { ...f.record, releaseVersion: "1.2.4" };
	const release = join(f.root, "opt/unit-001/releases", next.releaseVersion);
	writeRelease(release, next.releaseVersion);
	const runtime = join(release, "runtime/bin/node");
	chmodSync(runtime, 0o755);
	rmSync(f.install.current);
	symlinkSync(`../../releases/${next.releaseVersion}`, f.install.current);
	writeInstallation(next, f.root);
	write(join(f.install.config, "update/journal.json"), '{"phase":"complete"}\n', 0o600);
	const check = webCheckFixture(f);
	const updated = check("1200 980");
	assert.equal(updated.status, 0, updated.stderr);
	chmodSync(runtime, 0o744);
	const invalidMode = check("1200 980");
	assert.equal(invalidMode.status, 1);
	assert.match(invalidMode.stderr, /executable mode 0755/);
	chmodSync(runtime, 0o755);
	const removed = check("1200");
	assert.equal(removed.status, 1);
	assert.match(removed.stderr, /not an installation operator/);
	const config = readWebActivation(next, f.root);
	write(f.config, JSON.stringify({ ...config, state: "provisioning" }));
	assert.equal(check("1200 980").status, 1);
	const socketCheck = check("1200 980", "socket");
	assert.equal(socketCheck.status, 0, socketCheck.stderr);
	write(f.config, JSON.stringify(config));
	writeInstallation({ ...next, desiredState: "stopped" }, f.root);
	const stopped = check("1200 980");
	assert.equal(stopped.status, 1);
	assert.match(stopped.stderr, /not available for this installation/);
});
