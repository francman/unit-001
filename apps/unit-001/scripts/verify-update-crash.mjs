#!/usr/bin/env node
// Kills an actual activation only at its durable candidate boundary on the disposable native acceptance host.
import { lstatSync, readFileSync } from "node:fs";
import { readInstallation, trustedFile } from "../deploy/installation.mjs";
import { activateUpdate, createUpdateContext } from "../deploy/update-activation.mjs";
import { requireDisposableHost } from "./disposable-host.mjs";

requireDisposableHost();

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
