// Exercises inherited descriptor validation with real Linux sockets and Node adoption.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInheritedWebListener } from "../src/web/inherited-listener.ts";

const runFile = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/web-inherited-listener.py", import.meta.url));
const app = fileURLToPath(new URL("..", import.meta.url));

it.skipIf(process.platform === "linux")("refuses inherited descriptors outside Linux", async () => {
	await expect(readInheritedWebListener("/run/web.sock")).rejects.toThrow("require Linux");
});

describe.skipIf(process.platform !== "linux")("inherited web listener", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "unit-001-inherited-web-listener-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	function run(kind: string, overrides: Partial<Record<"LISTEN_PID" | "LISTEN_FDS" | "LISTEN_FDNAMES", string | null>> = {}) {
		const path = join(directory, "configured socket.sock");
		return runFile("python3", [fixture, process.execPath, kind, path, JSON.stringify(overrides)], {
			cwd: app,
			timeout: 4_000,
		});
	}

	it("serves an HTTP request from Node on the inherited listener", async () => {
		const { stdout } = await run("adopt");
		expect(stdout).toBe("adopted on fd 3");
	});

	it.each([
		{ LISTEN_PID: "0" },
		{ LISTEN_PID: null },
		{ LISTEN_FDS: "2" },
		{ LISTEN_FDS: "01" },
		{ LISTEN_FDS: null },
		{ LISTEN_FDNAMES: "unit-001-web:other" },
		{ LISTEN_FDNAMES: "unit-001-control" },
		{ LISTEN_FDNAMES: null },
	])("refuses activation metadata %j even with a valid listener", async (overrides) => {
		await expect(run("stream", overrides)).rejects.toMatchObject({
			stderr: expect.stringContaining("Expected one inherited descriptor named unit-001-web for this process"),
		});
	});

	it.each(["tcp", "control", "abstract", "newline", "bound", "connected", "datagram", "seqpacket", "fd4"])(
		"refuses the %s descriptor with otherwise valid activation metadata",
		async (kind) => {
			await expect(run(kind)).rejects.toMatchObject({
				stderr: expect.stringContaining("Inherited fd 3 must be a listening Unix stream socket bound at"),
			});
		},
	);
});
