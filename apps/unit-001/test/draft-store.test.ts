// #26: the draft store keeps one bounded unsent draft per installation and session across client exit.
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftsFor, type Runtime } from "../src/cli.ts";
import { createDraftStore, DRAFT_RETENTION_MS, MAX_DRAFT_BYTES, type StoredDraft } from "../src/draft-store.ts";

let root: string;
let directory: string;

beforeEach(async () => {
	// Physical, so messages naming a traversed entry match the paths the tests build.
	root = await realpath(await mkdtemp(join(tmpdir(), "unit-drafts-")));
	directory = join(root, "drafts");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function store(overrides: { installationId?: string; session?: string; now?: () => number } = {}) {
	return createDraftStore({ directory, installationId: "install-a", session: "default", ...overrides });
}

async function draftFile(): Promise<string> {
	const [name] = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
	return join(directory, name);
}

async function restored(draftStore = store()): Promise<StoredDraft | undefined> {
	const loaded = await draftStore.load();
	return loaded.status === "restored" ? loaded.draft : undefined;
}

// Writes a draft, then returns the path of the file it produced.
async function written(draft: StoredDraft = { text: "ok" }): Promise<string> {
	const writer = store();
	writer.save(draft);
	await writer.flush();
	return draftFile();
}

describe("draft store", () => {
	it("restores a flushed draft for the same installation and session", async () => {
		const first = store();
		first.save({ text: "line one\nline two" });
		expect(await first.flush()).toEqual({ status: "saved" });
		expect(await restored()).toEqual({ text: "line one\nline two" });
	});

	it("keeps an unconfirmed send and the current typing side by side", async () => {
		const first = store();
		first.save({ text: "new typing", unconfirmed: { text: "sent text", requestId: "req-1" } });
		await first.flush();
		expect(await restored()).toEqual({ text: "new typing", unconfirmed: { text: "sent text", requestId: "req-1" } });
		first.save({ text: "", unconfirmed: { text: "sent text", requestId: "req-1" } });
		await first.flush();
		expect(await restored()).toEqual({ text: "", unconfirmed: { text: "sent text", requestId: "req-1" } });
	});

	it("writes the file with mode 0600 in a 0700 directory and leaves no temporary files", async () => {
		await written({ text: "secret draft" });
		expect((await stat(await draftFile())).mode & 0o777).toBe(0o600);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});

	it("coalesces edits into one deferred write and never writes per keystroke", async () => {
		const writer = store();
		writer.save({ text: "a" });
		writer.save({ text: "ab" });
		writer.save({ text: "abc" });
		await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
		await writer.flush();
		expect(await restored()).toEqual({ text: "abc" });
	});

	it("removes the file when the draft is cleared, and creates no directory to do so", async () => {
		const writer = store();
		writer.save(undefined);
		expect(await writer.flush()).toEqual({ status: "saved" });
		await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
		writer.save({ text: "temporary" });
		await writer.flush();
		writer.save({ text: "" });
		await writer.flush();
		expect((await readdir(directory)).filter((entry) => entry.endsWith(".json"))).toEqual([]);
		expect(await store().load()).toEqual({ status: "none" });
	});

	it("never stores a draft above the 16 KiB bound", async () => {
		const writer = store();
		writer.save({ text: "x".repeat(MAX_DRAFT_BYTES + 1) });
		await writer.flush();
		expect(await restored()).toBeUndefined();
		writer.save({ text: "y".repeat(MAX_DRAFT_BYTES) });
		await writer.flush();
		expect((await restored())?.text.length).toBe(MAX_DRAFT_BYTES);
	});

	// #26 v2 review: an unconfirmed send's ID is what the next attach checks, so the store never drops it silently.
	it("keeps an unconfirmed send whose text sanitizes to nothing, with its ID and digest", async () => {
		const send = { text: "​", requestId: "req-z", digest: "a".repeat(64) };
		await written({ text: "", unconfirmed: send });
		expect(await restored()).toEqual({ text: "", unconfirmed: { ...send, text: "" } });
	});

	it("keeps an unconfirmed send beside an oversized draft, and fails the write of an oversized send", async () => {
		const send = { text: "sent", requestId: "req-1" };
		await written({ text: "x".repeat(MAX_DRAFT_BYTES + 1), unconfirmed: send });
		expect(await restored()).toEqual({ text: "", unconfirmed: send });
		const writer = store();
		writer.save({ text: "", unconfirmed: { text: "y".repeat(MAX_DRAFT_BYTES + 1), requestId: "req-2" } });
		expect(await writer.flush()).toMatchObject({ status: "failed" });
		expect(await restored()).toEqual({ text: "", unconfirmed: send });
	});

	it("ignores text above the 16 KiB bound written by something else", async () => {
		const path = await written();
		const file = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...file, text: "x".repeat(MAX_DRAFT_BYTES + 1) }), { mode: 0o600 });
		expect(await store().load()).toEqual({ status: "none" });
	});

	it("discards drafts older than the retention age and deletes the file", async () => {
		let now = 1_000_000;
		const writer = store({ now: () => now });
		writer.save({ text: "old" });
		await writer.flush();
		now += DRAFT_RETENTION_MS - 1;
		expect(await restored(store({ now: () => now }))).toEqual({ text: "old" });
		now += 2;
		expect(await store({ now: () => now }).load()).toEqual({ status: "none" });
		expect((await readdir(directory)).filter((entry) => entry.endsWith(".json"))).toEqual([]);
	});

	it("discards a draft dated more than five minutes in the future and deletes the file", async () => {
		let now = 1_000_000;
		const writer = store({ now: () => now });
		writer.save({ text: "from the future" });
		await writer.flush();
		now -= 5 * 60 * 1000;
		expect(await restored(store({ now: () => now }))).toEqual({ text: "from the future" });
		now -= 1;
		expect(await store({ now: () => now }).load()).toEqual({ status: "none" });
		expect((await readdir(directory)).filter((entry) => entry.endsWith(".json"))).toEqual([]);
	});

	it("ignores a file recorded for another installation or session", async () => {
		const path = await written({ text: "for install a" });
		const file = JSON.parse(await readFile(path, "utf8"));
		// A different installation reads a different file name, so also force the same name with the wrong identity.
		expect(await store({ installationId: "install-b" }).load()).toEqual({ status: "none" });
		expect(await store({ session: "other" }).load()).toEqual({ status: "none" });
		await writeFile(path, JSON.stringify({ ...file, installationId: "install-b" }), { mode: 0o600 });
		expect(await store().load()).toEqual({ status: "none" });
		await writeFile(path, JSON.stringify({ ...file, session: "other" }), { mode: 0o600 });
		expect(await store().load()).toEqual({ status: "none" });
	});

	it("ignores corrupt or unrecognised files", async () => {
		const path = await written();
		for (const contents of ["not json", "[]", "null", JSON.stringify({ schemaVersion: 2 })]) {
			await writeFile(path, contents);
			expect(await store().load()).toEqual({ status: "none" });
		}
	});

	it("reports a failed write instead of throwing", async () => {
		// A regular file where the directory should be makes every write fail.
		await writeFile(directory, "blocker");
		const writer = store();
		writer.save({ text: "cannot save" });
		expect((await writer.flush()).status).toBe("failed");
	});

	it("leaves unrelated files in the directory alone", async () => {
		const writer = store();
		writer.save({ text: "ok" });
		await writer.flush();
		await writeFile(join(directory, "other.json"), "{}");
		writer.save(undefined);
		await writer.flush();
		expect(await readFile(join(directory, "other.json"), "utf8")).toBe("{}");
	});
});

// #26 second review, finding 5: a path another user can change cannot hold drafts, however the leaf is checked.
describe("draft store ancestors", () => {
	const failure = async (draft: StoredDraft) => {
		const writer = store();
		writer.save(draft);
		const flushed = await writer.flush();
		return flushed.status === "failed" ? flushed.reason : "saved";
	};

	it("refuses a drafts directory below a directory others can write, creating nothing there", async () => {
		const shared = join(root, "shared");
		await mkdir(shared);
		await chmod(shared, 0o777);
		directory = join(shared, "drafts");
		expect(await failure({ text: "must not be written" })).toContain(`drafts path ${shared} can be changed by other users`);
		expect(await readdir(shared)).toEqual([]);
		// A directory already there, even a trusted-looking one of ours, is refused for reading too.
		await mkdir(directory, { mode: 0o700 });
		const loaded = await store().load();
		expect(loaded).toMatchObject({ status: "refused" });
		expect(loaded.status === "refused" ? loaded.reason : "").toContain("can be changed by other users");
	});

	// Follow-up from the 2026-11-22 review: a group-writable (mode 775) ancestor stays refused; recovery is reported
	// unavailable, nothing is written there and nothing is moved to another path.
	it("refuses a group-writable ancestor for load and save and reports recovery unavailable", async () => {
		const shared = join(root, "shared");
		await mkdir(shared);
		await chmod(shared, 0o775);
		directory = join(shared, "drafts");
		const reason = await failure({ text: "must not be written" });
		expect(reason).toContain(`drafts path ${shared} can be changed by other users (mode 775)`);
		expect(reason).toContain("draft recovery is unavailable");
		expect(await readdir(shared)).toEqual([]);
		await mkdir(directory, { mode: 0o700 });
		const loaded = await store().load();
		expect(loaded).toMatchObject({ status: "refused" });
		expect(loaded.status === "refused" ? loaded.reason : "").toContain("draft recovery is unavailable");
		expect(await readdir(directory)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("creates private directories under a umask of 002", async () => {
		const previous = process.umask(0o002);
		try {
			directory = join(root, "state", "unit-001", "drafts");
			expect(await failure({ text: "kept" })).toBe("saved");
			for (const path of [join(root, "state"), join(root, "state", "unit-001"), directory])
				expect((await stat(path)).mode & 0o777).toBe(0o700);
			expect(await restored()).toEqual({ text: "kept" });
		} finally {
			process.umask(previous);
		}
	});

	it("refuses a symlinked ancestor whose own directory others can write", async () => {
		const shared = join(root, "shared");
		const safe = join(root, "safe");
		await mkdir(shared);
		await chmod(shared, 0o777);
		await mkdir(safe, { mode: 0o700 });
		await symlink(safe, join(shared, "link"));
		directory = join(shared, "link", "drafts");
		expect(await failure({ text: "must not be written" })).toContain("can be changed by other users");
		expect(await readdir(safe)).toEqual([]);
	});

	it("refuses a link reached only through another link's target, inside a directory others can write", async () => {
		// root/entry -> root/shared/hop -> root/safe. `shared` is on neither the spelled chain (root/entry/drafts) nor the
		// resolved one (root/safe/drafts), yet anyone can replace `hop` and so choose where drafts land.
		const shared = join(root, "shared");
		const safe = join(root, "safe");
		await mkdir(shared);
		await chmod(shared, 0o777);
		await mkdir(safe, { mode: 0o700 });
		await symlink(safe, join(shared, "hop"));
		await symlink(join(shared, "hop"), join(root, "entry"));
		directory = join(root, "entry", "drafts");
		expect(await failure({ text: "must not be written" })).toContain(`drafts path ${shared} can be changed by other users`);
		expect(await readdir(safe)).toEqual([]);
	});

	it("accepts links whose every traversed entry is ours", async () => {
		const safe = join(root, "safe");
		await mkdir(safe, { mode: 0o700 });
		await symlink("safe", join(root, "relative"));
		await symlink(join(root, "relative"), join(root, "entry"));
		directory = join(root, "entry", "..", "entry", "drafts");
		expect(await failure({ text: "kept" })).toBe("saved");
		expect(await readdir(join(safe, "drafts"))).toHaveLength(1);
	});

	it("accepts a sticky shared parent such as /tmp, where others cannot rename our entries", async () => {
		const sticky = join(root, "sticky");
		await mkdir(sticky);
		await chmod(sticky, 0o1777);
		directory = join(sticky, "drafts");
		expect(await failure({ text: "kept" })).toBe("saved");
		expect(await restored()).toEqual({ text: "kept" });
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
	});
});

describe("draft store trust checks", () => {
	it("refuses a symlinked directory for both load and save", async () => {
		const target = join(root, "elsewhere");
		await mkdir(target, { mode: 0o700 });
		await symlink(target, directory);
		const writer = store();
		writer.save({ text: "must not land in the target" });
		const flushed = await writer.flush();
		expect(flushed).toMatchObject({ status: "failed" });
		expect(flushed.status === "failed" ? flushed.reason : "").toContain("symbolic link");
		expect(await readdir(target)).toEqual([]);
		const loaded = await store().load();
		expect(loaded.status).toBe("refused");
	});

	it("refuses a directory others can enter, reads nothing from it and never changes its mode", async () => {
		const first = store();
		first.save({ text: "planted" });
		await first.flush();
		await chmod(directory, 0o755);
		const loaded = await store().load();
		expect(loaded).toMatchObject({ status: "refused" });
		expect(loaded.status === "refused" ? loaded.reason : "").toContain("mode 755");
		const writer = store();
		writer.save({ text: "again" });
		expect((await writer.flush()).status).toBe("failed");
		expect((await stat(directory)).mode & 0o777).toBe(0o755);
	});

	it("refuses a symlinked draft file without following it", async () => {
		const path = await written();
		const target = join(root, "target.json");
		await writeFile(target, await readFile(path, "utf8"), { mode: 0o600 });
		await rm(path);
		await symlink(target, path);
		const loaded = await store().load();
		expect(loaded).toMatchObject({ status: "refused" });
		expect(loaded.status === "refused" ? loaded.reason : "").toContain("symbolic link");
	});

	it.skipIf(process.platform === "win32")("refuses a FIFO in place of the draft file without blocking", async () => {
		const path = await written();
		await rm(path);
		execFileSync("mkfifo", [path]);
		const loaded = await store().load();
		expect(loaded).toMatchObject({ status: "refused" });
		expect(loaded.status === "refused" ? loaded.reason : "").toContain("not a regular file");
	});

	it("refuses a file above the on-disk cap without reading it", async () => {
		const path = await written();
		await writeFile(path, "x".repeat(131_073), { mode: 0o600 });
		const loaded = await store().load();
		expect(loaded).toMatchObject({ status: "refused" });
		expect(loaded.status === "refused" ? loaded.reason : "").toContain("larger than");
	});

	it("removes expired draft files and orphaned temporary files, and nothing else", async () => {
		const path = await written();
		const old = (Date.now() - DRAFT_RETENTION_MS - 60_000) / 1000;
		const staleTemporary = join(directory, `.draft-${"a".repeat(8)}-aaaa-aaaa-aaaa-${"b".repeat(12)}.tmp`);
		const freshTemporary = join(directory, `.draft-${"c".repeat(8)}-cccc-cccc-cccc-${"d".repeat(12)}.tmp`);
		const abandoned = join(directory, `${"e".repeat(32)}.json`);
		const unrelated = join(directory, "notes.txt");
		for (const file of [staleTemporary, freshTemporary, abandoned, unrelated]) await writeFile(file, "x", { mode: 0o600 });
		for (const file of [staleTemporary, abandoned, unrelated]) await utimes(file, old, old);
		expect(await restored()).toEqual({ text: "ok" });
		const names = await readdir(directory);
		expect(names).not.toContain(staleTemporary.slice(directory.length + 1));
		expect(names).not.toContain(abandoned.slice(directory.length + 1));
		expect(names).toContain(freshTemporary.slice(directory.length + 1));
		expect(names).toContain("notes.txt");
		expect(names).toContain(path.slice(directory.length + 1));
	});

	it("strips terminal escapes and control characters from restored text", async () => {
		const path = await written();
		const file = JSON.parse(await readFile(path, "utf8"));
		const hostile = "\u001b]0;pwned\u0007safe\u001b[31m red\u0085\u0000\r\n\tkept";
		await writeFile(
			path,
			JSON.stringify({ ...file, text: hostile, unconfirmed: { text: "\u001b]52;c;eA==\u0007sent", requestId: "r" } }),
			{ mode: 0o600 },
		);
		expect(await restored()).toEqual({ text: "safe red\n\tkept", unconfirmed: { text: "sent", requestId: "r" } });
	});

	it("never writes terminal escapes to the file", async () => {
		const path = await written({ text: "a\u001b[2Jb" });
		expect(JSON.parse(await readFile(path, "utf8")).text).toBe("ab");
	});
});

describe("draft location", () => {
	const runtime = (managed?: Runtime["managed"]): Runtime => ({
		...(managed === undefined ? {} : { managed }),
		env: {},
		platform: "linux",
		home: root,
		cwd: root,
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		interactive: true,
	});

	it("keeps no drafts on the managed administrator path, but does for operators and unmanaged clients", () => {
		expect(draftsFor(runtime({ id: "id", name: "bob", state: root }), "id", "default")).toBeUndefined();
		expect(draftsFor(runtime({ id: "id", name: "bob", state: root, access: "operator" }), "id", "default")).toBeDefined();
		expect(draftsFor(runtime(), "local:x", "default")).toBeDefined();
	});
});
