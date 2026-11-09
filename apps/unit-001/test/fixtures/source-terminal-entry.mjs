// Runs the actual foreground entry point with local state and networking disabled for terminal acceptance.
import { main, processRuntime } from "../../dist/cli.js";

globalThis.fetch = async () => {
	throw Error("Provider network calls are forbidden in terminal acceptance");
};
process.env.OPENAI_API_KEY = "dummy-never-dispatched";
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
process.exitCode = await main(
	process.argv[2] === "compete" ? ["--print", "must not be dispatched"] : [],
	processRuntime(),
	controller.signal,
);
