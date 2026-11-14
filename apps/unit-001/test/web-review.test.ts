// Independently exercises live HTTP stream and owner-request cleanup at session boundaries.
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceClient } from "../src/service-client.ts";
import { createWebGateway, type WebGateway } from "../src/web/gateway.ts";

const gateways: WebGateway[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

async function fixture() {
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const port = (reservation.address() as AddressInfo).port;
	await new Promise<void>((resolve) => reservation.close(() => resolve()));
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
	const gateway = createWebGateway({ client, origin, secret: "fixture-secret-".repeat(4), assets: new Map() });
	gateways.push(gateway);
	gateway.server.listen(port, "127.0.0.1");
	await once(gateway.server, "listening");
	const pair = await fetch(`${origin}/api/v1/session`, {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({ secret: "fixture-secret-".repeat(4) }),
	});
	expect(pair.status).toBe(200);
	const session = (await pair.json()) as { csrfToken: string };
	const headers = {
		Origin: origin,
		"Content-Type": "application/json",
		Cookie: pair.headers.get("set-cookie")?.split(";")[0] ?? "",
		"X-Unit-CSRF": session.csrfToken,
	};
	return { gateway, origin, headers, client, streamAborted: () => streamAborted };
}

describe("independent browser session lifecycle acceptance", () => {
	it("logout aborts an open event stream and invalidates its cookie", async () => {
		const f = await fixture();
		const stream = await fetch(`${f.origin}/api/v1/events`, { headers: f.headers });
		const reader = stream.body?.getReader();
		expect((await reader?.read())?.value?.length).toBeGreaterThan(0);
		const logout = await fetch(`${f.origin}/api/v1/logout`, { method: "POST", headers: f.headers, body: "{}" });
		expect(logout.status).toBe(200);
		expect(f.streamAborted()).toBe(true);
		await reader?.read().catch(() => undefined);
		expect((await fetch(`${f.origin}/api/v1/events`, { headers: f.headers })).status).toBe(401);
	});

	it("shutdown aborts an open event stream before waiting for HTTP closure", async () => {
		const f = await fixture();
		const stream = await fetch(`${f.origin}/api/v1/events`, { headers: f.headers });
		await stream.body?.getReader().read();
		await f.gateway.close();
		expect(f.streamAborted()).toBe(true);
		gateways.splice(gateways.indexOf(f.gateway), 1);
	}, 3000);

	it("expiry closes existing event streams without another client request", async () => {
		const f = await fixture();
		const stream = await fetch(`${f.origin}/api/v1/events`, { headers: f.headers });
		const reader = stream.body?.getReader();
		await reader?.read();
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_800_001);
		await reader?.read().catch(() => undefined);
		expect(f.streamAborted()).toBe(true);
	}, 4000);

	it("logout aborts a pending owner wait and denies its late response without exposing errors", async () => {
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
		await ready;
		await fetch(`${f.origin}/api/v1/logout`, { method: "POST", headers: f.headers, body: "{}" });
		const response = await pending;
		const result = await response.text();
		expect(aborted).toBe(true);
		expect(response.status).toBe(401);
		expect(result).not.toContain("private fixture credential");
	});
});
