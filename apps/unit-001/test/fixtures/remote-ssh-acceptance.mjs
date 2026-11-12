// Run inside remote-ssh.Dockerfile after bootstrap; uses real SSH, separate users, SQLite and the faux provider.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { connectRemoteClient } from "../../dist/remote/client.js";
import { discoverRemote } from "../../dist/remote/ssh.js";

const signal = new AbortController();
const clients = [];
const events = [];
const timeout = setTimeout(() => signal.abort(new Error("Acceptance deadline exceeded")), 45_000);
async function until(predicate) {
	const deadline = Date.now() + 12_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Acceptance assertion timed out");
		await delay(25, undefined, { signal: signal.signal });
	}
}
async function client(profile, session = "default") {
	const value = await connectRemoteClient(profile, session, signal.signal);
	clients.push(value);
	return value;
}
try {
	const discovered = await discoverRemote("remote-fixture", "agent", "default", signal.signal);
	const profile = { schema: 1, name: "fixture", ...discovered };
	const occupied = createServer();
	await new Promise((resolve) => occupied.listen(45555, "127.0.0.1", resolve));
	try {
		assert.equal(
			(await discoverRemote("remote-forward", "agent", "default", signal.signal)).installationId,
			profile.installationId,
		);
		await assert.rejects(
			connectRemoteClient({ ...profile, host: "remote-forward" }, "default", signal.signal),
			/without configured/,
		);
	} finally {
		await new Promise((resolve) => occupied.close(resolve));
	}
	const remote = await client(profile);
	assert.equal((await remote.request({ type: "status" }, signal.signal)).type, "status");
	const otherSession = await client(profile, "research");
	assert.equal(otherSession.session, "research@fixture");
	const answer = await remote.request(
		{ type: "send", prompt: "A deterministic answer", requestId: "first" },
		signal.signal,
	);
	assert.equal(answer.type, "reply");
	assert.equal(answer.reply.text, "Remote faux answer received.");
	const memory = await remote.request(
		{ type: "memory", request: { operation: "remember", content: "SSH fixture memory", requestId: "remember-once" } },
		signal.signal,
	);
	assert.equal(memory.type, "memory");
	assert.equal(
		(await remote.request({ type: "memory", request: { operation: "stats" } }, signal.signal)).result.working,
		1,
	);
	await assert.rejects(discoverRemote("remote-outsider", "agent", "default", signal.signal));
	assert.throws(() =>
		execFileSync("runuser", ["-u", "operator", "--", "test", "-r", "/home/owner/state/default.sqlite"]),
	);
	// A renamed launcher must not strand an already pinned UUID profile on reconnect.
	await rename("/usr/local/bin/agent", "/usr/local/bin/renamed-agent");
	const watch = remote.watch((event) => events.push(event), signal.signal);
	void watch.catch(() => {});
	await until(() => events.at(-1)?.type === "view");
	const held = remote.request(
		{ type: "send", prompt: "hold-until-released", requestId: "uncertain-once" },
		signal.signal,
	);
	const failed = assert.rejects(held, /uncertain-once/);
	await until(() => events.at(-1)?.type === "view" && events.at(-1).view.busy);
	execFileSync("pkill", ["-u", "0", "-x", "ssh"]);
	await failed;
	await until(() => events.some((event) => event.type === "connecting"));
	await until(() => events.at(-1)?.type === "view" && events.at(-1).view.busy);
	assert.equal((await remote.request({ type: "status" }, signal.signal)).busy, true);
	await writeFile("/home/owner/state/release", "complete");
	await until(() => events.at(-1)?.type === "view" && !events.at(-1).view.busy);
	const beforeRetry = (await readFile("/home/owner/state/provider-calls.jsonl", "utf8")).trim().split("\n").length;
	assert.equal(
		(await remote.request({ type: "send", prompt: "hold-until-released", requestId: "uncertain-once" }, signal.signal))
			.type,
		"reply",
	);
	assert.equal(
		(await readFile("/home/owner/state/provider-calls.jsonl", "utf8")).trim().split("\n").length,
		beforeRetry,
	);
	await unlink("/home/owner/state/release");
	const cancelled = remote.request(
		{ type: "send", prompt: "hold-until-released again", requestId: "cancel-once" },
		signal.signal,
	);
	await until(() => events.at(-1)?.type === "view" && events.at(-1).view.busy);
	assert.equal((await remote.request({ type: "cancel" }, signal.signal)).type, "cancelled");
	assert.equal((await cancelled).reply.status, "failed");
	const reconnects = events.filter((event) => event.type === "connecting").length;
	execFileSync("pkill", ["-x", "sshd"]);
	const daemon = spawn("/usr/sbin/sshd", ["-D", "-e"], { detached: true, stdio: "ignore" });
	daemon.unref();
	await writeFile("/tmp/remote-sshd.pid", String(daemon.pid));
	await until(() => events.filter((event) => event.type === "connecting").length > reconnects);
	await until(() => events.at(-1)?.type === "view");
	assert.equal((await remote.request({ type: "status" }, signal.signal)).type, "status");
	const knownHosts = await readFile("/root/.ssh/known_hosts", "utf8");
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", "/tmp/wrong-host-key"]);
	await writeFile(
		"/root/.ssh/known_hosts",
		`127.0.0.1 ${(await readFile("/tmp/wrong-host-key.pub", "utf8")).trim()}\n`,
	);
	await assert.rejects(
		connectRemoteClient(profile, "default", signal.signal),
		/HOST IDENTIFICATION|Host key verification|host key/i,
	);
	await writeFile("/root/.ssh/known_hosts", knownHosts);
	signal.abort();
	await watch;
	console.log(
		"PASS: actual SSH discovery, UUID pin, sessions, private owner, memory, denied operator, disconnect, no replay, explicit retry, cancel, server restart, renamed launcher and host-key mismatch",
	);
} finally {
	clearTimeout(timeout);
	signal.abort();
	await Promise.all(clients.map((remote) => remote.close()));
	await rename("/usr/local/bin/renamed-agent", "/usr/local/bin/agent").catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}
