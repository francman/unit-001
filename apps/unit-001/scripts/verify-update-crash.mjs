#!/usr/bin/env node
// Kills an actual activation only at its durable candidate boundary on the disposable native acceptance host.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { readInstallation, trustedFile } from "../deploy/installation.mjs";
import { activateUpdate, createUpdateContext } from "../deploy/update-activation.mjs";

if (
	process.platform !== "linux" ||
	process.arch !== "x64" ||
	process.getuid() !== 0 ||
	process.env.GITHUB_ACTIONS !== "true" ||
	process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
	process.env.UNIT_001_DISPOSABLE_CI !== "1" ||
	execFileSync("ps", ["-p", "1", "-o", "comm="], { encoding: "utf8" }).trim() !== "systemd"
)
	throw new Error("Requires explicit disposable GitHub-hosted Ubuntu/systemd acceptance authorization.");

const [id, candidateFile] = process.argv.slice(2);
trustedFile(candidateFile, "/");
if (lstatSync(candidateFile).size > 16384) throw new Error("Unexpected crash fixture size.");
const candidate = JSON.parse(readFileSync(candidateFile));
const record = readInstallation(id);
if (record.desiredState !== "running") throw new Error("Crash acceptance requires an explicitly running installation.");
await activateUpdate(record, candidate, {
	...createUpdateContext(),
	fault(phase) {
		if (phase === "candidate") process.kill(process.pid, "SIGKILL");
	},
});
throw new Error("Candidate crash boundary was not reached.");
