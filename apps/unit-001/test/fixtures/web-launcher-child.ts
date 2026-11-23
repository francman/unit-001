// Runs the current or the 0.0.17 managed web launcher in its own process, so tests can kill it abruptly.
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { runWebWorkspace as runCurrent } from "../../src/web/launcher.ts";
import { runWebWorkspace as runLegacy } from "./web-launcher-0.0.17.ts";

const [variant, home, installationId, endpoint] = process.argv.slice(2);
if (!home || !installationId || !endpoint || (variant !== "current" && variant !== "legacy"))
	throw new Error("Usage: web-launcher-child.ts current|legacy <home> <installation-id> <owner-endpoint>");
const account = os.userInfo();
const readFile = fsPromises.readFile;
// A child process cannot use vitest mocks: point the account home at the fixture and serve fixed assets.
os.userInfo = (() => ({ ...account, homedir: home })) as typeof os.userInfo;
fsPromises.readFile = ((path: Parameters<typeof readFile>[0], options?: Parameters<typeof readFile>[1]) =>
	path instanceof URL && path.pathname.includes("/web-dist/")
		? Promise.resolve(Buffer.from("workspace fixture"))
		: readFile(path, options)) as typeof readFile;
syncBuiltinESMExports();
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
const run = variant === "current" ? runCurrent : runLegacy;
try {
	const code = await run(endpoint, 4317, (text) => process.stdout.write(text), controller.signal, installationId);
	process.stdout.write(`EXIT ${code}\n`);
} catch (error) {
	process.stdout.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
