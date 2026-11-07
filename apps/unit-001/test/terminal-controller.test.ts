// #21: Rich terminal controls use the service owner, never another storage writer.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceRequest, ServiceView } from "../src/service.ts";
import { createTerminalController, type TerminalState } from "../src/terminal-controller.ts";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "u1-control-"));
});
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	await rm(directory, { recursive: true, force: true });
});
const base: ServiceView = {
	pid: 12,
	version: "1",
	name: "bob",
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

async function server(initial: ServiceView | null = base) {
	const endpoint = join(directory, "default.sock");
	const sockets = new Set<Socket>();
	const watchers = new Set<Socket>();
	const requests: (ServiceRequest | { type: "watch" })[] = [];
	let respond = (_request: ServiceRequest, socket: Socket) => {
		socket.end('{"type":"cancelled"}\n');
	};
	const listener = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => {
			sockets.delete(socket);
			watchers.delete(socket);
		});
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const request = JSON.parse(buffer.slice(0, newline)) as ServiceRequest | { type: "watch" };
			buffer = "";
			requests.push(request);
			if (request.type === "watch") {
				watchers.add(socket);
				if (initial !== null) socket.write(`${JSON.stringify({ type: "view", view: initial })}\n`);
			} else respond(request, socket);
		});
	});
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(endpoint, resolve);
	});
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
	});
	return {
		endpoint,
		requests,
		respond(fn: typeof respond) {
			respond = fn;
		},
		view(view: ServiceView) {
			for (const socket of watchers) socket.write(`${JSON.stringify({ type: "view", view })}\n`);
		},
		wire(wire: string) {
			for (const socket of watchers) socket.write(wire);
		},
		disconnect() {
			for (const socket of watchers) socket.destroy();
		},
	};
}

async function connect(owner: Awaited<ReturnType<typeof server>>) {
	const states: TerminalState[] = [];
	const signal = new AbortController();
	const controller = createTerminalController(owner.endpoint, (state) => states.push(state), signal.signal);
	cleanup.push(async () => {
		controller.detach();
		await controller.closed;
	});
	await expect.poll(() => controller.state.connection).toBe("attached");
	return { controller, states, signal };
}

describe.skipIf(process.platform === "win32")("owner terminal controller", () => {
	it("publishes connecting state and refuses sends until initial committed state arrives", async () => {
		const owner = await server(null);
		const states: TerminalState[] = [];
		const signal = new AbortController();
		const controller = createTerminalController(owner.endpoint, (state) => states.push(state), signal.signal);
		cleanup.push(async () => {
			controller.detach();
			await controller.closed;
		});
		expect(states[0].connection).toBe("connecting");
		expect(controller.submit("not yet")).toEqual({ status: "rejected" });
		await expect.poll(() => owner.requests.length).toBe(1);
		owner.view(base);
		await expect.poll(() => controller.state.connection).toBe("attached");
		expect(controller.state.view).toEqual(base);
		expect(owner.requests).toEqual([{ type: "watch" }]);
	});

	it("submits with a stable request ID, bounds pending sends, and does not duplicate replies into views", async () => {
		const owner = await server();
		let pending: Socket | undefined;
		owner.respond((_request, socket) => {
			pending = socket;
		});
		const { controller } = await connect(owner);
		const result = controller.submit("multiline\nrequest");
		expect(result).toMatchObject({ status: "submitted", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
		expect(controller.submit("second")).toEqual({ status: "rejected" });
		await expect.poll(() => owner.requests.length).toBe(2);
		expect(owner.requests[1]).toMatchObject({
			type: "send",
			prompt: "multiline\nrequest",
			...(result.status === "submitted" ? { requestId: result.requestId } : {}),
		});
		pending?.end('{"type":"reply","reply":{"status":"answered","text":"reply is not the stream"}}\n');
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(controller.state.view).toEqual(base);
		expect(controller.state.notices.join(" ")).not.toContain("reply is not the stream");
		const next = controller.submit("third");
		expect(next).toMatchObject({ status: "submitted" });
		expect(next).not.toEqual(result);
	});

	it("passes live partials, model/usage metadata, and tool progress through the bounded service view", async () => {
		const owner = await server();
		const { controller } = await connect(owner);
		const view: ServiceView = {
			...base,
			busy: true,
			text: "partial",
			model: { provider: "faux", modelId: "faux-1" },
			usage: {
				scope: "conversation-models",
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { kind: "unknown" },
			},
			tools: [{ callId: "c", name: "read", status: "running" }],
		};
		owner.view(view);
		await expect.poll(() => controller.state.view?.text).toBe("partial");
		expect(controller.state.view).toEqual(view);
	});

	it("keeps busy state authoritative until the watch confirms cancellation", async () => {
		const owner = await server({ ...base, busy: true });
		let cancelSocket: Socket | undefined;
		owner.respond((request, socket) => {
			if (request.type === "cancel") cancelSocket = socket;
		});
		const { controller } = await connect(owner);
		controller.cancel();
		controller.cancel();
		await expect.poll(() => owner.requests.length).toBe(2);
		expect(controller.state.cancelling).toBe(true);
		cancelSocket?.end('{"type":"cancelled"}\n');
		await expect.poll(() => controller.state.cancelling).toBe(false);
		expect(controller.state.view?.busy).toBe(true);
		owner.view(base);
		await expect.poll(() => controller.state.view?.busy).toBe(false);
	});

	it("defers one cancellation until a just-submitted run becomes visible", async () => {
		const owner = await server();
		owner.respond((request, socket) => {
			if (request.type === "cancel") socket.end('{"type":"cancelled"}\n');
		});
		const { controller } = await connect(owner);
		controller.submit("start");
		controller.cancel();
		await expect.poll(() => owner.requests.filter((request) => request.type === "send").length).toBe(1);
		expect(owner.requests.filter((request) => request.type === "cancel")).toHaveLength(0);
		expect(controller.state.notices.join(" ")).toContain("queued until");
		owner.view({ ...base, busy: true });
		await expect.poll(() => owner.requests.filter((request) => request.type === "cancel").length).toBe(1);
		expect(controller.state.connection).toBe("attached");
	});

	it.each(["detach", "exit", "signal"] as const)(
		"%s closes only client connections while work remains busy",
		async (action) => {
			const owner = await server({ ...base, busy: true });
			const { controller, signal } = await connect(owner);
			if (action === "detach") controller.detach();
			else if (action === "exit") controller.submit("/exit");
			else signal.abort();
			expect(await controller.closed).toBe(0);
			expect(controller.state.connection).toBe("detached");
			expect(owner.requests).toEqual([{ type: "watch" }]);
		},
	);

	it("handles help/status/unknown commands locally and bounds notices", async () => {
		const owner = await server();
		const { controller } = await connect(owner);
		expect(controller.submit("/unknown")).toEqual({ status: "rejected" });
		for (let count = 0; count < 20; count++) expect(controller.submit("/help")).toEqual({ status: "command" });
		controller.submit("/status");
		expect(controller.state.notices).toHaveLength(8);
		expect(controller.state.notices.at(-1)).toContain("bob: ready; session default");
		expect(owner.requests).toEqual([{ type: "watch" }]);
		controller.submit("/detach");
		expect(await controller.closed).toBe(0);
	});

	it.each(["x".repeat(16_385), "\x00".repeat(12_000)])(
		"rejects oversized logical or encoded prompts without losing editor input",
		async (prompt) => {
			const owner = await server();
			const { controller } = await connect(owner);
			expect(controller.submit(prompt)).toEqual({ status: "rejected" });
			expect(controller.state.sending).toBe(false);
			expect(controller.state.notices.at(-1)).toContain("not submitted");
			expect(owner.requests).toEqual([{ type: "watch" }]);
		},
	);

	it("reports failed sends and permits another input while preserving the retry ID", async () => {
		const owner = await server();
		owner.respond((_request, socket) => socket.destroy());
		const { controller } = await connect(owner);
		const result = controller.submit("try");
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(controller.state.connection).toBe("attached");
		if (result.status !== "submitted") throw new Error("Prompt was rejected");
		expect(controller.state.notices.join(" ")).toContain(`retry request ${result.requestId}`);
		expect(controller.submit("next").status).toBe("submitted");
	});

	it("reports bounded remote failures without mutating the authoritative transcript", async () => {
		const owner = await server();
		owner.respond((_request, socket) =>
			socket.end(`${JSON.stringify({ type: "error", message: "z".repeat(2000) })}\n`),
		);
		const { controller } = await connect(owner);
		controller.submit("prompt");
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(controller.state.notices.at(-1)?.length).toBeLessThanOrEqual(1024);
		expect(controller.state.notices.at(-1)).toContain("notice truncated");
		expect(controller.state.view).toEqual(base);
	});

	it.each(["malformed", "disconnect"] as const)("%s watch terminates with a recovery diagnostic", async (kind) => {
		const owner = await server();
		const { controller } = await connect(owner);
		if (kind === "malformed") owner.wire('{"type":"view","view":{}}\n');
		else owner.disconnect();
		expect(await controller.closed).toBe(1);
		expect(controller.state.connection).toBe("failed");
		expect(controller.state.notices.join(" ")).toContain("Reattach to inspect persisted work");
		expect(owner.requests).toEqual([{ type: "watch" }]);
	});

	it("does not connect when the caller signal is already closed", async () => {
		const owner = await server();
		const signal = new AbortController();
		signal.abort();
		const controller = createTerminalController(owner.endpoint, () => {}, signal.signal);
		expect(await controller.closed).toBe(0);
		expect(owner.requests).toEqual([]);
	});

	it("closes a peer that never supplies an initial view", async () => {
		const owner = await server(null);
		const signal = new AbortController();
		const controller = createTerminalController(owner.endpoint, () => {}, signal.signal);
		cleanup.push(async () => {
			controller.detach();
			await controller.closed;
		});
		expect(await controller.closed).toBe(1);
		expect(controller.state.notices.join(" ")).toContain("within 5 seconds");
	}, 8000);
});
