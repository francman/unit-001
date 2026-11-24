// #16: Activation recovers failed units without resetting cold or intentionally stopped installations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const activation = fileURLToPath(new URL("../deploy/activate.sh", import.meta.url));
const id = "11111111-1111-4111-8111-111111111111";
const unit = `unit-001@${id}.service`;

for (const mode of [
	"failed",
	"inactive",
	"reset-failure",
	"stopped",
	"web-quiesce",
	"web-quiesce-failure",
	"rollback-success",
	"rollback-pointer-failure",
	"rollback-reload-failure",
]) {
	// #23: Upgrade recovery must clear failure limits without racing cold-unit garbage collection.
	test(`#16 activation handles ${mode} service state`, { skip: process.platform === "win32" }, async () => {
		const root = await mkdtemp(join(tmpdir(), "unit-activation-"));
		try {
			const prefix = join(root, "opt/unit-001/agents", id);
			const config = join(root, "etc/unit-001/agents", id);
			const management = join(root, "usr/lib/unit-001/agents", id);
			const release = join(root, "opt/unit-001/releases/0.0.2");
			const plan = join(root, "plan");
			const commands = join(root, "commands");
			const log = join(root, "commands.log");
			const files = {
				[join(config, "installation.json")]: "old record",
				[join(root, "usr/local/bin/agent")]: "old command",
				[join(root, "etc/systemd/system", unit)]: "old unit",
				[join(management, "lifecycle.mjs")]: "old helper",
				[join(plan, "record.json")]: "new record",
				[join(plan, "command")]: "new command",
				[join(plan, "unit")]: "new unit",
				[join(release, "runtime/bin/node")]: `#!/bin/sh
if [ "$2" = web-quiesce ]; then
  printf 'web-quiesce %s\\n' "$(readlink "$ACTIVATION_CURRENT")" >> "$ACTIVATION_LOG"
  [ "$ACTIVATION_MODE" != web-quiesce-failure ] || exit 51
else
  printf 'ready\\n' >> "$ACTIVATION_LOG"
  case "$ACTIVATION_MODE" in rollback-*) exit 52;; esac
fi
`,
				[join(commands, "mv")]: `#!/bin/sh
if [ "$ACTIVATION_MODE" = rollback-pointer-failure ]; then
  for arg do
    case "$arg" in
      "$ACTIVATION_CURRENT".next.*)
        [ "$(readlink "$arg")" != ../../releases/0.0.1 ] || exit 53;;
    esac
  done
fi
exec /bin/mv "$@"
`,
				[join(commands, "systemctl")]: `#!/bin/sh
printf '%s\\n' "$*" >> "$ACTIVATION_LOG"
case "$1" in
  is-active|is-enabled) case "$ACTIVATION_MODE" in rollback-*) exit 0;; *) exit 1;; esac;;
  daemon-reload)
    if [ "$ACTIVATION_MODE" = rollback-reload-failure ]; then
      [ "$(readlink "$ACTIVATION_CURRENT")" != ../../releases/0.0.1 ] || exit 54
    fi;;
  show) if [ "$ACTIVATION_MODE" = inactive ]; then echo inactive; else echo failed; fi;;
  reset-failed)
    [ "$ACTIVATION_MODE" != reset-failure ] || exit 42
    [ "$ACTIVATION_MODE" != inactive ] || exit 43
    touch "$ACTIVATION_RESET";;
  start)
    if [ "$ACTIVATION_MODE" = failed ]; then [ -f "$ACTIVATION_RESET" ] || exit 44; fi;;
esac
`,
			};
			if (mode.startsWith("web-quiesce")) files[join(config, "web-activation.json")] = "{}";
			for (const module of ["installation.mjs", "agent-command.mjs", "lifecycle.mjs", "update-activation.mjs"])
				files[join(release, "deploy", module)] = `new ${module}`;
			for (const [path, text] of Object.entries(files)) {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, text);
			}
			await mkdir(prefix, { recursive: true });
			await symlink("../../releases/0.0.1", join(prefix, "current"));
			await chmod(join(commands, "systemctl"), 0o755);
			await chmod(join(commands, "mv"), 0o755);
			await chmod(join(release, "runtime/bin/node"), 0o755);
			const result = spawnSync(
				"bash",
				[
					activation,
					root,
					id,
					"0.0.2",
					"agent",
					mode === "stopped" ? "stopped" : "running",
					plan,
					"1000",
					"manage",
				],
				{
					encoding: "utf8",
					timeout: 5000,
					env: {
						...process.env,
						PATH: `${commands}:${process.env.PATH}`,
						ACTIVATION_LOG: log,
						ACTIVATION_MODE: mode,
						ACTIVATION_RESET: join(root, "reset"),
						ACTIVATION_CURRENT: join(prefix, "current"),
					},
				},
			);
			const calls = (await readFile(log, "utf8")).trim().split("\n");
			// codex-2: A failed restore keeps the named installation's original files and selector.
			if (mode.startsWith("rollback-")) {
				assert.equal(result.status, 52, result.stderr);
				const retained = (await readdir(config)).filter((entry) => entry.startsWith(".activation-backup."));
				const restored = mode === "rollback-success";
				assert.equal(retained.length, restored ? 0 : 1, result.stderr);
				if (!restored) {
					const backup = join(config, retained[0]);
					assert.ok(result.stderr.includes(backup));
					assert.equal((await stat(backup)).mode & 0o777, 0o700);
					assert.equal(await readFile(join(backup, "current"), "utf8"), "../../releases/0.0.1\n");
					assert.equal(await readFile(join(backup, "record"), "utf8"), "old record");
					assert.equal(await readFile(join(backup, "command"), "utf8"), "old command");
					assert.equal(await readFile(join(backup, "unit"), "utf8"), "old unit");
					assert.equal(await readFile(join(backup, "management/lifecycle.mjs"), "utf8"), "old helper");
				}
				const pointerFailed = mode === "rollback-pointer-failure";
				assert.equal(await readlink(join(prefix, "current")), `../../releases/0.0.${pointerFailed ? 2 : 1}`);
				assert.equal(
					await readFile(join(config, "installation.json"), "utf8"),
					pointerFailed ? "new record" : "old record",
				);
				assert.ok(calls.indexOf("ready") < calls.lastIndexOf(`stop ${unit}`));
				assert.equal(calls.filter((call) => call === `start ${unit}`).length, restored ? 2 : 1);
				assert.equal(calls.filter((call) => call === `enable ${unit}`).length, restored ? 2 : 1);
				return;
			}
			assert.ok(!(await readdir(config)).some((entry) => entry.startsWith(".activation-backup.")));
			assert.equal(result.status, mode === "web-quiesce-failure" ? 51 : mode === "reset-failure" ? 42 : 0, result.stderr);
			if (mode.startsWith("web-quiesce")) {
				assert.ok(calls.includes("web-quiesce ../../releases/0.0.1"));
				assert.ok(calls.indexOf(`stop ${unit}`) < calls.indexOf("web-quiesce ../../releases/0.0.1"));
			}
			if (mode === "reset-failure" || mode === "web-quiesce-failure") {
				assert.equal(await readlink(join(prefix, "current")), "../../releases/0.0.1");
				assert.equal(await readFile(join(config, "installation.json"), "utf8"), "old record");
				assert.equal(await readFile(join(management, "lifecycle.mjs"), "utf8"), "old helper");
				assert.ok(!calls.includes(`start ${unit}`));
				assert.ok(!calls.includes("ready"));
			} else {
				assert.equal(await readlink(join(prefix, "current")), "../../releases/0.0.2");
				assert.equal(calls.includes(`reset-failed ${unit}`), ["failed", "web-quiesce"].includes(mode));
				assert.equal(calls.includes(`start ${unit}`), mode !== "stopped");
				assert.equal(calls.includes("ready"), mode !== "stopped");
				if (mode === "stopped") assert.ok(!calls.some((call) => call.startsWith("show ")));
				if (mode === "failed") assert.ok(calls.indexOf(`reset-failed ${unit}`) < calls.indexOf(`start ${unit}`));
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
