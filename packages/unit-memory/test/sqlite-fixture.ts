// Real SQLite Session lifecycle shared by memory document tests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type Session } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type SqliteFixture = {
	session: Session;
	storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
	reopen(): Promise<void>;
	close(): Promise<void>;
};

/** Open a disposable database whose Session can be closed and reopened in a test. */
export async function sqliteFixture(): Promise<SqliteFixture> {
	const directory = await mkdtemp(join(tmpdir(), "unit-memory-"));
	const file = join(directory, "memory.sqlite");
	const storage = await openNodeSqliteStorage(file);
	const fixture: SqliteFixture = {
		storage,
		session: createSession(storage),
		async reopen() {
			await fixture.session.close(BACKGROUND_CONTEXT);
			fixture.storage = await openNodeSqliteStorage(file);
			fixture.session = createSession(fixture.storage);
		},
		async close() {
			try {
				await fixture.session.close(BACKGROUND_CONTEXT);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	};
	return fixture;
}
