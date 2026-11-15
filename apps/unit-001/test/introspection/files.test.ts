// Verifies #57 public-file containment, bounded paging and credential-fragment redaction.
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { implementationExcerpt, redactImplementationText } from "../../src/introspection/files.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "unit-inspect-files-"));
	await mkdir(join(root, "src"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("public implementation excerpts", () => {
	it("#57 redacts quoted, JSON, compound and bearer credential literals", () => {
		const input =
			'PASSWORD="two words, private; value"\n"password": "json-private"\nBOT_TOKEN=bare;compound-secret\nAuthorization: Bearer abcdefghijklmnopqrst\nhttps://user:privatepass@example.test\nxoxb-abcdefghijklmnop\n';
		const result = redactImplementationText(input);
		expect(result).not.toMatch(/two words|json-private|compound-secret|abcdefghijklmnop|privatepass/);
	});
	it("#57 excludes credentials, traversal, absolute paths and symlinks", async () => {
		const secret = join(root, "auth.json");
		await writeFile(secret, "private-owner-marker");
		await symlink(secret, join(root, "src/escape.ts"));
		for (const path of [
			"auth.json",
			"../auth.json",
			"/etc/passwd",
			"src/../auth.json",
			"src/escape.ts",
			".env",
			"src/.hidden.ts",
		]) {
			const result = await implementationExcerpt(root, path);
			expect(result.kind).toBe("unavailable");
			expect(JSON.stringify(result)).not.toContain("private-owner-marker");
		}
	});
	it("#57 denies FIFOs and group-writable files without blocking", async () => {
		const fifo = join(root, "src/fifo.ts");
		execFileSync("mkfifo", [fifo]);
		expect(await implementationExcerpt(root, "src/fifo.ts")).toMatchObject({
			kind: "unavailable",
			reason: "not_regular",
		});
		await writeFile(join(root, "src/writable.ts"), "public");
		await chmod(join(root, "src/writable.ts"), 0o666);
		expect(await implementationExcerpt(root, "src/writable.ts")).toMatchObject({
			kind: "unavailable",
			reason: "denied",
		});
	});
	it("#57 redacts whole-file credential forms before paging across boundaries", async () => {
		const key = `sk-ant-${"secret-marker-".repeat(10)}`;
		await writeFile(
			join(root, "src/public.ts"),
			`${"x".repeat(8180)}${key}\nOPENAI_API_KEY=literal-secret-value\n-----BEGIN PRIVATE KEY-----\nprivate-key-marker\n-----END PRIVATE KEY-----\n`,
		);
		const first = await implementationExcerpt(root, "src/public.ts");
		if (first.kind !== "available") throw new Error("Expected file");
		expect(first.nextOffset).not.toBeNull();
		expect(first.redacted).toBe(true);
		const second = await implementationExcerpt(root, "src/public.ts", first.nextOffset!);
		for (const value of [first, second])
			expect(JSON.stringify(value)).not.toMatch(/secret-marker|literal-secret-value|private-key-marker/);
		expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(8192);
	});
	it("#57 pages UTF-8 on complete boundaries and rejects oversized or missing evidence", async () => {
		await writeFile(join(root, "src/long-line.ts"), "x".repeat(131072));
		expect(await implementationExcerpt(root, "src/long-line.ts")).toMatchObject({
			kind: "available",
			nextOffset: 8192,
		});
		await writeFile(join(root, "src/unicode.ts"), "語".repeat(4000));
		const first = await implementationExcerpt(root, "src/unicode.ts");
		if (first.kind !== "available") throw new Error("Expected file");
		expect(first.nextOffset).toBe(8190);
		expect(await implementationExcerpt(root, "src/unicode.ts", 1)).toMatchObject({
			kind: "unavailable",
			reason: "invalid_text",
		});
		expect(await implementationExcerpt(root, "src/unicode.ts", first.nextOffset!)).toMatchObject({
			kind: "available",
			nextOffset: null,
		});
		await writeFile(join(root, "src/large.ts"), "x".repeat(131073));
		expect(await implementationExcerpt(root, "src/large.ts")).toMatchObject({ kind: "unavailable", reason: "limit" });
		expect(await implementationExcerpt(root, "src/missing.ts")).toMatchObject({
			kind: "unavailable",
			reason: "missing",
		});
	});
});
