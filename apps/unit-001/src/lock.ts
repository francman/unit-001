// Holds session ownership through a separate SQLite transaction released automatically on process death.
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigurationError } from "./errors.ts";

/** Takes exclusive session ownership until release or process death, without deleting a competing owner's lock. */
export async function acquireSessionLock(path: string): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	// Closing a second descriptor for an existing inode can drop this process's SQLite locks.
	// If we create the file, close it before another acquisition on this event loop can run.
	let fd: number | undefined;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	if (fd !== undefined) closeSync(fd);
	const database = new DatabaseSync(path, { timeout: 0 });
	try {
		// Keeping this transaction open holds an OS-backed lock; the lock file itself is never removed.
		database.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		database.close();
		if (error instanceof Error && "errcode" in error && typeof error.errcode === "number") {
			if ((error.errcode & 0xff) === 5 || (error.errcode & 0xff) === 6) {
				throw new ConfigurationError(
					"This session is already running. Use attach for a running service, --session to open another, or stop its owner first.",
				);
			}
			if ((error.errcode & 0xff) === 26) {
				throw new ConfigurationError(
					`The session lock at ${path} uses the old PID-file format or is not a SQLite database. Stop all unit-001 processes for this session before removing that lock file.`,
				);
			}
		}
		throw error;
	}
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		try {
			database.exec("ROLLBACK");
		} finally {
			database.close();
		}
	};
}
