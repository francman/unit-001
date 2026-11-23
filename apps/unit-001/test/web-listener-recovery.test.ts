// Verifies the managed web launcher recovers crash residue under its lock and preserves everything it cannot identify.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { type BigIntStats, unlinkSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeFacts } from "../src/orientation.ts";
import { runWebWorkspace } from "../src/web/launcher.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("node:os", { spy: true });

const installationId = "11111111-1111-4111-8111-111111111111";
const account = userInfo();
const child = fileURLToPath(new URL("./fixtures/web-launcher-child.ts", import.meta.url));
const servers: Server[] = [];
const processes: ChildProcess[] = [];
let parent: string;
let home: string;
let web: string;
let socketPath: string;
let lockPath: string;
let recordPath: string;
let owner: string;

describe.skipIf(account.uid <= 0)("managed web listener recovery", { timeout: 30_000 }, () => {
	beforeEach(async () => {
		parent = await mkdtemp(join(account.homedir, ".r-"));
		home = join(parent, "h");
		await mkdir(home, { mode: 0o700 });
		web = join(home, ".unit-001", "web");
		socketPath = join(web, `${installationId}.sock`);
		lockPath = join(web, `${installationId}.lock`);
		recordPath = join(web, `${installationId}.listener`);
		owner = join(parent, "default.sock");
		for (const key of ["SUDO_UID", "SUDO_USER", "SUDO_GID", "SUDO_COMMAND"]) vi.stubEnv(key, undefined);
		servers.push(await listen(createOwner(), owner));
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		for (const process of processes.splice(0)) if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
		await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		await rm(parent, { recursive: true, force: true });
	});

	describe("0.0.17 migration", () => {
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
			const legacy = launch("legacy");
			await legacy.ready;
			const staging = await stagingPath();
			await kill(legacy);
			expect((await lstat(socketPath)).nlink).toBe(2);
			const current = launch("current");
			expect(await current.ready).not.toContain("Preserved");
			expect(await get(socketPath)).toEqual({ status: 200, body: "workspace fixture" });
			expect(await readdir(web)).not.toContain(staging.slice(web.length + 1));
			await stop(current);
			expect(await readdir(web)).toEqual([`${installationId}.lock`]);
		});
	});

	it("recovers the residue of a SIGKILLed current gateway on the next start", async () => {
		const first = launch("current");
		await first.ready;
		const staging = await stagingPath();
		expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ staging: staging.slice(web.length + 1) });
		await kill(first);
		await lockReleased();
		const next = launch("current");
		expect(await next.ready).not.toContain("Preserved");
		expect(await get(socketPath)).toEqual({ status: 200, body: "workspace fixture" });
		expect(await readdir(web)).not.toContain(staging.slice(web.length + 1));
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
		expect((await readdir(web)).filter((name) => name.startsWith(".listener-"))).toHaveLength(1);
	});

	describe("preserved paths", () => {
		it.each([
			{
				name: "an unrelated file at the socket path",
				reason: "it is not a recognized listener socket",
				arrange: async () => {
					await mkdir(web, { recursive: true, mode: 0o700 });
					await writeFile(socketPath, "unrelated file", { mode: 0o600 });
					return [socketPath];
				},
			},
			{
				name: "a symlink at the socket path to dead 0.0.17 residue",
				reason: "it is not a recognized listener socket",
				arrange: async () => {
					const staging = await legacyResidue();
					await rename(socketPath, join(parent, "moved.sock"));
					await symlink(join(staging, "s"), socketPath);
					return [socketPath, staging, join(staging, "s")];
				},
			},
			{
				name: "a 0.0.17 staging directory substituted by a symlink",
				reason: "it has no single matching staging link",
				arrange: async () => {
					const staging = await legacyResidue();
					await rename(staging, join(parent, "moved"));
					await symlink(join(parent, "moved"), staging);
					return [socketPath, staging, join(parent, "moved", "s")];
				},
			},
			{
				name: "a third link to dead 0.0.17 residue",
				reason: "it is not a recognized listener socket",
				arrange: async () => {
					const staging = await legacyResidue();
					await link(socketPath, join(parent, "extra.sock"));
					return [socketPath, staging, join(staging, "s")];
				},
			},
			{
				name: "an exposed 0.0.17 staging directory",
				reason: "its staging directory is not operator-owned with mode 0700",
				arrange: async () => {
					const staging = await legacyResidue();
					await chmod(staging, 0o750);
					return [socketPath, staging, join(staging, "s")];
				},
			},
			{
				name: "a live socket substituted after a current crash",
				reason: "it does not match the recorded listener",
				arrange: async () => {
					const crashed = launch("current");
					await crashed.ready;
					await kill(crashed);
					await lockReleased();
					await unlink(socketPath);
					const other = join(parent, "other.sock");
					servers.push(await listen(createServer((socket) => socket.end()), other));
					await link(other, socketPath);
					return [socketPath, other];
				},
			},
			{
				name: "a recorded public socket whose staging link is gone",
				reason: "its recorded staging link no longer corroborates it",
				arrange: async () => {
					const staging = await currentResidue();
					await unlink(join(staging, "s"));
					// The empty recorded staging directory is still removed; only the public name is kept.
					return [socketPath];
				},
			},
			{
				name: "a recorded public socket whose staging directory is gone",
				reason: "its recorded staging link no longer corroborates it",
				arrange: async () => {
					const staging = await currentResidue();
					await rm(staging, { recursive: true });
					return [socketPath];
				},
			},
		])("preserves $name", async ({ reason, arrange }) => {
			const paths = await arrange();
			const before = await snapshot(...paths);
			const current = launch("current");
			expect(await current.closed).toContain(`ERROR: Managed web socket path already exists: ${socketPath} (${reason}).`);
			expect(await snapshot(...paths)).toEqual(before);
		});

		it.each([
			{ name: "a FIFO at the record", path: () => recordPath, arrange: (path: string) => mkfifo(path) },
			{ name: "a FIFO at the temporary record", path: () => `${recordPath}.tmp`, arrange: (path: string) => mkfifo(path) },
			{
				name: "a non-private temporary record",
				path: () => `${recordPath}.tmp`,
				arrange: (path: string) => writeFile(path, "leftover", { mode: 0o644 }),
			},
		])("refuses $name without blocking and keeps it", async ({ path, arrange }) => {
			await mkdir(web, { recursive: true, mode: 0o700 });
			await arrange(path());
			const before = await snapshot(path());
			const current = launch("current");
			expect(await current.closed).toContain(`ERROR: The managed web listener record is not valid: ${path()}.`);
			expect(await snapshot(path())).toEqual(before);
			// Nothing was published, and the refused start left no staging directory behind.
			expect((await readdir(web)).filter((name) => name.endsWith(".sock") || name.startsWith(".listener-"))).toEqual([]);
		});

		it("reports a recorded staging directory that holds files it did not create", async () => {
			const crashed = launch("current");
			await crashed.ready;
			const staging = await stagingPath();
			await kill(crashed);
			await lockReleased();
			await writeFile(join(staging, "note"), "operator file");
			const next = launch("current");
			expect(await next.ready).toContain(
				`Preserved unrecognized path: ${staging} (it holds files this launcher did not create).\n`,
			);
			expect(await readdir(staging)).toEqual(["note"]);
		});
	});

	describe("interrupted cleanup", () => {
		it("starts after a cut between the public and staging unlinks of a current shutdown", async () => {
			const crashed = launch("current");
			await crashed.ready;
			const staging = await stagingPath();
			await kill(crashed);
			await lockReleased();
			// Shutdown unlinks the public path first; a kill right after it leaves only the staging link and the record.
			await unlink(socketPath);
			const next = launch("current");
			expect(await next.ready).not.toContain("Preserved");
			expect(await readdir(web)).not.toContain(staging.slice(web.length + 1));
		});

		it("starts after a cut between the unlinks of a 0.0.17 adoption", async () => {
			const staging = await legacyResidue();
			vi.mocked(userInfo).mockImplementation(() => ({ ...account, homedir: home }));
			vi.mocked(readFile).mockResolvedValue(Buffer.from("workspace fixture"));
			// Recovery unlinks the public path first; fail the staging unlink after it, as a kill at that point would.
			vi.mocked(unlink).mockImplementation(async (path) => {
				if (String(path).endsWith("/s")) throw Object.assign(new Error("cut between unlinks"), { code: "EIO" });
				unlinkSync(path);
			});
			await expect(runWebWorkspace(owner, 4317, vi.fn(), new AbortController().signal, installationId)).rejects.toThrow(
				"cut between unlinks",
			);
			vi.restoreAllMocks();
			expect(await readdir(web)).toEqual(
				expect.arrayContaining([`${installationId}.listener`, staging.slice(web.length + 1)]),
			);
			expect(await readdir(web)).not.toContain(`${installationId}.sock`);
			const next = launch("current");
			expect(await next.ready).not.toContain("Preserved");
			expect(await readdir(web)).not.toContain(staging.slice(web.length + 1));
		});
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

async function legacyResidue(): Promise<string> {
	const legacy = launch("legacy");
	await legacy.ready;
	const staging = await stagingPath();
	await kill(legacy);
	return staging;
}

async function currentResidue(): Promise<string> {
	const crashed = launch("current");
	await crashed.ready;
	const staging = await stagingPath();
	await kill(crashed);
	await lockReleased();
	return staging;
}

async function mkfifo(path: string): Promise<void> {
	const [code] = (await once(spawn("mkfifo", ["-m", "600", path], { stdio: "ignore" }), "exit")) as [number | null];
	expect(code).toBe(0);
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
