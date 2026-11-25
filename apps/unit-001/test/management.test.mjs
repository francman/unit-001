// Exercises named installation authority and lifecycle without changing the host's services.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { configuredEnvironment, confirmAction, dispatchAgent, run } from "../deploy/agent-command.mjs";
import {
	bootstrapReleaseUpdates,
	installationPaths,
	readInstallation,
	removeUnusedRelease,
	withManagementLock,
	writeAgentCommand,
	writeInstallation,
} from "../deploy/installation.mjs";
import { lifecycle, recoverRename } from "../deploy/lifecycle.mjs";
import { installUpdateCore, updatePaths, updateScheduling } from "../deploy/update-activation.mjs";
import { writeReleaseChecksums, writeUpdateBootstrap } from "../scripts/build-release.mjs";
import { generateRepositoryKeys } from "../scripts/update-repository.mjs";

const roots = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "unit-management-"));
	roots.push(root);
	const record = {
		schemaVersion: 1,
		id,
		name: "agent",
		account: "ua-111111111111411181111111",
		releaseVersion: "0.0.1",
		desiredState: "running",
	};
	const paths = installationPaths(id, root);
	await mkdir(paths.config, { recursive: true });
	await writeInstallation(record, root);
	const calls = [];
	const context = {
		root,
		uid: 0,
		groups: () => [],
		async run(command, args) {
			calls.push([command, ...args]);
			return args[0] === "show" ? "inactive\n" : 0;
		},
		async account() {
			return { uid: 1001, gid: 1001 };
		},
		async release() {
			return "/opt/trusted-release";
		},
		async ready() {},
		async applicationEnvironment() {
			return {};
		},
		async confirm() {
			return false;
		},
		async unitExists(unit) {
			return unit === paths.unit;
		},
		async unitRunning() {
			return false;
		},
	};
	return { root, record, paths, calls, context };
}

test("management capture waits for the output pipe after the child exits", async () => {
	const output = await run("/bin/sh", ["-c", "(sleep 0.1; printf 'LoadState=loaded\\n') &"], true);
	assert.equal(output, "LoadState=loaded\n");
});

test("#23 management lock uses a protected directory instead of an attacker-precreated /run/lock file", async () => {
	const { root, paths } = await setup();
	await mkdir(join(root, "run/lock"), { recursive: true, mode: 0o1777 });
	await chmod(join(root, "run/lock"), 0o1777);
	const old = join(root, "run/lock/unit-001-management.lock");
	await writeFile(old, "untrusted blocker", { mode: 0o666 });
	await withManagementLock(async () => {
		assert.equal(paths.lock, join(root, "run/unit-001/management.lock"));
		const directory = await stat(join(root, "run/unit-001"));
		assert.equal(directory.mode & 0o022, 0);
		assert.equal(directory.uid, process.getuid());
		await assert.rejects(
			withManagementLock(async () => assert.fail("Contender acquired the lock"), root),
			/Another install, update, or lifecycle operation is running/,
		);
	}, root);
	await withManagementLock(async () => {}, root);
	assert.equal(await readFile(old, "utf8"), "untrusted blocker");
});

test("#23 management locking rejects writable or symlinked directories before creating a lock", async () => {
	for (const unsafe of ["writable", "symlink"]) {
		const { root } = await setup();
		await mkdir(join(root, "run"));
		const outside = join(root, "outside");
		await mkdir(outside);
		if (unsafe === "symlink") await symlink(outside, join(root, "run/unit-001"));
		else {
			await mkdir(join(root, "run/unit-001"));
			await chmod(join(root, "run/unit-001"), 0o777);
		}
		await assert.rejects(
			withManagementLock(async () => assert.fail("Unsafe lock acquired"), root),
			/Unsafe installation path|Untrusted installation directory/,
		);
		await assert.rejects(stat(join(outside, "management.lock")), { code: "ENOENT" });
	}
});

test("#19 root app commands drop privileges and bind identity before opening data", async () => {
	const { context, calls } = await setup();
	await dispatchAgent(id, "agent", ["login", "openai"], context);
	assert.deepEqual(calls[0], [
		"runuser",
		"-u",
		"ua-111111111111411181111111",
		"--",
		"/opt/trusted-release/runtime/bin/node",
		"/opt/trusted-release/app/dist/named.js",
		id,
		"agent",
		`/var/lib/unit-001/agents/${id}`,
		"login",
		"openai",
	]);
	await assert.rejects(dispatchAgent(id, "bob", ["status"], context), /renamed/);
});

test("#33 public help/version never switch account or read provider environment", async () => {
	const { context, calls } = await setup();
	for (const action of ["--help", "-h", "--version", "-v"]) {
		await dispatchAgent(id, "agent", [action], {
			...context,
			uid: 2001,
			async account() {
				assert.fail("Public commands must not need an installation account lookup");
			},
			async applicationEnvironment() {
				assert.fail("Public commands must not read provider credentials");
			},
			async execApp(node, args) {
				calls.push([node, ...args]);
				return 0;
			},
		});
		assert.deepEqual(calls.at(-1), [
			"/opt/trusted-release/runtime/bin/node",
			"/opt/trusted-release/app/dist/named.js",
			id,
			"agent",
			`/var/lib/unit-001/agents/${id}`,
			"--operator",
			action,
		]);
	}
});

test("#33 only the installation group gets a normal-user client without private environment access", async () => {
	const { context, calls } = await setup();
	const operator = {
		...context,
		uid: 2001,
		groups: () => [1001],
		async applicationEnvironment() {
			assert.fail("Operator clients must not read provider credentials");
		},
		async execApp(node, args) {
			calls.push([node, ...args]);
			return 0;
		},
	};
	await dispatchAgent(id, "agent", ["service-status"], operator);
	assert.equal(calls[0].at(-2), "--operator");
	assert.equal(calls[0].at(-1), "service-status");
	await assert.rejects(
		dispatchAgent(id, "agent", ["service-status"], { ...operator, groups: () => [2002] }),
		/operator access/,
	);
	assert.equal(calls.length, 1);
});

test("#33 changing operator membership requires root and preserves other groups", async () => {
	const { context, calls, record, root, paths } = await setup();
	await software(record, root, paths);
	const notices = [];
	await assert.rejects(
		dispatchAgent(id, "agent", ["operator", "add", "ubuntu"], { ...context, uid: 2001 }),
		/require root/,
	);
	assert.deepEqual(calls, []);
	await dispatchAgent(id, "agent", ["operator", "add", "ubuntu"], {
		...context,
		notice: (message) => notices.push(message),
	});
	assert.deepEqual(calls[0], ["usermod", "--append", "--groups", "ua-111111111111411181111111", "ubuntu"]);
	assert.match(notices[0], /Reconnect SSH/);
	await dispatchAgent(id, "agent", ["operator", "remove", "ubuntu"], {
		...context,
		notice: (message) => notices.push(message),
	});
	assert.deepEqual(calls[1], ["gpasswd", "--delete", "ubuntu", "ua-111111111111411181111111"]);
	assert.match(notices[1], /Existing sessions retain their groups/);
});

// #33: The exact legacy unit remains owned after an old updater publishes new application code.
async function legacyUnit(paths) {
	const current = await readFile(paths.unitFile, "utf8");
	const legacy = current.replace(`RuntimeDirectory=unit-001-${id}\nRuntimeDirectoryMode=0750\n`, "");
	assert.equal(
		createHash("sha256")
			.update(legacy.replaceAll(id, "@ID@").replaceAll("ua-111111111111411181111111", "@ACCOUNT@"))
			.digest("hex"),
		"566fc74ff71df178eb6c773477ebf44d8ac9cf551aa01ab5214d126defc3b874",
	);
	await writeFile(paths.unitFile, legacy);
	return { current, legacy };
}

test("#33 legacy operator bootstrap requires stopped intent and never silently restarts work", async () => {
	const { context, calls, record, root, paths } = await setup();
	await software(record, root, paths);
	const { current, legacy } = await legacyUnit(paths);
	const operatorContext = { ...context, notice() {} };
	await assert.rejects(dispatchAgent(id, "agent", ["operator", "add", "ubuntu"], operatorContext), /Stop agent first/);
	assert.deepEqual(calls, []);
	assert.equal(await readFile(paths.unitFile, "utf8"), legacy);
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
	await assert.rejects(
		dispatchAgent(id, "agent", ["operator", "add", "ubuntu"], {
			...operatorContext,
			async unitRunning() {
				return true;
			},
		}),
		/Stop agent first/,
	);
	await dispatchAgent(id, "agent", ["operator", "add", "ubuntu"], operatorContext);
	assert.equal(await readFile(paths.unitFile, "utf8"), current);
	assert.deepEqual(calls, [
		["systemctl", "daemon-reload"],
		["usermod", "--append", "--groups", record.account, "ubuntu"],
	]);
	assert.equal(readInstallation(id, root).desiredState, "stopped");
});

test("#33 failed operator policy reload restores the exact old unit and does not grant access", async () => {
	const { context, record, root, paths } = await setup();
	await software(record, root, paths);
	const { legacy } = await legacyUnit(paths);
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
	let reloads = 0;
	await assert.rejects(
		dispatchAgent(id, "agent", ["operator", "add", "ubuntu"], {
			...context,
			notice() {},
			async run(command, args) {
				assert.deepEqual([command, ...args], ["systemctl", "daemon-reload"]);
				if (++reloads === 1) throw new Error("reload failure");
			},
		}),
		/reload failure/,
	);
	assert.equal(reloads, 2);
	assert.equal(await readFile(paths.unitFile, "utf8"), legacy);
	assert.equal(readInstallation(id, root).desiredState, "stopped");
});

test("#33 uninstall recognizes the exact legacy unit and preserves a customized unit", async () => {
	for (const custom of [false, true]) {
		const { context, record, root, paths } = await setup();
		await software(record, root, paths);
		const { legacy } = await legacyUnit(paths);
		if (custom) await writeFile(paths.unitFile, `${legacy}# administrator customization\n`);
		if (custom) {
			await assert.rejects(lifecycle(record, "uninstall", context), /unowned service unit/);
			assert.equal(await readFile(paths.unitFile, "utf8"), `${legacy}# administrator customization\n`);
			await assert.rejects(
				dispatchAgent(id, "agent", ["operator", "add", "ubuntu"], { ...context, notice() {} }),
				/unowned service unit/,
			);
		} else {
			await lifecycle(record, "uninstall", context);
			await assert.rejects(readFile(paths.unitFile), { code: "ENOENT" });
		}
	}
});

test("#19 two names route to separate accounts, UUIDs and state", async () => {
	const { context, record, calls, root } = await setup();
	const second = { ...record, id: otherId, name: "bob", account: "ua-222222222222422282222222" };
	await mkdir(installationPaths(otherId, root).config, { recursive: true });
	await writeInstallation(second, root);
	await dispatchAgent(id, "agent", ["status"], context);
	await dispatchAgent(otherId, "bob", ["status"], context);
	assert.equal(calls[0][2], record.account);
	assert.equal(calls[1][2], second.account);
	assert.ok(calls[1].includes(`/var/lib/unit-001/agents/${otherId}`));
});

test("setup requires root, an interactive terminal and no extra arguments before launching the app", async () => {
	const { context, calls, root } = await setup();
	const before = readInstallation(id, root);
	for (const [args, overrides, message] of [
		[["setup"], { uid: 1001, interactive: true }, /sudo agent setup/],
		[["setup"], { interactive: false }, /interactive terminal/],
		[["setup", "--yes"], { interactive: true }, /Invalid setup arguments/],
	]) {
		await assert.rejects(dispatchAgent(id, "agent", args, { ...context, ...overrides }), message);
	}
	assert.deepEqual(calls, []);
	assert.deepEqual(readInstallation(id, root), before);
});

test("setup configures as the installation account and declining start preserves stopped intent", async () => {
	const { context, record, root, calls } = await setup();
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
	const prompts = [];
	let forwarded;
	assert.equal(
		await dispatchAgent(id, "agent", ["setup"], {
			...context,
			interactive: true,
			async applicationEnvironment() {
				return { OPENAI_API_KEY: "protected provider key" };
			},
			async run(command, args, capture, environment, options) {
				calls.push([command, ...args]);
				assert.equal(capture, false);
				assert.deepEqual(options, { forwardSignals: true });
				forwarded = environment;
				// Authentication writes must not overlap an update backup or rollback.
				await assert.rejects(
					withManagementLock(async () => assert.fail("Update acquired setup lock"), root),
					/Another install, update, or lifecycle operation/,
				);
				return 0;
			},
			async confirm(prompt) {
				prompts.push(prompt);
				return false;
			},
		}),
		0,
	);
	assert.deepEqual(calls, [
		[
			"runuser",
			"-u",
			record.account,
			"--",
			"/opt/trusted-release/runtime/bin/node",
			"/opt/trusted-release/app/dist/named.js",
			id,
			"agent",
			`/var/lib/unit-001/agents/${id}`,
			"setup",
		],
	]);
	assert.deepEqual(forwarded, { OPENAI_API_KEY: "protected provider key" });
	assert.deepEqual(prompts, ["Start agent now? [y/N] "]);
	assert.equal(readInstallation(id, root).desiredState, "stopped");
	await withManagementLock(async () => {}, root);
});

test("setup starts the selected custom name only after successful configuration and explicit confirmation", async () => {
	const { context, record, root, calls, paths } = await setup();
	await writeInstallation({ ...record, name: "bob", desiredState: "stopped" }, root);
	const prompts = [];
	assert.equal(
		await dispatchAgent(id, "bob", ["setup"], {
			...context,
			interactive: true,
			async confirm(prompt) {
				assert.equal(calls[0][0], "runuser");
				assert.equal(calls.length, 1);
				prompts.push(prompt);
				return true;
			},
		}),
		0,
	);
	assert.deepEqual(prompts, ["Start bob now? [y/N] "]);
	assert.ok(calls.some((call) => call[0] === "systemctl" && call[1] === "enable" && call.includes(paths.unit)));
	assert.equal(readInstallation(id, root).desiredState, "running");
});

test("setup failure, EOF and interruption never prompt for start and preserve the child exit status", async () => {
	for (const code of [1, 2, 130]) {
		const { context, record, root } = await setup();
		await writeInstallation({ ...record, desiredState: "stopped" }, root);
		const result = await dispatchAgent(id, "agent", ["setup"], {
			...context,
			interactive: true,
			async run() {
				throw Object.assign(new Error("Child cancelled or failed"), { exitCode: code });
			},
			async confirm() {
				assert.fail("Failed setup must never ask to start");
			},
		});
		assert.equal(result, code);
		assert.equal(readInstallation(id, root).desiredState, "stopped");
		await withManagementLock(async () => {}, root);
	}
});

test(
	"#32 setup wrapper retains the management lock until its signalled child finishes",
	{ timeout: 10000, skip: process.platform === "win32" },
	async () => {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
			const { root } = await setup();
			const childFile = join(root, "setup-child.mjs");
			const parentFile = join(root, "setup-parent.mjs");
			await writeFile(
				childFile,
				`process.stdin.resume();
process.stdin.once('end', () => process.exit(0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  process.stdout.write('child-stopping\\n');
  process.stdin.once('data', () => process.exit(0));
});
process.stdout.write('child-ready\\n');
`,
			);
			await writeFile(
				parentFile,
				`import { run } from ${JSON.stringify(new URL("../deploy/agent-command.mjs", import.meta.url).href)};
import { withManagementLock } from ${JSON.stringify(new URL("../deploy/installation.mjs", import.meta.url).href)};
try {
  await withManagementLock(() => run(process.execPath, [${JSON.stringify(childFile)}], false, {}, { forwardSignals: true }), ${JSON.stringify(root)});
} catch (error) {
  process.exitCode = error.exitCode ?? 1;
}
`,
			);
			const parent = spawn(process.execPath, [parentFile], { stdio: ["pipe", "pipe", "inherit"] });
			try {
				assert.match((await once(parent.stdout, "data"))[0].toString(), /child-ready/);
				const stopping = once(parent.stdout, "data");
				parent.kill(signal);
				assert.match((await stopping)[0].toString(), /child-stopping/);
				await assert.rejects(
					withManagementLock(async () => assert.fail("Update acquired setup lock before child exit"), root),
					/Another install, update, or lifecycle operation/,
				);
				const closed = once(parent, "close");
				parent.stdin.end("finish\n");
				assert.equal((await closed)[0], { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
				await withManagementLock(async () => {}, root);
			} finally {
				if (!parent.stdin.writableEnded) parent.stdin.end("finish\n");
				if (parent.exitCode === null) parent.kill("SIGKILL");
			}
		}
	},
);

test("#32 setup rejects an incomplete update before launching any configuration writes", async () => {
	for (const phase of ["holding", "backed-up", "candidate", "committed", "restored"]) {
		const { context, root, calls } = await setup();
		const update = updatePaths(id, root);
		await mkdir(update.configDirectory, { recursive: true });
		await writeFile(update.journal, JSON.stringify({ schemaVersion: 1, id, operationId: "pending-update", phase }), {
			mode: 0o600,
		});
		await assert.rejects(
			dispatchAgent(id, "agent", ["setup"], { ...context, interactive: true }),
			/update recover before setup/,
		);
		assert.deepEqual(calls, []);
		await withManagementLock(async () => {}, root);
	}
});

test("persistent web provisioning requires root and refuses an incomplete update before touching units", async () => {
	const { context, root, calls, paths } = await setup();
	await assert.rejects(
		dispatchAgent(id, "agent", ["web", "enable", "ubuntu"], { ...context, uid: 1001 }),
		/provisioning requires root/,
	);
	const update = updatePaths(id, root);
	await mkdir(update.configDirectory, { recursive: true });
	await writeFile(update.journal, JSON.stringify({ schemaVersion: 1, id, operationId: "pending-update", phase: "candidate" }), {
		mode: 0o600,
	});
	await assert.rejects(dispatchAgent(id, "agent", ["web", "enable", "ubuntu"], context), /Recover the incomplete update/);
	assert.deepEqual(calls, []);
	await assert.rejects(stat(join(paths.config, "web-activation.json")), { code: "ENOENT" });
});

test("#32 an active administrative operation blocks setup before authentication begins", async () => {
	const { context, root, calls } = await setup();
	await withManagementLock(async () => {
		await assert.rejects(
			dispatchAgent(id, "agent", ["setup"], { ...context, interactive: true }),
			/Another install, update, or lifecycle operation/,
		);
	}, root);
	assert.deepEqual(calls, []);
});

test("#32 a completed update journal permits setup", async () => {
	const { context, root, calls } = await setup();
	const update = updatePaths(id, root);
	await mkdir(update.configDirectory, { recursive: true });
	await writeFile(
		update.journal,
		JSON.stringify({ schemaVersion: 1, id, operationId: "completed-update", phase: "complete" }),
		{ mode: 0o600 },
	);
	assert.equal(await dispatchAgent(id, "agent", ["setup"], { ...context, interactive: true }), 0);
	assert.equal(calls[0][0], "runuser");
});

test("#32 setup's start prompt names the environment model override without exposing credentials", async () => {
	const { context, record, root } = await setup();
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
	let prompt;
	await dispatchAgent(id, "agent", ["setup"], {
		...context,
		interactive: true,
		async applicationEnvironment() {
			return { OPENAI_API_KEY: "never-display-this", UNIT_001_MODEL: "openai/gpt-5" };
		},
		async confirm(value) {
			prompt = value;
			return false;
		},
	});
	assert.equal(prompt, "Start agent now using UNIT_001_MODEL (overrides the saved setup model)? [y/N] ");
	assert.doesNotMatch(prompt, /openai\/gpt-5/);
	assert.doesNotMatch(prompt, /never-display-this/);
});

test("setup never restarts an already running service and explains how to apply changed settings", async () => {
	const { context, record, root, calls } = await setup();
	const notices = [];
	assert.equal(
		await dispatchAgent(id, "agent", ["setup"], {
			...context,
			interactive: true,
			async unitRunning() {
				return true;
			},
			notice(message) {
				notices.push(message);
			},
			async confirm() {
				assert.fail("Running setup must not offer an ineffective start");
			},
		}),
		0,
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(notices, ["Settings are saved. To apply changes, stop and start agent.\n"]);
	assert.equal(readInstallation(id, root).desiredState, record.desiredState);
});

test("#20 confirmation defaults to no and --yes does not confer root authority", async () => {
	const { context, calls } = await setup();
	await assert.rejects(dispatchAgent(id, "agent", ["stop"], context), /cancelled/);
	await assert.rejects(dispatchAgent(id, "agent", ["stop", "--yes"], { ...context, uid: 1001 }), /sudo/);
	assert.deepEqual(calls, []);
});

test("#20 stop and kill persist stopped intent before preventing restart", async () => {
	for (const action of ["stop", "kill"]) {
		const { record, context, calls, paths } = await setup();
		await lifecycle(record, action, {
			...context,
			async run(command, args) {
				assert.equal(JSON.parse(await readFile(paths.record, "utf8")).desiredState, "stopped");
				calls.push([command, ...args]);
				return 0;
			},
		});
		assert.deepEqual(calls[0], ["systemctl", "disable", paths.unit]);
		if (action === "kill")
			assert.ok(
				calls.findIndex((c) => c.includes("--no-block")) < calls.findIndex((c) => c.includes("--signal=SIGKILL")),
			);
	}
});

test("#20 a failed stop prevents uninstall removal", async () => {
	const { record, context, paths, root } = await setup();
	const release = await software(record, root, paths);
	await assert.rejects(
		lifecycle(record, "uninstall", {
			...context,
			async run(_command, args) {
				if (args[0] === "stop") throw new Error("stop failed");
				return 0;
			},
		}),
		/stop failed/,
	);
	assert.equal(JSON.parse(await readFile(paths.record, "utf8")).desiredState, "stopped");
	for (const path of [paths.unitFile, paths.wrapper(record.name), join(paths.management, "agent-command.mjs")])
		assert.ok(await readFile(path));
	assert.equal(await readlink(paths.current), `../../releases/${record.releaseVersion}`);
	assert.equal(await readFile(join(release, "VERSION"), "utf8"), `${record.releaseVersion}\n`);
});

test("#19 rename preserves UUID and state, removes old command, and rejects collisions", async () => {
	const { record, context, root, paths } = await setup();
	await writeAgentCommand(record, root);
	await lifecycle(record, "rename", context, "bob");
	const updated = readInstallation(id, root);
	assert.equal(updated.id, id);
	assert.equal(updated.name, "bob");
	await assert.rejects(readFile(paths.wrapper("agent")), { code: "ENOENT" });
	assert.match(await readFile(paths.wrapper("bob"), "utf8"), /bob/);
	await assert.rejects(lifecycle(updated, "rename", context, "bad/name"), /Agent name/);
});

test("#19 interrupted rename removes only the nonauthoritative owned wrapper", async () => {
	const { record, context, root, paths } = await setup();
	await writeAgentCommand(record, root);
	await writeAgentCommand({ ...record, name: "bob" }, root);
	await writeFile(join(paths.config, "rename.json"), JSON.stringify({ oldName: "agent", newName: "bob" }));
	await recoverRename(record, root);
	assert.ok(await readFile(paths.wrapper("agent")));
	await assert.rejects(readFile(paths.wrapper("bob")), { code: "ENOENT" });
	await assert.rejects(dispatchAgent(id, "bob", ["status"], context), /renamed/);
});

// codex-9: the rename journal outlives a failed restart, so the owner never keeps the previous name unnoticed.
test("a failed rename restart leaves a same-name retry able to restart the owner", async () => {
	const { record, context, calls, root, paths } = await setup();
	await writeAgentCommand(record, root);
	const ready = [];
	let restarts = 0;
	const renaming = {
		...context,
		async run(command, args) {
			calls.push([command, ...args]);
			if (args[0] === "restart" && ++restarts === 1) throw new Error("restart failed");
			return 0;
		},
		async ready(current) {
			ready.push(current.name);
		},
	};
	await assert.rejects(dispatchAgent(id, "agent", ["rename", "bob", "--yes"], renaming), /restart failed/);
	assert.equal(readInstallation(id, root).name, "bob");
	await assert.rejects(readFile(paths.wrapper("agent")), { code: "ENOENT" });
	await dispatchAgent(id, "bob", ["rename", "bob", "--yes"], renaming);
	assert.equal(restarts, 2);
	assert.deepEqual(ready, ["bob"]);
	await assert.rejects(readFile(join(paths.config, "rename.json")), { code: "ENOENT" });
	assert.equal(readInstallation(id, root).id, id);
	// Without a pending restart, renaming to the current name changes nothing.
	calls.length = 0;
	await dispatchAgent(id, "bob", ["rename", "bob", "--yes"], renaming);
	assert.deepEqual(calls, []);
});

test("a rename interrupted after the record switch keeps the owner restart for a same-name retry", async () => {
	const { record, root, paths } = await setup();
	const updated = { ...record, name: "bob" };
	await writeAgentCommand(record, root);
	await writeAgentCommand(updated, root);
	await writeInstallation(updated, root);
	await writeFile(join(paths.config, "rename.json"), JSON.stringify({ oldName: "agent", newName: "bob" }));
	await recoverRename(updated, root);
	await assert.rejects(readFile(paths.wrapper("agent")), { code: "ENOENT" });
	assert.deepEqual(JSON.parse(await readFile(join(paths.config, "rename.json"), "utf8")), { newName: "bob" });
	await recoverRename(updated, root);
	assert.ok(await readFile(paths.wrapper("bob")));
	await recoverRename({ ...updated, desiredState: "stopped" }, root);
	await assert.rejects(readFile(join(paths.config, "rename.json")), { code: "ENOENT" });
});

// codex-11: a foreign unit is detected before uninstall changes operator intent or the service manager.
test("uninstall of a foreign unit changes no intent, manager state or files", async () => {
	const { record, context, calls, root, paths } = await setup();
	const release = await software(record, root, paths);
	const foreign = `${await readFile(paths.unitFile, "utf8")}# administrator customization\n`;
	await writeFile(paths.unitFile, foreign);
	await assert.rejects(dispatchAgent(id, "agent", ["uninstall", "--yes"], context), /unowned service unit/);
	assert.deepEqual(calls, []);
	assert.equal(readInstallation(id, root).desiredState, "running");
	assert.equal(await readFile(paths.unitFile, "utf8"), foreign);
	for (const path of [paths.wrapper(record.name), join(paths.management, "agent-command.mjs"), join(release, "VERSION")])
		assert.ok(await readFile(path));
	assert.equal(await readlink(paths.current), `../../releases/${record.releaseVersion}`);
});

// xr-rd-1: unexpected persistent web files are refused before the owner is stopped.
test("uninstall refuses unexpected persistent web files before any intent or manager change", async () => {
	const socket = `unit-001-web@${id}.socket`;
	// No web-activation.json exists, so every one of these belongs to someone else.
	const cases = [
		["unregistered unit", /unregistered persistent web unit/, (units) =>
			writeFile(join(units, socket), "[Socket]\nListenStream=/tmp/x\n")],
		["unregistered enablement", /unexpected persistent web enablement/, async (units, paths) => {
			await mkdir(join(units, `${paths.unit}.wants`));
			await symlink(`/etc/systemd/system/${socket}`, join(units, `${paths.unit}.wants`, socket));
		}],
		["unregistered listener", /unexpected persistent web listener/, async (units, paths, root) => {
			await mkdir(join(root, "run/unit-001-web"), { recursive: true });
			await writeFile(join(root, `run/unit-001-web/${id}.sock`), "");
		}],
	];
	for (const [name, message, plant] of cases) {
		const { record, context, calls, root, paths } = await setup();
		await software(record, root, paths);
		await plant(join(root, "etc/systemd/system"), paths, root);
		await assert.rejects(dispatchAgent(id, "agent", ["uninstall", "--yes"], context), message, name);
		assert.deepEqual(calls, [], name);
		assert.equal(readInstallation(id, root).desiredState, "running", name);
		assert.ok(await readFile(paths.unitFile), name);
	}
});

// xr-rd2-1, xr-rd2-2: the wrapper, the shared update launcher and a registered listener are refused before any change.
test("uninstall refuses a foreign command, update launcher or registered listener before any change", async () => {
	const cases = [
		["foreign command", /unexpected command/, (record, root, paths) =>
			writeFile(paths.wrapper(record.name), "#!/bin/sh\necho administrator\n", { mode: 0o755 })],
		["writable update launcher", /not owned and protected/, async (record, root) => {
			await mkdir(updatePaths(id, root).cores, { recursive: true });
			const launcher = join(root, "usr/local/sbin/unit-001-update");
			await mkdir(join(root, "usr/local/sbin"), { recursive: true });
			await writeFile(launcher, "#!/bin/sh\n");
			await chmod(launcher, 0o666);
		}],
		["registered non-socket listener", /unexpected persistent web listener/, async (record, root, paths) => {
			const config = join(paths.config, "web-activation.json");
			await writeFile(config, `${JSON.stringify({ schemaVersion: 1, id, operator: "op", uid: 1001, state: "configured" })}\n`);
			await chmod(config, 0o644);
			const directory = join(root, "run/unit-001-web");
			await mkdir(directory, { recursive: true });
			await chmod(directory, 0o755);
			await writeFile(join(directory, `${id}.sock`), "");
		}],
	];
	// Web units are absent from the manager, so without the preflight uninstall reaches the listener after the owner stop.
	const absent = "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\nNeedDaemonReload=no\nJob=\nMainPID=0\nControlPID=0\nControlGroup=\n";
	for (const [name, message, plant] of cases) {
		const { record, context, calls, root, paths } = await setup();
		const release = await software(record, root, paths);
		await plant(record, root, paths);
		const manager = {
			...context,
			async run(command, args) {
				calls.push([command, ...args]);
				return args[0] === "show" ? absent : 0;
			},
		};
		await assert.rejects(dispatchAgent(id, "agent", ["uninstall", "--yes"], manager), message, name);
		assert.deepEqual(calls, [], name);
		assert.equal(readInstallation(id, root).desiredState, "running", name);
		for (const path of [paths.unitFile, paths.wrapper(record.name), join(paths.management, "agent-command.mjs"), join(release, "VERSION")])
			assert.ok(await readFile(path), `${name}: ${path}`);
		assert.equal(await readlink(paths.current), `../../releases/${record.releaseVersion}`, name);
	}
	// Only the last installation's uninstall reads the launcher: another updater root still needs it.
	const { record, context, calls, root, paths } = await setup();
	await software(record, root, paths);
	await mkdir(updatePaths(id, root).cores, { recursive: true });
	await mkdir(updatePaths(otherId, root).updaterRoot, { recursive: true });
	const launcher = join(root, "usr/local/sbin/unit-001-update");
	await mkdir(join(root, "usr/local/sbin"), { recursive: true });
	await writeFile(launcher, "#!/bin/sh\n");
	await chmod(launcher, 0o666);
	await lifecycle(record, "uninstall", context);
	assert.equal(readInstallation(id, root).desiredState, "uninstalled");
	assert.ok(calls.length > 0);
	assert.equal(await readFile(launcher, "utf8"), "#!/bin/sh\n");
});

async function software(record, root, paths) {
	const release = join(root, "opt/unit-001/releases", record.releaseVersion);
	await mkdir(join(release, "deploy"), { recursive: true });
	await mkdir(paths.management, { recursive: true });
	await mkdir(paths.agentRoot, { recursive: true });
	await mkdir(join(root, "etc/systemd/system"), { recursive: true });
	const files = new Map([["VERSION", `${record.releaseVersion}\n`]]);
	for (const file of [
		"agent-command.mjs",
		"lifecycle.mjs",
		"installation.mjs",
		"update-activation.mjs",
		"unit-001.service",
	]) {
		const text = await readFile(new URL(`../deploy/${file}`, import.meta.url), "utf8");
		files.set(`deploy/${file}`, text);
		if (file !== "unit-001.service") await writeFile(join(paths.management, file), text);
	}
	for (const [file, text] of files) await writeFile(join(release, file), text);
	await writeFile(
		join(release, "SHA256SUMS"),
		[...files].map(([file, text]) => `${createHash("sha256").update(text).digest("hex")}  ./${file}\n`).join(""),
	);
	await writeFile(
		paths.unitFile,
		files.get("deploy/unit-001.service").replaceAll("@ID@", record.id).replaceAll("@ACCOUNT@", record.account),
	);
	await symlink(`../../releases/${record.releaseVersion}`, paths.current);
	await writeAgentCommand(record, root);
	return release;
}

test("#20 uninstall removes owned software and unused release while preserving state and record", async () => {
	const { record, root, paths, context } = await setup();
	const release = await software(record, root, paths);
	await mkdir(paths.state, { recursive: true });
	await writeFile(join(paths.state, "credentials.json"), "keep");
	await lifecycle(record, "uninstall", context);
	for (const path of [paths.wrapper(record.name), paths.current, paths.unitFile, paths.management, release])
		await assert.rejects(readFile(path), { code: "ENOENT" });
	assert.equal(await readFile(join(paths.state, "credentials.json"), "utf8"), "keep");
	assert.equal(readInstallation(id, root).desiredState, "uninstalled");
	await lifecycle(readInstallation(id, root), "uninstall", {
		...context,
		async unitExists() {
			return false;
		},
	});
});

// codex-3: Both reload boundaries must leave the documented named command callable.
test("named uninstall can retry after either manager reload fails", async (t) => {
	for (const failedReload of [1, 2]) {
		await t.test(`reload ${failedReload}`, async () => {
			const { record, root, paths, context } = await setup();
			const release = await software(record, root, paths);
			const runtime = join(paths.current, "runtime/bin/node");
			await mkdir(join(release, "runtime/bin"), { recursive: true });
			await writeFile(runtime, "fixture runtime", { mode: 0o755 });
			const wrapper = paths.wrapper(record.name);
			const wrapperBytes = await readFile(wrapper, "utf8");
			const helpers = ["agent-command.mjs", "lifecycle.mjs", "installation.mjs", "update-activation.mjs"];
			const schedule = updateScheduling(record, root);
			await writeFile(schedule.servicePath, schedule.serviceContents);
			await writeFile(schedule.timerPath, schedule.timerContents);
			const unitFiles = new Map([
				[paths.unit, paths.unitFile],
				[schedule.serviceName, schedule.servicePath],
				[schedule.timerName, schedule.timerPath],
			]);
			const loaded = new Set(unitFiles.keys());
			const second = { ...record, id: otherId, name: "bob", account: "ua-222222222222422282222222" };
			await writeInstallation(second, root);
			const otherPaths = installationPaths(otherId, root);
			await software(second, root, otherPaths);
			writeReleaseChecksums(release);
			await mkdir(paths.state, { recursive: true });
			const credentials = join(paths.state, "credentials.json");
			await writeFile(credentials, "keep");
			let reloads = 0;
			const uninstall = () => dispatchAgent(id, record.name, ["uninstall", "--yes"], {
				...context,
				async unitExists(unit) {
					return loaded.has(unit);
				},
				async run(command, [action, ...args]) {
					assert.equal(command, "systemctl");
					assert.equal(readInstallation(id, root).desiredState, "stopped");
					if (action === "daemon-reload") {
						if (++reloads === failedReload) throw new Error("reload failed");
						for (const [unit, path] of unitFiles) {
							try {
								await stat(path);
							} catch (error) {
								if (error.code !== "ENOENT") throw error;
								loaded.delete(unit);
							}
						}
					} else {
						const unit = args.at(-1);
						assert.ok(unitFiles.has(unit), `unexpected unit ${unit}`);
						if (action === "disable") await stat(unitFiles.get(unit));
					}
					return 0;
				},
			});

			await assert.rejects(uninstall(), /reload failed/);
			assert.equal(readInstallation(id, root).desiredState, "stopped");
			assert.equal(await readFile(wrapper, "utf8"), wrapperBytes);
			assert.equal(await readlink(paths.current), `../../releases/${record.releaseVersion}`);
			assert.equal((await stat(runtime)).mode & 0o111, 0o111);
			for (const file of helpers) assert.ok(await readFile(join(paths.management, file)));
			assert.equal(await readFile(credentials, "utf8"), "keep");

			assert.equal(await uninstall(), 0);
			assert.equal(readInstallation(id, root).desiredState, "uninstalled");
			assert.equal(loaded.size, 0);
			for (const path of [wrapper, paths.current, paths.management])
				await assert.rejects(lstat(path), { code: "ENOENT" });
			assert.equal(await readFile(credentials, "utf8"), "keep");
			assert.deepEqual(readInstallation(otherId, root), second);
			assert.ok(await readFile(otherPaths.wrapper(second.name)));
			assert.equal(await readFile(join(release, "VERSION"), "utf8"), `${record.releaseVersion}\n`);
		});
	}
});

test("#20 uninstall preserves a release referenced by another stopped installation", async () => {
	const { record, root, paths, context } = await setup();
	const release = await software(record, root, paths);
	const second = {
		...record,
		id: otherId,
		name: "bob",
		account: "ua-222222222222422282222222",
		desiredState: "stopped",
	};
	await writeInstallation(second, root);
	await lifecycle(record, "uninstall", context);
	assert.equal(await readFile(join(release, "VERSION"), "utf8"), "0.0.1\n");
});

test("unit-gp1.11 uninstall retains the inventory for another installation's selected updater core", async (t) => {
	for (const [selection, desiredState] of [
		["currentCore", "running"],
		["recoveryCore", "stopped"],
	]) {
		await t.test(`${selection} on a ${desiredState} installation with a newer application`, async () => {
			const { record, root, paths, context } = await setup();
			const release = await software(record, root, paths);
			const other = {
				...record,
				id: otherId,
				name: "bob",
				account: "ua-222222222222422282222222",
				releaseVersion: "0.0.2",
				desiredState,
			};
			await writeInstallation(other, root);
			const otherPaths = installationPaths(otherId, root);
			const newer = await software(other, root, otherPaths);
			for (const [archive, version] of [
				[release, record.releaseVersion],
				[newer, other.releaseVersion],
			]) {
				await mkdir(join(archive, "updater/runtime/bin"), { recursive: true });
				await mkdir(join(archive, "updater/lib"), { recursive: true });
				await writeFile(join(archive, "updater/runtime/bin/node"), `runtime ${version}`);
				await writeFile(join(archive, "updater/lib/update.mjs"), `// updater ${version}\n`);
				writeReleaseChecksums(archive);
				assert.equal(installUpdateCore({ ...other, releaseVersion: version }, archive, context), true);
			}
			const update = updatePaths(otherId, root);
			const oldTarget = `cores/${record.releaseVersion}`;
			const newTarget = `cores/${other.releaseVersion}`;
			const otherSelector = selection === "currentCore" ? update.recoveryCore : update.currentCore;
			await rm(otherSelector);
			await symlink(newTarget, otherSelector);
			const inventory = await readFile(join(release, "SHA256SUMS"));

			await lifecycle(record, "uninstall", context);
			assert.equal(readInstallation(id, root).desiredState, "uninstalled");
			assert.equal(await readlink(otherPaths.current), `../../releases/${other.releaseVersion}`);
			assert.equal(await readlink(update[selection]), oldTarget);
			assert.deepEqual(await readFile(join(release, "SHA256SUMS")), inventory);
			assert.deepEqual(
				await readFile(join(release, "updater/runtime/bin/node")),
				await readFile(join(update[selection], "runtime/bin/node")),
			);

			await symlink(oldTarget, update.previousCore);
			await rm(update[selection]);
			await symlink(newTarget, update[selection]);
			assert.equal(removeUnusedRelease(record, root), true);
			await assert.rejects(stat(release), { code: "ENOENT" });
			assert.equal(await readlink(update.previousCore), oldTarget);
			assert.equal(
				await readFile(join(update.previousCore, "runtime/bin/node"), "utf8"),
				`runtime ${record.releaseVersion}`,
			);
			assert.equal(await readFile(join(newer, "VERSION"), "utf8"), `${other.releaseVersion}\n`);
		});
	}

	for (const [condition, pathKey, createEntry] of [
		["absent selector directory", null],
		["malformed selector", "recoveryCore", (path) => writeFile(path, "unexpected")],
		["foreign selector", "recoveryCore", (path, release) => symlink(release, path)],
		["dangling selector", "recoveryCore", (path) => symlink("cores/0.0.9", path)],
		["writable selector directory", "updaterRoot", (path) => chmod(path, 0o777)],
	]) {
		await t.test(`uninstall handles ${condition}`, async () => {
			const { record, root, paths, context } = await setup();
			const release = await software(record, root, paths);
			await writeInstallation(
				{
					...record,
					id: otherId,
					name: "bob",
					account: "ua-222222222222422282222222",
					releaseVersion: "0.0.2",
				},
				root,
			);
			const update = updatePaths(otherId, root);
			const entry = pathKey && update[pathKey];
			let original;
			if (entry) {
				await mkdir(update.updaterRoot, { recursive: true });
				await createEntry(entry, release);
				original = await lstat(entry);
			}

			await lifecycle(record, "uninstall", context);
			assert.equal(readInstallation(id, root).desiredState, "uninstalled");
			await assert.rejects(stat(paths.wrapper(record.name)), { code: "ENOENT" });
			if (entry) {
				assert.equal((await lstat(entry)).ino, original.ino);
				assert.equal(await readFile(join(release, "VERSION"), "utf8"), `${record.releaseVersion}\n`);
			} else {
				await assert.rejects(stat(release), { code: "ENOENT" });
			}
		});
	}
});

test("unit-gp1.14 uninstall retains another installation's journal-reachable release", async (t) => {
	for (const phase of ["backed-up", "candidate", "committed", "complete", "holding", "restored"]) {
		await t.test(phase, async () => {
			const { record, root, paths, context } = await setup();
			const release = await software(record, root, paths);
			const other = {
				...record,
				id: otherId,
				name: "bob",
				account: "ua-222222222222422282222222",
				releaseVersion: "0.0.3",
				desiredState: "stopped",
			};
			const otherPaths = installationPaths(otherId, root);
			await writeInstallation(other, root);
			await software(other, root, otherPaths);
			const update = updatePaths(otherId, root);
			const core = "cores/0.0.0";
			await mkdir(join(update.updaterRoot, core), { recursive: true });
			for (const selector of [update.currentCore, update.recoveryCore]) await symlink(core, selector);
			await mkdir(update.configDirectory);

			const previous = {
				schemaVersion: 1,
				id: otherId,
				operationId: "33333333-3333-4333-8333-333333333333",
				previousRecord: { ...other, releaseVersion: record.releaseVersion, desiredState: "running" },
				candidateVersion: other.releaseVersion,
				phase: "complete",
			};
			const canRestoreReceipt = phase === "holding" || phase === "restored";
			const journal =
				canRestoreReceipt
					? {
							...previous,
							operationId: "44444444-4444-4444-8444-444444444444",
							previousRecord: { ...other, desiredState: "running" },
							candidateVersion: "0.0.4",
							phase,
							...(phase === "restored" ? { liveDeferred: true } : {}),
						}
					: { ...previous, phase };
			const receipt = JSON.stringify({ operationId: journal.operationId, journal: previous });
			if (canRestoreReceipt) await writeFile(update.priorJournal, receipt);
			const journalBytes = JSON.stringify(journal);
			await writeFile(update.journal, journalBytes);
			const inventory = await readFile(join(release, "SHA256SUMS"));

			await lifecycle(record, "uninstall", context);
			assert.equal(readInstallation(id, root).desiredState, "uninstalled");
			assert.equal(await readlink(otherPaths.current), `../../releases/${other.releaseVersion}`);
			assert.equal(await readlink(update.currentCore), core);
			assert.equal(await readlink(update.recoveryCore), core);
			assert.equal(await readFile(update.journal, "utf8"), journalBytes);
			if (canRestoreReceipt) assert.equal(await readFile(update.priorJournal, "utf8"), receipt);
			assert.deepEqual(await readFile(join(release, "SHA256SUMS")), inventory);

			await writeFile(
				update.journal,
				JSON.stringify({ ...previous, previousRecord: { ...previous.previousRecord, releaseVersion: "0.0.2" } }),
			);
			assert.equal(removeUnusedRelease(record, root), true);
			await assert.rejects(stat(release), { code: "ENOENT" });
		});
	}
});

test("unit-gp1.14 uninstall finishes when another installation's recovery metadata is ambiguous", async (t) => {
	for (const condition of [
		"null marker",
		"untrusted journal",
		"unknown phase",
		"foreign record",
		"invalid release",
		"invalid receipt",
	]) {
		await t.test(condition, async () => {
			const { record, root, paths, context } = await setup();
			const release = await software(record, root, paths);
			const other = {
				...record,
				id: otherId,
				name: "bob",
				account: "ua-222222222222422282222222",
				releaseVersion: "0.0.3",
			};
			await writeInstallation(other, root);
			const update = updatePaths(otherId, root);
			await mkdir(update.configDirectory);
			const journal = {
				schemaVersion: 1,
				id: otherId,
				operationId: "33333333-3333-4333-8333-333333333333",
				previousRecord: other,
				candidateVersion: "0.0.4",
				phase: "holding",
			};
			if (condition === "unknown phase") journal.phase = "unknown";
			if (condition === "foreign record") journal.previousRecord = record;
			if (condition === "invalid release") journal.candidateVersion = "../0.0.4";
			if (condition === "invalid receipt")
				await writeFile(update.priorJournal, JSON.stringify({ operationId: journal.operationId }));
			const journalBytes = JSON.stringify(condition === "null marker" ? null : journal);
			await writeFile(update.journal, journalBytes);
			if (condition === "untrusted journal") await chmod(update.journal, 0o666);

			await lifecycle(record, "uninstall", context);
			assert.equal(readInstallation(id, root).desiredState, "uninstalled");
			await assert.rejects(stat(paths.wrapper(record.name)), { code: "ENOENT" });
			assert.equal(await readFile(update.journal, "utf8"), journalBytes);
			assert.equal(await readFile(join(release, "VERSION"), "utf8"), `${record.releaseVersion}\n`);
		});
	}
});

test("#19 service launches as its recorded UID with process replacement and rejects root", async () => {
	const { context, calls } = await setup();
	await assert.rejects(dispatchAgent(id, "--service", [], context), /installation account/);
	await dispatchAgent(id, "--service", [], {
		...context,
		uid: 1001,
		async execApp(node, args) {
			calls.push([node, ...args]);
			return 0;
		},
	});
	assert.equal(calls[0][0], "/opt/trusted-release/runtime/bin/node");
	assert.equal(calls[0].at(-1), "serve");
	await assert.rejects(dispatchAgent(id, "agent", ["status"], { ...context, uid: 1002 }), /installation account/);
});

test("#20 explicit start restores running intent and failed readiness leaves it stopped and disabled", async () => {
	const { context, record, root, calls } = await setup();
	await lifecycle({ ...record, desiredState: "stopped" }, "start", context);
	assert.equal(readInstallation(id, root).desiredState, "running");
	assert.deepEqual(calls.slice(0, 2), [
		["systemctl", "show", "--property=ActiveState", "--value", installationPaths(id, root).unit],
		["systemctl", "enable", "--now", installationPaths(id, root).unit],
	]);
	await assert.rejects(
		lifecycle(record, "start", {
			...context,
			async ready() {
				throw new Error("not ready");
			},
		}),
		/not ready/,
	);
	assert.equal(readInstallation(id, root).desiredState, "stopped");
	assert.deepEqual(calls.at(-1), ["systemctl", "disable", "--now", installationPaths(id, root).unit]);
});

test("unit-off.8 named stop and start publish a service-readable record under umask 077", async () => {
	const { context, record, root, paths } = await setup();
	await writeFile(paths.environment, "UNIT_001_MODEL=faux/faux-1\n", { mode: 0o600 });
	const modes = [];
	const previousUmask = process.umask(0o077);
	try {
		await dispatchAgent(id, record.name, ["stop", "--yes"], context);
		assert.equal(readInstallation(id, root).desiredState, "stopped");
		modes.push((await stat(paths.record)).mode & 0o777);
		await dispatchAgent(id, record.name, ["start", "--yes"], {
			...context,
			async ready() {
				modes.push((await stat(paths.record)).mode & 0o777);
			},
		});
	} finally {
		process.umask(previousUmask);
	}
	assert.deepEqual(modes, [0o644, 0o644]);
	assert.equal(readInstallation(id, root).desiredState, "running");
	assert.equal((await stat(paths.environment)).mode & 0o777, 0o600);
});

// codex-10: a restrictive administrator umask must not cut operators off from the renamed command.
test("rename under umask 077 publishes a 0755 wrapper and keeps private files private", async () => {
	const { context, record, root, paths } = await setup();
	await writeAgentCommand(record, root);
	await writeFile(paths.environment, "UNIT_001_MODEL=faux/faux-1\n", { mode: 0o600 });
	const previousUmask = process.umask(0o077);
	try {
		await dispatchAgent(id, record.name, ["rename", "bob", "--yes"], context);
	} finally {
		process.umask(previousUmask);
	}
	assert.equal((await stat(paths.wrapper("bob"))).mode & 0o777, 0o755);
	assert.equal((await stat(paths.record)).mode & 0o777, 0o644);
	assert.equal((await stat(paths.environment)).mode & 0o777, 0o600);
	assert.equal(readInstallation(id, root).name, "bob");
});

test("#20 uninstall preserves unexpected helper bytes instead of recursively deleting them", async () => {
	const { context, record, root, paths } = await setup();
	const release = await software(record, root, paths);
	await writeFile(join(paths.management, "agent-command.mjs"), "unexpected");
	await assert.rejects(lifecycle(record, "uninstall", context), /unexpected management helper/);
	assert.equal(await readFile(join(paths.management, "agent-command.mjs"), "utf8"), "unexpected");
	assert.ok(await readFile(paths.wrapper(record.name)));
	assert.ok(await readFile(join(paths.current, "VERSION")));
	assert.equal(await readFile(join(release, "VERSION"), "utf8"), "0.0.1\n");
	// codex-11: the ownership refusal precedes any intent change.
	assert.equal(readInstallation(id, root).desiredState, "running");
});

test("#20 terminal EOF and nonterminal input decline confirmation without hanging", { timeout: 1000 }, async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	assert.equal(await confirmAction("stop? [y/N] ", input, output), false);
	input.isTTY = true;
	output.isTTY = true;
	const answer = confirmAction("stop? [y/N] ", input, output);
	input.end();
	assert.equal(await answer, false);
});

test("#19 foreground app receives configured provider/model without root loader or PATH injection", async () => {
	const { context, root, paths } = await setup();
	await writeFile(
		paths.environment,
		'OPENAI_API_KEY="configured key"\nANTHROPIC_OAUTH_TOKEN=oauth\nANTHROPIC_AUTH_TOKEN=auth\nUNIT_001_MODEL=openai/example\nNODE_OPTIONS=--import=/tmp/evil.mjs\nPATH=/tmp/evil\nUNIT_001_HOME=/tmp/other\n',
		{ mode: 0o600 },
	);
	const configured = await configuredEnvironment(paths.environment, root);
	assert.deepEqual(configured, {
		OPENAI_API_KEY: "configured key",
		ANTHROPIC_OAUTH_TOKEN: "oauth",
		ANTHROPIC_AUTH_TOKEN: "auth",
		UNIT_001_MODEL: "openai/example",
	});
	let forwarded;
	await dispatchAgent(id, "agent", ["status"], {
		...context,
		applicationEnvironment: (path) => configuredEnvironment(path, root),
		async run(_command, _args, _capture, env) {
			forwarded = env;
			return 0;
		},
	});
	assert.deepEqual(forwarded, configured);
});

test("#16 explicit start recovers an owned service after its configuration crash-loop hit the start limit", async () => {
	const { record, context, root, paths } = await setup();
	let limited = true;
	await lifecycle({ ...record, desiredState: "stopped" }, "start", {
		...context,
		async run(command, args) {
			assert.equal(command, "systemctl");
			if (args[0] === "show") return "failed\n";
			if (args[0] === "reset-failed") {
				assert.deepEqual(args, ["reset-failed", paths.unit]);
				limited = false;
			}
			if (args[0] === "enable" && limited) throw new Error("start-limit-hit");
			return 0;
		},
	});
	assert.equal(limited, false);
	assert.equal(readInstallation(id, root).desiredState, "running");
});

test("#16 first start skips reset for a cold inactive unit that systemd may unload", async () => {
	const { record, context, root, paths } = await setup();
	let loaded = false;
	await lifecycle({ ...record, desiredState: "stopped" }, "start", {
		...context,
		async run(_command, args, capture) {
			if (args[0] === "show") {
				assert.deepEqual(args, ["show", "--property=ActiveState", "--value", paths.unit]);
				assert.equal(capture, true);
				loaded = true;
				return "inactive\n";
			}
			if (args[0] === "reset-failed") throw new Error("Unit not loaded");
			return 0;
		},
	});
	assert.equal(loaded, true);
	assert.equal(readInstallation(id, root).desiredState, "running");
});

test("#16 reset failure still rejects start and restores stopped intent", async () => {
	const { record, context, root, paths, calls } = await setup();
	await assert.rejects(
		lifecycle(record, "start", {
			...context,
			async run(command, args) {
				calls.push([command, ...args]);
				if (args[0] === "show") return "failed\n";
				if (args[0] === "reset-failed") throw new Error("reset denied");
				return 0;
			},
		}),
		/reset denied/,
	);
	assert.equal(readInstallation(id, root).desiredState, "stopped");
	assert.equal(
		calls.some((call) => call[1] === "enable"),
		false,
	);
	assert.deepEqual(calls.at(-1), ["systemctl", "disable", "--now", paths.unit]);
});

test("#18 signed public installation configures updates automatically and starts its timer only with explicit agent start", async () => {
	const { record, root, paths, context, calls } = await setup();
	const release = await software(record, root, paths);
	const keys = join(root, "fixture-keys");
	generateRepositoryKeys(keys);
	writeUpdateBootstrap(release, join(keys, "root.json"));
	writeReleaseChecksums(release);
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
	assert.equal(bootstrapReleaseUpdates(record, release, root), true);
	const update = updatePaths(id, root),
		schedule = updateScheduling(record, root);
	assert.deepEqual(JSON.parse(await readFile(update.config)), {
		schemaVersion: 1,
		id,
		enabled: true,
		pin: null,
		repository: "francman/unit-001-releases",
		channel: "stable",
	});
	assert.equal((await stat(update.trustRoot)).mode & 0o022, 0);
	await assert.rejects(stat(update.token), { code: "ENOENT" });
	assert.equal(await readFile(schedule.timerPath, "utf8"), schedule.timerContents);
	assert.deepEqual(calls, []);
	await lifecycle({ ...record, desiredState: "stopped" }, "start", context);
	assert(calls.some((call) => call[0] === "systemctl" && call[1] === "enable" && call.includes(schedule.timerName)));
});

test("#18 failed update scheduling warns without stopping the healthy agent or reverting running intent", async () => {
	const { record, root, paths, context, calls } = await setup();
	const release = await software(record, root, paths),
		keys = join(root, "fixture-keys");
	generateRepositoryKeys(keys);
	writeUpdateBootstrap(release, join(keys, "root.json"));
	bootstrapReleaseUpdates(record, release, root);
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
	const schedule = updateScheduling(record, root),
		warnings = [];
	let ready = false;
	await lifecycle({ ...record, desiredState: "stopped" }, "start", {
		...context,
		async run(command, args) {
			calls.push([command, ...args]);
			if (args[0] === "show") return "inactive\n";
			if (args[0] === "enable" && args.includes(schedule.timerName)) throw new Error("timer permission failed");
			return 0;
		},
		async ready() {
			ready = true;
		},
		warn(message) {
			warnings.push(message);
		},
	});
	assert.equal(ready, true);
	assert.equal(readInstallation(id, root).desiredState, "running");
	assert.equal(
		calls.some((call) => call[1] === "disable" && call.includes(paths.unit)),
		false,
	);
	assert.match(warnings[0], /Agent is running.*timer permission failed/);
	assert.match(warnings[0], /sudo agent update status/);
});

test("#18 installing another public release never overwrites an existing private feed, pin, disabled policy or trust", async () => {
	const { record, root, paths } = await setup();
	const release = await software(record, root, paths);
	const keys = join(root, "fixture-keys");
	generateRepositoryKeys(keys);
	writeUpdateBootstrap(release, join(keys, "root.json"));
	const update = updatePaths(id, root);
	await mkdir(update.configDirectory, { recursive: true });
	const policy = JSON.stringify({
		schemaVersion: 1,
		id,
		enabled: false,
		pin: "0.0.1",
		repository: "francman/unit-001",
		channel: "stable",
	});
	await writeFile(update.config, policy, { mode: 0o600 });
	await writeFile(update.trustRoot, "previous-operator-trust", { mode: 0o600 });
	assert.equal(bootstrapReleaseUpdates(record, release, root), false);
	assert.equal(await readFile(update.config, "utf8"), policy);
	assert.equal(await readFile(update.trustRoot, "utf8"), "previous-operator-trust");
});

test("#18 unsigned development bundles do not silently enable updates", async () => {
	const { record, root, paths } = await setup();
	const release = await software(record, root, paths);
	assert.equal(bootstrapReleaseUpdates(record, release, root), false);
	await assert.rejects(stat(updatePaths(id, root).config), { code: "ENOENT" });
});

test("#18 an interrupted bundled bootstrap finishes without changing its trusted root", async () => {
	const { record, root, paths } = await setup();
	const release = await software(record, root, paths),
		keys = join(root, "fixture-keys");
	const bytes = generateRepositoryKeys(keys);
	writeUpdateBootstrap(release, join(keys, "root.json"));
	const update = updatePaths(id, root);
	await mkdir(update.configDirectory, { recursive: true });
	await writeFile(update.trustRoot, bytes, { mode: 0o644 });
	await writeFile(
		join(update.configDirectory, "bootstrap.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			rootSha256: createHash("sha256").update(bytes).digest("hex"),
			repository: "francman/unit-001-releases",
			channel: "stable",
		})}\n`,
		{ mode: 0o600 },
	);
	assert.equal(bootstrapReleaseUpdates(record, release, root), true);
	assert.equal(JSON.parse(await readFile(update.config)).enabled, true);
	assert.deepEqual(await readFile(update.trustRoot), bytes);
	await assert.rejects(stat(join(update.configDirectory, "bootstrap.json")), { code: "ENOENT" });
});

test("#18 partial operator trust without an installer receipt is preserved", async () => {
	const { record, root, paths } = await setup();
	const release = await software(record, root, paths),
		keys = join(root, "fixture-keys");
	generateRepositoryKeys(keys);
	writeUpdateBootstrap(release, join(keys, "root.json"));
	const update = updatePaths(id, root);
	await mkdir(update.configDirectory, { recursive: true });
	await writeFile(update.trustRoot, "operator-managed-root", { mode: 0o600 });
	assert.equal(bootstrapReleaseUpdates(record, release, root), false);
	assert.equal(await readFile(update.trustRoot, "utf8"), "operator-managed-root");
	await assert.rejects(stat(update.config), { code: "ENOENT" });
});
