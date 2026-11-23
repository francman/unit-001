#!/usr/bin/env node
import { main, processRuntime } from "./cli.ts";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
// SSH can close the terminal without delivering Ctrl+C. Only the web workspace detaches cleanly on hangup, as in named.ts.
if (process.argv[2] === "web") process.once("SIGHUP", () => controller.abort());

process.exitCode = await main(process.argv.slice(2), processRuntime(), controller.signal);
