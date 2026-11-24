// Verifies the managed launcher publishes and cleans up its private filesystem socket.
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeFacts } from "../src/orientation.ts";
import { localServiceClient } from "../src/service-client.ts";
import { runWebWorkspace } from "../src/web/launcher.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("node:os", { spy: true });
vi.mock("../src/service-client.ts", () => ({ localServiceClient: vi.fn() }));

const installationId = "11111111-1111-4111-8111-111111111111";
const account = userInfo();
const root = account.homedir;
const servers: Server[] = [];
const launches: { controller: AbortController; done: Promise<number> }[] = [];
let parent: string;
let home: string;
let socketPath: string;

describe.skipIf(account.uid <= 0)("managed web listener", () => {
	beforeEach(async () => {
		parent = await mkdtemp(join(root, ".w-"));
		home = join(parent, "h");
		await mkdir(home, { mode: 0o700 });
		socketPath = join(home, ".unit-001", "web", `${installationId}.sock`);
		vi.mocked(userInfo).mockImplementation(() => ({ ...account, homedir: home }));
		vi.mocked(readFile).mockResolvedValue(Buffer.from("workspace fixture"));
		for (const key of ["SUDO_UID", "SUDO_USER", "SUDO_GID", "SUDO_COMMAND"]) vi.stubEnv(key, undefined);
		vi.mocked(localServiceClient).mockReturnValue({
			session: "default",
			ownerSession: "default",
			request: async () => ({
				type: "status",
				installationId,
				pid: process.pid,
				name: "fixture",
				version: "test",
				busy: false,
				inhibited: false,
				maintenance: { protocol: 1, state: "open", operationId: null },
				runtime: createRuntimeFacts("fixture", null)(),
			}),
			watch: async () => {},
		});
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		for (const { controller } of launches) controller.abort();
		await Promise.allSettled(launches.splice(0).map(({ done }) => done));
		await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		await rm(parent, { recursive: true, force: true });
	});

	it("serves the published socket with owner-only permissions and restarts after shutdown", async () => {
		vi.stubEnv("HOME", join(parent, "wrong-home"));
		const reserved = createServer((_req, res) => res.end("host TCP port"));
		servers.push(reserved);
		await once(reserved.listen(0, "127.0.0.1"), "listening");
		const address = reserved.address() as AddressInfo;
		const origin = `http://127.0.0.1:${address.port}`;
		const mask = process.umask();
		const first = await start(address.port);
		expect(process.umask()).toBe(mask);
		expect(first.output).toContain(`Browser workspace: ${origin}\nManaged socket: ${socketPath}\n`);
		expect(first.output).not.toMatch(/pairing|expires|minutes/i);
		for (const path of [join(home, ".unit-001"), dirname(socketPath)]) {
			const directory = await lstat(path);
			expect(directory.isDirectory()).toBe(true);
			expect(directory.uid).toBe(account.uid);
			expect(directory.mode & 0o7777).toBe(0o700);
		}
		const socket = await lstat(socketPath);
		expect(socket.isSocket()).toBe(true);
		expect(socket.uid).toBe(account.uid);
		expect(socket.mode & 0o7777).toBe(0o600);
		expect(await get(origin, socketPath)).toEqual({ status: 200, body: "workspace fixture" });
		expect(await get(origin)).toEqual({ status: 200, body: "host TCP port" });
		first.controller.abort();
		expect(await first.done).toBe(0);
		// Only the lock remains: its inode must stay stable for every later launcher.
		expect(await readdir(dirname(socketPath))).toEqual([`${installationId}.lock`]);
		const lock = await lstat(join(dirname(socketPath), `${installationId}.lock`));
		expect(lock.isFile() && lock.uid === account.uid && (lock.mode & 0o7777) === 0o600).toBe(true);
		const second = await start(address.port);
		expect(await get(origin, socketPath)).toEqual({ status: 200, body: "workspace fixture" });
		second.controller.abort();
		expect(await second.done).toBe(0);
	});

	it("preserves an unrelated file and a live socket, and replaces a stale socket", async () => {
		await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
		const write = vi.fn();
		const signal = new AbortController().signal;
		await writeFile(socketPath, "unrelated file", { mode: 0o640 });
		const file = await lstat(socketPath);
		await expect(runWebWorkspace("fixture", 4317, write, signal, installationId)).rejects.toThrow(
			"path already exists",
		);
		expect(await lstat(socketPath)).toMatchObject({ uid: file.uid, mode: file.mode, ino: file.ino });
		await unlink(socketPath);
		const other = createServer((_req, res) => res.end("existing server"));
		servers.push(other);
		const otherPath = join(dirname(socketPath), "existing.sock");
		await once(other.listen(otherPath), "listening");
		await link(otherPath, socketPath);
		const socket = await lstat(socketPath);
		await expect(runWebWorkspace("fixture", 4317, write, signal, installationId)).rejects.toThrow(
			"path already exists",
		);
		expect(await lstat(socketPath)).toMatchObject({ uid: socket.uid, mode: socket.mode, ino: socket.ino });
		expect(await get("http://127.0.0.1:4317", socketPath)).toEqual({ status: 200, body: "existing server" });
		expect(write).not.toHaveBeenCalled();
		// Closing unlinks the server's own name and leaves a refusing socket at the managed path: a dead launcher's residue.
		await new Promise<void>((resolve) => other.close(() => resolve()));
		const next = await start(4317);
		expect(await get("http://127.0.0.1:4317", socketPath)).toEqual({ status: 200, body: "workspace fixture" });
		next.controller.abort();
		expect(await next.done).toBe(0);
		expect(await readdir(dirname(socketPath))).toEqual([`${installationId}.lock`]);
	});

	it("refuses writable ancestors, a linked account home, and an exposed private directory", async () => {
		const signal = new AbortController().signal;
		const write = vi.fn();
		await chmod(parent, 0o770);
		await expect(runWebWorkspace("fixture", 4317, write, signal, installationId)).rejects.toThrow(
			"home path is not protected",
		);
		expect(await readdir(home)).toEqual([]);
		await chmod(parent, 0o700);
		const linkedHome = join(parent, "l");
		await symlink(home, linkedHome);
		vi.mocked(userInfo).mockImplementationOnce(() => ({ ...account, homedir: linkedHome }));
		await expect(runWebWorkspace("fixture", 4317, write, signal, installationId)).rejects.toThrow(
			"home path is not protected",
		);
		await mkdir(join(home, ".unit-001"), { mode: 0o755 });
		await expect(runWebWorkspace("fixture", 4317, write, signal, installationId)).rejects.toThrow(
			"operator-owned with mode 0700",
		);
		expect(await readdir(join(home, ".unit-001"))).toEqual([]);
		expect(write).not.toHaveBeenCalled();
	});

	it("refuses sudo-marked managed launches before connecting to the owner", async () => {
		vi.mocked(localServiceClient).mockClear();
		vi.stubEnv("SUDO_UID", String(account.uid));
		const signal = new AbortController().signal;
		await expect(runWebWorkspace("fixture", 4317, vi.fn(), signal, installationId)).rejects.toThrow("without sudo");
		expect(localServiceClient).not.toHaveBeenCalled();
		expect(await readdir(home)).toEqual([]);
	});
});

async function start(port: number) {
	const controller = new AbortController();
	const ready = Promise.withResolvers<string>();
	const done = runWebWorkspace("fixture", port, ready.resolve, controller.signal, installationId);
	launches.push({ controller, done });
	const output = await Promise.race([
		ready.promise,
		done.then(() => {
			throw new Error("Listener closed before reporting readiness.");
		}),
	]);
	return { output, controller, done };
}

function get(origin: string, socketPath?: string): Promise<{ status: number | undefined; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(origin, { socketPath, agent: false }, (res) => {
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
