// Exercises the browser trust boundary against a synthetic owner without model or storage access.
import { once } from "node:events";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createServer, type OutgoingHttpHeaders, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanView } from "../src/missions/plan-wire.ts";
import type { ServiceRequest, ServiceResponse } from "../src/service.ts";
import type { ServiceClient } from "../src/service-client.ts";
import { parseWebRequest } from "../src/web/contract.ts";
import { createWebGateway, type WebGatewayOptions } from "../src/web/gateway.ts";
import { planTerms } from "./missions/fixtures/plan.ts";

const directories: string[] = [];
const servers: ReturnType<typeof createWebGateway>[] = [];
const workspaceId = "a".repeat(64);

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.map((gateway) => gateway.close()));
	servers.length = 0;
	await Promise.all(directories.splice(0).map((dir) => rmdir(dir)));
});

async function startGateway(
	options: Pick<WebGatewayOptions, "managed" | "managedReview" | "planReview" | "workspaceId"> = {},
	transport: "tcp" | "unix" = "tcp",
) {
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
	const reservation = createServer().listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const port = (reservation.address() as AddressInfo).port;
	await new Promise<void>((resolve) => reservation.close(() => resolve()));
	const origin = `http://127.0.0.1:${port}`;
	const server = createWebGateway({
		client,
		origin,
		...options,
		assets: new Map([
			["/", { contentType: "text/html; charset=utf-8", body: Buffer.from("<title>Workspace</title>") }],
		]),
	});
	servers.push(server);
	let socketPath: string | undefined;
	if (transport === "unix") {
		const dir = await mkdtemp(join(tmpdir(), "unit-web-"));
		directories.push(dir);
		socketPath = join(dir, "web.sock");
		server.server.listen(socketPath);
	} else server.server.listen(port, "127.0.0.1");
	await once(server.server, "listening");
	const call = (path: string, headers: OutgoingHttpHeaders = {}, body?: string) =>
		new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
			const req = request(
				new URL(path, origin),
				{ socketPath, method: body === undefined ? "GET" : "POST", headers },
				(res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						text += chunk;
					});
					res.once("error", reject);
					res.once("end", () => resolve({ status: res.statusCode, body: text }));
				},
			);
			req.once("error", reject);
			req.end(body);
		});
	return { origin, requests, client, call, server: server.server };
}

async function fixture(options?: Parameters<typeof startGateway>[0]) {
	const f = await startGateway(options);
	const response = await fetch(`${f.origin}/api/v1/session`);
	expect(response.status).toBe(200);
	const session = (await response.json()) as { csrfToken: string };
	const headers = { Origin: f.origin, "Content-Type": "application/json", "X-Unit-CSRF": session.csrfToken };
	return { ...f, headers, session };
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
				error: `Origin is not permitted. Open ${origin} exactly.`,
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
	});

	it.each([
		{ mode: "without a workspace binding", workspace: undefined },
		{ mode: "with a workspace binding", workspace: workspaceId },
	])("keeps a full generation while a write is pending ($mode)", async ({ workspace }) => {
		const f = await fixture(workspace === undefined ? {} : { workspaceId: workspace });
		const admitted = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		f.client.request = async (operation) => {
			f.requests.push(operation);
			if (operation.type === "send") {
				admitted.resolve();
				await finish.promise;
				throw new Error("Synthetic owner outcome unavailable");
			}
			return { type: "cancelled" };
		};
		const post = (requestId: string, operation: unknown = { type: "cancel" }, headers = f.headers) =>
			f.call("/api/v1/requests", headers, JSON.stringify({ requestId, operation }));
		const pending = post("pending", { type: "send", prompt: "Work" });
		try {
			await admitted.promise;
			for (let index = 1; index < 32; index++) expect((await post(`write-${index}`)).status).toBe(200);
			const boundary = await post("boundary");
			expect(boundary.status).toBe(429);
			expect(JSON.parse(boundary.body)).toEqual({
				error: "Mutation receipts are full. Wait for pending mutations to settle.",
			});
			expect((await post("write-1")).status).toBe(200);
			expect((await post("write-1", { type: "send", prompt: "Different" })).status).toBe(409);
			expect(f.requests).toHaveLength(32);
			expect(JSON.parse((await f.call("/api/v1/session")).body)).toEqual(f.session);
			expect((await post("inspect", { type: "status" })).status).toBe(200);
			expect(f.requests.at(-1)).toEqual({ type: "status" });
		} catch (error) {
			finish.resolve();
			await pending;
			throw error;
		}

		const body = JSON.stringify({ requestId: "delayed", operation: { type: "cancel" } });
		const headersReceived = once(f.server, "request");
		const delayed = request(`${f.origin}/api/v1/requests`, {
			method: "POST",
			headers: { ...f.headers, "Content-Length": Buffer.byteLength(body) },
		});
		const delayedReply = once(delayed, "response");
		try {
			delayed.flushHeaders();
			await headersReceived;
			finish.resolve();
			const settled = await pending;
			expect(settled.status).toBe(200);
			expect(JSON.parse(settled.body)).toMatchObject({ requestId: "pending", state: "unknown" });
			if (workspace === undefined) {
				const boundary = await post("boundary");
				expect(boundary.status).toBe(403);
				expect(JSON.parse(boundary.body)).toEqual({
					error: "Mutation session renewed. Refresh the session before acting again.",
				});
			}
			delayed.end(body);
			const [response] = await delayedReply;
			response.resume();
			expect(response.statusCode).toBe(403);
		} finally {
			finish.resolve();
			delayed.destroy();
			await delayedReply.catch(() => {});
		}
		expect((await post("write-1")).status).toBe(403);
		expect(f.requests).toHaveLength(33);

		const session = JSON.parse((await f.call("/api/v1/session")).body) as { csrfToken: string };
		expect(session.csrfToken).not.toBe(f.session.csrfToken);
		const headers = { ...f.headers, "X-Unit-CSRF": session.csrfToken };
		expect((await post("write-1", { type: "cancel" }, headers)).status).toBe(200);
		expect((await post("deliberate-next-write", { type: "cancel" }, headers)).status).toBe(200);
		expect(f.requests.filter(({ type }) => type !== "status")).toHaveLength(34);
	});

	it("rotates on the 24th reply, keeps the stream, and admits 100 consecutive deliberate writes", async () => {
		const f = await fixture({ workspaceId });
		const subscriber = Promise.withResolvers<Parameters<ServiceClient["watch"]>[0]>();
		f.client.watch = async (listener, signal) => {
			subscriber.resolve(listener);
			await once(signal, "abort");
		};
		const stream = new AbortController();
		try {
			const events = await fetch(`${f.origin}/api/v1/events`, { signal: stream.signal });
			expect(events.headers.get("X-Unit-Workspace")).toBe(workspaceId);
			const reader = events.body?.getReader();
			if (!reader) throw new Error("Gateway did not open an event stream.");
			const publish = await subscriber.promise;
			let token = f.session.csrfToken;
			for (let number = 1; number <= 100; number++) {
				const requestId = `write-${number}`;
				const reply = await fetch(`${f.origin}/api/v1/requests`, {
					method: "POST",
					headers: { ...f.headers, "X-Unit-CSRF": token },
					body: JSON.stringify({ requestId, operation: { type: "cancel" } }),
				});
				expect(reply.status).toBe(200);
				expect(await reply.json()).toEqual({ requestId, state: "completed", response: { type: "cancelled" } });
				const next = reply.headers.get("X-Unit-Next-CSRF");
				if (number % 24 === 0) {
					expect(next).toMatch(/^[0-9a-f]{64}$/);
					expect(next).not.toBe(token);
					expect(reply.headers.get("X-Unit-Workspace")).toBe(workspaceId);
					token = next ?? token;
				} else {
					expect(next).toBeNull();
					expect(reply.headers.get("X-Unit-Workspace")).toBeNull();
				}
			}
			expect(f.requests).toHaveLength(100);
			publish({ type: "connecting", message: "Synthetic owner event" });
			expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: connecting");
		} finally {
			stream.abort();
		}
	});

	it("does not replay a write when its rollover reply is lost", async () => {
		const f = await fixture({ workspaceId });
		for (let number = 1; number < 24; number++) await postOwnerReply(f, `write-${number}`, { type: "cancel" });
		const admitted = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		f.client.request = async (operation) => {
			f.requests.push(operation);
			admitted.resolve();
			await finish.promise;
			return { type: "cancelled" };
		};
		const controller = new AbortController();
		const lost = fetch(`${f.origin}/api/v1/requests`, {
			method: "POST",
			headers: f.headers,
			body: JSON.stringify({ requestId: "lost", operation: { type: "cancel" } }),
			signal: controller.signal,
		});
		const rejected = expect(lost).rejects.toMatchObject({ name: "AbortError" });
		try {
			await admitted.promise;
			controller.abort();
			await rejected;
		} finally {
			finish.resolve();
		}
		await expect
			.poll(async () => JSON.parse((await f.call("/api/v1/session")).body).csrfToken)
			.not.toBe(f.session.csrfToken);
		const stale = await f.call(
			"/api/v1/requests",
			f.headers,
			JSON.stringify({ requestId: "later", operation: { type: "cancel" } }),
		);
		expect(stale.status).toBe(403);
		expect(f.requests).toHaveLength(24);
	});
	it("requires exact-origin JSON and the launcher CSRF token", async () => {
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
		).toBe(403);
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
		const { Origin: _origin, ...missingOrigin } = headers;
		for (const invalid of [missingOrigin, { ...headers, "Content-Type": "text/plain" }]) {
			expect((await fetch(`${origin}/api/v1/requests`, { method: "POST", headers: invalid, body })).status).toBe(403);
		}
		expect(requests).toEqual([]);
	});

	it("serves only GET session, with a CSRF token stable absent mutation rollover", async () => {
		const f = await fixture();
		const excess = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-Fixture-${i}`, "1"]));
		expect((await f.call("/api/v1/session", { Host: new URL(f.origin).host, ...excess })).status).toBe(431);
		expect(f.session).toEqual({ csrfToken: expect.stringMatching(/^[0-9a-f]{64}$/) });
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
		const response = await fetch(`${f.origin}/api/v1/session`);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(await response.json()).toEqual(f.session);
		const next = await fixture();
		expect(next.session.csrfToken).not.toBe(f.session.csrfToken);
		for (const path of ["/api/v1/session", "/api/v1/logout"]) {
			expect((await fetch(f.origin + path, { method: "POST", headers: f.headers, body: "{}" })).status).toBe(404);
		}
		for (const suffix of ["/", "?query=1"])
			expect((await fetch(`${f.origin}/api/v1/session${suffix}`)).status).toBe(404);
	});

	it("refuses mismatched listener transports before serving assets or session data", async () => {
		for (const f of [await startGateway({ managed: true }, "tcp"), await startGateway({}, "unix")]) {
			expect((await f.call("/")).status).toBe(403);
			expect((await f.call("/api/v1/session")).status).toBe(403);
			expect((await f.call("/api/v1/events")).status).toBe(403);
			expect(f.requests).toEqual([]);
		}
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

	it("bounds concurrent requests and shares an in-flight mutation with retries", async () => {
		const f = await fixture();
		const finish = Promise.withResolvers<void>();
		f.client.request = async (request) => {
			f.requests.push(request);
			await finish.promise;
			return { type: "cancelled" };
		};
		const cancel = (id: number) =>
			f.call("/api/v1/requests", f.headers, JSON.stringify({ requestId: String(id), operation: { type: "cancel" } }));
		const pending = [0, 1, 2, 3].map(cancel);
		try {
			await expect.poll(() => f.requests.length).toBe(4);
			pending.push(cancel(0));
			expect((await cancel(4)).status).toBe(429);
		} finally {
			finish.resolve();
		}
		expect((await Promise.all(pending)).map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
		expect(f.requests).toHaveLength(4);
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

	it("dispatches the read-only memory graph only with a valid CSRF token", async () => {
		const { origin, headers, requests } = await fixture();
		const body = (request: unknown) => JSON.stringify({ requestId: "graph", operation: { type: "memory", request } });
		const post = (init: { headers: Record<string, string>; body: string }) =>
			fetch(`${origin}/api/v1/requests`, { method: "POST", ...init });
		const { "X-Unit-CSRF": _csrf, ...anonymous } = headers;
		expect((await post({ headers: anonymous, body: body({ operation: "graph" }) })).status).toBe(403);
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
		const dispatch = vi.fn(async (): Promise<ServiceResponse> => ({ type: "mission-refused", code: "stale-revision" }));
		f.client.request = dispatch;
		for (let attempt = 0; attempt < 2; attempt++)
			expect(await postOwnerReply(f, "propose-once", operation)).toEqual({
				requestId: "propose-once",
				state: "refused",
				code: "stale-revision",
			});
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("dispatches only explicitly confirmed developer-local agreement with the exact revision and digest", async () => {
		const f = await fixture();
		const agree = { operation: "agree", revision: 2, digest: "a".repeat(64) };
		const post = (confirmed: boolean) =>
			f.call(
				"/api/v1/requests",
				f.headers,
				JSON.stringify({ requestId: "approve", operation: { type: "mission", request: { ...agree, confirmed } } }),
			);
		expect((await post(false)).status).toBe(400);
		expect(f.requests).toEqual([]);
		f.client.request = async (request) => {
			f.requests.push(request);
			return { type: "mission-refused", code: "stale-digest" };
		};
		expect(JSON.parse((await post(true)).body)).toEqual({
			requestId: "approve",
			state: "refused",
			code: "stale-digest",
		});
		expect(f.requests).toEqual([{ type: "mission", request: { ...agree, requestId: "approve" } }]);
	});

	it("requires a reviewed protected head before reporting developer-local plan agreement complete", async () => {
		const digest = "a".repeat(64);
		const binding = { missionId: "mission-1", purposeRevision: 1, purposeDigest: "b".repeat(64) };
		let headValid = false;
		const f = await fixture({
			planReview: async () => ({
				canAgree: true, headValid, openUnderHead: false, draftDigest: null, runnablePurposeBinding: binding,
			}),
		});
		const plan: PlanView = {
			missionId: "mission-1",
			adopted: true,
			head: { revision: 2, digest, previousDigest: null, terms: planTerms(), agreedAt: 17, receiptId: "receipt-2" },
			headValid: true,
			previous: null,
			history: [],
			draft: null,
			gate: { state: "open", reason: null },
			runs: { used: 0, limit: 32 },
			due: [],
			preview: null,
			reviews: [],
			allowance: null,
			turns: [],
			blocker: null,
		};
		f.client.request = async () => ({
			type: "mission",
			result: {
				stage: "awaiting_approval",
				formation: { nextRevision: 3, lastOperation: null, agreement: null, draft: null },
				creator: null,
				authority: "developer-local",
				authorityError: null,
				agreementValid: false,
				missing: [],
				execution: "not-implemented",
				tools: [],
				plan,
			},
		});
		const agree = { type: "mission", request: { operation: "plan-agree", revision: 2, digest, confirmed: true } };
		expect(await postOwnerReply(f, "unverified", agree)).toMatchObject({ state: "unknown" });
		headValid = true;
		expect(await postOwnerReply(f, "verified", agree)).toMatchObject({
			state: "completed",
			response: {
				type: "mission",
				result: {
					canAgreePlan: true, runnablePurposeBinding: binding,
					plan: { headValid: true, gate: { state: "closed", reason: "reopen-needed" } },
				},
			},
		});
		expect(await postOwnerReply(f, "unverified", agree)).toMatchObject({ state: "unknown" });
		const receiptId = "11111111-1111-4111-8111-111111111111";
		f.client.request = async () => ({ type: "mission-plan-issued", receiptId });
		expect(await postOwnerReply(f, "pending", agree)).toEqual({
			requestId: "pending", state: "issued", receiptId, reconciled: false,
		});
	});

	it("accepts a managed filesystem socket for review and locally denies every browser agreement", async () => {
		const proposal = {
			missionId: "mission-one",
			revision: 2,
			digest: "b".repeat(64),
			authorityRevision: 1,
			previousReceipt: null,
		};
		const review = vi.fn(async () => ({ proposal }));
		const f = await startGateway({ managed: true, managedReview: review }, "unix");
		const session = await f.call("/api/v1/session");
		expect(session.status).toBe(200);
		expect(JSON.parse(session.body)).toEqual({ csrfToken: expect.any(String) });
		const headers = { Origin: f.origin, "Content-Type": "application/json" };
		const post = (requestId: string, action: unknown, extra: Record<string, string>) =>
			f.call(
				"/api/v1/requests",
				{ ...headers, ...extra },
				JSON.stringify({ requestId, operation: { type: "mission", request: action } }),
			);
		const status = { operation: "status" };
		expect((await post("read", status, {})).status).toBe(403);
		const csrf = { "X-Unit-CSRF": JSON.parse(session.body).csrfToken as string };
		for (const bad of [
			{ Host: "localhost" },
			{ Origin: "https://other.example" },
			{ Forwarded: "for=127.0.0.1" },
			{ "X-Forwarded-For": "127.0.0.1" },
		] as const)
			expect((await f.call("/api/v1/session", bad)).status).toBe(403);
		const agree = { operation: "agree", revision: 2, digest: proposal.digest, confirmed: true };
		const denied = await post("simple", agree, csrf);
		expect(denied.status).toBe(200);
		expect(JSON.parse(denied.body)).toEqual({ requestId: "simple", state: "refused", code: "not-enabled" });
		// The browser never names a protected receipt; the field is rejected like any other unknown one.
		expect((await post("reviewed", { ...agree, previousReceipt: null }, csrf)).status).toBe(400);
		const planDenied = await post(
			"managed-plan",
			{ operation: "plan-agree", revision: 2, digest: proposal.digest, confirmed: true },
			csrf,
		);
		expect(planDenied.status).toBe(200);
		expect(JSON.parse(planDenied.body)).toEqual({
			requestId: "managed-plan",
			state: "refused",
			code: "managed-requires-gateway",
		});
		expect(f.requests).toEqual([]);
		expect(review).not.toHaveBeenCalled();
		f.client.request = async () => ({
			type: "mission",
			result: {
				stage: "awaiting_approval",
				formation: {
					nextRevision: 3,
					lastOperation: null,
					agreement: null,
					draft: { missionId: proposal.missionId, revision: 2, status: "proposed", terms: {}, digest: "a".repeat(64) },
				},
				creator: null,
				authority: "managed-administrator",
				authorityError: null,
				agreementValid: true,
				missing: [],
				execution: "not-implemented",
				tools: [],
			},
		});
		const projected = await post("read", status, csrf);
		expect(JSON.parse(projected.body)).toMatchObject({
			state: "completed",
			response: {
				result: {
					canAgree: false,
					canAgreePlan: false,
					agreementValid: false,
					review: proposal,
					formation: { draft: { digest: proposal.digest } },
				},
			},
		});
		expect(review).toHaveBeenCalledOnce();
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
					canAgreePlan: false,
					plan: null,
					planError: null,
					runnablePurposeBinding: null,
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
