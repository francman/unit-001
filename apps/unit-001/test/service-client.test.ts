import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServiceView } from "../src/service.ts";
import { localServiceClient } from "../src/service-client.ts";

const view: ServiceView = {
	pid: 42,
	version: "0.0.7",
	name: "agent",
	installationId: null,
	model: null,
	usage: null,
	entries: [],
	busy: false,
	text: "",
	textTruncated: false,
	tools: [],
	historyTruncated: false,
};

async function owner(onTestFinished: (cleanup: () => Promise<void>) => void) {
	const directory = await mkdtemp(join(tmpdir(), "unit-service-client-"));
	const endpoint = join(directory, "default.sock");
	const watch = Promise.withResolvers<Socket>();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.once("data", () => watch.resolve(socket));
	});
	onTestFinished(async () => {
		for (const socket of sockets) socket.destroy();
		if (server.listening) {
			const closed = once(server, "close");
			server.close();
			await closed;
		}
		await rm(directory, { recursive: true, force: true });
		vi.useRealTimers();
	});
	const listening = once(server, "listening");
	server.listen(endpoint);
	await listening;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	return { client: localServiceClient(endpoint), watch: watch.promise };
}

describe("local service client watch", () => {
	it("fails a silent first view at five seconds and closes the watch socket", async ({ onTestFinished }) => {
		const peer = await owner(onTestFinished);
		const watching = peer.client.watch(() => {}, new AbortController().signal);
		const failed = expect(watching).rejects.toThrow("Service did not provide initial state within 5 seconds");
		const socket = await peer.watch;
		const closed = once(socket, "close");
		await vi.advanceTimersByTimeAsync(5_000);
		await failed;
		await closed;
	});

	it("resolves caller abort before the first view and clears the deadline", async ({ onTestFinished }) => {
		const peer = await owner(onTestFinished);
		const signal = new AbortController();
		const watching = peer.client.watch(() => {}, signal.signal);
		await peer.watch;
		signal.abort();
		await watching;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps streaming past the deadline once a first view arrives", async ({ onTestFinished }) => {
		const peer = await owner(onTestFinished);
		const signal = new AbortController();
		const listener = vi.fn();
		const watching = peer.client.watch(listener, signal.signal);
		void watching.catch(() => {});
		const socket = await peer.watch;
		socket.write(`${JSON.stringify({ type: "view", view })}\n`);
		await expect.poll(() => listener.mock.calls.length).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		const next = { ...view, busy: true };
		socket.write(`${JSON.stringify({ type: "view", view: next })}\n`);
		await expect.poll(() => listener.mock.lastCall?.[0]).toEqual({ type: "view", view: next });
		signal.abort();
		await watching;
	});

	it("preserves a pre-view transport error and clears the deadline", async ({ onTestFinished }) => {
		const peer = await owner(onTestFinished);
		const watching = peer.client.watch(() => {}, new AbortController().signal);
		const failed = expect(watching).rejects.toThrow("The service disconnected");
		(await peer.watch).destroy();
		await failed;
		expect(vi.getTimerCount()).toBe(0);
	});
});
