// #56: Channel authority stays root-only and executes only the fixed module in the selected verified release.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { dispatchAgent } from "../deploy/agent-command.mjs";
import { installationPaths, withManagementLock, writeInstallation } from "../deploy/installation.mjs";
import { updatePaths } from "../deploy/update-activation.mjs";

const execFileAsync = promisify(execFile);

const temporary = [];
afterEach(async () => {
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(uid = 0) {
	const root = await mkdtemp(join(tmpdir(), "unit-channel-dispatch-"));
	temporary.push(root);
	const record = {
		schemaVersion: 1,
		id: "11111111-1111-4111-8111-111111111111",
		name: "agent",
		account: "ua-111111111111411181111111",
		releaseVersion: "0.0.7",
		desiredState: "running",
	};
	await mkdir(installationPaths(record.id, root).config, { recursive: true });
	writeInstallation(record, root);
	const calls = [];
	return {
		record,
		calls,
		context: {
			root,
			uid,
			administratorOrigin: { SUDO_UID: "2001", SUDO_USER: "creator" },
			async release() {
				return "/opt/verified-release";
			},
			async account() {
				assert.fail("Channel metadata issuer must not initialize the owner account");
			},
			async applicationEnvironment() {
				assert.fail("Channel metadata issuer must not inherit model-provider credentials");
			},
			async run(...arguments_) {
				calls.push(arguments_);
				return 0;
			},
		},
	};
}

test("#56 executes the selected-release channel issuer with a fixed installation identity", async () => {
	const { record, calls, context } = await fixture();
	await dispatchAgent(record.id, record.name, ["channels", "policy", "--file", "/private/policy.json"], context);
	assert.deepEqual(calls, [
		[
			"/opt/verified-release/runtime/bin/node",
			[
				join("/opt/verified-release", "deploy/channels.mjs"),
				"policy",
				"--file",
				"/private/policy.json",
				"--id",
				record.id,
			],
			false,
			{ SUDO_UID: "2001", SUDO_USER: "creator" },
		],
	]);
});

test("#56 rejects unprivileged changes and caller-selected installation IDs before running an issuer", async () => {
	const operator = await fixture(2001);
	for (const action of ["policy", "approve", "revoke", "telegram-bootstrap"])
		await assert.rejects(
			dispatchAgent(operator.record.id, "agent", ["channels", action], operator.context),
			/host administrator/,
		);
	assert.deepEqual(operator.calls, []);
	const administrator = await fixture();
	for (const override of [["--id", "other"], ["--id=other"]])
		await assert.rejects(
			dispatchAgent(administrator.record.id, "agent", ["channels", "approve", ...override], administrator.context),
			/installation identity/,
		);
	assert.deepEqual(administrator.calls, []);
});

for (const [issuer, success] of [
	["channels", "channel-disabled"],
	["mission", "creator-configured"],
]) {
	test(`${issuer} issuer requires the executing release to match selection under the management lock`, async () => {
		const { record, context } = await fixture();
		const root = await realpath(context.root);
		const { current } = installationPaths(record.id, root);
		const next = { ...record, releaseVersion: "0.0.8" };
		const filename = `${issuer}.mjs`;
		const oldRelease = join(root, "opt/unit-001/releases", record.releaseVersion);
		const nextRelease = join(root, "opt/unit-001/releases", next.releaseVersion);
		for (const release of [oldRelease, nextRelease])
			await cp(new URL("../deploy/", import.meta.url), join(release, "deploy"), { recursive: true });
		// The installed helper must also load from the shipped deploy layout without the test preload.
		await execFileAsync(process.execPath, [join(nextRelease, "deploy", "issuer-release.mjs")], { timeout: 5000 });
		await mkdir(dirname(current), { recursive: true });
		await symlink(`../../releases/${record.releaseVersion}`, current);
		const select = async (version) => {
			await symlink(`../../releases/${version}`, `${current}.next`);
			await rename(`${current}.next`, current);
		};
		const input = join(root, "creator.json");
		await writeFile(
			input,
			JSON.stringify({
				creator: { id: "creator", kind: "human", uid: 2001 },
				ceiling: {
					allowedTools: [],
					maxCycles: 1,
					maxRequests: 1,
					maxRetries: 0,
					maxConsecutiveNoProgress: 1,
					maxDurationMs: 1,
				},
			}),
			{ mode: 0o600 },
		);
		const args =
			issuer === "channels" ? [issuer, "revoke", "--channel", "fixture"] : [issuer, "creator", "--file", input];
		const preload = new URL("./fixtures/issuer-runtime.mjs", import.meta.url).href;
		const dispatch = (release, beforeEntry) =>
			dispatchAgent(record.id, record.name, args, {
				root,
				uid: 0,
				release: realpath,
				async run(runtime, childArgs) {
					assert.equal(runtime, join(release, "runtime/bin/node"));
					assert.equal(childArgs[0], join(release, "deploy", filename));
					assert.deepEqual(childArgs.slice(-2), ["--id", record.id]);
					await beforeEntry?.();
					return execFileAsync(process.execPath, ["--conditions=source", `--import=${preload}`, ...childArgs], {
						env: {
							PATH: process.env.PATH,
							SUDO_UID: String(process.getuid()),
							SUDO_USER: "fixture",
							UNIT_TEST_ISSUER_ROOT: root,
						},
						timeout: 5000,
					});
				},
			});
		const rejection = issuer === "channels" ? /Channel administration failed/ : /selected release changed/;
		await assert.rejects(
			dispatch(oldRelease, () =>
				withManagementLock(async () => {
					await select(next.releaseVersion);
					writeInstallation(next, root);
				}, root),
			),
			{ code: 1, stderr: rejection },
		);
		const effects = join(root, "authority-events");
		await assert.rejects(readFile(effects), { code: "ENOENT" });

		// The execution path still matches the record here, so only the locked selector check can refuse it.
		await assert.rejects(
			dispatch(nextRelease, () => withManagementLock(() => select(record.releaseVersion), root)),
			{ code: 1, stderr: rejection },
		);
		await withManagementLock(() => select(next.releaseVersion), root);
		await assert.rejects(readFile(effects), { code: "ENOENT" });

		const installedIssuer = join(nextRelease, "deploy", filename);
		await chmod(installedIssuer, 0o664);
		await assert.rejects(dispatch(nextRelease), {
			code: 1,
			stderr: issuer === "channels" ? rejection : /file is not owned and protected/,
		});
		await assert.rejects(readFile(effects), { code: "ENOENT" });
		await chmod(installedIssuer, 0o644);

		const { journal } = updatePaths(record.id, root);
		await mkdir(dirname(journal), { recursive: true });
		const update = { schemaVersion: 1, id: record.id, operationId: "fixture", phase: "candidate" };
		await writeFile(journal, JSON.stringify(update), { mode: 0o600 });
		await assert.rejects(dispatch(nextRelease), {
			code: 1,
			stderr: issuer === "channels" ? rejection : /Recover the incomplete update/,
		});
		await assert.rejects(readFile(effects), { code: "ENOENT" });

		await writeFile(journal, JSON.stringify({ ...update, phase: "complete" }));
		const { stdout } = await dispatch(nextRelease);
		assert.equal(JSON.parse(stdout).status, success);
		assert.equal(await readFile(effects, "utf8"), `read ${issuer}\nwrite ${issuer}\n`);
	});
}
