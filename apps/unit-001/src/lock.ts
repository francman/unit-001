// Holds session ownership through a separate SQLite transaction released automatically on process death.
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigurationError } from "./errors.ts";

/** Takes exclusive session ownership until release or process death, without deleting a competing owner's lock. */
export async function acquireSessionLock(path: string): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	const file = await open(path, "a", 0o600);
	await file.close();
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
