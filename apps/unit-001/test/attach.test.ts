// #21: Attached terminals observe the owner and detach without cancelling durable work.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAttach } from "../src/attach.ts";
import type { Terminal } from "../src/repl.ts";
import type { ServiceRequest, ServiceView } from "../src/service.ts";

let directory: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
	vi.stubEnv("TERM", "xterm-256color");
	directory = await mkdtemp(join(tmpdir(), "u1-attach-"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await rm(directory, { recursive: true, force: true });
});

const base: ServiceView = {
	pid: 123,
	version: "1.0.0",
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

function terminal() {
	const input = new PassThrough();
	const output = new PassThrough();
	const out: string[] = [];
	const err: string[] = [];
	const io: Terminal = {
		input,
		output,
		out: (text) => {
			out.push(text);
		},
		err: (text) => {
			err.push(text);
		},
	};
	return { input, io, out: () => out.join(""), err: () => err.join("") };
}

async function server(initial: ServiceView | null = base) {
	const watchers = new Set<Socket>();
	const sockets = new Set<Socket>();
	const requests: (ServiceRequest | { type: "watch" })[] = [];
	let respond = (_request: ServiceRequest, socket: Socket) => {
		socket.end('{"type":"cancelled"}\n');
	};
	const endpoint = join(directory, "default.sock");
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
	cleanups.push(async () => {
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

async function attach(service: Awaited<ReturnType<typeof server>>) {
	const io = terminal();
	const controller = new AbortController();
	const running = runAttach(service.endpoint, io.io, controller.signal);
	cleanups.push(async () => {
		controller.abort();
		await running;
	});
	await expect.poll(io.err).toContain("Attached to");
	return { ...io, controller, running };
}

describe.skipIf(process.platform === "win32")("service terminal", () => {
	it("shows bounded recent history and identity before accepting prompts", async () => {
		const service = await server(null);
		const io = terminal();
		const controller = new AbortController();
		const running = runAttach(service.endpoint, io.io, controller.signal);
		cleanups.push(async () => {
			controller.abort();
			await running;
		});
		await expect.poll(() => service.requests.length).toBe(1);
		expect(io.err()).toBe("");
		service.view({
			...base,
			entries: [
				{ id: 1, role: "user", text: "previous", truncated: false },
				{ id: 2, role: "assistant", text: "answer", truncated: false },
			],
			historyTruncated: true,
		});
		await expect.poll(io.out).toContain("assistant> answer");
		expect(io.err()).toContain("session default");
		expect(io.err()).toContain("earlier entries omitted");
		io.input.write("/status\n/help\n/exit\n");
		expect(await running).toBe(0);
		expect(io.err()).toContain("bob: ready");
		// #25: plain help must expose shared cancellation, not suggest it only affects this client.
		expect(io.err().match(/shared session, including other operators' queued inputs/g)).toHaveLength(2);
		expect(io.err()).toContain("cancels while busy or submitting; otherwise it detaches");
		expect(io.err()).toContain("Detaching leaves admitted work running");
		expect(service.requests).toEqual([{ type: "watch" }]);
	});

	it("streams partials and tools, prints the committed final once, and generates a retry ID", async () => {
		const service = await server();
		let sendSocket: Socket | undefined;
		service.respond((request, socket) => {
			if (request.type === "send") sendSocket = socket;
		});
		const io = await attach(service);
		io.input.write("hello\n");
		await expect.poll(() => service.requests.length).toBe(2);
		const sent = service.requests[1];
		expect(sent).toMatchObject({
			type: "send",
			prompt: "hello",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		service.view({
			...base,
			busy: true,
			entries: [{ id: 1, role: "user", text: "hello", truncated: false }],
			text: "Hel",
		});
		service.view({
			...base,
			busy: true,
			entries: [{ id: 1, role: "user", text: "hello", truncated: false }],
			text: "Hello",
		});
		service.view({
			...base,
			entries: [
				{ id: 1, role: "user", text: "hello", truncated: false },
				{ id: 2, role: "assistant", text: "Hello!", truncated: false },
			],
		});
		sendSocket?.end('{"type":"reply","reply":{"status":"answered","text":"Hello!"}}\n');
		await expect.poll(io.out).toContain("Hello!");
		expect(io.out().match(/Hello!/g)).toHaveLength(1);
		service.view({ ...base, tools: [{ callId: "call", name: "read", status: "running" }] });
		service.view({ ...base, tools: [{ callId: "call", name: "read", status: "done" }] });
		await expect.poll(io.err).toContain("[read: done]");
		io.input.write("/exit\n");
		expect(await io.running).toBe(0);
	});

	it("bounds pending input but keeps explicit cancel responsive; cancel acknowledgement does not imply idle", async () => {
		const service = await server({ ...base, busy: true });
		let pendingSend: Socket | undefined;
		service.respond((request, socket) => {
			if (request.type === "send") pendingSend = socket;
			if (request.type === "cancel") socket.end('{"type":"cancelled"}\n');
		});
		const io = await attach(service);
		io.input.write("first\nsecond\n/cancel\n");
		await expect.poll(() => service.requests.filter((request) => request.type === "cancel").length).toBe(1);
		expect(service.requests.filter((request) => request.type === "send")).toHaveLength(1);
		expect(io.err()).toContain("additional prompts are not queued");
		await expect.poll(io.err).toContain("Cancellation requested");
		io.input.write("/status\n");
		expect(io.err()).toContain("bob: working");
		io.input.write("\x03");
		await expect.poll(() => service.requests.filter((request) => request.type === "cancel").length).toBe(2);
		pendingSend?.end('{"type":"reply","reply":{"status":"failed","reason":"aborted"}}\n');
		await expect.poll(io.err).toContain("Unanswered: aborted");
		service.view(base);
		await expect.poll(io.err).toContain("[ready]");
		io.input.write("\x03");
		expect(await io.running).toBe(0);
	});

	it.each(["exit", "detach", "eof", "signal"] as const)(
		"%s detaches without a cancellation request",
		async (action) => {
			const service = await server({ ...base, busy: true });
			const io = await attach(service);
			if (action === "eof") io.input.end();
			else if (action === "signal") io.controller.abort();
			else io.input.write(`/${action}\n`);
			expect(await io.running).toBe(0);
			expect(service.requests).toEqual([{ type: "watch" }]);
			expect(io.err()).toContain("detaching does not cancel admitted work");
		},
	);

	it("sanitizes complete cumulative snapshots and all remote labels/errors", async () => {
		const service = await server({
			...base,
			name: "bob\x1b]2;evil\x07",
			entries: [{ id: 1, role: "user", text: "safe\x1b[31m text\x00\n\ttab", truncated: false }],
		});
		const io = await attach(service);
		service.view({ ...base, busy: true, text: "one\x1b[" });
		service.view({
			...base,
			busy: true,
			text: "one\x1b[31mtwo\n",
			tools: [{ callId: "c", name: "read\x1b]52;clipboard\x07", status: "running" }],
		});
		service.respond((_request, socket) => socket.end('{"type":"error","message":"bad\\u001b[2Jerror"}\n'));
		io.input.write("prompt\n");
		await expect.poll(io.err).toContain("baderror");
		expect(io.out()).toContain("safe text\n\ttab");
		expect(io.out() + io.err()).not.toMatch(/[\x00\x1b\x7f-\x9f]/);
		expect(io.out()).toContain("onetwo");
		io.input.write("/exit\n");
		await io.running;
	});

	it("marks truncation and does not duplicate a shorter committed prefix after long live output", async () => {
		const service = await server({ ...base, busy: true, text: "a".repeat(8192), textTruncated: true });
		const io = await attach(service);
		service.view({ ...base, entries: [{ id: 1, role: "assistant", text: "a".repeat(4096), truncated: true }] });
		await expect.poll(io.err).toContain("Entry truncated");
		expect(io.out()).toBe(`assistant> ${"a".repeat(8192)}\n`);
		expect(io.err()).toContain("not the complete answer");
		io.input.write("/exit\n");
		await io.running;
	});

	it.each(["malformed", "disconnect"] as const)(
		"%s watch exits with a recovery hint instead of hanging",
		async (kind) => {
			const service = await server();
			const io = await attach(service);
			if (kind === "malformed") service.wire('{"type":"view","view":{}}\n');
			else service.disconnect();
			expect(await io.running).toBe(1);
			expect(io.err()).toContain("Reattach to inspect persisted work");
			expect(service.requests).toEqual([{ type: "watch" }]);
		},
	);

	it("bounds a line even before its terminating newline", async () => {
		const service = await server();
		const io = await attach(service);
		io.input.write("x".repeat(16_385));
		expect(await io.running).toBe(2);
		expect(io.err()).toContain("Input exceeds 16 KiB");
		expect(service.requests).toEqual([{ type: "watch" }]);
	});
	it("queues Ctrl+C cancellation until a pending submission becomes visible", async () => {
		const service = await server();
		service.respond((request, socket) => {
			if (request.type === "cancel") socket.end('{"type":"cancelled"}\n');
		});
		const io = await attach(service);
		io.input.write("hello\r\x03");
		await expect.poll(io.err).toContain("Cancellation queued");
		expect(service.requests.filter((request) => request.type === "cancel")).toHaveLength(0);
		service.view({ ...base, busy: true });
		await expect.poll(() => service.requests.filter((request) => request.type === "cancel").length).toBe(1);
		expect(io.err()).not.toContain("Detached");
		io.input.write("/exit\r");
		expect(await io.running).toBe(0);
	});

	it.each(["enter", "backspace"] as const)(
		"bounds current input rather than counting prior %s bytes",
		async (kind) => {
			const service = await server();
			const io = await attach(service);
			if (kind === "enter") for (let index = 0; index < 2200; index++) io.input.write("/status\r");
			else for (let index = 0; index < 2000; index++) io.input.write("12345\x7f\x7f\x7f\x7f\x7f");
			io.input.write("/exit\r");
			expect(await io.running).toBe(0);
			expect(io.err()).not.toContain("Input exceeds");
		},
	);

	it("preserves an edited draft and cursor when asynchronous output arrives", async () => {
		const service = await server();
		const io = await attach(service);
		io.input.write("draft\x1b[D\x1b[D");
		service.view({ ...base, busy: true, text: "remote output\n" });
		expect(io.out()).not.toContain("remote output");
		io.input.write("X\r");
		await expect.poll(() => service.requests.length).toBe(2);
		expect(service.requests[1]).toMatchObject({ type: "send", prompt: "draXft" });
		io.input.write("/exit\r");
		expect(await io.running).toBe(0);
	});

	it("repeats identical answers on a later prompt without suppressing its live text", async () => {
		const service = await server({
			...base,
			entries: [{ id: 1, role: "assistant", text: "same\n", truncated: false }],
		});
		const io = await attach(service);
		service.view({
			...base,
			busy: true,
			entries: [
				{ id: 1, role: "assistant", text: "same\n", truncated: false },
				{ id: 2, role: "user", text: "again", truncated: false },
			],
			text: "same\n",
		});
		await expect.poll(() => io.out().match(/same/g)?.length).toBe(2);
		service.view({
			...base,
			entries: [
				{ id: 1, role: "assistant", text: "same\n", truncated: false },
				{ id: 2, role: "user", text: "again", truncated: false },
				{ id: 3, role: "assistant", text: "same\n", truncated: false },
			],
		});
		await expect.poll(() => io.err().match(/\[ready\]/g)?.length).toBe(2);
		io.input.write("/exit\r");
		await io.running;
		expect(io.out().match(/same/g)).toHaveLength(2);
	});
	it("catches synchronous encoded-request overflow without crashing the client", async () => {
		const service = await server();
		const io = terminal();
		const controller = new AbortController();
		const running = runAttach(service.endpoint, { ...io.io, output: undefined }, controller.signal);
		cleanups.push(async () => {
			controller.abort();
			await running;
		});
		await expect.poll(io.err).toContain("Attached to");
		io.input.write(`${"\x00".repeat(12_000)}\n`);
		await expect.poll(io.err).toContain("Service request exceeds 64 KiB");
		expect(service.requests).toEqual([{ type: "watch" }]);
		io.input.write("/exit\n");
		expect(await running).toBe(0);
	});

	it("bounds a logical draft assembled across small input chunks", async () => {
		const service = await server();
		const io = await attach(service);
		io.input.write("x".repeat(9000));
		io.input.write("x".repeat(9000));
		expect(await io.running).toBe(2);
		expect(service.requests).toEqual([{ type: "watch" }]);
	});

	it("times out a peer that never provides initial state", async () => {
		const service = await server(null);
		const io = terminal();
		const controller = new AbortController();
		const running = runAttach(service.endpoint, io.io, controller.signal);
		cleanups.push(async () => {
			controller.abort();
			await running;
		});
		expect(await running).toBe(1);
		expect(io.err()).toContain("within 5 seconds");
	}, 8000);
});
