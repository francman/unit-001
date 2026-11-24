// Holds the managed web listener lock on a stable inode until release or process death.
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { ConfigurationError } from "../errors.ts";

/**
 * Takes the exclusive per-installation web lock, or refuses when another launcher holds it.
 * The lock file is never removed, so every launcher contends on the same inode. The kernel releases it when the holder dies.
 */
export async function acquireListenerLock(path: string, uid: number): Promise<() => Promise<void>> {
	const file = await openLockFile(path, uid);
	try {
		// Same pattern as the installation management lock: flock(1) locks the open file description this process keeps.
		if (process.platform === "linux") {
			await lockDescriptor(file, path);
			return () => file.close();
		}
		if (process.platform !== "darwin") throw new ConfigurationError("Managed web locking requires Linux.");
		const holder = await holdDarwinLock(path);
		return async () => {
			try {
				await releaseDarwinLock(holder);
			} finally {
				await file.close();
			}
		};
	} catch (error) {
		await file.close();
		throw error;
	}
}

async function openLockFile(path: string, uid: number): Promise<FileHandle> {
	const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	const entry = await file.stat();
	if (!entry.isFile() || entry.uid !== uid || (entry.mode & 0o077) !== 0) {
		await file.close();
		throw new ConfigurationError(`The managed web lock must be an operator-owned 0600 file: ${path}.`);
	}
	return file;
}

async function lockDescriptor(file: FileHandle, path: string): Promise<void> {
	const locker = spawn("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", file.fd] });
	let detail = "";
	locker.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		detail += chunk;
	});
	const status = await new Promise<number | null>((resolve, reject) => {
		locker.once("error", reject);
		locker.once("exit", (code) => resolve(code));
	});
	if (status === 1) throw heldError(path);
	if (status !== 0) throw new Error(`flock failed on ${path}: ${detail.trim() || `exit ${status}`}`);
}

async function holdDarwinLock(path: string): Promise<ChildProcess> {
	const holder = spawn("lockf", ["-k", "-t", "0", path, "sh", "-c", "printf 'LOCKED\\n'; cat >/dev/null"], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	await new Promise<void>((resolve, reject) => {
		holder.once("error", reject);
		holder.stdout?.once("data", () => resolve());
		// lockf exits with EX_TEMPFAIL when the lock is busy and its timeout is zero.
		holder.once("exit", (code) =>
			reject(code === 75 ? heldError(path) : new Error(`lockf failed on ${path}: exit ${code}`)),
		);
	});
	return holder;
}

async function releaseDarwinLock(holder: ChildProcess): Promise<void> {
	if (holder.exitCode !== null || holder.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
	holder.stdin?.end();
	await exited;
}

// The lock proves only that no cooperating launcher holds it; it says nothing about a listener's readiness or PID.
function heldError(path: string): ConfigurationError {
	return new ConfigurationError(`Another bob web launcher holds this installation's web lock: ${path}.`);
}
