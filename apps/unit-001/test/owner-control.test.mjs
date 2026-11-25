// Exercises the provider-free private control transport against real local sockets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { controlRequest, readOwnerControl, readOwnerFrame } from "../deploy/control.mjs";

test("#18 control entry point executes through the installation's current symlink", async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-owner-entry-"));
	try {
		const entry = join(directory, "control.mjs");
		await symlink(fileURLToPath(new URL("../deploy/control.mjs", import.meta.url)), entry);
		const result = spawnSync(process.execPath, [entry, "invalid-id", "1000", "service-status"], {
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /installation account|Invalid owner control installation identity/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function withOwner(listener, verify) {
	const directory = await mkdtemp(join(tmpdir(), "unit-owner-control-"));
	const endpoint = join(directory, "owner.sock");
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		listener(socket);
	});
	try {
		await new Promise((resolve) => server.listen(endpoint, resolve));
		await verify(endpoint);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	}
}

test("#18 provider-free controls admit only status and exact maintenance arguments", () => {
	assert.deepEqual(controlRequest(["service-status"]), { type: "status" });
	assert.deepEqual(controlRequest(["maintenance-enter", "--operation-id", "update-1", "--timeout-ms", "0"]), {
		type: "maintenance-enter",
		operationId: "update-1",
		timeoutMs: 0,
	});
	assert.deepEqual(controlRequest(["maintenance-release", "--operation-id", "update-1"]), {
		type: "maintenance-release",
		operationId: "update-1",
	});
	for (const args of [
		["send", "text"],
		["service-status", "extra"],
		["maintenance-release", "--operation-id", ""],
		["maintenance-enter", "--operation-id", "x", "--timeout-ms", "30001"],
	])
		assert.throws(() => controlRequest(args), /control operation/);
});

test("#18 fragmented owner responses preserve exact wire data", async () => {
	await withOwner(
		(socket) =>
			socket.once("data", (request) => {
				assert.deepEqual(JSON.parse(request), { type: "status" });
				socket.write('{"type":"sta');
				socket.end('tus","pid":123,"installationId":"fixture"}\n');
			}),
		async (endpoint) => {
			assert.deepEqual(await readOwnerControl(endpoint, ["service-status"], 1000), {
				type: "status",
				pid: 123,
				installationId: "fixture",
			});
		},
	);
});

test("#18 oversized, incomplete, invalid and rejected responses fail closed", async () => {
	for (const [bytes, expected] of [
		[`${"x".repeat(16385)}\n`, /16 KiB/],
		['{"type":"status"}', /complete control response/],
		['{"type":"reply"}\n', /Unexpected/],
		['{"type":"error","message":"denied"}\n', /denied/],
	])
		await withOwner(
			(socket) => socket.once("data", () => socket.end(bytes)),
			async (endpoint) => {
				await assert.rejects(readOwnerControl(endpoint, ["service-status"], 1000), expected);
			},
		);
});

test("#18 ongoing bytes cannot extend the total control deadline", async () => {
	await withOwner(
		(socket) => {
			const interval = setInterval(() => socket.write(" "), 5);
			socket.once("close", () => clearInterval(interval));
		},
		async (endpoint) => {
			await assert.rejects(readOwnerControl(endpoint, ["service-status"], 40), /deadline/);
		},
	);
});

// codex-12: mission and channel administration hold the management lock while they wait for this reply.
test("owner frames keep one total deadline and their caller's size limit", async () => {
	await withOwner(
		(socket) => {
			const interval = setInterval(() => socket.write(" "), 5);
			socket.once("close", () => clearInterval(interval));
		},
		async (endpoint) => {
			await assert.rejects(readOwnerFrame(endpoint, { type: "mission" }, 40, 1024 * 1024), /deadline/);
		},
	);
	for (const [bytes, expected] of [
		[`${"x".repeat(2049)}\n`, /exceeds 2 KiB/],
		['{"type":"mission"', /complete control response/],
		['{"type":"error","message":"denied"}\n', /denied/],
	])
		await withOwner(
			(socket) => socket.once("data", () => socket.end(bytes)),
			async (endpoint) => {
				await assert.rejects(readOwnerFrame(endpoint, { type: "mission" }, 1000, 2048), expected);
			},
		);
	await withOwner(
		(socket) =>
			socket.once("data", (request) => {
				assert.deepEqual(JSON.parse(request), { type: "channels", request: { operation: "status" } });
				socket.end('{"type":"channels","result":{}}\n');
			}),
		async (endpoint) => {
			assert.deepEqual(
				await readOwnerFrame(endpoint, { type: "channels", request: { operation: "status" } }, 1000, 2048),
				{ type: "channels", result: {} },
			);
		},
	);
});
