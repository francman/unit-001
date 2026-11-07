// #16: Activation recovers failed units without resetting cold or intentionally stopped installations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const activation = fileURLToPath(new URL("../deploy/activate.sh", import.meta.url));
const id = "11111111-1111-4111-8111-111111111111";
const unit = `unit-001@${id}.service`;

for (const mode of ["failed", "inactive", "reset-failure", "stopped"]) {
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
				[join(release, "runtime/bin/node")]: "#!/bin/sh\nprintf 'ready\\n' >> \"$ACTIVATION_LOG\"\n",
				[join(commands, "systemctl")]: `#!/bin/sh
printf '%s\\n' "$*" >> "$ACTIVATION_LOG"
case "$1" in
  is-active|is-enabled) exit 1;;
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
			for (const module of ["installation.mjs", "agent-command.mjs", "lifecycle.mjs"])
				files[join(release, "deploy", module)] = `new ${module}`;
			for (const [path, text] of Object.entries(files)) {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, text);
			}
			await mkdir(prefix, { recursive: true });
			await symlink("../../releases/0.0.1", join(prefix, "current"));
			await chmod(join(commands, "systemctl"), 0o755);
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
					},
				},
			);
			const calls = (await readFile(log, "utf8")).trim().split("\n");
			assert.equal(result.status, mode === "reset-failure" ? 42 : 0, result.stderr);
			if (mode === "reset-failure") {
				assert.equal(await readlink(join(prefix, "current")), "../../releases/0.0.1");
				assert.equal(await readFile(join(config, "installation.json"), "utf8"), "old record");
				assert.equal(await readFile(join(management, "lifecycle.mjs"), "utf8"), "old helper");
				assert.ok(!calls.includes(`start ${unit}`));
				assert.ok(!calls.includes("ready"));
			} else {
				assert.equal(await readlink(join(prefix, "current")), "../../releases/0.0.2");
				assert.equal(calls.includes(`reset-failed ${unit}`), mode === "failed");
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
