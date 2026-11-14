// #55: Socket-backed transport tests never call a provider or create another storage owner.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRemoteClient } from "../src/remote/client.ts";
import type { RemoteProfile } from "../src/remote/profiles.ts";
import * as ssh from "../src/remote/ssh.ts";
import type { ServiceView } from "../src/service.ts";
import type { ServiceClientEvent } from "../src/service-client.ts";
import { createServiceTerminalController } from "../src/terminal-controller.ts";

const profile: RemoteProfile = {
	schema: 1,
	name: "remote",
	host: "ssh-alias",
	agentName: "agent",
	session: "default",
	installationId: "aa49e3de-4cb1-4caf-9b98-26e4c399c12d",
};
const base: ServiceView = {
	pid: 42,
	version: "0.0.7",
	name: "agent",
	installationId: profile.installationId,
	model: null,
	usage: null,
	entries: [],
	busy: false,
	text: "",
	textTruncated: false,
	tools: [],
	historyTruncated: false,
};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function owner() {
	const directory = await mkdtemp(join(tmpdir(), "unit-remote-client-"));
	const endpoint = join(directory, "default.sock");
	const sockets = new Set<Socket>();
	const watchers = new Set<Socket>();
	const memorySockets = new Set<Socket>();
	const sendSockets = new Set<Socket>();
	const requests: { type: string; requestId?: string }[] = [];
	let view = base;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => {
			sockets.delete(socket);
			watchers.delete(socket);
			memorySockets.delete(socket);
			sendSockets.delete(socket);
		});
		socket.once("data", (data) => {
			const request = JSON.parse(String(data).trim()) as { type: string; requestId?: string };
			requests.push(request);
			if (request.type === "watch") {
				watchers.add(socket);
				socket.write(`${JSON.stringify({ type: "view", view })}\n`);
			} else if (request.type === "status")
				socket.end(
					`${JSON.stringify({
						type: "status",
						pid: 42,
						version: "0.0.7",
						name: view.name,
						installationId: view.installationId,
						busy: view.busy,
						inhibited: false,
						maintenance: { protocol: 1, state: "open", operationId: null },
						runtime: {
							application: "unit-001",
							name: view.name,
							pid: 42,
							provider: "faux",
							modelId: "faux-1",
							startedAt: 1,
							observedAt: 2,
							uptimeMs: 1,
						},
					})}\n`,
				);
			else if (request.type === "cancel") socket.end('{"type":"cancelled"}\n');
			else if (request.type === "memory") memorySockets.add(socket);
			else if (request.type === "send") sendSockets.add(socket);
			// Sends deliberately remain unresolved, representing work admitted by the remote owner.
		});
	});
	await new Promise<void>((resolve) => server.listen(endpoint, resolve));
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	const open = vi.spyOn(ssh, "openRemoteTunnel").mockImplementation(async () => ({
		endpoint,
		closed: new Promise<string>(() => {}),
		async close() {
			for (const socket of sockets) socket.destroy();
		},
	}));
	return {
		requests,
		open,
		rejectSend() {
			for (const socket of sendSockets) socket.end('{"type":"error","message":"Owner rejected send"}\n');
			sendSockets.clear();
		},
		rejectMemory() {
			for (const socket of memorySockets) socket.end('{"type":"error","message":"Owner rejected mutation"}\n');
			memorySockets.clear();
		},
		replyToMemory() {
			for (const socket of memorySockets)
				socket.end('{"type":"memory","result":{"operation":"remember","id":"remembered"}}\n');
			memorySockets.clear();
		},
		view(next: ServiceView) {
			view = next;
			for (const socket of watchers) socket.write(`${JSON.stringify({ type: "view", view })}\n`);
		},
		disconnect() {
			for (const socket of sockets) socket.destroy();
		},
	};
}

describe("remote observation and single-attempt admission", () => {
	it("#55 clears acknowledged memory rejections without exhausting uncertain request slots", async () => {
		const peer = await owner();
		const signal = new AbortController();
		const client = await connectRemoteClient(profile, "default", signal.signal);
		cleanups.push(() => client.close());
		const controller = createServiceTerminalController(client, () => {}, signal.signal);
		cleanups.push(async () => {
			controller.detach();
			await controller.closed;
		});
		await expect.poll(() => controller.state.connection).toBe("attached");
		for (let index = 0; index < 9; index++) {
			controller.submit("/memory remember rejected");
			await expect.poll(() => peer.requests.filter((request) => request.type === "memory").length).toBe(index + 1);
			peer.rejectMemory();
			await expect.poll(() => controller.state.unresolvedRequestIds).toEqual([]);
			expect(controller.submit("rejected send").status).toBe("submitted");
			await expect.poll(() => peer.requests.filter((request) => request.type === "send").length).toBe(index + 1);
			peer.rejectSend();
			await expect.poll(() => controller.state.sending).toBe(false);
			expect(controller.state.unresolvedRequestIds).toEqual([]);
		}
		expect(controller.submit("still admitted").status).toBe("submitted");
	});
	it("#55 retains uncertain memory IDs beyond notices and clears acknowledged mutations", async () => {
		const peer = await owner();
		const signal = new AbortController();
		const client = await connectRemoteClient(profile, "default", signal.signal);
		cleanups.push(() => client.close());
		const controller = createServiceTerminalController(client, () => {}, signal.signal);
		cleanups.push(async () => {
			controller.detach();
			await controller.closed;
		});
		await expect.poll(() => controller.state.connection).toBe("attached");
		controller.submit("/memory remember acknowledged");
		await expect.poll(() => peer.requests.filter((request) => request.type === "memory").length).toBe(1);
		expect(controller.state.unresolvedRequestIds).toHaveLength(1);
		peer.replyToMemory();
		await expect.poll(() => controller.state.unresolvedRequestIds).toEqual([]);
		controller.submit("/memory remember uncertain");
		await expect.poll(() => peer.requests.filter((request) => request.type === "memory").length).toBe(2);
		const ids = controller.state.unresolvedRequestIds;
		peer.disconnect();
		await expect.poll(() => controller.state.connection).toBe("connecting");
		for (let index = 0; index < 12; index++) controller.submit("/help");
		expect(controller.state.unresolvedRequestIds).toEqual(ids);
		await expect.poll(() => controller.state.connection).toBe("attached");
		expect(peer.requests.filter((request) => request.type === "memory")).toHaveLength(2);
		controller.detach();
		expect(await controller.closed).toBe(0);
		expect(controller.state.unresolvedRequestIds).toEqual(ids);
	});
	it("#55 performs exactly five SSH reconnect attempts when the host stays offline", async () => {
		const peer = await owner();
		const signal = new AbortController();
		const client = await connectRemoteClient(profile, "default", signal.signal);
		cleanups.push(() => client.close());
		const events: ServiceClientEvent[] = [];
		const watch = client.watch((event) => events.push(event), signal.signal);
		const rejected = expect(watch).rejects.toThrow("SSH offline");
		await expect.poll(() => events.at(-1)?.type).toBe("view");
		peer.open.mockRejectedValue(new Error("SSH offline"));
		peer.disconnect();
		await rejected;
		expect(peer.open).toHaveBeenCalledTimes(6);
		expect(events.filter((event) => event.type === "connecting")).toHaveLength(5);
	}, 12_000);
	it("#55 resets the reconnect budget after a fresh verified view", async () => {
		const peer = await owner();
		const signal = new AbortController();
		const client = await connectRemoteClient(profile, "default", signal.signal);
		cleanups.push(() => client.close());
		let views = 0;
		const watch = client.watch((event) => {
			if (event.type === "view") views++;
		}, signal.signal);
		void watch.catch(() => {});
		await expect.poll(() => views).toBe(1);
		for (let outage = 1; outage <= 7; outage++) {
			peer.disconnect();
			await expect.poll(() => views).toBe(outage + 1);
		}
		signal.abort();
		await watch;
		expect(peer.open).toHaveBeenCalledTimes(8);
	}, 8_000);

	it("#55 refuses a changed stream identity without retrying or admitting work", async () => {
		const peer = await owner();
		const signal = new AbortController();
		const client = await connectRemoteClient(profile, "default", signal.signal);
		cleanups.push(() => client.close());
		const events: ServiceClientEvent[] = [];
		const watch = client.watch((event) => events.push(event), signal.signal);
		const rejected = expect(watch).rejects.toThrow(/identity changed/);
		await expect.poll(() => events.length).toBe(1);
		peer.view({ ...base, installationId: "bb49e3de-4cb1-4caf-9b98-26e4c399c12d" });
		await rejected;
		expect(peer.open).toHaveBeenCalledTimes(1);
		expect(events.every((event) => event.type === "view")).toBe(true);
		await expect(client.request({ type: "send", prompt: "denied" }, signal.signal)).rejects.toThrow(/not sent/);
	});
	it("rejects a different installation before a prompt or watch is sent", async () => {
		const peer = await owner();
		peer.view({ ...base, installationId: "bb49e3de-4cb1-4caf-9b98-26e4c399c12d" });
		await expect(connectRemoteClient(profile, "default", new AbortController().signal)).rejects.toThrow(/identity/);
		expect(peer.requests).toEqual([{ type: "status" }]);
	});

	it("reconnects the watch, retains an unknown request ID and never replays its send", async () => {
		const peer = await owner();
		const signal = new AbortController();
		const client = await connectRemoteClient(profile, "default", signal.signal);
		cleanups.push(() => client.close());
		const events: ServiceClientEvent[] = [];
		const watch = client.watch((event) => events.push(event), signal.signal);
		void watch.catch(() => {});
		await expect.poll(() => events.length).toBe(1);
		const send = client.request({ type: "send", prompt: "persist once", requestId: "retain-this-id" }, signal.signal);
		const failed = expect(send).rejects.toThrow(/retain-this-id/);
		await expect.poll(() => peer.requests.filter((request) => request.type === "send").length).toBe(1);
		peer.disconnect();
		await failed;
		await expect.poll(() => events.some((event) => event.type === "connecting")).toBe(true);
		await expect(client.request({ type: "cancel" }, signal.signal)).rejects.toThrow(/not sent/);
		peer.view({ ...base, name: "renamed-agent", busy: true });
		await expect.poll(() => events.at(-1)).toMatchObject({ type: "view", view: { name: "renamed-agent", busy: true } });
		expect(peer.requests.filter((request) => request.type === "send")).toHaveLength(1);
		expect(peer.requests.filter((request) => request.type === "cancel")).toHaveLength(0);
		expect(peer.open).toHaveBeenLastCalledWith(profile, "default", expect.any(AbortSignal));
		signal.abort();
		await watch;
	});

	it("clears a pre-admission cancellation after transport loss and detaches without cancellation", async () => {
		const peer = await owner();
		const signal = new AbortController();
		const client = await connectRemoteClient(profile, "default", signal.signal);
		cleanups.push(() => client.close());
		const controller = createServiceTerminalController(client, () => {}, signal.signal);
		cleanups.push(async () => {
			controller.detach();
			await controller.closed;
		});
		await expect.poll(() => controller.state.connection).toBe("attached");
		controller.submit("work");
		controller.cancel();
		await expect.poll(() => peer.requests.some((request) => request.type === "send")).toBe(true);
		peer.disconnect();
		await expect.poll(() => controller.state.connection).toBe("connecting");
		controller.submit("/status");
		expect(controller.state.notices.some((notice) => notice.text.startsWith("Last observed (disconnected):"))).toBe(
			true,
		);
		const retainedIds = controller.state.unresolvedRequestIds;
		expect(retainedIds).toHaveLength(1);
		for (let index = 0; index < 12; index++) controller.submit("/help");
		expect(controller.state.unresolvedRequestIds).toEqual(retainedIds);
		peer.view({ ...base, busy: true });
		await expect.poll(() => controller.state.connection).toBe("attached");
		expect(peer.requests.filter((request) => request.type === "cancel")).toHaveLength(0);
		controller.detach();
		expect(await controller.closed).toBe(0);
		expect(controller.state.unresolvedRequestIds).toEqual(retainedIds);
		expect(peer.requests.filter((request) => request.type === "cancel")).toHaveLength(0);
	});
});
