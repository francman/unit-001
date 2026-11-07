// Exercises named release installation in filesystem images without host accounts or systemd mutations.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Record {
	schemaVersion: number;
	id: string;
	name: string;
	account: string;
	releaseVersion: string;
	desiredState: string;
}

const deployment = fileURLToPath(new URL("../deploy/", import.meta.url));
let temporary: string;
beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "unit-named-deploy-"));
});
afterEach(() => rm(temporary, { recursive: true, force: true }));

async function release(version: string) {
	const directory = join(temporary, `release-${version}`);
	const node = process.execPath.replaceAll("'", "'\\''");
	const files: { [path: string]: string } = {
		VERSION: `${version}\n`,
		"runtime/bin/node": `#!/bin/sh\nexec '${node}' "$@"\n`,
		"app/dist/bin.js": "console.log('fixture');\n",
		"app/dist/named.js": "console.log('named fixture');\n",
		"app/package.json": '{"name":"unit-001"}\n',
		"bin/agent": "#!/bin/sh\nexit 98\n",
		"install.sh": await readFile(join(deployment, "install.sh"), "utf8"),
	};
	for (const name of [
		"installation.mjs",
		"agent-command.mjs",
		"lifecycle.mjs",
		"activate.sh",
		"check-ready.mjs",
		"unit-001.service",
	])
		files[`deploy/${name}`] = await readFile(join(deployment, name), "utf8");
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(directory, path)), { recursive: true });
		await writeFile(join(directory, path), content);
	}
	await writeFile(
		join(directory, "SHA256SUMS"),
		Object.entries(files)
			.map(([path, content]) => `${createHash("sha256").update(content).digest("hex")}  ./${path}\n`)
			.sort()
			.join(""),
	);
	return directory;
}

function install(directory: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
	return spawnSync("bash", [join(directory, "install.sh"), ...args], { encoding: "utf8", env, timeout: 15_000 });
}

async function records(root: string): Promise<Record[]> {
	const directory = join(root, "etc/unit-001/agents");
	const ids = await readdir(directory);
	return Promise.all(
		ids.map(async (id) => JSON.parse(await readFile(join(directory, id, "installation.json"), "utf8")) as Record),
	);
}

describe.skipIf(process.platform === "win32")("named Linux installation", () => {
	it("shows help and verifies a release without installing", async () => {
		expect(install(deployment, ["--help"]).stdout).toContain("--name NAME");
		const directory = await release("0.0.1");
		const result = install(directory, ["--dry-run"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Plan: install command agent");
	});

	it("installs default agent and custom bob with separate identities and one shared immutable release", async () => {
		// #19: command identity and state ownership must never be shared merely because release bytes are shared.
		const root = join(temporary, "image");
		const directory = await release("0.0.1");
		const commands = join(temporary, "commands");
		await mkdir(commands);
		for (const command of ["systemctl", "useradd", "chown"]) {
			await writeFile(join(commands, command), "#!/bin/sh\necho 'Host mutation attempted' >&2\nexit 91\n");
			await chmod(join(commands, command), 0o755);
		}
		const env = { ...process.env, PATH: `${commands}:${process.env.PATH}` };
		const first = install(directory, ["--root", root], env);
		expect(first.status, first.stderr).toBe(0);
		const second = install(directory, ["--root", root, "--name", "bob"], env);
		expect(second.status, second.stderr).toBe(0);
		const installed = await records(root);
		expect(installed.map(({ name }) => name).sort()).toEqual(["agent", "bob"]);
		expect(new Set(installed.map(({ id }) => id)).size).toBe(2);
		expect(new Set(installed.map(({ account }) => account)).size).toBe(2);
		for (const record of installed) {
			expect(record.account.length).toBeLessThanOrEqual(32);
			expect(record.desiredState).toBe("stopped");
			expect(await readlink(join(root, "opt/unit-001/agents", record.id, "current"))).toBe("../../releases/0.0.1");
			const command = await readFile(join(root, "usr/local/bin", record.name), "utf8");
			expect(command).toContain(`${record.id}' '${record.name}'`);
			expect(command).toContain("unset NODE_OPTIONS NODE_PATH");
			expect(await readFile(join(root, "etc/systemd/system", `unit-001@${record.id}.service`), "utf8")).toContain(
				`User=${record.account}`,
			);
			expect((await stat(join(root, "var/lib/unit-001/agents", record.id))).mode & 0o777).toBe(0o700);
			expect(await readFile(join(root, "usr/lib/unit-001/agents", record.id, "installation.mjs"), "utf8")).toContain(
				"readInstallation",
			);
		}
		expect(await readdir(join(root, "opt/unit-001/releases"))).toEqual(["0.0.1"]);
		await expect(stat(join(root, "usr/local/bin/u1"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("upgrades only the selected name and preserves credentials, workspace, UUID, and stopped intent", async () => {
		const root = join(temporary, "image");
		const first = await release("0.0.1");
		expect(install(first, ["--root", root, "--name", "bob"]).status).toBe(0);
		expect(install(first, ["--root", root]).status).toBe(0);
		const bob = (await records(root)).find(({ name }) => name === "bob")!;
		const agent = (await records(root)).find(({ name }) => name === "agent")!;
		const state = join(root, "var/lib/unit-001/agents", bob.id);
		const config = join(root, "etc/unit-001/agents", bob.id);
		await writeFile(join(state, "auth.json"), "credentials\n");
		await writeFile(join(state, "workspace/file.txt"), "work\n");
		await writeFile(join(config, "environment"), "UNIT_001_MODEL=faux/faux-1\n");
		const second = await release("0.0.2");
		const result = install(second, ["--root", root, "--name", "bob"]);
		expect(result.status, result.stderr).toBe(0);
		expect((await records(root)).find(({ name }) => name === "bob")).toEqual({ ...bob, releaseVersion: "0.0.2" });
		expect(await readlink(join(root, "opt/unit-001/agents", agent.id, "current"))).toBe("../../releases/0.0.1");
		expect(await readFile(join(state, "auth.json"), "utf8")).toBe("credentials\n");
		expect(await readFile(join(state, "workspace/file.txt"), "utf8")).toBe("work\n");
		expect(await readFile(join(config, "environment"), "utf8")).toBe("UNIT_001_MODEL=faux/faux-1\n");
		expect(install(second, ["--root", root, "--name", "bob"]).status).toBe(0);
	});

	it.each(["../bob", "Bob", "--bob", "a b", "bob;sh", "x".repeat(33)])(
		"rejects invalid name %s without creating an image",
		async (name) => {
			const directory = await release("0.0.1");
			const root = join(temporary, "image");
			const result = install(directory, ["--root", root, "--name", name]);
			expect(result.status).not.toBe(0);
			await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.each(["etc", "var", "opt", "usr", "run", "etc/unit-001", "var/lib/unit-001/agents"])(
		"rejects staging symlink %s before image mutations",
		async (path) => {
			const directory = await release("0.0.1");
			const root = join(temporary, "image");
			const outside = join(temporary, "outside");
			await mkdir(dirname(join(root, path)), { recursive: true });
			await mkdir(outside);
			await writeFile(join(outside, "sentinel"), "unchanged");
			await symlink(outside, join(root, path));
			const result = install(directory, ["--root", root]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Unsafe installation path");
			expect(await readdir(outside)).toEqual(["sentinel"]);
			await expect(stat(join(root, "opt/unit-001/releases"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.each(["usr/local/bin", "usr/bin", "usr/local/sbin"])(
		"preserves command collisions in %s before software changes",
		async (path) => {
			const directory = await release("0.0.1");
			const root = join(temporary, "image");
			await mkdir(join(root, path), { recursive: true });
			await writeFile(join(root, path, "agent"), "foreign command");
			const result = install(directory, ["--root", root]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("collides with an existing path");
			expect(await readFile(join(root, path, "agent"), "utf8")).toBe("foreign command");
			await expect(stat(join(root, "opt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("rejects altered payloads and unknown release files before creating an image", async () => {
		const directory = await release("0.0.1");
		const root = join(temporary, "image");
		await writeFile(join(directory, "runtime/bin/node"), "changed");
		expect(install(directory, ["--root", root]).stderr).toContain("checksum verification failed");
		await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
		await writeFile(join(directory, "extra.js"), "unlisted");
		expect(install(directory, ["--dry-run"]).stderr).toContain("inventory differs");
	});

	it.each([
		"healthy",
		"inactive-running",
		"stopped",
		"never-ready",
		"wrong-version",
		"wrong-id",
		"wrong-pid",
		"service-start",
		"pointer-switch",
		"stop-failure",
	])("activates only the intended ready agent and handles %s", async (mode) => {
		const root = join(temporary, "image");
		const first = await release("0.0.1");
		expect(install(first, ["--root", root, "--name", "bob"]).status).toBe(0);
		const bob = (await records(root))[0];
		bob.desiredState = mode === "stopped" ? "stopped" : "running";
		const recordPath = join(root, "etc/unit-001/agents", bob.id, "installation.json");
		await writeFile(recordPath, JSON.stringify(bob));
		const candidate = await release("0.0.2");
		await cp(candidate, join(root, "opt/unit-001/releases/0.0.2"), { recursive: true });
		await chmod(join(root, "opt/unit-001/releases/0.0.2/runtime/bin/node"), 0o755);
		const plan = join(temporary, "plan");
		await mkdir(plan);
		await writeFile(join(plan, "record.json"), JSON.stringify({ ...bob, releaseVersion: "0.0.2" }));
		await writeFile(join(plan, "command"), await readFile(join(root, "usr/local/bin/bob")));
		await writeFile(
			join(plan, "unit"),
			await readFile(join(root, "etc/systemd/system", `unit-001@${bob.id}.service`)),
		);
		const commands = join(temporary, "commands");
		const log = join(temporary, "commands.log");
		await mkdir(commands);
		await writeFile(
			join(commands, "systemctl"),
			'#!/bin/sh\nprintf "%s %s\\n" "$*" "$(readlink "$UNIT_DEPLOY_POINTER")" >> "$UNIT_DEPLOY_LOG"\n' +
				'case "$1" in\nshow) echo 12345; exit 0;;\nis-enabled) exit 1;;\nis-active) case "$UNIT_DEPLOY_MODE" in inactive-running|stopped) exit 1;; esac;;\n' +
				'stop) if [ "$UNIT_DEPLOY_MODE" = stop-failure ] && [ "$(readlink "$UNIT_DEPLOY_POINTER")" = ../../releases/0.0.2 ]; then exit 51; fi;;\n' +
				'start) if [ "$UNIT_DEPLOY_MODE" = service-start ] && [ "$(readlink "$UNIT_DEPLOY_POINTER")" = ../../releases/0.0.2 ]; then exit 42; fi;;\nesac\nexit 0\n',
		);
		await writeFile(
			join(commands, "runuser"),
			'#!/bin/sh\nprintf "runuser %s\\n" "$*" >> "$UNIT_DEPLOY_LOG"\n' +
				'case "$UNIT_DEPLOY_MODE" in\nnever-ready) exec sleep 10;;\nwrong-version|stop-failure) version=0.0.1;;\n*) version=0.0.2;;\nesac\n' +
				'id="$UNIT_DEPLOY_ID"; pid=12345\nif [ "$UNIT_DEPLOY_MODE" = wrong-id ]; then id=other; fi\nif [ "$UNIT_DEPLOY_MODE" = wrong-pid ]; then pid=99999; fi\n' +
				'printf \'{"type":"status","installationId":"%s","version":"%s","pid":%s,"busy":false}\\n\' "$id" "$version" "$pid"\n',
		);
		await writeFile(
			join(commands, "ln"),
			'#!/bin/sh\nif [ "$UNIT_DEPLOY_MODE" = pointer-switch ] && [ "$3" = ../../releases/0.0.2 ]; then exit 42; fi\nexec /bin/ln "$@"\n',
		);
		for (const command of ["systemctl", "runuser", "ln"]) await chmod(join(commands, command), 0o755);
		const result = spawnSync(
			"bash",
			[join(deployment, "activate.sh"), root, bob.id, "0.0.2", "bob", bob.desiredState, plan, "1000", "manage"],
			{
				encoding: "utf8",
				timeout: 5_000,
				env: {
					...process.env,
					PATH: `${commands}:${process.env.PATH}`,
					UNIT_DEPLOY_MODE: mode,
					UNIT_DEPLOY_ID: bob.id,
					UNIT_DEPLOY_LOG: log,
					UNIT_DEPLOY_POINTER: join(root, "opt/unit-001/agents", bob.id, "current"),
				},
			},
		);
		const calls = await readFile(log, "utf8");
		const success = ["healthy", "inactive-running", "stopped"].includes(mode);
		expect(result.status, result.stderr).toBe(
			success ? 0 : ["service-start", "pointer-switch"].includes(mode) ? 42 : 1,
		);
		if (mode === "stop-failure") {
			expect(await readlink(join(root, "opt/unit-001/agents", bob.id, "current"))).toBe("../../releases/0.0.2");
			expect((await records(root))[0].releaseVersion).toBe("0.0.2");
			expect(result.stderr).toContain("cannot stop candidate");
			const backup = /Recovery backup: (.+)/.exec(result.stderr)?.[1];
			expect(backup).toBeDefined();
			if (backup) await rm(backup, { recursive: true, force: true });
			return;
		}
		expect(await readlink(join(root, "opt/unit-001/agents", bob.id, "current"))).toBe(
			success ? "../../releases/0.0.2" : "../../releases/0.0.1",
		);
		if (success) {
			if (mode === "stopped") expect(calls).not.toContain("start unit-001@");
			else expect(calls).toContain(`start unit-001@${bob.id}.service`);
		} else {
			expect((await records(root))[0]).toEqual(bob);
			expect(calls).toContain(`disable unit-001@${bob.id}.service`);
			expect(calls.trim().endsWith(`start unit-001@${bob.id}.service ../../releases/0.0.1`)).toBe(true);
		}
	});
});
