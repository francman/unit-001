#!/usr/bin/env node
import { main, processRuntime } from "./cli.ts";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());

process.exitCode = await main(process.argv.slice(2), processRuntime(), controller.signal);
