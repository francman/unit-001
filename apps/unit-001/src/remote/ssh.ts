// Opens bounded OpenSSH processes without a remote terminal, shell interpolation or public listener.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateSessionName } from "../paths.ts";
import { sanitizeTerminalText } from "../render.ts";
import { operatorEndpoint, parseServiceResponse } from "../service.ts";
import { type RemoteProfile, validateRemoteName } from "./profiles.ts";

export interface RemoteTunnel {
	readonly endpoint: string;
	readonly closed: Promise<string>;
	close(): Promise<void>;
}

const SSH = "/usr/bin/ssh";
const OPTIONS = [
	"-T",
	"-oBatchMode=yes",
	"-oStrictHostKeyChecking=yes",
	"-oForwardAgent=no",
	"-oForwardX11=no",
	"-oControlMaster=no",
	"-oControlPath=none",
	"-oControlPersist=no",
	"-oPermitLocalCommand=no",
	"-oConnectTimeout=10",
	"-oServerAliveInterval=5",
	"-oServerAliveCountMax=2",
];

/** Discovers a managed owner through its fixed read-only status command before pinning its identity. */
export async function discoverRemote(
	host: string,
	agentName: string,
	session: string,
	signal: AbortSignal,
): Promise<Omit<RemoteProfile, "schema" | "name">> {
	checkPlatform();
	validateRemoteName(host);
	validateRemoteName(agentName);
	validateSessionName(session);
	signal.throwIfAborted();
	// OpenSSH joins command arguments into a shell command; validated literals are quoted regardless.
	const command = `'${agentName}' service-status --session '${session}'`;
	const wire = await sshOutput([...OPTIONS, "-oClearAllForwardings=yes", "--", host, command], signal);
	const response = parseServiceResponse(wire.trim());
	if (response.type !== "status" || response.installationId === null)
		throw new Error("Remote discovery requires a running managed unit-001 installation with operator access.");
	operatorEndpoint(response.installationId, session);
	return { host, agentName: response.name, installationId: response.installationId, session };
}

async function sshOutput(args: readonly string[], signal: AbortSignal): Promise<string> {
	const child = spawn(SSH, args, { env: sshEnvironment(), stdio: "pipe" });
	const output: Buffer[] = [];
	let bytes = 0;
	let force: ReturnType<typeof setTimeout> | undefined;
	const abort = () => {
		child.kill("SIGTERM");
		force ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
	};
	signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(abort, 15_000);
	const finished = collectExit(child);
	child.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > 1_048_576) abort();
		else output.push(chunk);
	});
	try {
		const error = await finished;
		signal.throwIfAborted();
		if (bytes > 1_048_576) throw new Error("Remote discovery response exceeds 1 MiB.");
		if (error !== "") throw new Error(`Remote discovery failed: ${error}`);
		return Buffer.concat(output).toString("utf8");
	} finally {
		clearTimeout(timeout);
		clearTimeout(force);
		signal.removeEventListener("abort", abort);
		await stop(child);
	}
}

/** Forwards one private local Unix socket to the UUID-bound existing operator endpoint. */
export async function openRemoteTunnel(
	profile: RemoteProfile,
	session: string,
	signal: AbortSignal,
): Promise<RemoteTunnel> {
	checkPlatform();
	validateRemoteName(profile.host);
	const remote = operatorEndpoint(profile.installationId, session);
	signal.throwIfAborted();
	const configuration = await sshOutput([...OPTIONS, "-G", "--", profile.host], signal);
	if (/^(?:localforward|remoteforward|dynamicforward)\s/im.test(configuration))
		throw new Error(
			"Remote sessions require an SSH alias without configured LocalForward, RemoteForward or DynamicForward entries.",
		);
	const directory = await mkdtemp(join(tmpdir(), "unit-remote-"));
	const endpoint = join(directory, "control.sock");
	const child = spawn(
		SSH,
		[
			...OPTIONS,
			"-N",
			"-oExitOnForwardFailure=yes",
			"-oStreamLocalBindMask=0177",
			"-L",
			`${endpoint}:${remote}`,
			"--",
			profile.host,
		],
		{ env: sshEnvironment(), stdio: "pipe" },
	);
	const closed = collectExit(child);
	child.stdout.resume();
	let cleanup: Promise<void> | undefined;
	const close = () => {
		cleanup ??= (async () => {
			signal.removeEventListener("abort", abort);
			await stop(child);
			await rm(directory, { recursive: true, force: true });
		})();
		return cleanup;
	};
	const abort = () => {
		void close();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const deadline = Date.now() + 15_000;
		while (true) {
			signal.throwIfAborted();
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`SSH connection failed: ${await closed}`);
			const socket = await lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			if (socket?.isSocket()) return { endpoint, closed, close };
			if (Date.now() >= deadline) throw new Error("SSH connection did not become ready within 15 seconds.");
			await delay(25, undefined, { signal });
		}
	} catch (error) {
		await close();
		throw error;
	}
}

function collectExit(child: ChildProcessWithoutNullStreams): Promise<string> {
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		// Diagnostics are bounded and exclude terminal escape/control characters from remote output.
		stderr = sanitizeTerminalText((stderr + chunk.toString("utf8")).slice(-16_384));
	});
	child.stdin.end();
	return new Promise((resolve) => {
		child.once("error", (error) => resolve(error.message));
		child.once("close", (code, signal) =>
			resolve(code === 0 ? "" : stderr.trim() || `SSH exited (${code ?? signal}).`),
		);
	});
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
	try {
		await closed;
	} finally {
		clearTimeout(timer);
	}
}

function sshEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"])
		if (process.env[key] !== undefined) env[key] = process.env[key];
	return env;
}

function checkPlatform(): void {
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw new Error("Remote sessions currently support macOS and Linux clients.");
}
