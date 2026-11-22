// #18: Update fault recovery keeps a two-way door until commit and never restores state after release.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
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
	serviceUnitExpansions,
	updatePaths,
	updateScheduling,
} from "../deploy/update-activation.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = "11111111-1111-4111-8111-111111111111";
const compatibility = { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 };

const template = readFileSync(fileURLToPath(new URL("../deploy/unit-001.service", import.meta.url)), "utf8");

function release(root, version, stateCompatibility = compatibility, serviceTemplate = template) {
	const directory = join(root, "opt/unit-001/releases", version);
	const files = {
		VERSION: `${version}\n`,
		"release.json": JSON.stringify({ compatibility: stateCompatibility }),
		"runtime/bin/node": "node",
		"bin/agent": "agent",
		"install.sh": "install",
		"updater/runtime/bin/node": "independent node",
		"updater/lib/update.mjs": "independent core",
		"updater/lib/update-activation.mjs": "activation core",
		"deploy/unit-001.service": serviceTemplate,
	};
	if (version === "0.0.6")
		files["deploy/unit-001.service"] = files["deploy/unit-001.service"].replace(
			"RuntimeDirectory=unit-001-@ID@\nRuntimeDirectoryMode=0750\n",
			"",
		);
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

function setup(mode = "healthy", versions = { baseline: "0.0.2", candidate: "0.0.3" }) {
	const root = mkdtempSync(join(tmpdir(), "unit-update-"));
	roots.push(root);
	const record = {
		schemaVersion: 1,
		id,
		name: "agent",
		account: "ua-111111111111411181111111",
		releaseVersion: versions.baseline,
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
	const old = release(root, versions.baseline);
	const next = release(root, versions.candidate);
	symlinkSync(`../../releases/${versions.baseline}`, paths.current);
	mkdirSync(dirname(paths.unitFile), { recursive: true });
	writeFileSync(
		paths.unitFile,
		readFileSync(join(old, "deploy/unit-001.service"), "utf8")
			.replaceAll("@ID@", id)
			.replaceAll("@ACCOUNT@", record.account),
	);
	const calls = [];
	let running = mode !== "broken";
	let inhibited = false;
	let maintenance = { protocol: 1, state: "open", operationId: null };
	const context = {
		root,
		async run(command, args) {
			calls.push([command, ...args]);
			if (command === "systemctl") {
				// Systemd's loaded view: the managed unit file plus the updater's recovery drop-in.
				if (args.includes("--property=FragmentPath")) return `/etc/systemd/system/${paths.unit}`;
				if (args.includes("--property=DropInPaths")) return `/etc/systemd/system/${paths.unit}.d/update.conf`;
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
	return {
		root,
		record,
		paths,
		context,
		calls,
		candidate: { releasePath: next, version: versions.candidate, compatibility },
	};
}

// #33: A bootstrapped operator unit must not break the old 0.0.6 lifecycle after explicit code rollback.
test("#33 legacy rollback preserves custom service policy before draining or stopping work", async () => {
	const fixture = setup("healthy", { baseline: "0.0.7", candidate: "0.0.6" });
	const custom = `${readFileSync(fixture.paths.unitFile, "utf8")}# administrator customization\n`;
	writeFileSync(fixture.paths.unitFile, custom);
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /unowned service unit/);
	assert.deepEqual(fixture.calls, []);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), custom);
});

test("#33 explicit 0.0.7 to 0.0.6 activation restores the exact legacy unit before startup", async () => {
	const fixture = setup("healthy", { baseline: "0.0.7", candidate: "0.0.6" });
	const legacy = readFileSync(join(fixture.candidate.releasePath, "deploy/unit-001.service"), "utf8")
		.replaceAll("@ID@", id)
		.replaceAll("@ACCOUNT@", fixture.record.account);
	const run = fixture.context.run;
	fixture.context.run = async (command, args, ...rest) => {
		if (command === "systemctl" && args[0] === "start")
			assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), legacy);
		return run(command, args, ...rest);
	};
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), legacy);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.6");
});

for (const phase of ["service-unit", "candidate"])
	test(`#33 interrupted legacy rollback at ${phase} restores the operator unit and owner`, async () => {
		const fixture = setup("healthy", { baseline: "0.0.7", candidate: "0.0.6" });
		const previous = readFileSync(fixture.paths.unitFile, "utf8");
		const run = fixture.context.run;
		let crashed = false;
		fixture.context.fault = (current) => {
			if (current === phase) {
				crashed = true;
				throw new Error("power loss");
			}
		};
		fixture.context.run = async (...args) => {
			if (crashed) throw new Error("power loss");
			return run(...args);
		};
		await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /power loss/);
		assert.notEqual(readFileSync(fixture.paths.unitFile, "utf8"), previous);
		assert.equal(readInstallation(id, fixture.root).releaseVersion, phase === "candidate" ? "0.0.6" : "0.0.7");
		delete fixture.context.fault;
		fixture.context.run = run;
		await recoverUpdate(fixture.record, fixture.context);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), previous);
		assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.7");
		assert.equal(readlinkSync(fixture.paths.current), "../../releases/0.0.7");
		assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
	});

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
	// The deferral leaves no journal of its own: the installation never had an update to roll back.
	assert.equal(readUpdateJournal(id, fixture.root), null);
	assert.equal(existsSync(updatePaths(id, fixture.root).priorJournal), false);
});

// unit-6si: a deferred attempt once completed its own journal, which names the unchanged release as the update's
// result; rollback then refused every retry and `update rollback` pinned the current release.
test("#18 a rollback deferred under the hold keeps the committed journal, and its retry succeeds", async () => {
	const fixture = setup();
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	const committed = readFileSync(updatePaths(id, fixture.root).journal, "utf8");
	const control = fixture.context.control;
	fixture.context.control = async (current, args) => {
		const result = await control(current, args);
		return args[0] === "maintenance-enter" && args[4] === "30000" ? { ...result, result: "deferred" } : result;
	};
	fixture.calls.length = 0;
	const deferred = await rollbackUpdate(readInstallation(id, fixture.root), fixture.context);
	assert.deepEqual(deferred, { status: "deferred", reason: "Active work did not drain." });
	assert.ok(!fixture.calls.some((call) => call[0] === "systemctl" && call[1] === "stop"));
	const status = await control(fixture.record, ["service-status"]);
	assert.equal(status.maintenance.state, "open");
	assert.equal(readFileSync(updatePaths(id, fixture.root).journal, "utf8"), committed);
	fixture.context.control = control;
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
});

test("#18 power loss after a deferral released its hold still restores the committed journal", async () => {
	const fixture = setup();
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	const committed = readFileSync(updatePaths(id, fixture.root).journal, "utf8");
	const control = fixture.context.control;
	fixture.context.control = async (current, args) => {
		const result = await control(current, args);
		return args[0] === "maintenance-enter" && args[4] === "30000" ? { ...result, result: "deferred" } : result;
	};
	fixture.context.fault = (phase) => {
		if (phase === "restored") throw new Error("power loss");
	};
	await assert.rejects(rollbackUpdate(readInstallation(id, fixture.root), fixture.context), /power loss/);
	delete fixture.context.fault;
	fixture.context.control = control;
	// The in-process recovery ends the deferral through the same path a boot recovery takes.
	assert.equal(readFileSync(updatePaths(id, fixture.root).journal, "utf8"), committed);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
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
		// "holding" changed nothing, so it puts back the journal it displaced; this first attempt displaced none.
		if (phase === "holding") assert.equal(readUpdateJournal(id, fixture.root), null);
		else assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
	});

// Codex wiring re-check: boot preparation saw "holding", skipped the live-owner branch that restores the prior journal,
// and finalization completed the attempt journal over the committed one, so rollback refused every retry.
test("#18 power loss at holding during a rollback keeps the committed journal through boot recovery", async () => {
	const fixture = setup();
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	const committed = readFileSync(updatePaths(id, fixture.root).journal, "utf8");
	// Thrown right after the journal is saved, before the hold: nothing in the process runs recovery.
	fixture.context.fault = (phase) => {
		if (phase === "holding") throw new Error("power loss");
	};
	await assert.rejects(rollbackUpdate(readInstallation(id, fixture.root), fixture.context), /power loss/);
	delete fixture.context.fault;
	assert.equal(readUpdateJournal(id, fixture.root).phase, "holding");
	await fixture.context.run("systemctl", ["stop", fixture.paths.unit]);
	assert.deepEqual(await recoverUpdate(fixture.record, fixture.context, { phase: "prepare" }), { status: "prepared" });
	await fixture.context.run("systemctl", ["start", fixture.paths.unit]);
	assert.equal((await recoverUpdate(fixture.record, fixture.context, { phase: "finalize" })).status, "recovered");
	const status = await fixture.context.control(fixture.record, ["service-status"]);
	assert.equal(status.inhibited, false);
	assert.equal(status.maintenance.state, "open");
	assert.equal(readFileSync(updatePaths(id, fixture.root).journal, "utf8"), committed);
	assert.equal(existsSync(updatePaths(id, fixture.root).priorJournal), false);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
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

// #72: a release without the loop task leaves a live loop blocked and then defers its own updates forever.
const loopCompatibility = { ...compatibility, features: ["mission-loop"] };

async function loopFixture(answer) {
	const fixture = setup();
	fixture.candidate = { ...fixture.candidate, compatibility: loopCompatibility };
	release(fixture.root, "0.0.3", loopCompatibility);
	fixture.context.missionStatus = async () => {
		fixture.calls.push(["mission-status"]);
		return answer();
	};
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	assert.ok(!fixture.calls.some((call) => call[0] === "mission-status"), "A forward install never asks.");
	fixture.calls.length = 0;
	return fixture;
}

test("#72 rollback dropping the mission loop defers before any journal or hold while a loop is live", async () => {
	let rollback = "live-loop";
	const fixture = await loopFixture(() => ({ loopRollback: rollback }));
	const journal = readFileSync(updatePaths(id, fixture.root).journal, "utf8");
	const result = await rollbackUpdate(readInstallation(id, fixture.root), fixture.context);
	assert.equal(result.status, "deferred");
	assert.match(result.reason, /mission loop is live.*sudo agent mission operate close/);
	assert.deepEqual(fixture.calls, [["control", "service-status"], ["mission-status"]]);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
	// The committed update's journal stays, so the rollback can be retried once the operation is closed.
	assert.equal(readFileSync(updatePaths(id, fixture.root).journal, "utf8"), journal);
	rollback = "no-live-loop";
	fixture.calls.length = 0;
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	const asked = fixture.calls.filter((call) => call[0] === "mission-status" || call[1] === "maintenance-enter");
	assert.deepEqual(
		asked.map((call) => call[0]),
		["mission-status", "control", "mission-status"],
	);
});

test("#72 a loop opened after the first answer is caught under the hold before the stop", async () => {
	const answers = ["no-live-loop", "live-loop", "no-live-loop", "no-live-loop"];
	const fixture = await loopFixture(() => ({ loopRollback: answers.shift() }));
	const committed = readFileSync(updatePaths(id, fixture.root).journal, "utf8");
	const result = await rollbackUpdate(readInstallation(id, fixture.root), fixture.context);
	assert.equal(result.status, "deferred");
	assert.match(result.reason, /mission loop is live/);
	assert.deepEqual(
		fixture.calls.map((call) => call.slice(0, 2)),
		[
			["control", "service-status"],
			["mission-status"],
			["control", "maintenance-enter"],
			["mission-status"],
			["control", "maintenance-release"],
		],
	);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
	// unit-6si: the refusal leaves the committed update's journal, so the rollback is retried once the loop closes.
	assert.equal(readFileSync(updatePaths(id, fixture.root).journal, "utf8"), committed);
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
});

test("#72 the archive and its signed descriptor must declare the same features", async () => {
	const features = (...names) => ({ ...compatibility, features: names });
	for (const [archive, signed] of [
		[compatibility, loopCompatibility],
		[loopCompatibility, compatibility],
		// Codex wiring re-check: equal length plus one-way membership accepted unequal sets padded by a duplicate.
		[features("a", "a"), features("a", "mission-loop")],
		[features("a", "mission-loop"), features("a", "a")],
		[features("mission-loop", "mission-loop"), features("mission-loop", "mission-loop")],
	]) {
		const fixture = setup();
		release(fixture.root, "0.0.3", archive);
		const result = await activateUpdate(
			fixture.record,
			{ ...fixture.candidate, compatibility: signed },
			fixture.context,
		);
		assert.deepEqual(result, {
			status: "incompatible",
			reason: "The release's features differ from its signed descriptor.",
			version: "0.0.3",
		});
		assert.ok(!fixture.calls.some((call) => call[0] === "control" && call[1] !== "service-status"));
		assert.equal(readUpdateJournal(id, fixture.root), null);
		assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	}
});

test("#72 a descriptor claiming the loop cannot install an archive that drops it while a loop is live", async () => {
	const fixture = await loopFixture(() => ({ loopRollback: "live-loop" }));
	release(fixture.root, "0.0.4", compatibility);
	const result = await activateUpdate(
		readInstallation(id, fixture.root),
		{ releasePath: join(fixture.root, "opt/unit-001/releases/0.0.4"), version: "0.0.4", compatibility: loopCompatibility },
		fixture.context,
	);
	assert.equal(result.status, "incompatible");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
	assert.ok(!fixture.calls.some((call) => call[0] === "control" && call[1] === "maintenance-enter"));
});

test("#72 only the owner's affirmative task answer permits dropping the loop; the purpose document does not", async () => {
	for (const [answer, status] of [
		[() => Promise.reject(new Error("owner refused")), "deferred"],
		[() => ({ execution: "not-started" }), "deferred"],
		[() => ({ loopRollback: "unknown" }), "deferred"],
		// An owner before the task answer: neither no purpose nor a purpose's own answer is enough.
		[() => ({ purpose: null }), "deferred"],
		[() => ({ purpose: { rollback: "no-live-loop" } }), "deferred"],
		// Malformed history hides the purpose while a parked loop task stays live.
		[() => ({ purpose: null, purposeError: "Invalid purpose record.", loopRollback: "live-loop" }), "deferred"],
		// An empty installation.
		[() => ({ purpose: null, purposeError: null, loopRollback: "no-live-loop" }), "updated"],
	]) {
		const fixture = await loopFixture(answer);
		assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, status);
	}
});

test("#72 a closed owner cannot drop the mission loop, and refuses before any hold or stop", async () => {
	const fixture = await loopFixture(() => assert.fail("A closed owner cannot answer."));
	await fixture.context.run("systemctl", ["stop", fixture.paths.unit]);
	fixture.calls.length = 0;
	const result = await rollbackUpdate(readInstallation(id, fixture.root), fixture.context);
	assert.equal(result.status, "incompatible");
	assert.match(result.reason, /cannot run a mission loop/);
	assert.ok(!fixture.calls.some((call) => call[0] === "control" && call[1] !== "service-status"));
	assert.ok(!fixture.calls.some((call) => call[0] === "systemctl" && call[1] !== "show"));
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
});

test("#72 the shipped release declares the mission loop", () => {
	const declared = JSON.parse(
		readFileSync(fileURLToPath(new URL("../deploy/release-compatibility.json", import.meta.url)), "utf8"),
	);
	assert.deepEqual(declared.features, ["mission-loop"]);
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

// Leaves the files a busy deferral had written when power failed right after it saved "restored".
async function deferredThenPowerLoss(fixture) {
	const paths = updatePaths(id, fixture.root);
	const saved = [];
	fixture.context.fault = (phase) => {
		if (phase === "restored") for (const path of [paths.journal, paths.priorJournal]) saved.push([path, readFileSync(path)]);
	};
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "deferred");
	delete fixture.context.fault;
	for (const [path, bytes] of saved) writeFileSync(path, bytes);
	assert.equal(readUpdateJournal(id, fixture.root).liveDeferred, true);
}

test("#18 a reboot after deferred release clears inhibited startup before completing recovery", async () => {
	const fixture = setup("busy");
	await deferredThenPowerLoss(fixture);
	await fixture.context.run("systemctl", ["stop", fixture.paths.unit]);
	await recoverUpdate(fixture.record, fixture.context, { phase: "prepare" });
	await fixture.context.run("systemctl", ["start", fixture.paths.unit]);
	await recoverUpdate(fixture.record, fixture.context, { phase: "finalize" });
	const status = await fixture.context.control(fixture.record, ["service-status"]);
	assert.equal(status.inhibited, false);
	assert.equal(status.maintenance.state, "open");
	// The first attempt displaced no journal, so recovery leaves none.
	assert.equal(readUpdateJournal(id, fixture.root), null);
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

// #18: A slow old storage owner must not strand boot finalization on its first status probe.
test("#18 boot finalization retries service status while storage opens", async () => {
	const fixture = setup("busy");
	await deferredThenPowerLoss(fixture);
	await fixture.context.run("systemctl", ["start", fixture.paths.unit]);
	const control = fixture.context.control;
	let remaining = 2;
	fixture.context.control = async (...args) => {
		if (args[1][0] === "service-status" && remaining-- > 0) throw new Error("storage opening");
		return control(...args);
	};
	assert.equal((await recoverUpdate(fixture.record, fixture.context, { phase: "finalize" })).status, "recovered");
	assert.ok(remaining < 0);
});

// #18: Workspace links retain their literal relative target through both backup and recovery.
test("#18 relative workspace symlinks survive precommit restoration unchanged", async () => {
	const fixture = setup();
	mkdirSync(join(fixture.paths.state, "workspace"));
	symlinkSync("../marker", join(fixture.paths.state, "workspace/link"));
	fixture.context.fault = (phase) => {
		if (phase === "candidate") throw new Error("candidate failure");
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /candidate failure/);
	assert.equal(readlinkSync(join(fixture.paths.state, "workspace/link")), "../marker");
	assert.equal(
		readlinkSync(join(updatePaths(id, fixture.root).configDirectory, "backup/workspace/link")),
		"../marker",
	);
});

// #18: Restore staging can reside on a different filesystem from the protected backup.
test("#18 low state filesystem space defers even when backup filesystem has room", async () => {
	const fixture = setup();
	fixture.context.availableBytes = (path) => (path === dirname(fixture.paths.state) ? 0 : Number.MAX_SAFE_INTEGER);
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "deferred");
	assert.ok(!fixture.calls.some((call) => call[0] === "control" && call[1] === "maintenance-enter"));
});

// #18: An intentional workspace socket is not silently discarded or discovered after downtime.
test("#18 special files outside control defer before admission hold or service stop", async () => {
	const fixture = setup();
	const short = mkdtempSync("/tmp/unit-special-");
	roots.push(short);
	symlinkSync(fixture.paths.state, join(short, "s"));
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(join(short, "s/workspace.sock"), resolve);
	});
	try {
		assert.match((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).reason, /special file/);
		assert.ok(!fixture.calls.some((call) => call[1] === "maintenance-enter" || call[1] === "stop"));
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

// #18: Intentional upgrades/recovery do not exhaust the unchanged service crash-loop budget.
test("#18 update rollback and failed candidate recovery reset intentional start accounting", async () => {
	const fixture = setup();
	const run = fixture.context.run;
	let starts = 5;
	let resets = 0;
	fixture.context.run = async (command, args, ...rest) => {
		if (command === "systemctl" && args[0] === "reset-failed") {
			starts = 0;
			resets++;
		}
		if (command === "systemctl" && args[0] === "start" && ++starts > 5) throw new Error("start-limit-hit");
		return run(command, args, ...rest);
	};
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	await rollbackUpdate(readInstallation(id, fixture.root), fixture.context);
	const ready = fixture.context.ready;
	let fail = true;
	fixture.context.ready = async (...args) => {
		if (fail) {
			fail = false;
			throw new Error("Injected candidate health failure");
		}
		return ready.apply(fixture.context, args);
	};
	await assert.rejects(
		activateUpdate(readInstallation(id, fixture.root), fixture.candidate, fixture.context),
		/Injected candidate health failure/,
	);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	assert.equal((await fixture.context.control(fixture.record, ["service-status"])).inhibited, false);
	assert.equal(resets, 4);
});

// #18: Only a failed unit is reset, and that reset must succeed; a failed unit is always loaded.
test("#18 updater resets only a failed unit, and a refused reset of it stays fatal", async () => {
	const fixture = setup();
	const run = fixture.context.run;
	fixture.context.run = async (command, args, ...rest) => {
		if (command === "systemctl" && args[0] === "reset-failed") throw new Error("reset refused");
		return run(command, args, ...rest);
	};
	// The fixture reports a stopped unit as failed.
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /reset refused/);
});

// Native review of #18: a stopped unit that systemd has unloaded is inactive, `show` loads it (LoadState=loaded), and
// reset-failed then refuses it as not loaded. Cold `recover --start` must start it without that reset.
test("#18 cold recover --start starts an unloaded inactive unit without reset-failed", async () => {
	const fixture = setup();
	const run = fixture.context.run;
	let crashed = false;
	fixture.context.fault = (phase) => {
		if (phase === "candidate") {
			crashed = true;
			throw new Error("power loss");
		}
	};
	fixture.context.run = async (...args) => {
		if (crashed) throw new Error("power loss");
		return run(...args);
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /power loss/);
	delete fixture.context.fault;
	writeInstallation({ ...readInstallation(id, fixture.root), desiredState: "stopped" }, fixture.root);
	await run("systemctl", ["stop", fixture.paths.unit]);
	let cold = true;
	fixture.context.run = async (command, args, ...rest) => {
		if (command === "systemctl" && cold) {
			if (args[0] === "reset-failed") throw new Error(`Unit ${fixture.paths.unit} not loaded.`);
			if (args.includes("--property=ActiveState")) return "inactive";
			if (args.includes("--property=LoadState")) return "loaded";
			if (args[0] === "start" || args[0] === "enable") cold = false;
		}
		return run(command, args, ...rest);
	};
	const begin = fixture.calls.length;
	assert.equal((await recoverUpdate(fixture.record, fixture.context, { start: true })).status, "recovered");
	assert.ok(!fixture.calls.slice(begin).some((call) => call[0] === "systemctl" && call[1] === "reset-failed"));
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	assert.equal(readInstallation(id, fixture.root).desiredState, "running");
	assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
});

// #18: A working retained core must not entrust recovery to the broken selected updater.
test("#18 retained executing core owns recovery across failed repair and successful rollback", async () => {
	const fixture = setup();
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	const paths = updatePaths(id, fixture.root);
	fixture.context.executingModule = join(paths.cores, "0.0.2/lib/update-activation.mjs");
	const ready = fixture.context.ready;
	let fail = true;
	fixture.context.ready = async (...args) => {
		if (fail) {
			fail = false;
			throw new Error("repair health failure");
		}
		return ready.apply(fixture.context, args);
	};
	const repair = { releasePath: release(fixture.root, "0.0.4"), version: "0.0.4", compatibility };
	await assert.rejects(
		activateUpdate(readInstallation(id, fixture.root), repair, fixture.context),
		/repair health failure/,
	);
	assert.equal(readlinkSync(paths.currentCore), "cores/0.0.2");
	assert.equal(readlinkSync(paths.recoveryCore), "cores/0.0.2");
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
	assert.equal(
		(
			await activateUpdate(
				readInstallation(id, fixture.root),
				{ releasePath: join(fixture.root, "opt/unit-001/releases/0.0.2"), version: "0.0.2", compatibility },
				fixture.context,
			)
		).status,
		"updated",
	);
	assert.equal(readlinkSync(paths.currentCore), "cores/0.0.2");
	assert.equal(readlinkSync(paths.recoveryCore), "cores/0.0.2");
	assert.deepEqual(readdirSync(paths.cores), ["0.0.2"]);
});

// #18: Service-template evolution is versioned and never widens the agent's privileges implicitly.
const versioned = (serviceTemplate) => ({ ...compatibility, serviceTemplate });
const rendered = (text) => text.replaceAll("@ID@", id).replaceAll("@ACCOUNT@", "ua-111111111111411181111111");
const hardened = template
	.replace("PrivateTmp=yes\n", "PrivateTmp=yes\nProtectKernelTunables=yes\n")
	.replace("RestartSec=5\n", "RestartSec=10\n");
// The plan runs after this read-only probe and before any drain, stop or file change.
const statusProbeOnly = [["control", "service-status"]];

function templateFixture(
	candidateTemplate,
	candidateVersion = 3,
	candidateCompatibility = versioned(candidateVersion),
) {
	const fixture = setup();
	release(fixture.root, "0.0.2", versioned(2));
	release(fixture.root, "0.0.3", candidateCompatibility, candidateTemplate);
	return {
		...fixture,
		candidate: { ...fixture.candidate, compatibility: candidateCompatibility },
		previousUnit: readFileSync(fixture.paths.unitFile, "utf8"),
	};
}

test("#18 an unchanged service template keeps even an administrator-edited unit byte for byte", async () => {
	const fixture = templateFixture(template, 2);
	const custom = `${fixture.previousUnit}# administrator customization\n`;
	writeFileSync(fixture.paths.unitFile, custom);
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), custom);
	assert.equal(readUpdateJournal(id, fixture.root).serviceUnit, undefined);
});

test("#18 a narrowing service template is installed before the candidate starts", async () => {
	const fixture = templateFixture(hardened);
	const run = fixture.context.run;
	let started = 0;
	fixture.context.run = async (command, args, ...rest) => {
		if (command === "systemctl" && args[0] === "start") {
			started++;
			assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(hardened));
		}
		return run(command, args, ...rest);
	};
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	assert.equal(started, 1);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(hardened));
	assert.deepEqual(readUpdateJournal(id, fixture.root).serviceUnit, {
		previous: fixture.previousUnit,
		candidate: rendered(hardened),
		previousTemplate: 2,
		candidateTemplate: 3,
	});
});

for (const [name, candidate, directive] of [
	["a root service account", template.replace("User=@ACCOUNT@", "User=root"), /\[Service\] User/],
	["dropped no-new-privileges", template.replace("NoNewPrivileges=yes\n", ""), /NoNewPrivileges/],
	[
		"an added writable path",
		template.replace("ReadWritePaths=/var/lib/unit-001/agents/@ID@", "ReadWritePaths=/var/lib/unit-001/agents/@ID@ /etc"),
		/ReadWritePaths/,
	],
	["a privileged start hook", template.replace("ExecStart=", "ExecStartPre=+/bin/true\nExecStart="), /ExecStartPre/],
	["a weaker system protection", template.replace("ProtectSystem=strict", "ProtectSystem=full"), /ProtectSystem/],
	[
		"an ambient capability",
		template.replace("UMask=0077\n", "UMask=0077\nAmbientCapabilities=CAP_NET_ADMIN\n"),
		/AmbientCapabilities/,
	],
	[
		"a pulled-in unit",
		template.replace("Wants=network-online.target", "Wants=network-online.target ssh.service"),
		/\[Unit\] Wants/,
	],
	["an output file", template.replace("StandardOutput=journal", "StandardOutput=file:/etc/shadow"), /StandardOutput/],
	[
		"a no-break space after a hardening value",
		template.replace("NoNewPrivileges=yes", "NoNewPrivileges=yes "),
		/unreviewable unit syntax/,
	],
])
	test(`#18 ${name} holds before any drain or host change`, async () => {
		const fixture = templateFixture(candidate);
		const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
		assert.equal(result.status, "held");
		assert.equal(result.version, "0.0.3");
		assert.match(result.reason, directive);
		assert.match(result.reason, /administrator must review/);
		assert.deepEqual(fixture.calls, statusProbeOnly);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
		assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
		assert.equal(readUpdateJournal(id, fixture.root), null);
	});

test("#18 a template change without a new declared version is incompatible", async () => {
	for (const declared of [versioned(2), compatibility]) {
		const fixture = templateFixture(hardened, 2, declared);
		const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
		assert.equal(result.status, "incompatible");
		assert.match(result.reason, /new, higher template version/);
		assert.deepEqual(fixture.calls, statusProbeOnly);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
	}
});

test("#18 a template change holds when the installed unit is not the current release's template", async () => {
	const fixture = templateFixture(hardened);
	const legacy = fixture.previousUnit.replace(/RuntimeDirectory=.*\nRuntimeDirectoryMode=0750\n/, "");
	writeFileSync(fixture.paths.unitFile, legacy);
	const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	assert.equal(result.status, "held");
	assert.match(result.reason, /installed unit is not release 0\.0\.2's template/);
	assert.deepEqual(fixture.calls, statusProbeOnly);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), legacy);
});

for (const phase of ["service-unit", "candidate"])
	test(`#18 power loss at ${phase} restores the previous service unit with the previous release`, async () => {
		const fixture = templateFixture(hardened);
		const run = fixture.context.run;
		let crashed = false;
		fixture.context.fault = (current) => {
			if (current === phase) {
				crashed = true;
				throw new Error("power loss");
			}
		};
		fixture.context.run = async (...args) => {
			if (crashed) throw new Error("power loss");
			return run(...args);
		};
		await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /power loss/);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(hardened));
		delete fixture.context.fault;
		fixture.context.run = run;
		await recoverUpdate(fixture.record, fixture.context);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
		assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
		assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
	});

test("#18 failed candidate health restores the previous service unit before the old owner restarts", async () => {
	const fixture = templateFixture(hardened);
	const ready = fixture.context.ready;
	let fail = true;
	fixture.context.ready = async (...args) => {
		if (fail) {
			fail = false;
			throw new Error("candidate health failure");
		}
		return ready.apply(fixture.context, args);
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /candidate health failure/);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
});

test("#18 committed recovery keeps the applied service unit", async () => {
	const fixture = templateFixture(hardened);
	fixture.context.fault = (phase) => {
		if (phase === "committed") throw new Error("power loss");
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /power loss/);
	delete fixture.context.fault;
	await recoverUpdate(fixture.record, fixture.context);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(hardened));
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
});

test("#18 explicit rollback restores the exact replaced unit, but a later release cannot drop hardening", async () => {
	const fixture = templateFixture(hardened);
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	assert.equal(
		(await activateUpdate(readInstallation(id, fixture.root), fixture.candidate, fixture.context)).status,
		"updated",
	);
	const looser = {
		releasePath: release(fixture.root, "0.0.4", versioned(4)),
		version: "0.0.4",
		compatibility: versioned(4),
	};
	const result = await activateUpdate(readInstallation(id, fixture.root), looser, fixture.context);
	assert.equal(result.status, "held");
	assert.match(result.reason, /ProtectKernelTunables/);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(hardened));
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
});

test("#18 template classification accepts only neutral or narrowing directive changes", () => {
	const base = "[Unit]\nDescription=a\n[Service]\nUser=u\nProtectSystem=yes\nReadWritePaths=/a /b\nPrivateTmp=yes\n";
	for (const [to, expected] of [
		[base.replace("Description=a", "Description=b\nAfter=x.target"), []],
		[base.replace("ProtectSystem=yes", "ProtectSystem=strict"), []],
		[base.replace("ReadWritePaths=/a /b", "ReadWritePaths=/a"), []],
		[`${base}InaccessiblePaths=/c\nRestrictSUIDSGID=yes\n`, []],
		[`${base}# comment only\n`, []],
		[base.replace("ProtectSystem=yes", "ProtectSystem=no"), ["[Service] ProtectSystem"]],
		[base.replace("PrivateTmp=yes", "PrivateTmp=true"), ["[Service] PrivateTmp"]],
		[base.replace("ReadWritePaths=/a /b", "ReadWritePaths="), ["[Service] ReadWritePaths"]],
		[`${base}ProtectHome=tmpfs\n`, ["[Service] ProtectHome"]],
		[`${base}Environment=A=1\n`, ["[Service] Environment"]],
		[base.replace("User=u", "User = u"), ["unreviewable unit syntax"]],
		[`${base}ExecStart=/bin/a \\\n  --flag\n`, ["unreviewable unit syntax"]],
	])
		assert.deepEqual(serviceUnitExpansions(base, to), expected, to);
});

// Review of #18: output destinations are opened with manager privileges, so they are never neutral.
test("#18 output redirection changes hold for review", () => {
	const base = "[Service]\nStandardOutput=journal\nStandardError=journal\n";
	for (const [to, directive] of [
		[base.replace("StandardOutput=journal", "StandardOutput=file:/etc/shadow"), "[Service] StandardOutput"],
		[base.replace("StandardError=journal", "StandardError=append:/root/.ssh/authorized_keys"), "[Service] StandardError"],
		[base.replace("StandardOutput=journal", "StandardOutput=socket"), "[Service] StandardOutput"],
	])
		assert.deepEqual(serviceUnitExpansions(base, to), [directive], to);
});

// Review of #18: list syntax whose systemd meaning is not a plain set holds, even when the entries look narrower.
test("#18 complex list syntax holds instead of comparing entries", () => {
	const base = "[Service]\nUser=u\n";
	for (const [from, to, directive] of [
		// Dropping an excluded capability from an exclusion list grants it.
		["AmbientCapabilities=~CAP_SYS_ADMIN CAP_NET_ADMIN", "AmbientCapabilities=~CAP_SYS_ADMIN", "AmbientCapabilities"],
		// Splitting a quoted path removes the original restriction while its fragments look retained.
		['ReadOnlyPaths="/srv/a b"', 'ReadOnlyPaths="/srv/a b" /srv/c', "ReadOnlyPaths"],
		['ReadOnlyPaths="/srv/a b"', "ReadOnlyPaths=/srv/a b", "ReadOnlyPaths"],
		["ReadWritePaths=/a /b", "ReadWritePaths=-/a", "ReadWritePaths"],
		["ReadWritePaths=/a /b", "ReadWritePaths=/a/../etc", "ReadWritePaths"],
		["InaccessiblePaths=/a", "InaccessiblePaths=/a  /b", "InaccessiblePaths"],
		["SupplementaryGroups=adm", "SupplementaryGroups=", "SupplementaryGroups"],
	])
		assert.deepEqual(
			serviceUnitExpansions(`${base}${from}\n`, `${base}${to}\n`),
			[`[Service] ${directive}`],
			`${from} -> ${to}`,
		);
	assert.deepEqual(
		serviceUnitExpansions(`${base}AmbientCapabilities=CAP_A CAP_B\n`, `${base}AmbientCapabilities=CAP_A\n`),
		[],
	);
});

// Review of #18: syntax JavaScript and systemd read differently is refused before any comparison.
test("#18 ambiguous unit syntax is refused before comparison", () => {
	const base = "[Unit]\nDescription=a\n[Service]\nNoNewPrivileges=yes\nReadWritePaths=/a\n";
	for (const to of [
		// A no-break space after a hardening value: systemd rejects the value and drops the setting.
		base.replace("NoNewPrivileges=yes", "NoNewPrivileges=yes "),
		base.replace("NoNewPrivileges=yes", "NoNewPrivileges=yes\t"),
		base.replace("NoNewPrivileges=yes", "NoNewPrivileges=yes\r"),
		base.replace("NoNewPrivileges=yes", "NoNewPrivileges=yes "),
		base.replace("NoNewPrivileges=yes", "NoNewPrivileges= yes"),
		base.replace("NoNewPrivileges=yes", " NoNewPrivileges=yes"),
		`${base}NoNewPrivileges=yes\n`,
		`${base}# a comment continued \\\nNoNewPrivileges=no\n`,
		base.replace("ReadWritePaths=/a", "ReadWritePaths=%h"),
		base.replace("Description=a", "Description=%n"),
		base.replace("[Service]", "[X-Service]"),
		`${base}[Install]\nWantedBy=multi-user.target\n[Service]\nNoNewPrivileges=no\n`,
	])
		assert.deepEqual(serviceUnitExpansions(base, to), ["unreviewable unit syntax"], JSON.stringify(to));
});

const unitDirectory = (root) => join(root, "etc/systemd/system");

// Review of #18: drop-ins merge into the effective unit, so a reviewed main file alone proves nothing.
for (const [where, relativePath] of [
	["an instance drop-in", `etc/systemd/system/unit-001@${id}.service.d/override.conf`],
	["a runtime set-property drop-in", `run/systemd/system.control/unit-001@${id}.service.d/50-ProtectSystem.conf`],
	["a template-wide drop-in", "usr/lib/systemd/system/unit-001@.service.d/hardening.conf"],
	["a name-prefix drop-in", "etc/systemd/system/unit-.service.d/override.conf"],
	["a service-wide drop-in", "etc/systemd/system/service.d/override.conf"],
	["a higher-priority unit file", `etc/systemd/system.control/unit-001@${id}.service`],
])
	test(`#18 ${where} holds a template change before any drain`, async () => {
		const fixture = templateFixture(hardened);
		mkdirSync(dirname(join(fixture.root, relativePath)), { recursive: true });
		writeFileSync(join(fixture.root, relativePath), "[Service]\nProtectSystem=full\n");
		const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
		assert.equal(result.status, "held");
		assert.match(result.reason, /Other systemd files also configure/);
		assert.ok(result.reason.includes(join(fixture.root, relativePath)));
		assert.deepEqual(fixture.calls, statusProbeOnly);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
	});

test("#18 a changed recovery drop-in and unrelated units are told apart", async () => {
	const fixture = templateFixture(hardened);
	const recovery = join(unitDirectory(fixture.root), `unit-001@${id}.service.d/update.conf`);
	const original = readFileSync(recovery, "utf8");
	// Unrelated drop-ins and non-.conf files do not configure this unit.
	mkdirSync(join(unitDirectory(fixture.root), "other-unit.service.d"), { recursive: true });
	writeFileSync(join(unitDirectory(fixture.root), "other-unit.service.d/override.conf"), "[Service]\nUser=root\n");
	writeFileSync(join(dirname(recovery), "notes.txt"), "ignored by systemd");
	writeFileSync(recovery, `${original}[Service]\nProtectSystem=full\n`);
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "held");
	writeFileSync(recovery, original);
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
});

test("#18 systemd loading other policy after reload restores the previous unit and release", async () => {
	const fixture = templateFixture(hardened);
	const run = fixture.context.run;
	const alias = `/run/systemd/system/unit-001-alias.service.d/override.conf`;
	fixture.context.run = async (command, args, ...rest) => {
		const output = await run(command, args, ...rest);
		return args.includes("--property=DropInPaths") ? `${output} ${alias}` : output;
	};
	await assert.rejects(
		activateUpdate(fixture.record, fixture.candidate, fixture.context),
		/loaded service policy beyond the reviewed unit/,
	);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
	assert.equal(readUpdateJournal(id, fixture.root).phase, "complete");
});

// Review of #18: escape-heavy units that fit their own bound must not produce a journal recovery cannot read.
test("#18 an oversized serialized journal is refused before drain", async () => {
	// Quotes double under JSON escaping; pad each rendered unit to just under 16 KiB.
	const padded = (text) => {
		const length = Buffer.byteLength(rendered(`${text}#\n`));
		return `${text}#${'"'.repeat(16380 - length)}\n`;
	};
	const fixture = templateFixture(padded(hardened));
	release(fixture.root, "0.0.2", versioned(2), padded(template));
	writeFileSync(fixture.paths.unitFile, rendered(padded(template)));
	const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	assert.equal(result.status, "incompatible");
	assert.match(result.reason, /journal would exceed its size limit/);
	assert.deepEqual(fixture.calls, statusProbeOnly);
	assert.equal(readUpdateJournal(id, fixture.root), null);
	assert.equal(readlinkSync(updatePaths(id, fixture.root).recoveryCore), "cores/0.0.2");
});

// Review of #18: "restored" lets a retry skip preparation, so it must follow a successful daemon-reload.
test("#18 recovery reloads systemd before publishing the restored phase", async () => {
	const fixture = templateFixture(hardened);
	const run = fixture.context.run;
	// Tracks the unit systemd has loaded, as a real service manager caches it until daemon-reload.
	let loaded = fixture.previousUnit;
	const started = [];
	let killAtReload = false;
	fixture.context.run = async (command, args, ...rest) => {
		if (command === "systemctl" && args[0] === "daemon-reload") {
			if (killAtReload) {
				killAtReload = false;
				throw new Error("updater killed");
			}
			loaded = readFileSync(fixture.paths.unitFile, "utf8");
		}
		if (command === "systemctl" && args[0] === "start") started.push(loaded);
		return run(command, args, ...rest);
	};
	const ready = fixture.context.ready;
	fixture.context.ready = async () => {
		killAtReload = true;
		throw new Error("candidate health failure");
	};
	await assert.rejects(activateUpdate(fixture.record, fixture.candidate, fixture.context), /updater killed/);
	assert.equal(started.at(-1), rendered(hardened));
	assert.equal(readUpdateJournal(id, fixture.root).phase, "candidate");
	fixture.context.ready = ready;
	assert.equal((await recoverUpdate(fixture.record, fixture.context)).status, "recovered");
	assert.equal(started.at(-1), fixture.previousUnit);
	assert.equal(loaded, fixture.previousUnit);
	assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.2");
});

// Review of #18: a lower template version is reserved for explicit, journal-matched rollback.
test("#18 a forward update cannot lower the template version", async () => {
	const fixture = templateFixture(hardened, 1);
	const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	assert.equal(result.status, "incompatible");
	assert.match(result.reason, /higher template version/);
	assert.deepEqual(fixture.calls, statusProbeOnly);
	// The same transition is not a rollback unless the operation says so and the journal matches.
	const forward = templateFixture(hardened);
	await activateUpdate(forward.record, forward.candidate, forward.context);
	const previous = join(forward.root, "opt/unit-001/releases/0.0.2");
	const downgrade = { releasePath: previous, version: "0.0.2", compatibility: versioned(2) };
	const refused = await activateUpdate(readInstallation(id, forward.root), downgrade, forward.context);
	assert.equal(refused.status, "incompatible");
	assert.equal(readFileSync(forward.paths.unitFile, "utf8"), rendered(hardened));
});

// Review of #18: the unit's mode is the administrator's, and rewriting the content must not reset it.
test("#18 applying and restoring a unit keep its file mode", async () => {
	const fixture = templateFixture(hardened);
	chmodSync(fixture.paths.unitFile, 0o600);
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	assert.equal(statSync(fixture.paths.unitFile).mode & 0o777, 0o600);
	assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
	assert.equal(statSync(fixture.paths.unitFile).mode & 0o777, 0o600);
});

test("#18 a unit with bytes outside the reviewed subset holds a template change", async () => {
	const fixture = templateFixture(hardened);
	const invalid = Buffer.concat([Buffer.from(fixture.previousUnit), Buffer.from([0x23, 0xff, 0x0a])]);
	writeFileSync(fixture.paths.unitFile, invalid);
	const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	assert.equal(result.status, "held");
	assert.deepEqual(readFileSync(fixture.paths.unitFile), invalid);
	assert.deepEqual(fixture.calls, statusProbeOnly);
});

// Review of #18: an updater before template versioning selects new code but keeps the old unit.
function skippedFixture(currentTemplate, nextTemplate = currentTemplate, nextVersion = 3) {
	const fixture = setup();
	release(fixture.root, "0.0.3", versioned(3), currentTemplate);
	const record = { ...fixture.record, releaseVersion: "0.0.3" };
	writeInstallation(record, fixture.root);
	// The journal an older updater leaves: no service unit entry, previous release 0.0.2.
	writeFileSync(
		updatePaths(id, fixture.root).journal,
		JSON.stringify({
			schemaVersion: 1,
			id,
			operationId: "00000000-0000-4000-8000-000000000000",
			previousRecord: fixture.record,
			candidateVersion: "0.0.3",
			compatibility,
			phase: "complete",
			previousCore: "cores/0.0.2",
		}),
	);
	const releasePath = release(fixture.root, "0.0.4", versioned(nextVersion), nextTemplate);
	return {
		...fixture,
		record,
		candidate: { releasePath, version: "0.0.4", compatibility: versioned(nextVersion) },
		previousUnit: readFileSync(fixture.paths.unitFile, "utf8"),
	};
}

test("#18 a skipped release's narrowing template is applied at the next update", async () => {
	const fixture = skippedFixture(hardened);
	assert.equal(fixture.previousUnit, rendered(template));
	assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(hardened));
	assert.equal(readUpdateJournal(id, fixture.root).serviceUnit.previous, fixture.previousUnit);
});

// Third review of #18: identical shipped templates must not hide the journaled migration from explicit rollback.
test("#18 rollback after a skipped-release migration restores the kept unit, and the next update migrates again", async () => {
	for (const nextTemplate of [hardened, hardened.replace("RestartSec=10", "RestartSec=12")]) {
		const fixture = skippedFixture(hardened, nextTemplate, nextTemplate === hardened ? 3 : 4);
		assert.equal((await activateUpdate(fixture.record, fixture.candidate, fixture.context)).status, "updated");
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(nextTemplate));
		assert.equal((await rollbackUpdate(readInstallation(id, fixture.root), fixture.context)).status, "updated");
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
		assert.equal(readInstallation(id, fixture.root).releaseVersion, "0.0.3");
		assert.equal(readUpdateJournal(id, fixture.root).serviceUnit.candidateKeptRelease, "0.0.2");
		// The rollback journal is the evidence that the restored unit is release 0.0.2's, kept by an older updater.
		assert.equal(
			(await activateUpdate(readInstallation(id, fixture.root), fixture.candidate, fixture.context)).status,
			"updated",
		);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), rendered(nextTemplate));
		assert.equal(readUpdateJournal(id, fixture.root).serviceUnit.previousKeptRelease, "0.0.2");
	}
});

test("#18 an administrator edit after a migration rollback keeps the unit on the next update", async () => {
	const fixture = skippedFixture(hardened);
	await activateUpdate(fixture.record, fixture.candidate, fixture.context);
	await rollbackUpdate(readInstallation(id, fixture.root), fixture.context);
	const edited = `${fixture.previousUnit}# administrator customization\n`;
	writeFileSync(fixture.paths.unitFile, edited);
	assert.equal(
		(await activateUpdate(readInstallation(id, fixture.root), fixture.candidate, fixture.context)).status,
		"updated",
	);
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), edited);
});

test("#18 a skipped release's expanding template holds with the kept release named", async () => {
	const wider = template.replace("ProtectSystem=strict", "ProtectSystem=full");
	for (const [next, version] of [
		[wider, 3],
		[wider.replace("RestartSec=5", "RestartSec=7"), 4],
	]) {
		const fixture = skippedFixture(wider, next, version);
		const result = await activateUpdate(fixture.record, fixture.candidate, fixture.context);
		assert.equal(result.status, "held");
		assert.match(result.reason, /release 0\.0\.2's service unit, which an older updater kept/);
		assert.match(result.reason, /\[Service\] ProtectSystem/);
		assert.deepEqual(fixture.calls, statusProbeOnly);
		assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), fixture.previousUnit);
	}
});

test("#18 the legacy unit kept by an older updater keeps its operator migration", async () => {
	const fixture = setup("healthy", { baseline: "0.0.6", candidate: "0.0.7" });
	release(fixture.root, "0.0.7", versioned(2));
	writeInstallation({ ...fixture.record, releaseVersion: "0.0.7" }, fixture.root);
	writeFileSync(
		updatePaths(id, fixture.root).journal,
		JSON.stringify({
			schemaVersion: 1,
			id,
			operationId: "00000000-0000-4000-8000-000000000000",
			previousRecord: fixture.record,
			candidateVersion: "0.0.7",
			compatibility,
			phase: "complete",
			previousCore: "cores/0.0.6",
		}),
	);
	const legacy = readFileSync(fixture.paths.unitFile, "utf8");
	const candidate = {
		releasePath: release(fixture.root, "0.0.8", versioned(2)),
		version: "0.0.8",
		compatibility: versioned(2),
	};
	const record = readInstallation(id, fixture.root);
	assert.equal((await activateUpdate(record, candidate, fixture.context)).status, "updated");
	assert.equal(readFileSync(fixture.paths.unitFile, "utf8"), legacy);
});

// Review of #18: clients that skip the first versioned release start the next template under their old unit until
// the following update migrates it. Changing the template requires qualifying that path first (docs/updates.md).
test("#18 the shipped template stays pinned until a skipped-release migration is qualified", () => {
	const declared = JSON.parse(
		readFileSync(fileURLToPath(new URL("../deploy/release-compatibility.json", import.meta.url)), "utf8"),
	).serviceTemplate;
	assert.equal(declared, 2, "Qualify the skipped-release migration in docs/updates.md, then update this pin.");
	assert.equal(
		createHash("sha256").update(template).digest("hex"),
		"338be3844ce0bad92dfab8f55df482c1d062bf5795ec320441c7785cf68ccc8a",
		"A template change needs a new serviceTemplate and a qualified skipped-release migration.",
	);
});
