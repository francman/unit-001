// Exercises the browser trust boundary against a synthetic owner without model or storage access.
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceClient } from "../src/service-client.ts";
import type { ServiceRequest } from "../src/service.ts";
import { parseWebRequest } from "../src/web/contract.ts";
import { createWebGateway } from "../src/web/gateway.ts";

const servers: ReturnType<typeof createWebGateway>[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.map((gateway) => gateway.close()));
	servers.length = 0;
});

async function fixture() {
	const requests: ServiceRequest[] = [];
	const client: ServiceClient = {
		session: "default",
		ownerSession: "default",
		request: async (request) => {
			requests.push(request);
			return { type: "cancelled" };
		},
		watch: async (_listener, signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	};
	// Reserve an ephemeral port first so the gateway can enforce its exact configured origin.
	const reservation = createWebGateway({
		client,
		origin: "http://127.0.0.1:1",
		secret: "a".repeat(32),
		assets: new Map(),
	});
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
	const body = (await pair.json()) as { csrfToken: string };
	const headers = {
		Origin: origin,
		"Content-Type": "application/json",
		Cookie: pair.headers.get("set-cookie")?.split(";")[0] ?? "",
		"X-Unit-CSRF": body.csrfToken,
	};
	return { origin, headers, requests, client, pair };
}

describe("web gateway", () => {
	it("requires authenticated exact-origin JSON and a per-session CSRF token", async () => {
		const { origin, headers, requests, pair } = await fixture();
		expect(pair.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
		const body = JSON.stringify({ requestId: "cancel-1", operation: { type: "cancel" } });
		expect(
			(
				await fetch(`${origin}/api/v1/requests`, {
					method: "POST",
					headers: { Origin: origin, "Content-Type": "application/json" },
					body,
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(`${origin}/api/v1/requests`, {
					method: "POST",
					headers: { ...headers, "X-Unit-CSRF": "wrong" },
					body,
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${origin}/api/v1/requests`, {
					method: "POST",
					headers: { ...headers, Origin: "https://evil.example" },
					body,
				})
			).status,
		).toBe(403);
		expect(
			await new Promise<number | undefined>((resolve) => {
				const req = request(`${origin}/api/v1/session`, { headers: { Host: "evil.example" } }, (response) => {
					response.resume();
					resolve(response.statusCode);
				});
				req.end();
			}),
		).toBe(403);
		expect(
			(await fetch(`${origin}/api/v1/session`, { headers: { "X-Forwarded-Host": "trusted.example" } }))
				.status,
		).toBe(403);
		expect(requests).toEqual([]);
	});

	it("consumes pairing once and expires authenticated sessions", async () => {
		const { origin, headers } = await fixture();
		expect(
			(
				await fetch(`${origin}/api/v1/session`, {
					method: "POST",
					headers,
					body: JSON.stringify({ secret: "a".repeat(32) }),
				})
			).status,
		).toBe(429);
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 1_800_001);
		expect(await (await fetch(`${origin}/api/v1/session`, { headers })).json()).toEqual({
			authenticated: false,
		});
	});

	it("deduplicates stable IDs and refuses cross-agent or privileged input", async () => {
		const { origin, headers, requests } = await fixture();
		const send = (operation: unknown) =>
			fetch(`${origin}/api/v1/requests`, {
				method: "POST",
				headers,
				body: JSON.stringify({ requestId: "stable", operation }),
			});
		expect((await send({ type: "cancel" })).status).toBe(200);
		expect((await send({ type: "cancel" })).status).toBe(200);
		expect(requests).toEqual([{ type: "cancel" }]);
		expect((await send({ type: "send", prompt: "different" })).status).toBe(409);
		expect((await send({ type: "status", installationId: "another" })).status).toBe(400);
		expect((await send({ type: "mission", request: { operation: "approve-local" } })).status).toBe(400);
	});

	it("returns an unknown outcome without replaying a failed owner request", async () => {
		const { origin, headers, client, requests } = await fixture();
		client.request = async (request) => {
			requests.push(request);
			throw new Error("private credential");
		};
		const body = JSON.stringify({ requestId: "uncertain", operation: { type: "send", prompt: "work" } });
		const first = await (await fetch(`${origin}/api/v1/requests`, { method: "POST", headers, body })).text();
		expect(first).toContain('"state":"unknown"');
		expect(first).not.toContain("private credential");
		await fetch(`${origin}/api/v1/requests`, { method: "POST", headers, body });
		expect(requests).toHaveLength(1);
	});

	it("rejects unconfirmed forget and caller-supplied authority", () => {
		expect(() =>
			parseWebRequest({
				requestId: "f",
				operation: { type: "memory", request: { operation: "forget", id: "record" } },
			}),
		).toThrow();
		expect(() =>
			parseWebRequest({
				requestId: "f",
				operation: {
					type: "memory",
					request: { operation: "forget", id: "record", confirmed: true, requestId: "forged" },
				},
			}),
		).toThrow();
		expect(
			parseWebRequest({
				requestId: "f",
				operation: { type: "memory", request: { operation: "forget", id: "record", confirmed: true } },
			}),
		).toEqual({
			requestId: "f",
			operation: {
				type: "memory",
				request: { operation: "forget", id: "record", confirmed: true, requestId: "f" },
			},
		});
	});
});
