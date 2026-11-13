// #14: Runs the real unconfigured owner; no provider or network is available to mission formation.
import { main, processRuntime } from "../../dist/cli.js";

globalThis.fetch = async () => {
	throw new Error("Network is forbidden in mission terminal acceptance");
};
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
process.exitCode = await main([], processRuntime(), controller.signal);
