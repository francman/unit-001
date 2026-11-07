#!/usr/bin/env node
// Checks the candidate's local control response against its expected version and systemd owner within one deadline.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { installationPaths, readInstallation } from "./installation.mjs";

const [root, id, version, duration] = process.argv.slice(2);
const timeoutMs = Number(duration);
if (root === undefined || !version || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
	throw new Error("Expected installation root, release version, and readiness timeout (1–30000 ms).");
}
const deadline = performance.now() + timeoutMs;
const filesystem = root || "/";
const paths = installationPaths(id, filesystem);
const record = readInstallation(id, filesystem);
let failure = "The candidate has not advertised readiness.";
while (performance.now() < deadline) {
	try {
		const run = (command, args) => {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new Error("Readiness deadline expired.");
			return execFileSync(command, args, {
				encoding: "utf8",
				timeout: Math.max(1, Math.floor(Math.min(2_000, remaining))),
				killSignal: "SIGKILL",
				maxBuffer: 16_384,
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		};
		const owner = run("systemctl", ["show", "--property=MainPID", "--value", paths.unit]);
		if (!/^[1-9][0-9]*$/.test(owner)) throw new Error("systemd reports no running candidate owner.");
		const remaining = Math.min(1_500, deadline - performance.now());
		const wire = run("runuser", [
			"-u",
			record.account,
			"--",
			"timeout",
			"--signal=KILL",
			`${remaining / 1_000}s`,
			join(paths.current, "runtime/bin/node"),
			join(paths.management, "agent-command.mjs"),
			id,
			record.name,
			"service-status",
		]);
		const response = JSON.parse(wire);
		if (
			response?.type !== "status" ||
			response.installationId !== id ||
			response.version !== version ||
			response.pid !== Number(owner)
		) {
			throw new Error("The control socket does not report the expected candidate version and owner.");
		}
		if (run("systemctl", ["show", "--property=MainPID", "--value", paths.unit]) !== owner) {
			throw new Error("The candidate restarted during its readiness check.");
		}
		console.log(`Ready: unit-001 ${version}, PID ${owner}.`);
		process.exit(0);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const remaining = deadline - performance.now();
	if (remaining > 0) await setTimeout(Math.min(200, remaining));
}
console.error(`unit-001 install: candidate readiness failed: ${failure}`);
process.exitCode = 1;
