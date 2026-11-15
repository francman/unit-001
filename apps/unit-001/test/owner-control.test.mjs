// Exercises the provider-free private control transport against real local sockets.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { controlRequest, readOwnerControl } from "../deploy/control.mjs";

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
