// Verifies the managed web launcher clears a dead launcher's residue under its lock and refuses an occupied socket path.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import type { BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeFacts } from "../src/orientation.ts";

const installationId = "11111111-1111-4111-8111-111111111111";
const otherInstallationId = "22222222-2222-4222-8222-222222222222";
const account = userInfo();
const child = fileURLToPath(new URL("./fixtures/web-launcher-child.ts", import.meta.url));
const servers: Server[] = [];
const processes: ChildProcess[] = [];
let parent: string;
let home: string;
let web: string;
let socketPath: string;
let lockPath: string;
let owner: string;

describe.skipIf(account.uid <= 0)("managed web listener recovery", { timeout: 30_000 }, () => {
	beforeEach(async () => {
		parent = await mkdtemp(join(account.homedir, ".r-"));
		home = join(parent, "h");
		await mkdir(home, { mode: 0o700 });
		web = join(home, ".unit-001", "web");
		socketPath = join(web, `${installationId}.sock`);
		lockPath = join(web, `${installationId}.lock`);
		owner = join(parent, "default.sock");
		for (const key of ["SUDO_UID", "SUDO_USER", "SUDO_GID", "SUDO_COMMAND"]) vi.stubEnv(key, undefined);
		servers.push(await listen(createOwner(), owner));
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const process of processes.splice(0)) if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
		await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		await rm(parent, { recursive: true, force: true });
	});

	describe("0.0.17 residue", () => {
		it("preserves a live lockless 0.0.17 gateway", async () => {
			const legacy = launch("legacy");
			await legacy.ready;
			const before = await snapshot(socketPath, await stagingPath());
			const current = launch("current");
			expect(await current.closed).toContain(
				`ERROR: Managed web socket path already exists: ${socketPath} (it accepts connections).`,
			);
			expect(await snapshot(socketPath, await stagingPath())).toEqual(before);
			expect(await get(socketPath)).toEqual({ status: 200, body: "workspace fixture" });
			legacy.process.kill("SIGTERM");
			expect(await legacy.closed).toContain("EXIT 0");
			const next = launch("current");
			await next.ready;
			expect(await get(socketPath)).toEqual({ status: 200, body: "workspace fixture" });
		});

		it("recovers the residue of a SIGKILLed 0.0.17 gateway on the next start", async () => {
			await legacyResidue();
			expect((await lstat(socketPath)).nlink).toBe(2);
			const current = launch("current");
			await current.ready;
			expect(await get(socketPath)).toEqual({ status: 200, body: "workspace fixture" });
			expect((await readdir(web)).toSorted()).toEqual([`${installationId}.lock`, `${installationId}.sock`]);
			await stop(current);
			expect(await readdir(web)).toEqual([`${installationId}.lock`]);
		});

		it("unlinks only the recognized socket in its staging directory and keeps other entries", async () => {
			await legacyResidue();
			const staging = await stagingPath();
			await writeFile(join(staging, "extra"), "not the launcher's", { mode: 0o600 });
			const current = launch("current");
			await current.ready;
			expect(await readdir(staging)).toEqual(["extra"]);
			await stop(current);
		});

		it("leaves a dead staging directory it cannot attribute to this installation", async () => {
			await legacyResidue();
			const staging = await stagingPath();
			await unlink(socketPath);
			const before = await snapshot(staging, join(staging, "s"));
			const current = launch("current");
			await current.ready;
			await stop(current);
			expect(await snapshot(staging, join(staging, "s"))).toEqual(before);
		});

		it("removes the listener record a SIGKILLed bc723f302 launcher kept beside the same layout", async () => {
			await legacyResidue();
			await writeFile(join(web, `${installationId}.listener`), "{}", { mode: 0o600 });
			await writeFile(join(web, `${installationId}.listener.tmp`), "", { mode: 0o600 });
			const current = launch("current");
			await current.ready;
			await stop(current);
			expect(await readdir(web)).toEqual([`${installationId}.lock`]);
		});

		it("removes the staging a bc723f302 record names after its public link is gone", async () => {
			await legacyResidue();
			const staging = await stagingPath();
			const { dev, ino } = await lstat(join(staging, "s"), { bigint: true });
			await unlink(socketPath);
			const record = { version: 1, staging: basename(staging), socketDev: String(dev), socketIno: String(ino) };
			await writeFile(join(web, `${installationId}.listener`), JSON.stringify(record), { mode: 0o600 });
			const current = launch("current");
			await current.ready;
			await stop(current);
			expect(await readdir(web)).toEqual([`${installationId}.lock`]);
		});
	});

	// Codex HOLD on fix-gateway: installation B holds its own lock (or none on 0.0.17), so A's cleanup ran while B was
	// between mkdtemp and bind and recursively removed B's staging directory.
	it("leaves another installation's staging directory between mkdir and bind", async () => {
		await mkdir(web, { recursive: true, mode: 0o700 });
		const other = join(web, `${otherInstallationId}.sock`);
		const staging = await mkdtemp(join(web, ".listener-"));
		const current = launch("current");
		await current.ready;
		servers.push(await listen(createServer(), join(staging, "s")));
		await link(join(staging, "s"), other);
		expect((await lstat(other)).isSocket()).toBe(true);
		await stop(current);
		const expected = [`${installationId}.lock`, `${otherInstallationId}.sock`, basename(staging)];
		expect((await readdir(web)).toSorted()).toEqual(expected.toSorted());
	});

	it("recovers the socket of a SIGKILLed current gateway on the next start", async () => {
		const first = launch("current");
		await first.ready;
		await kill(first);
		await lockReleased();
		expect((await lstat(socketPath)).isSocket()).toBe(true);
		const next = launch("current");
		await next.ready;
		expect(await get(socketPath)).toEqual({ status: 200, body: "workspace fixture" });
		await stop(next);
		expect(await readdir(web)).toEqual([`${installationId}.lock`]);
	});

	it.each(["legacy", "current"] as const)("yields one publisher when two launchers race after a %s crash", async (variant) => {
		const crashed = launch(variant);
		await crashed.ready;
		await kill(crashed);
		if (variant === "current") await lockReleased();
		const racers = [launch("current"), launch("current")];
		const outcomes = await Promise.all(
			racers.map((racer) => Promise.race([racer.ready.then(() => "ready"), racer.closed.then(() => "refused")])),
		);
		expect(outcomes.toSorted()).toEqual(["ready", "refused"]);
		const refused = racers[outcomes.indexOf("refused")]!;
		const output = await refused.closed;
		expect(output).toContain(`ERROR: Another bob web launcher holds this installation's web lock: ${lockPath}.`);
		expect(output).not.toMatch(/\bpid\b|Browser workspace/i);
		expect(await get(socketPath)).toEqual({ status: 200, body: "workspace fixture" });
		expect((await readdir(web)).toSorted()).toEqual([`${installationId}.lock`, `${installationId}.sock`]);
	});

	it.each([
		{
			name: "an unrelated file",
			reason: "it is not a recognized listener socket",
			arrange: async () => {
				await writeFile(socketPath, "unrelated file", { mode: 0o600 });
				return [socketPath];
			},
		},
		{
			name: "a symlink to a dead socket",
			reason: "it is not a recognized listener socket",
			arrange: async () => {
				const dead = join(web, "dead.sock");
				await deadSocket(dead);
				await symlink(dead, socketPath);
				return [socketPath, dead];
			},
		},
		{
			name: "a socket whose connection probe is not refused",
			reason: "its connection probe was not refused",
			arrange: async () => {
				// Without write permission, connect fails with EACCES before the kernel looks for a listener.
				await deadSocket(socketPath);
				await chmod(socketPath, 0o000);
				return [socketPath];
			},
		},
	])("refuses $name at the socket path and keeps it", async ({ reason, arrange }) => {
		await mkdir(web, { recursive: true, mode: 0o700 });
		const paths = await arrange();
		const before = await snapshot(...paths);
		const current = launch("current");
		expect(await current.closed).toContain(`ERROR: Managed web socket path already exists: ${socketPath} (${reason}).`);
		expect(await snapshot(...paths)).toEqual(before);
	});

	// flock(1) locks the launcher's own open file description, so no helper process outlives it. Cannot run on macOS.
	it.runIf(process.platform === "linux")("releases the lock in the kernel when the launcher dies", async () => {
		const first = launch("current");
		await first.ready;
		expect(await locker(["--nonblock", lockPath, "true"])).toBe(1);
		first.process.kill("SIGKILL");
		await first.closed;
		expect(await locker(["--nonblock", lockPath, "true"])).toBe(0);
	});
});

interface Launch {
	readonly process: ChildProcess;
	readonly ready: Promise<string>;
	readonly closed: Promise<string>;
}

function launch(variant: "current" | "legacy"): Launch {
	const process = spawn(globalThis.process.execPath, [child, variant, home, installationId, owner], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	processes.push(process);
	let output = "";
	const ready = Promise.withResolvers<string>();
	for (const stream of [process.stdout, process.stderr]) {
		stream.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
			if (output.includes("Ctrl+C detaches")) ready.resolve(output);
		});
	}
	const closed = once(process, "close").then(() => output);
	void closed.then(() => ready.reject(new Error(`Launcher closed before readiness:\n${output}`)));
	ready.promise.catch(() => {});
	return { process, ready: ready.promise, closed };
}

async function kill(target: Launch): Promise<void> {
	target.process.kill("SIGKILL");
	await target.closed;
}

async function stop(target: Launch): Promise<void> {
	target.process.kill("SIGTERM");
	expect(await target.closed).toContain("EXIT 0");
}

// On macOS the lock lives in a lockf helper that exits once its parent's pipe closes; wait for it, never poll.
async function lockReleased(): Promise<void> {
	expect(await locker(process.platform === "linux" ? ["--wait", "10", lockPath, "true"] : ["-k", "-t", "10", lockPath, "true"])).toBe(0);
}

async function locker(args: string[]): Promise<number | null> {
	const process = spawn(globalThis.process.platform === "linux" ? "flock" : "lockf", args, { stdio: "ignore" });
	const [code] = (await once(process, "exit")) as [number | null];
	return code;
}

async function legacyResidue(): Promise<void> {
	const legacy = launch("legacy");
	await legacy.ready;
	await stagingPath();
	await kill(legacy);
}

// Node unlinks a server's bound path on close, so bind a second name and keep only the link at `path`.
async function deadSocket(path: string): Promise<void> {
	const server = await listen(createServer(), `${path}.bind`);
	await link(`${path}.bind`, path);
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stagingPath(): Promise<string> {
	const names = (await readdir(web)).filter((name) => name.startsWith(".listener-"));
	expect(names).toHaveLength(1);
	return join(web, names[0]!);
}

async function snapshot(...paths: string[]): Promise<Pick<BigIntStats, "dev" | "ino" | "mode" | "nlink">[]> {
	return Promise.all(
		paths.map(async (path) => {
			const { dev, ino, mode, nlink } = await lstat(path, { bigint: true });
			return { dev, ino, mode, nlink };
		}),
	);
}

function createOwner(): Server {
	const status = {
		type: "status",
		installationId,
		pid: process.pid,
		name: "fixture",
		version: "test",
		busy: false,
		inhibited: false,
		maintenance: { protocol: 1, state: "open", operationId: null },
		runtime: createRuntimeFacts("fixture", null)(),
	};
	return createServer((socket) => {
		socket.setEncoding("utf8");
		socket.once("data", () => socket.end(`${JSON.stringify(status)}\n`));
	});
}

async function listen(server: Server, path: string): Promise<Server> {
	server.listen(path);
	await once(server, "listening");
	return server;
}

function get(socketPath: string): Promise<{ status: number | undefined; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request("http://127.0.0.1:4317", { socketPath, agent: false }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			res.once("error", reject);
			res.once("end", () => resolve({ status: res.statusCode, body }));
		});
		req.once("error", reject);
		req.end();
	});
}
