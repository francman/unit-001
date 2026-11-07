// Runs application commands under the installation account with a fixed identity and state directory.
import { dirname } from "node:path";
import { main, processRuntime } from "./cli.ts";

const [id, name, state, ...args] = process.argv.slice(2);
if (
	process.geteuid?.() === 0 ||
	id === undefined ||
	!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
	name === undefined ||
	!/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
	state !== `/var/lib/unit-001/agents/${id}`
) {
	process.stderr.write("Invalid named agent identity or account; use the installed agent command.\n");
	process.exitCode = 1;
} else {
	process.chdir(`${state}/workspace`);
	// Tools use the bundled runtime even when the host has no Node installation.
	process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin"}`;
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
	process.exitCode = await main(args, { ...processRuntime(), managed: { id, name, state } }, controller.signal);
}
