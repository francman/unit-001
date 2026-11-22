// Exercises the browser trust boundary against a synthetic owner without model or storage access.
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceRequest, ServiceResponse } from "../src/service.ts";
import type { ServiceClient } from "../src/service-client.ts";
import { parseWebRequest } from "../src/web/contract.ts";
import { createWebGateway, type ManagedWebAgreement } from "../src/web/gateway.ts";

const servers: ReturnType<typeof createWebGateway>[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.map((gateway) => gateway.close()));
	servers.length = 0;
});

async function unpairedFixture(managedAgreement?: ManagedWebAgreement, managed = false) {
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
	const server = createWebGateway({
		client,
		origin,
		secret: "a".repeat(32),
		managedAgreement,
		managed,
		assets: new Map([
			["/", { contentType: "text/html; charset=utf-8", body: Buffer.from("<title>Workspace</title>") }],
		]),
	});
	servers.push(server);
	server.server.listen(port, "127.0.0.1");
	await once(server.server, "listening");
	const pairWith = (secret: string) =>
		fetch(`${origin}/api/v1/session`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
	return { origin, requests, client, pairWith };
}

async function fixture(managedAgreement?: ManagedWebAgreement, managed = false) {
	const f = await unpairedFixture(managedAgreement, managed);
	const pair = await f.pairWith("a".repeat(32));
	expect(pair.status).toBe(200);
	const body = (await pair.json()) as { sessionToken: string; csrfToken: string; expiresAt: number };
	const headers = {
		Origin: f.origin,
		"Content-Type": "application/json",
		Authorization: `Bearer ${body.sessionToken}`,
		"X-Unit-CSRF": body.csrfToken,
	};
	return { ...f, headers, pair, body };
}

// Put a harmless marker on every object layer, including nested rows.
function annotated(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(annotated);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries([
		...Object.entries(value).map(([key, item]) => [key, annotated(item)]),
		["annotation", "sample"],
	]);
}

async function postOwnerReply(f: Awaited<ReturnType<typeof fixture>>, requestId: string, operation: unknown) {
	const response = await fetch(`${f.origin}/api/v1/requests`, {
		method: "POST",
		headers: f.headers,
		body: JSON.stringify({ requestId, operation }),
	});
	expect(response.status).toBe(200);
	return response.json();
}

describe("web gateway", () => {
	it("#65 permits direct navigation without Origin and explains rejected hostnames without reflecting them", async () => {
		const { origin, requests } = await fixture();
		const direct = await fetch(origin);
		expect(direct.status).toBe(200);
		expect(await direct.text()).toBe("<title>Workspace</title>");
		const head = await fetch(origin, { method: "HEAD" });
		expect(head.status).toBe(200);
		for (const header of [
			"content-length",
			"content-type",
			"cache-control",
			"content-security-policy",
			"referrer-policy",
			"permissions-policy",
			"x-content-type-options",
		])
			expect(head.headers.get(header)).toBe(direct.headers.get(header));
		expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("<title>Workspace</title>")));
		expect(await head.text()).toBe("");
		expect((await fetch(`${origin}/missing.js`, { method: "HEAD" })).status).toBe(404);
		for (const host of [new URL(origin).host.replace("127.0.0.1", "localhost"), "127.0.0.1:1", "evil.example"]) {
			const rejected = await new Promise<{ status: number | undefined; body: string }>((resolve) => {
				const req = request(origin, { headers: { Host: host } }, (response) => {
					let body = "";
					response.setEncoding("utf8");
					response.on("data", (chunk: string) => {
						body += chunk;
					});
					response.on("end", () => resolve({ status: response.statusCode, body }));
				});
				req.end();
			});
			expect(rejected.status).toBe(403);
			expect(JSON.parse(rejected.body)).toEqual({
				error: `Origin is not permitted. Open ${origin} exactly. SSH forwarding must use the same local and remote port.`,
			});
			expect(rejected.body).not.toContain(host);
		}
		expect(requests).toEqual([]);
	});
	it("#65 keeps send and cancel acknowledgements known when the discarded owner payload exceeds 128 KiB", async () => {
		const f = await fixture();
		const largeText = "x".repeat(140_000);
		f.client.request = async (request) => {
			f.requests.push(request);
			if (request.type === "send") return { type: "reply", reply: { status: "answered", text: largeText } };
			const response = { type: "cancelled" as const, annotation: largeText };
			return response;
		};
		for (const [operation, type] of [
			[{ type: "send", prompt: "work" }, "sent"],
			[{ type: "cancel" }, "cancelled"],
		] as const) {
			const expected = { requestId: type, state: "completed", response: { type } };
			expect(await postOwnerReply(f, type, operation)).toEqual(expected);
			expect(await postOwnerReply(f, type, operation)).toEqual(expected);
		}
		expect(f.requests).toHaveLength(2);
	});
	it("applies the 128 KiB cap after discarding owner-only fields", async () => {
		const f = await fixture();
		const status = {
			type: "status",
			inhibited: false,
			maintenance: { state: "open" },
			runtime: { configuration: "configured", uptimeMs: 4 },
		} as const;
		const ownerStatus = {
			...status,
			pid: 1,
			version: "fixture",
			name: "fixture",
			installationId: null,
			busy: false,
			maintenance: { ...status.maintenance, protocol: 1, operationId: null },
			runtime: {
				...status.runtime,
				application: "unit-001",
				name: "fixture",
				provider: "faux",
				modelId: "faux-1",
				pid: 1,
				startedAt: 1,
				observedAt: 5,
			},
		} satisfies Extract<ServiceResponse, { type: "status" }>;
		let annotation = "";
		f.client.request = async () => {
			const response = { ...ownerStatus, annotation };
			return response;
		};
		const operation = { type: "status" };
		expect(await postOwnerReply(f, "small-status", operation)).toMatchObject({
			state: "completed",
			response: status,
		});
		annotation = "語".repeat(44_000);
		expect(await postOwnerReply(f, "large-status", operation)).toEqual({
			requestId: "large-status",
			state: "completed",
			response: status,
		});
	});
	it("#65 enforces one bounded cooldown across concurrent pairing attempts", async () => {
		const f = await unpairedFixture();
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const failures = await Promise.all(Array.from({ length: 6 }, () => f.pairWith("wrong")));
		expect(failures.map((reply) => reply.status).sort()).toEqual([401, 401, 401, 401, 429, 429]);
		for (const reply of failures.filter((reply) => reply.status === 429))
			expect(reply.headers.get("retry-after")).toBe("60");
		clock.mockReturnValue(now + 59_999);
		const waiting = await f.pairWith("a".repeat(32));
		expect(waiting.status).toBe(429);
		expect(waiting.headers.get("retry-after")).toBe("1");
		clock.mockReturnValue(now + 60_000);
		const valid = await Promise.all([f.pairWith("a".repeat(32)), f.pairWith("a".repeat(32))]);
		expect(valid.map((reply) => reply.status).sort()).toEqual([200, 429]);
	});
	it("#65 read-only refreshes do not exhaust mutation receipts and rejected UTF-8 prompts never dispatch", async () => {
		const { origin, headers, requests } = await fixture();
		for (let index = 0; index < 40; index++) {
			const response = await fetch(`${origin}/api/v1/requests`, {
				method: "POST",
				headers,
				body: JSON.stringify({ requestId: `status-${index}`, operation: { type: "status" } }),
			});
			expect(response.status).toBe(200);
		}
		const oversized = await fetch(`${origin}/api/v1/requests`, {
			method: "POST",
			headers,
			body: JSON.stringify({ requestId: "oversized", operation: { type: "send", prompt: "語".repeat(12000) } }),
		});
		expect(oversized.status).toBe(400);
		expect(requests).toHaveLength(40);
		for (let index = 0; index < 32; index++) {
			const response = await fetch(`${origin}/api/v1/requests`, {
				method: "POST",
				headers,
				body: JSON.stringify({ requestId: `cancel-${index}`, operation: { type: "cancel" } }),
			});
			expect(response.status).toBe(200);
		}
		expect(
			(
				await fetch(`${origin}/api/v1/requests`, {
					method: "POST",
					headers,
					body: JSON.stringify({ requestId: "exhausted", operation: { type: "cancel" } }),
				})
			).status,
		).toBe(429);
		expect(
			(
				await fetch(`${origin}/api/v1/requests`, {
					method: "POST",
					headers,
					body: JSON.stringify({ requestId: "still-inspect", operation: { type: "status" } }),
				})
			).status,
		).toBe(200);
	});
	it("requires authenticated exact-origin JSON and a per-session CSRF token", async () => {
		const { origin, headers, requests } = await fixture();
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
			(await fetch(`${origin}/api/v1/session`, { headers: { "X-Forwarded-Host": "trusted.example" } })).status,
		).toBe(403);
		expect(requests).toEqual([]);
	});

	it("issues a bearer only on pairing and requires it for session metadata and streams", async () => {
		const { origin, headers, pair, body } = await fixture();
		expect(body).toEqual({
			authenticated: true,
			sessionToken: expect.stringMatching(/^[0-9a-f]{64}$/),
			csrfToken: expect.stringMatching(/^[0-9a-f]{64}$/),
			expiresAt: expect.any(Number),
		});
		expect(body.sessionToken).not.toBe(body.csrfToken);
		expect(pair.headers.get("set-cookie")).toBeNull();
		expect(pair.headers.get("cache-control")).toBe("no-store");
		for (const credentials of [
			new Headers(),
			new Headers({ Authorization: "Bearer invalid" }),
			new Headers({ Cookie: `unit_session=${body.sessionToken}` }),
		]) {
			const session = await fetch(`${origin}/api/v1/session`, { headers: credentials });
			expect(session.status).toBe(200);
			expect(await session.json()).toEqual({ authenticated: false });
			expect((await fetch(`${origin}/api/v1/events`, { headers: credentials })).status).toBe(401);
		}
		const credentials = { Authorization: headers.Authorization };
		expect(await (await fetch(`${origin}/api/v1/session`, { headers: credentials })).json()).toEqual({
			authenticated: true,
			csrfToken: body.csrfToken,
			expiresAt: body.expiresAt,
		});
		const controller = new AbortController();
		const events = await fetch(`${origin}/api/v1/events`, { headers: credentials, signal: controller.signal });
		expect(events.status).toBe(200);
		expect(events.headers.get("content-type")).toBe("text/event-stream");
		controller.abort();
		const logout = await fetch(`${origin}/api/v1/logout`, { method: "POST", headers });
		expect(logout.status).toBe(200);
		expect(logout.headers.get("set-cookie")).toBeNull();
		expect(await logout.json()).toEqual({ authenticated: false });
		expect((await fetch(`${origin}/api/v1/events`, { headers: credentials })).status).toBe(401);
	});

	it("drops a view at session expiry before the cleanup timer runs", async () => {
		const { client, origin, headers, body } = await fixture();
		const watching = Promise.withResolvers<Parameters<ServiceClient["watch"]>>();
		client.watch = (listener, signal) => {
			watching.resolve([listener, signal]);
			return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		};
		const events = await fetch(`${origin}/api/v1/events`, { headers });
		if (!events.body) throw new Error("Expected an event stream.");
		const reader = events.body.getReader();
		const [emit, signal] = await watching.promise;
		emit({ type: "connecting", message: "fixture" });
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: connecting");
		// No timer can run between advancing the clock and delivering this callback.
		vi.spyOn(Date, "now").mockReturnValue(body.expiresAt);
		expect(signal.aborted).toBe(false);
		emit({
			type: "view",
			view: {
				name: "fixture",
				version: "fixture",
				pid: 1,
				installationId: null,
				model: null,
				usage: null,
				entries: [],
				tools: [],
				busy: false,
				text: "expired",
				textTruncated: false,
				historyTruncated: false,
			},
		});
		expect(signal.aborted).toBe(true);
		await expect(reader.read()).rejects.toThrow();
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

	it("dispatches the read-only memory graph only through an authenticated CSRF-checked session", async () => {
		const { origin, headers, requests } = await fixture();
		const body = (request: unknown) => JSON.stringify({ requestId: "graph", operation: { type: "memory", request } });
		const post = (init: { headers: Record<string, string>; body: string }) =>
			fetch(`${origin}/api/v1/requests`, { method: "POST", ...init });
		const { Authorization: _authorization, ...anonymous } = headers;
		expect((await post({ headers: anonymous, body: body({ operation: "graph" }) })).status).toBe(401);
		expect(
			(await post({ headers: { ...headers, "X-Unit-CSRF": "wrong" }, body: body({ operation: "graph" }) })).status,
		).toBe(403);
		expect(
			(await post({ headers: { ...headers, Origin: "https://evil.example" }, body: body({ operation: "graph" }) }))
				.status,
		).toBe(403);
		expect((await post({ headers, body: body({ operation: "graph", limit: 10_000 }) })).status).toBe(400);
		expect((await post({ headers, body: body({ operation: "graph", id: "memory:a" }) })).status).toBe(400);
		expect(requests).toEqual([]);
		for (let attempt = 0; attempt < 2; attempt++)
			expect((await post({ headers, body: body({ operation: "graph" }) })).status).toBe(200);
		// A read is never retained as a mutation receipt, so each refresh reaches the owner.
		expect(requests).toEqual([
			{ type: "memory", request: { operation: "graph" } },
			{ type: "memory", request: { operation: "graph" } },
		]);
	});

	it("replays a closed mission refusal without repeating the owner operation", async () => {
		const f = await fixture();
		const operation = { type: "mission", request: { operation: "propose", expectedRevision: 2 } };
		const dispatch = vi.fn(
			async (): Promise<ServiceResponse> => ({ type: "mission-refused", code: "stale-revision" }),
		);
		f.client.request = dispatch;
		for (let attempt = 0; attempt < 2; attempt++)
			expect(await postOwnerReply(f, "propose-once", operation)).toEqual({
				requestId: "propose-once",
				state: "refused",
				code: "stale-revision",
			});
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("requires the reviewed receipt head for managed agreement and preserves pending reconciliation", async () => {
		const receiptId = "11111111-2222-4333-8444-555555555555";
		const agree = vi.fn<ManagedWebAgreement["agree"]>(async () => ({
			status: "issued",
			receiptId,
			reconciled: false,
		}));
		const lookup = vi.fn<NonNullable<ManagedWebAgreement["lookup"]>>(async () => ({
			status: "issued",
			receiptId,
			reconciled: true,
		}));
		const f = await fixture({ review: async () => undefined, agree, lookup });
		const request = { operation: "agree", revision: 2, digest: "b".repeat(64), confirmed: true };
		const operation = { type: "mission", request };
		expect(await postOwnerReply(f, "missing-head", operation)).toEqual({
			requestId: "missing-head",
			state: "refused",
			code: "stale-authority",
		});
		const approved = { ...operation, request: { ...request, previousReceipt: null } };
		expect(await postOwnerReply(f, "approve-once", approved)).toEqual({
			requestId: "approve-once",
			state: "issued",
			receiptId,
			reconciled: false,
		});
		expect(await postOwnerReply(f, "approve-once", approved)).toMatchObject({ state: "issued", reconciled: true });
		expect(agree).toHaveBeenCalledTimes(1);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(agree.mock.calls[0]?.[0]).toEqual({
			requestId: "approve-once",
			revision: 2,
			digest: request.digest,
			previousReceipt: null,
		});
		expect(f.requests).toEqual([]);
	});

	it("never sends agreement to the service owner on an unarmed managed launch", async () => {
		const f = await fixture(undefined, true);
		const operation = {
			type: "mission",
			request: { operation: "agree", revision: 2, digest: "b".repeat(64), confirmed: true },
		};
		expect(await postOwnerReply(f, "approve", operation)).toEqual({
			requestId: "approve",
			state: "refused",
			code: "not-enabled",
		});
		expect(
			await postOwnerReply(f, "reviewed-before-restart", {
				...operation,
				request: { ...operation.request, previousReceipt: null },
			}),
		).toMatchObject({ state: "unknown" });
		expect(f.requests).toEqual([]);
	});

	describe("browser POST response projection", () => {
		it("rebuilds status, mission and channel details down to the rendered fields", async () => {
			const f = await fixture();
			const status = {
				type: "status",
				inhibited: true,
				maintenance: { state: "held" },
				runtime: { configuration: "unconfigured", uptimeMs: 500 },
			};
			const mission = {
				type: "mission",
				result: {
					stage: "agreed",
					formation: {
						agreement: {
							revision: 1,
							terms: {
								objective: "Ship the change",
								scope: "Unit",
								successCriteria: ["Checked"],
								approvalBoundary: ["Local"],
								reviewEveryMs: 1000,
								policy: {
									allowedTools: ["read"],
									maxCycles: 2,
									maxRequests: 3,
									maxRetries: 4,
									maxConsecutiveNoProgress: 1,
									deadlineAt: 5000,
									maxEstimatedCost: 0.25,
								},
							},
							approval: { approvedAt: 10, approvedBy: { kind: "developer-local" } },
						},
						draft: {
							missionId: "mission-one",
							revision: 2,
							status: "proposed",
							digest: "a".repeat(64),
							terms: { objective: "Next change", policy: { allowedTools: ["read"], maxCycles: 3 } },
						},
					},
					creator: { kind: "human", id: "operator" },
					authority: "developer-local",
					authorityError: null,
					canAgree: true,
					agreementValid: true,
					missing: [],
					execution: "waiting",
					runtime: {
						status: "waiting",
						blocker: "maintenance",
						nextWakeAt: 999,
						cycles: 1,
						requests: 2,
						retries: 1,
						noProgress: 1,
						estimatedCost: 0.125,
						reservedCost: 0,
						unknownRequests: 0,
						unpricedResponses: 1,
						uncertainTools: 0,
						evidence: [{ criterion: "Checked", accepted: true, detail: "Passed", observedAt: 9 }],
						observedAt: 10,
					},
					tools: Array.from({ length: 128 }, (_, index) => `tool-${index}`),
				},
			};
			const channels = {
				type: "channels",
				result: {
					operation: "status",
					view: {
						channels: [
							{
								request: { channelId: "alpha", adapter: "sample" },
								outcome: { kind: "awaiting_creator", step: "grant" },
								lastHealth: null,
							},
							{
								request: { channelId: "beta", adapter: "sample" },
								outcome: { kind: "failed", reason: "transport" },
								lastHealth: { observedAt: 12, healthy: false },
							},
							{
								request: { channelId: "gamma", adapter: "sample" },
								outcome: { kind: "ready" },
								lastHealth: null,
							},
							{
								request: { channelId: "delta", adapter: "sample" },
								outcome: { kind: "unknown" },
								lastHealth: null,
							},
						],
					},
				},
			};
			for (const [operation, expected, owner] of [
				[
					{ type: "status" },
					status,
					{ ...status, pid: 42, maintenance: { ...status.maintenance, operationId: "sample" } },
				],
				[{ type: "mission", request: { operation: "status" } }, mission, mission],
				[{ type: "channels", request: { operation: "status" } }, channels, channels],
			] as const) {
				// Only the expected browser fields and synthetic extra data are necessary for this boundary fixture.
				f.client.request = async () => {
					if (owner.type !== "mission") return annotated(owner) as ServiceResponse;
					const { formation, ...result } = mission.result;
					return {
						type: "mission",
						result: { ...result, formation: { ...formation, extra: "sample" } },
					} as unknown as ServiceResponse;
				};
				expect(await postOwnerReply(f, expected.type, operation)).toEqual({
					requestId: expected.type,
					state: "completed",
					response: expected,
				});
			}
			mission.result.formation.agreement.terms.successCriteria = Array.from({ length: 22 }, () => "語".repeat(2000));
			f.client.request = async () => mission as unknown as ServiceResponse;
			expect(
				await postOwnerReply(f, "large-mission", { type: "mission", request: { operation: "status" } }),
			).toMatchObject({
				state: "unknown",
				message: expect.stringContaining("exceeded the browser limit"),
			});
		});

		it("keeps memory read rows and mutation outcomes but omits scores, counts not used by the page and reply text", async () => {
			const f = await fixture();
			const record = { id: "memory:a", content: "Example", origin: "user", tier: "working" };
			const node = {
				...record,
				truncated: false,
				kind: "fact",
				importance: 0.25,
				createdAt: 2,
				conversation: "0123456789ab",
			};
			const stats = {
				operation: "stats",
				working: 1,
				episodic: 1,
				tombstones: 2,
				pendingCaptures: 3,
				failedCaptures: 4,
				consolidation: "scheduled",
			};
			const recall = { operation: "recall", records: [record] };
			const graph = {
				operation: "graph",
				nodes: [node, { ...node, id: "memory:b", tier: "episodic" }],
				edges: [
					{ from: "memory:b", to: "memory:a", kind: "summary" },
					{ from: "memory:a", to: "memory:b", kind: "supports", derivation: "explicit" },
				],
				total: 3,
				limited: true,
			};
			const forget = { operation: "forget", removed: false };
			for (const [request, expected, owner] of [
				[{ operation: "stats" }, stats, { ...stats, relations: 12 }],
				[{ operation: "recall", query: "example" }, recall, { ...recall, records: [{ ...record, score: 0.5 }] }],
				[{ operation: "graph" }, graph, graph],
				[{ operation: "forget", id: record.id, confirmed: true }, forget, forget],
			] as const) {
				f.client.request = async () => annotated({ type: "memory", result: owner }) as ServiceResponse;
				expect(await postOwnerReply(f, request.operation, { type: "memory", request })).toEqual({
					requestId: request.operation,
					state: "completed",
					response: { type: "memory", result: expected },
				});
			}
			for (const [operation, owner, response] of [
				[
					{ type: "send", prompt: "work" },
					{ type: "reply", reply: { status: "answered", text: "Sample answer" } },
					{ type: "sent" },
				],
				[{ type: "cancel" }, { type: "cancelled" }, { type: "cancelled" }],
				[
					{ type: "status" },
					{ type: "error", message: "Sample rejection" },
					{ type: "error", message: "Owner rejected the operation." },
				],
				[
					{ type: "send", prompt: "work" },
					{ type: "reply", reply: { status: "failed", reason: "sample", detail: "Sample detail" } },
					{ type: "send-failed" },
				],
			] as const) {
				const requestId = `outcome-${f.requests.length}`;
				f.client.request = async (request) => {
					f.requests.push(request);
					return annotated(owner) as ServiceResponse;
				};
				expect(await postOwnerReply(f, requestId, operation)).toEqual({ requestId, state: "completed", response });
			}
		});

		it("records owner errors and unexpected replies as unknown without redispatching mutations", async () => {
			const f = await fixture();
			const sent = { type: "send", prompt: "work" };
			const forget = { type: "memory", request: { operation: "forget", id: "memory:a", confirmed: true } };
			const rejected = { type: "error", message: "Sample owner error" };
			for (const [requestId, operation, owner] of [
				["wrong-type", sent, { type: "cancelled" }],
				["wrong-memory-operation", forget, { type: "memory", result: { operation: "recall", records: [] } }],
				["invalid-removal", forget, { type: "memory", result: { operation: "forget", removed: "sample" } }],
				["bad-send", sent, { type: "reply", reply: { status: "answered" } }],
				["owner-send-error", sent, rejected],
				["owner-forget-error", forget, rejected],
				["owner-cancel-error", { type: "cancel" }, rejected],
			] as const) {
				f.client.request = async (request) => {
					f.requests.push(request);
					return annotated(owner) as ServiceResponse;
				};
				const expected = {
					requestId,
					state: "unknown",
					message: "Owner outcome is unknown. Inspect current state before acting again.",
				};
				expect(await postOwnerReply(f, requestId, operation)).toEqual(expected);
				expect(await postOwnerReply(f, requestId, operation)).toEqual(expected);
			}
			expect(f.requests).toHaveLength(7);
		});
	});

	it("accepts a graph envelope at 1 MiB and rejects one additional request ID byte", async () => {
		const f = await fixture();
		const content = "語".repeat(280);
		const response = {
			type: "memory",
			result: {
				operation: "graph",
				nodes: Array.from({ length: 300 }, (_, index) => ({
					id: `memory:${index}`,
					content,
					truncated: true,
					kind: "fact",
					tier: "working",
					origin: "user",
					importance: 0,
					createdAt: 0,
					conversation: "0123456789ab",
				})),
				edges: [],
				total: 300,
				limited: false,
			},
		} satisfies Extract<ServiceResponse, { type: "memory" }>;
		f.client.request = async () => response;
		const operation = { type: "memory", request: { operation: "graph" } };
		const full = await postOwnerReply(f, "graph", operation);
		expect(full).toMatchObject({ state: "completed", response: { result: { total: 300 } } });
		expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(131_072);
		// Distribute UTF-8 padding across valid IDs to reach the exact envelope limit.
		const remaining = 1_048_576 - Buffer.byteLength(JSON.stringify(full));
		const nodes = response.result.nodes;
		for (const [index, node] of nodes.entries()) {
			const bytes = Math.floor(remaining / nodes.length) + Number(index < remaining % nodes.length);
			node.id += "語".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
		}
		expect(Buffer.byteLength(JSON.stringify(response)) + 1).toBeLessThan(1_048_576);
		const atLimit = await postOwnerReply(f, "graph", operation);
		expect(atLimit).toMatchObject({ state: "completed" });
		expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(1_048_576);
		expect(await postOwnerReply(f, "graph2", operation)).toMatchObject({
			state: "unknown",
			message: expect.stringContaining("exceeded the browser limit"),
		});
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
