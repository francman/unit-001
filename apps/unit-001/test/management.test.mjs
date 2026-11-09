// Exercises named installation authority and lifecycle without changing the host's services.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { configuredEnvironment, confirmAction, dispatchAgent } from "../deploy/agent-command.mjs";
import {
	bootstrapReleaseUpdates,
	installationPaths,
	readInstallation,
	withManagementLock,
	writeAgentCommand,
	writeInstallation,
} from "../deploy/installation.mjs";
import { lifecycle, recoverRename } from "../deploy/lifecycle.mjs";
import { updatePaths, updateScheduling } from "../deploy/update-activation.mjs";
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
	const { context, calls } = await setup();
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
	const { record, context, paths } = await setup();
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

test("#20 uninstall preserves unexpected helper bytes instead of recursively deleting them", async () => {
	const { context, record, root, paths } = await setup();
	const release = await software(record, root, paths);
	await writeFile(join(paths.management, "agent-command.mjs"), "unexpected");
	await assert.rejects(lifecycle(record, "uninstall", context), /unexpected management helper/);
	assert.equal(await readFile(join(paths.management, "agent-command.mjs"), "utf8"), "unexpected");
	assert.ok(await readFile(paths.wrapper(record.name)));
	assert.ok(await readFile(join(paths.current, "VERSION")));
	assert.equal(await readFile(join(release, "VERSION"), "utf8"), "0.0.1\n");
	assert.equal(readInstallation(id, root).desiredState, "stopped");
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
