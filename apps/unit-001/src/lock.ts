import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigurationError } from "./errors.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Takes the exclusive right to run a session. Pi Durable has no cross-process locking, so two agents on one storage
 * could corrupt it. The lock is a file holding the owner's pid; a lock whose process is gone is taken over.
 * Returns the function that releases it.
 */
export async function acquireSessionLock(path: string): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const handle = await open(path, "wx");
			try {
				await handle.writeFile(`${process.pid}\n`);
			} finally {
				await handle.close();
			}
			return async () => {
				await unlink(path).catch(() => {});
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
		if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
			throw new ConfigurationError(
				`This session is already running (process ${owner}). Use --session to open another, or delete ${path} if no unit-001 is running.`,
			);
		}
		// The owner is gone, or the file is unreadable: a stale lock.
		await unlink(path).catch(() => {});
	}
	throw new ConfigurationError(`Could not lock the session at ${path}.`);
}
