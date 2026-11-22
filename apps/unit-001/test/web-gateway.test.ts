// Exercises the browser trust boundary against a synthetic owner without model or storage access.
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceRequest, ServiceResponse } from "../src/service.ts";
import type { ServiceClient } from "../src/service-client.ts";
import { parseWebRequest } from "../src/web/contract.ts";
import { createWebGateway } from "../src/web/gateway.ts";

const servers: ReturnType<typeof createWebGateway>[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.map((gateway) => gateway.close()));
	servers.length = 0;
});

async function fixture(wrongGuesses = 0) {
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
		assets: new Map([
			["/", { contentType: "text/html; charset=utf-8", body: Buffer.from("<title>Workspace</title>") }],
		]),
	});
	servers.push(server);
	server.server.listen(port, "127.0.0.1");
	await once(server.server, "listening");
	const failedStatuses: number[] = [];
	for (let index = 0; index < wrongGuesses; index++) {
		failedStatuses.push(
			(
				await fetch(`${origin}/api/v1/session`, {
					method: "POST",
					headers: { Origin: origin, "Content-Type": "application/json" },
					body: JSON.stringify({ secret: "wrong" }),
				})
			).status,
		);
	}
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
	return { origin, headers, requests, client, pair, failedStatuses };
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
	it("checks a non-graph read against the raw 128 KiB cap before dropping extra fields", async () => {
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
		expect(await postOwnerReply(f, "small-status", operation)).toMatchObject({ state: "completed", response: status });
		annotation = "語".repeat(44_000);
		expect(await postOwnerReply(f, "large-status", operation)).toMatchObject({
			state: "unknown",
			message: expect.stringContaining("exceeded the browser limit"),
		});
	});
	it("#65 a valid pairing code remains usable after invalid local guesses", async () => {
		const f = await fixture(6);
		expect(f.failedStatuses).toEqual([401, 401, 401, 401, 429, 429]);
		expect(f.pair.status).toBe(200);
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
			(await fetch(`${origin}/api/v1/session`, { headers: { "X-Forwarded-Host": "trusted.example" } })).status,
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

	it("dispatches the read-only memory graph only through an authenticated CSRF-checked session", async () => {
		const { origin, headers, requests } = await fixture();
		const body = (request: unknown) => JSON.stringify({ requestId: "graph", operation: { type: "memory", request } });
		const post = (init: { headers: Record<string, string>; body: string }) =>
			fetch(`${origin}/api/v1/requests`, { method: "POST", ...init });
		const { Cookie: _cookie, ...anonymous } = headers;
		expect((await post({ headers: anonymous, body: body({ operation: "graph" }) })).status).toBe(401);
		expect((await post({ headers: { ...headers, "X-Unit-CSRF": "wrong" }, body: body({ operation: "graph" }) })).status).toBe(
			403,
		);
		expect(
			(await post({ headers: { ...headers, Origin: "https://evil.example" }, body: body({ operation: "graph" }) })).status,
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
						draft: { revision: 2, status: "editing", digest: null, terms: { objective: "Next change" } },
					},
					creator: { kind: "human", id: "operator" },
					authority: "developer-local",
					authorityError: null,
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
				f.client.request = async () => annotated(owner) as ServiceResponse;
				expect(await postOwnerReply(f, expected.type, operation)).toEqual({
					requestId: expected.type,
					state: "completed",
					response: expected,
				});
			}
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

	it("allows a full memory graph past the general browser limit but not past the owner frame", async () => {
		const f = await fixture();
		let annotation = "";
		const content = "語".repeat(280);
		f.client.request = async () => {
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
				annotation,
			} satisfies Extract<ServiceResponse, { type: "memory" }> & { annotation: string };
			return response;
		};
		const operation = { type: "memory", request: { operation: "graph" } };
		const full = await postOwnerReply(f, "graph", operation);
		expect(full).toMatchObject({ state: "completed", response: { result: { total: 300 } } });
		expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(131_072);
		annotation = "x".repeat(1_048_576);
		expect(await postOwnerReply(f, "graph-2", operation)).toMatchObject({
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
