// A fake service owner on a Unix socket for terminal client tests: it records requests, streams views to watchers and
// lets a test answer every other request.
import { createServer, type Socket } from "node:net";
import type { ServiceRequest, ServiceView } from "../../src/service.ts";

export type FakeOwnerRequest = ServiceRequest | { type: "watch" };

export interface FakeOwnerOptions {
	/** The view sent to each new watcher; `null` sends none, so a client waits for its first view. */
	readonly initial: ServiceView | null;
	/** Answers every mission request with this error and records it in `missionRequests`, not `requests`. */
	readonly missionError?: string;
}

export interface FakeOwner {
	readonly endpoint: string;
	/** Every request except mission requests when `missionError` is set, in arrival order. */
	readonly requests: FakeOwnerRequest[];
	readonly missionRequests: ServiceRequest[];
	/** Replaces how non-watch requests are answered; the default ends the socket with a `cancelled` reply. */
	respond(answer: (request: ServiceRequest, socket: Socket) => void): void;
	/** Sends a view to every watcher. */
	view(view: ServiceView): void;
	/** Sends raw wire text to every watcher. */
	wire(wire: string): void;
	/** Destroys every watcher's socket. */
	disconnect(): void;
	/** Destroys every socket and stops listening. */
	close(): Promise<void>;
}

/** Listens on `endpoint` as a fake owner until `close`. */
export async function startFakeOwner(endpoint: string, options: FakeOwnerOptions): Promise<FakeOwner> {
	const watchers = new Set<Socket>();
	const sockets = new Set<Socket>();
	const requests: FakeOwnerRequest[] = [];
	const missionRequests: ServiceRequest[] = [];
	let answer = (_request: ServiceRequest, socket: Socket) => {
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
			const request = JSON.parse(buffer.slice(0, newline)) as FakeOwnerRequest;
			buffer = "";
			if (request.type === "mission" && options.missionError !== undefined) {
				missionRequests.push(request);
				socket.end(`${JSON.stringify({ type: "error", message: options.missionError })}\n`);
				return;
			}
			requests.push(request);
			if (request.type === "watch") {
				watchers.add(socket);
				if (options.initial !== null) socket.write(`${JSON.stringify({ type: "view", view: options.initial })}\n`);
			} else answer(request, socket);
		});
	});
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(endpoint, resolve);
	});
	return {
		endpoint,
		requests,
		missionRequests,
		respond(next) {
			answer = next;
		},
		view(view) {
			for (const socket of watchers) socket.write(`${JSON.stringify({ type: "view", view })}\n`);
		},
		wire(wire) {
			for (const socket of watchers) socket.write(wire);
		},
		disconnect() {
			for (const socket of watchers) socket.destroy();
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
