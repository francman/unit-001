// #26 (sec-ipc Low 1): the browser receives only the closed workspace projection of each owner frame.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceView } from "../src/service.ts";
import type { ServiceClient } from "../src/service-client.ts";
import { parseWebRequest } from "../src/web/contract.ts";
import { createWebGateway } from "../src/web/gateway.ts";

const servers: ReturnType<typeof createWebGateway>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((gateway) => gateway.close()));
});

const ownerFrame: ServiceView = {
	pid: 4242,
	version: "1.0.0",
	name: "bob",
	installationId: null,
	model: { provider: "faux", modelId: "faux-1" },
	usage: null,
	entries: [{ id: 1, role: "assistant", text: "hello", truncated: false }],
	busy: false,
	text: "",
	textTruncated: false,
	tools: [{ callId: "toolu_1", name: "bash", status: "failed", reason: { code: "exit_code", exitCode: 2 } }],
	historyTruncated: false,
	failure: { reason: "model_error", problem: "overloaded" },
	retry: { attempt: 2, at: 1_700_000_000_000, problem: "rate_limited" },
};

async function gateway(view: ServiceView) {
	const client: ServiceClient = {
		session: "default",
		ownerSession: "default",
		request: async () => ({ type: "cancelled" }),
		watch: async (listener, signal) => {
			listener({ type: "view", view });
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	};
	// Reserve an ephemeral port first so the gateway can enforce its exact configured origin.
	const reservation = createWebGateway({ client, origin: "http://127.0.0.1:1", secret: "a".repeat(32), assets: new Map() });
	reservation.server.listen(0, "127.0.0.1");
	await once(reservation.server, "listening");
	const port = (reservation.server.address() as AddressInfo).port;
	await reservation.close();
	const origin = `http://127.0.0.1:${port}`;
	const server = createWebGateway({ client, origin, secret: "a".repeat(32), assets: new Map() });
	servers.push(server);
	server.server.listen(port, "127.0.0.1");
	await once(server.server, "listening");
	const pair = await fetch(`${origin}/api/v1/session`, {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({ secret: "a".repeat(32) }),
	});
	return { origin, cookie: pair.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function firstViewFrame(origin: string, cookie: string): Promise<string> {
	const abort = new AbortController();
	const response = await fetch(`${origin}/api/v1/events`, { headers: { Origin: origin, Cookie: cookie }, signal: abort.signal });
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let stream = "";
	try {
		while (!stream.includes("\n\n")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			stream += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		abort.abort();
	}
	const frame = stream.split("\n\n")[0];
	expect(frame.startsWith("event: view\n")).toBe(true);
	return frame.slice(frame.indexOf("data: ") + 6);
}

describe("browser frame projection", () => {
	it("forwards only workspace fields: no failure, retry, tool reason or owner PID", async () => {
		const { origin, cookie } = await gateway(ownerFrame);
		const data = JSON.parse(await firstViewFrame(origin, cookie)) as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(
			["busy", "entries", "historyTruncated", "installationId", "model", "name", "text", "textTruncated", "tools", "usage", "version"].sort(),
		);
		expect(data.tools).toEqual([{ callId: "toolu_1", name: "bash", status: "failed" }]);
	});

	it("never exposes the tool-evidence operation to the browser", () => {
		expect(() => parseWebRequest({ requestId: "e", operation: { type: "tool-evidence", callId: "toolu_1" } })).toThrow();
		expect(() => parseWebRequest({ requestId: "e", operation: { type: "tool-evidence" } })).toThrow(
			"Operation is unavailable on the browser surface.",
		);
	});
});
