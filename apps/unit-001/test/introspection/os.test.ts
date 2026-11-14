// Verifies deterministic OS facts, trusted distribution symlinks, bounded parsing and actual-host provenance.
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectOperatingSystem,
	operatingSystemFacts,
	parseOsRelease,
	readOsReleaseFile,
	renderOperatingSystemFacts,
} from "../../src/introspection/os.ts";

let directory: string | undefined;
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("deterministic OS introspection", () => {
	it("keeps Linux distribution, kernel, architecture and namespace scope separate", async () => {
		const value = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\nVERSION_ID="24.04"\n');
		const facts = await collectOperatingSystem({
			platform: "linux",
			architecture: "x64",
			kernel: { name: "Linux", release: "6.8.0-example", version: "kernel build", source: "node:os" },
			linuxRelease: async () => ({ kind: "available", source: "/etc/os-release", value }),
			macVersion: async () => {
				throw new Error("Wrong platform read.");
			},
			now: () => 1000,
		});
		expect(facts).toMatchObject({
			observedAt: 1000,
			scope: "current-process-namespace",
			container: "unknown",
			userland: { value: { id: "ubuntu", versionId: "24.04" } },
			kernel: { release: "6.8.0-example" },
		});
		expect(renderOperatingSystemFacts(facts)).toContain("Ubuntu 24.04.3 LTS");
		expect(renderOperatingSystemFacts(facts)).toContain("Sources: kernel node:os; userland /etc/os-release");
		expect(renderOperatingSystemFacts(facts)).toContain("physical-host and container identity are unknown");
	});

	it("never executes expansion, rejects malformed metadata and ignores unrelated private fields", () => {
		expect(parseOsRelease('NAME="Literal $(no_execution)"\nID=test\nSECRET="private-value"\n')).toEqual({
			id: "test",
			name: "Literal $(no_execution)",
			prettyName: null,
			versionId: null,
		});
		expect(JSON.stringify(parseOsRelease('NAME=Linux\nSECRET="private-value"\n'))).not.toContain("private");
		expect(() => parseOsRelease("NAME=Linux;touch /tmp/no\n")).toThrow("value");
		expect(() => parseOsRelease('NAME="first""second"\n')).toThrow("quoting");
		expect(() => parseOsRelease("NAME=Linux\nBAD=$(id)\n")).toThrow();
		expect(() => parseOsRelease("NAME=\u001b[31mLinux")).toThrow();
		expect(() => parseOsRelease(`NAME=${"x".repeat(17000)}`)).toThrow();
	});

	it("accepts an intentional protected relative symlink, denies writable metadata and reports limits/missing", async () => {
		directory = await mkdtemp(join(tmpdir(), "unit-os-metadata-"));
		const target = join(directory, "vendor-release");
		const selector = join(directory, "os-release");
		await writeFile(target, "ID=example\nNAME=Example\n", { mode: 0o644 });
		await symlink("vendor-release", selector);
		const uid = process.getuid?.();
		if (uid === undefined) throw new Error("POSIX test requires UID.");
		expect(await readOsReleaseFile(selector, uid)).toMatchObject({ kind: "available", value: { id: "example" } });
		await chmod(target, 0o666);
		expect(await readOsReleaseFile(selector, uid)).toMatchObject({ kind: "unavailable", reason: "permission" });
		await chmod(target, 0o644);
		await writeFile(target, "x".repeat(17000));
		expect(await readOsReleaseFile(selector, uid)).toMatchObject({ reason: "limit" });
		expect(await readOsReleaseFile(join(directory, "missing"), uid)).toMatchObject({ reason: "missing" });
	});

	it("reports unavailable evidence instead of inventing a version, and reads actual host facts without a provider", async () => {
		const unavailable = await collectOperatingSystem({
			platform: "win32",
			architecture: "arm64",
			kernel: { name: "Windows_NT", release: "kernel", version: "kernel", source: "node:os" },
			linuxRelease: async () => {
				throw new Error("Unexpected read.");
			},
			macVersion: async () => {
				throw new Error("Unexpected read.");
			},
			now: () => 1000,
		});
		expect(unavailable.userland).toMatchObject({ kind: "unavailable", reason: "unsupported" });
		expect(renderOperatingSystemFacts(unavailable)).toContain("unavailable (unsupported)");
		const before = Date.now();
		const actual = await operatingSystemFacts();
		expect(actual.platform).toBe(process.platform);
		expect(actual.architecture).toBe(process.arch);
		expect(actual.observedAt).toBeGreaterThanOrEqual(before);
		expect(actual.scope).toBe("current-process-namespace");
		if (process.platform === "darwin")
			expect(actual.userland).toMatchObject({ kind: "available", value: { id: "macos" } });
	});
});
