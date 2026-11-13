// Configures disposable container identities; it never reads or changes the developer's SSH configuration.
import { execFileSync, spawn } from "node:child_process";
import { chmod, chown, copyFile, lstat, mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";

if (process.platform !== "linux" || process.getuid?.() !== 0)
	throw new Error("Remote SSH acceptance requires its disposable Linux root container");
await readFile("/.dockerenv");
if (!execFileSync("getent", ["passwd", "owner"], { encoding: "utf8" }).startsWith("owner:x:2000:2000:"))
	throw new Error("Disposable remote owner identity is missing");
if (
	await lstat("/root/.ssh/id_ed25519").catch((error) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	})
)
	throw new Error("Refusing to overwrite an existing SSH identity");

const id = "aa49e3de-4cb1-4caf-9b98-26e4c399c12d";
const published = process.argv[2] === "--published-0.0.7";
if (process.argv.length > (published ? 3 : 2)) throw new Error("Unknown disposable fixture arguments");
const runtime = published ? "/published/runtime/bin/node" : "/usr/local/bin/node";
const ownerEntry = published
	? "/published-fixture/test/fixtures/remote-service-owner.mjs"
	: "/repo/apps/unit-001/test/fixtures/remote-service-owner.mjs";
const namedEntry = published ? "/published/app/dist/named.js" : "/repo/apps/unit-001/dist/named.js";
if (published) {
	// The unchanged test harness resolves every app/SDK import from the hash-verified published release.
	await mkdir("/published-fixture/test/fixtures", { recursive: true });
	await copyFile("/repo/apps/unit-001/test/fixtures/remote-service-owner.mjs", ownerEntry);
	await symlink("/published/app/dist", "/published-fixture/dist");
	await symlink("/published/app/node_modules", "/published-fixture/node_modules");
}
await mkdir("/root/.ssh", { mode: 0o700 });
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", "/root/.ssh/id_ed25519"]);
const publicKey = await readFile("/root/.ssh/id_ed25519.pub");
for (const [name, uid] of [
	["operator", 2001],
	["outsider", 2002],
]) {
	const directory = `/home/${name}/.ssh`;
	await mkdir(directory, { mode: 0o700 });
	await chown(directory, uid, name === "operator" ? 100 : uid);
	const file = `${directory}/authorized_keys`;
	await writeFile(file, publicKey, { mode: 0o600 });
	await chown(file, uid, name === "operator" ? 100 : uid);
}
await mkdir(`/run/unit-001-${id}`, { mode: 0o750 });
await chown(`/run/unit-001-${id}`, 2000, 2000);
const key = (await readFile("/etc/ssh/ssh_host_ed25519_key.pub", "utf8")).trim();
await writeFile("/root/.ssh/known_hosts", `127.0.0.1 ${key}\n`, { mode: 0o600 });
await writeFile(
	"/root/.ssh/config",
	"Host remote-fixture\n HostName 127.0.0.1\n User operator\n IdentityFile /root/.ssh/id_ed25519\nHost remote-outsider\n HostName 127.0.0.1\n User outsider\n IdentityFile /root/.ssh/id_ed25519\nHost remote-forward\n HostName 127.0.0.1\n User operator\n IdentityFile /root/.ssh/id_ed25519\n LocalForward 127.0.0.1:45555 127.0.0.1:22\n ExitOnForwardFailure yes\n",
	{ mode: 0o600 },
);
await writeFile(
	"/usr/local/bin/agent",
	`#!/bin/sh\nexec ${runtime} ${namedEntry} ${id} agent /var/lib/unit-001/agents/${id} --operator "$@"\n`,
	{ mode: 0o755 },
);
await chmod("/usr/local/bin/agent", 0o755);
const sshLog = await open("/tmp/remote-sshd.log", "a");
const sshd = spawn("/usr/sbin/sshd", ["-D", "-e"], { detached: true, stdio: ["ignore", sshLog.fd, sshLog.fd] });
sshd.unref();
await writeFile("/tmp/remote-sshd.pid", String(sshd.pid));
await sshLog.close();
for (const session of ["default", "research"]) {
	const log = await open(`/tmp/remote-owner-${session}.log`, "a");
	const owner = spawn("runuser", ["-u", "owner", "--", runtime, ownerEntry, session], {
		detached: true,
		stdio: ["ignore", log.fd, log.fd],
	});
	owner.unref();
	await writeFile(`/tmp/remote-owner-${session}.pid`, String(owner.pid));
	await log.close();
}
