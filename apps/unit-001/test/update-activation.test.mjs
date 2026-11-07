// #18: Update fault recovery keeps a two-way door until commit and never restores state after release.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { installationPaths, readInstallation, writeInstallation } from "../deploy/installation.mjs";
import {
	activateUpdate,
	installUpdateCore,
	readUpdateJournal,
	recoverUpdate,
	restartUpdateScheduling,
	rollbackUpdate,
	updatePaths,
	updateScheduling,
} from "../deploy/update-activation.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = "11111111-1111-4111-8111-111111111111";
const compatibility = { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 };

function release(root, version, stateCompatibility = compatibility) {
	const directory = join(root, "opt/unit-001/releases", version);
	const files = {
		VERSION: `${version}\n`,
		"release.json": JSON.stringify({ compatibility: stateCompatibility }),
		"runtime/bin/node": "node",
		"bin/agent": "agent",
		"install.sh": "install",
		"updater/runtime/bin/node": "independent node",
		"updater/lib/update.mjs": "independent core",
	};
	for (const name of ["installation.mjs", "lifecycle.mjs", "agent-command.mjs", "update-activation.mjs"])
		files[`deploy/${name}`] = readFileSync(fileURLToPath(new URL(`../deploy/${name}`, import.meta.url)), "utf8");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), text);
	}
	writeFileSync(
		join(directory, "SHA256SUMS"),
		Object.entries(files)
			.map(([path, text]) => `${createHash("sha256").update(text).digest("hex")}  ./${path}\n`)
			.join(""),
	);
	return directory;
}

function setup(mode = "healthy") {
	const root = mkdtempSync(join(tmpdir(), "unit-update-"));
	roots.push(root);
	const record = {
		schemaVersion: 1,
		id,
		name: "agent",
		account: "ua-111111111111411181111111",
		releaseVersion: "0.0.2",
		desiredState: "running",
	};
	writeInstallation(record, root);
	const paths = installationPaths(id, root);
	mkdirSync(join(paths.state, "sessions"), { recursive: true });
	mkdirSync(paths.management, { recursive: true });
	mkdirSync(paths.agentRoot, { recursive: true });
	const database = new DatabaseSync(join(paths.state, "sessions/default.sqlite"));
	database.exec("CREATE TABLE proof(value TEXT)");
	database.close();
	writeFileSync(join(paths.state, "marker"), "old state");
	const old = release(root, "0.0.2");
	const next = release(root, "0.0.3");
	symlinkSync("../../releases/0.0.2", paths.current);
	const calls = [];
	let running = mode !== "broken";
	let inhibited = false;
	let maintenance = { protocol: 1, state: "open", operationId: null };
	const context = {
		root,
		async run(command, args) {
			calls.push([command, ...args]);
			if (command === "systemctl") {
				if (args[0] === "show") return running ? "active" : "failed";
				if (args[0] === "stop") running = false;
				if (args[0] === "start" || (args[0] === "enable" && args.includes("--now"))) {
					running = true;
					inhibited = readUpdateJournal(id, root)?.phase !== "complete";
				}
			}
			return "";
		},
		async control(current, args) {
			calls.push(["control", ...args]);
			if (!running) throw new Error("service unavailable");
			if (args[0] === "service-status")
				return {
					type: "status",
					installationId: id,
					version: current.releaseVersion,
					pid: 1,
					inhibited,
					maintenance,
				};
			if (args[0] === "maintenance-enter") {
				maintenance = { protocol: 1, state: "held", operationId: args[2] };
				return { type: "maintenance", ...maintenance, result: mode === "busy" ? "deferred" : "drained" };
			}
			if (args[0] === "maintenance-release") {
				assert.ok(["complete", "committed", "restored", "holding"].includes(readUpdateJournal(id, root).phase));
				maintenance = { protocol: 1, state: "open", operationId: null };
				inhibited = false;
				return { type: "maintenance", ...maintenance };
			}
			throw new Error("Unknown control");
		},
		async ready(current, operationId) {
			if (maintenance.state === "open" && inhibited)
				await this.control(current, ["maintenance-enter", "--operation-id", operationId, "--timeout-ms", "0"]);
			assert.equal(inhibited, true);
			assert.equal(maintenance.operationId, operationId);
		},
	};
	installUpdateCore(record, old, context);
	return { root, record, paths, context, calls, candidate: { releasePath: next, version: "0.0.3", compatibility } };
}

test("#18 independent core survives an unusable application and activates a compatible repair", async () => {
	const fixture = setup("broken");
	assert.deepEqual(await activateUpdate(fixture.record, fixture.candidate, fixture.context), {
		status: "updated",
		version: "0.0.3",
	});
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
	assert.equal(readlinkSync(updatePaths(id, fixture.root).currentCore), "cores/0.0.3");
	assert.equal(readlinkSync(updatePaths(id, fixture.root).recoveryCore), "cores/0.0.2");
	assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
});

test("#18 busy work defers with an explicit gate release and no service stop", async () => {
	const fixture = setup("busy");
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "deferred");
	assert.ok(!fixture.calls.some((call) => call[0] === "systemctl" && call[1] === "stop"));
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
});

test("#18 incompatible metadata and stopped operator intent never activate", async () => {
	const fixture = setup();
	assert.equal(
		(
			await activateUpdate(
				fixture.record,
				{ ...fixture.candidate, compatibility: { ...compatibility, stateVersion: 2 } },
				fixture.context,
			)
		).status,
		"incompatible",
	);
	writeInstallation({ ...fixture.record, desiredState: "stopped" }, fixture.root);
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "deferred");
	assert.deepEqual(fixture.calls, []);
});

for (const phase of ["holding", "backed-up", "candidate"])
	test(`#18 power loss at ${phase} restores only precommit state`, async () => {
		const fixture = setup();
		fixture.context.fault = (current) => {
			if (current === phase) {
				if (phase === "candidate") writeFileSync(join(fixture.paths.state, "marker"), "candidate migration");
				throw new Error("power loss");
			}
		};
		await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /power loss/);
		delete fixture.context.fault;
		await fixture.context.run("systemctl", ["stop", fixture.paths.unit]);
		await recoverUpdate(fixture.record, fixture.context, { phase: "prepare" });
		assert.equal(readlinkSync(fixture.paths.current), "../../releases/0.0.2");
		assert.equal(readFileSync(join(fixture.paths.state, "marker"), "utf8"), "old state");
		await fixture.context.run("systemctl", ["start", fixture.paths.unit]);
		await recoverUpdate(fixture.record, fixture.context, { phase: "finalize" });
		assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
	});

test("#18 committed recovery preserves new state and never restores the closed backup", async () => {
	const fixture = setup();
	fixture.context.fault = (phase) => {
		if (phase === "committed") throw new Error("power loss");
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /power loss/);
	delete fixture.context.fault;
	writeFileSync(join(fixture.paths.state, "marker"), "new durable work");
	await recoverUpdate(fixture.record, fixture.context);
	assert.equal(readFileSync(join(fixture.paths.state, "marker"), "utf8"), "new durable work");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
});

test("#18 explicit rollback performs another drain and keeps current state", async () => {
	const fixture = setup();
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	writeFileSync(join(fixture.paths.state, "marker"), "work after update");
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	assert.equal(readFileSync(join(fixture.paths.state, "marker"), "utf8"), "work after update");
});

test("#18 stopped recovery remains stopped until an explicit recovery start", async () => {
	const fixture = setup();
	fixture.context.fault = (phase) => {
		if (phase === "holding") throw new Error("power loss");
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /power loss/);
	delete fixture.context.fault;
	writeInstallation({ ...readInstallation(id, fixture.root), desiredState: "stopped" }, fixture.root);
	await fixture.context.run("systemctl", ["stop", fixture.paths.unit]);
	const begin = fixture.calls.length;
	assert.equal((await recoverUpdate(fixture.record, fixture.context)).status, "deferred");
	assert.ok(!fixture.calls.slice(begin).some((call) => call[0] === "systemctl" && call[1] === "start"));
	await assert.rejects(
		recoverUpdate(fixture.record, fixture.context, { phase: "prepare", start: true }),
		/boot phase/,
	);
	assert.equal((await recoverUpdate(fixture.record, fixture.context, { start: true })).status, "recovered");
	assert.equal(readInstallation(id, fixture.root).desiredState, "running");
});

test("#18 a live unreachable service and another session both defer without stopping work", async () => {
	const fixture = setup();
	const control = fixture.context.control;
	fixture.context.control = async () => {
		throw new Error("unreachable");
	};
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "deferred");
	fixture.context.control = control;
	writeFileSync(join(fixture.paths.state, "sessions/other.sqlite"), "other owner");
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "deferred");
	assert.ok(!fixture.calls.some((call) => call[0] === "systemctl" && call[1] === "stop"));
});

test("#18 policy changed during fetch is checked again inside activation ownership", async () => {
	const fixture = setup();
	fixture.context.admit = () => ({ status: "deferred", reason: "Disabled during fetch" });
	assert.deepEqual(await activateUpdate(fixture.record, fixture.candidate, fixture.context), {
		status: "deferred",
		reason: "Disabled during fetch",
	});
	assert.deepEqual(fixture.calls, []);
});

test("#18 explicit start restores only enabled protected scheduling with exact unit ownership", async () => {
	const fixture = setup();
	const paths = updatePaths(id, fixture.root);
	writeFileSync(paths.config, JSON.stringify({ schemaVersion: 1, id, enabled: true }));
	const scheduling = updateScheduling(fixture.record, fixture.root);
	writeFileSync(scheduling.servicePath, scheduling.serviceContents);
	writeFileSync(scheduling.timerPath, scheduling.timerContents);
	await restartUpdateScheduling(fixture.record, fixture.context);
	assert.deepEqual(fixture.calls.at(-1), ["systemctl", "enable", "--now", scheduling.timerName]);
	writeFileSync(scheduling.timerPath, "unrelated timer");
	await assert.rejects(restartUpdateScheduling(fixture.record, fixture.context), /unexpected/);
});

test("#18 an independent session lock prevents backup until the owner closes", async () => {
	const fixture = setup();
	const owner = new DatabaseSync(join(fixture.paths.state, "sessions/default.sqlite.lock"));
	owner.exec("BEGIN EXCLUSIVE");
	try {
		await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /locked/);
	} finally {
		owner.close();
	}
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	assert.equal(readFileSync(join(fixture.paths.state, "marker"), "utf8"), "old state");
	assert.equal((await recoverUpdate(fixture.record, fixture.context)).status, "idle");
});

test("#18 core retention keeps only current, previous and recovery selections", async () => {
	const fixture = setup();
	for (const version of ["0.0.0", "0.0.1"])
		installUpdateCore(
			{ ...fixture.record, releaseVersion: version },
			release(fixture.root, version),
			fixture.context,
		);
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	assert.deepEqual(readdirSync(updatePaths(id, fixture.root).cores).sort(), ["0.0.2", "0.0.3"]);
});

test("#18 rollback checks the previous payload's reader compatibility", async () => {
	const fixture = setup();
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	release(fixture.root, "0.0.2", { ...compatibility, minReaderVersion: 2 });
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "incompatible");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
});

test("#18 failed recovery preparation preserves stopped operator intent", async () => {
	const fixture = setup();
	fixture.context.fault = (phase) => {
		if (phase === "holding") throw new Error("crash");
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /crash/);
	delete fixture.context.fault;
	const path = updatePaths(id, fixture.root).journal;
	writeFileSync(path, JSON.stringify({ ...readUpdateJournal(id, fixture.root), phase: "backed-up" }));
	writeInstallation({ ...fixture.record, desiredState: "stopped" }, fixture.root);
	await assert.rejects(recoverUpdate(fixture.record, fixture.context, { start: true }), /backup is missing/);
	assert.equal(readInstallation(id, fixture.root).desiredState, "stopped");
});

test("#18 a reboot after deferred release clears inhibited startup before completing recovery", async () => {
	const fixture = setup("busy");
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	const path = updatePaths(id, fixture.root).journal;
	writeFileSync(
		path,
		JSON.stringify({ ...readUpdateJournal(id, fixture.root), phase: "restored", liveDeferred: true }),
	);
	await fixture.context.run("systemctl", ["stop", fixture.paths.unit]);
	await recoverUpdate(fixture.record, fixture.context, { phase: "prepare" });
	await fixture.context.run("systemctl", ["start", fixture.paths.unit]);
	await recoverUpdate(fixture.record, fixture.context, { phase: "finalize" });
	const status = await fixture.context.control(fixture.record, ["service-status"]);
	assert.equal(status.inhibited, false);
	assert.equal(status.maintenance.state, "open");
	assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
});

test("#18 closed backup excludes the live control socket tree", async () => {
	const fixture = setup();
	const control = join(fixture.paths.state, "control");
	mkdirSync(control);
	const short = mkdtempSync("/tmp/unit-ctl-");
	roots.push(short);
	symlinkSync(control, join(short, "c"));
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(join(short, "c/a"), resolve);
	});
	try {
		assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
		assert.equal(existsSync(join(updatePaths(id, fixture.root).configDirectory, "backup/control")), false);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("#18 insufficient backup space defers before closing admissions", async () => {
	const fixture = setup();
	fixture.context.availableBytes = () => 0;
	assert.match((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).reason, /free space/);
	assert.ok(!fixture.calls.some((call) => call[0] === "control" && call[1] === "maintenance-enter"));
});

for (const kind of ["directory", "lock"])
	test(`#18 root ownership probes refuse an agent-controlled ${kind} symlink`, async () => {
		const fixture = setup();
		const outside = join(fixture.root, "outside");
		mkdirSync(outside);
		const file = join(outside, "unrelated.sqlite");
		const database = new DatabaseSync(file);
		database.exec("CREATE TABLE unrelated(value TEXT)");
		database.close();
		const before = readFileSync(file);
		if (kind === "directory") {
			renameSync(join(fixture.paths.state, "sessions"), join(outside, "sessions"));
			symlinkSync(join(outside, "sessions"), join(fixture.paths.state, "sessions"));
		} else symlinkSync(file, join(fixture.paths.state, "sessions/default.sqlite.lock"));
		await assert.rejects(
			activateUpdate(fixture.record, fixture.candidate, fixture.context),
			/Unsafe installation path|regular files/,
		);
		assert.deepEqual(readFileSync(file), before);
		assert.deepEqual(
			readdirSync(outside).sort(),
			kind === "directory" ? ["sessions", "unrelated.sqlite"] : ["unrelated.sqlite"],
		);
	});

test("#18 a crash between recovery directory renames can retry from the closed backup", async () => {
	const fixture = setup();
	fixture.context.fault = (phase) => {
		if (phase === "backed-up") throw new Error("candidate failure");
		if (phase === "restore-quarantined") throw new Error("restore crash");
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /restore crash/);
	assert.equal(existsSync(fixture.paths.state), false);
	delete fixture.context.fault;
	await recoverUpdate(fixture.record, fixture.context);
	assert.equal(readFileSync(join(fixture.paths.state, "marker"), "utf8"), "old state");
	const database = new DatabaseSync(join(fixture.paths.state, "sessions/default.sqlite"));
	try {
		assert.equal(database.prepare("SELECT COUNT(*) AS count FROM proof").get().count, 0);
	} finally {
		database.close();
	}
});
