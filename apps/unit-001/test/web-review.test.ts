// Independently exercises live HTTP stream and owner-request cleanup at session boundaries.
import { once } from "node:events";
import { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceClient } from "../src/service-client.ts";
import { createWebGateway, type WebGateway } from "../src/web/gateway.ts";
import { freePort, sessionHeaders } from "./helpers/web.ts";

const gateways: WebGateway[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

async function fixture() {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	let streamAborted = false;
	const client: ServiceClient = {
		session: "default",
		ownerSession: "default",
		request: async () => ({ type: "cancelled" }),
		watch: async (listener, signal) => {
			listener({ type: "connecting", message: "synthetic owner" });
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						streamAborted = true;
						resolve();
					},
					{ once: true },
				);
			});
		},
	};
	const gateway = createWebGateway({ client, origin, assets: new Map() });
	gateways.push(gateway);
	gateway.server.listen(port, "127.0.0.1");
	await once(gateway.server, "listening");
	const response = await fetch(`${origin}/api/v1/session`);
	expect(response.status).toBe(200);
	const session = (await response.json()) as { csrfToken: string };
	const headers = sessionHeaders(origin, session.csrfToken);
	return { gateway, origin, headers, client, streamAborted: () => streamAborted };
}

describe("gateway streams and shutdown", () => {
	it("#65 detaches a stream whose queued bytes reach the fixed bound", async () => {
		const f = await fixture();
		let publish = () => {};
		let aborted = false;
		f.client.watch = async (listener, signal) => {
			publish = () => listener({ type: "connecting", message: "fixture" });
			await new Promise<void>((resolve) =>
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve();
					},
					{ once: true },
				),
			);
		};
		const response = await fetch(`${f.origin}/api/v1/events`, { headers: f.headers });
		const queued = vi.spyOn(ServerResponse.prototype, "writableLength", "get").mockReturnValue(1_048_576);
		try {
			publish();
			await expect.poll(() => aborted).toBe(true);
		} finally {
			queued.mockRestore();
			await response.body?.cancel().catch(() => undefined);
		}
	});
	it("#65 streams a healthy 80 KiB frame and bounds simultaneous subscriptions", async () => {
		const f = await fixture();
		f.client.watch = async (listener, signal) => {
			listener({
				type: "view",
				view: {
					pid: 1,
					name: "agent",
					version: "fixture",
					installationId: null,
					model: null,
					usage: null,
					entries: Array.from({ length: 20 }, (_, id) => ({
						id,
						role: "assistant" as const,
						text: "x".repeat(4096),
						truncated: false,
					})),
					busy: false,
					text: "",
					textTruncated: false,
					historyTruncated: false,
					tools: [],
				},
			});
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		};
		const first = await fetch(`${f.origin}/api/v1/events`, { headers: f.headers });
		const reader = first.body!.getReader();
		let text = "";
		while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
		expect(text.length).toBeGreaterThan(80000);
		const second = await fetch(`${f.origin}/api/v1/events`, { headers: f.headers });
		expect(second.status).toBe(200);
		expect((await fetch(`${f.origin}/api/v1/events`, { headers: f.headers })).status).toBe(429);
		await reader.cancel();
		await second.body?.cancel();
	});
	it("shutdown aborts an open event stream before waiting for HTTP closure", async () => {
		const f = await fixture();
		const stream = await fetch(`${f.origin}/api/v1/events`, { headers: f.headers });
		await stream.body?.getReader().read();
		await f.gateway.close();
		expect(f.streamAborted()).toBe(true);
		gateways.splice(gateways.indexOf(f.gateway), 1);
	}, 3000);

	it("shutdown aborts a pending owner request", async () => {
		const f = await fixture();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let aborted = false;
		f.client.request = async (_request, signal) => {
			started();
			return await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new Error("private fixture credential"));
					},
					{ once: true },
				);
			});
		};
		const pending = fetch(`${f.origin}/api/v1/requests`, {
			method: "POST",
			headers: f.headers,
			body: JSON.stringify({ requestId: "pending", operation: { type: "status" } }),
		});
		const disconnected = expect(pending).rejects.toThrow();
		await ready;
		await f.gateway.close();
		await disconnected;
		expect(aborted).toBe(true);
		gateways.splice(gateways.indexOf(f.gateway), 1);
	});
});
