// Creates a loopback-only browser gateway without opening agent state or granting creator authority.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServiceClient } from "../service-client.ts";
import { parseWebRequest, type WebResult } from "./contract.ts";

export type WebGatewayOptions = {
	client: ServiceClient;
	origin: string;
	secret: string;
	assets: ReadonlyMap<string, { contentType: string; body: Uint8Array }>;
};

type Session = {
	csrf: string;
	expiresAt: number;
	abort: AbortController;
	streams: number;
	requests: Map<string, { fingerprint: string; result: Promise<WebResult> }>;
	inFlight: number;
};

export type WebGateway = { server: Server; close(): Promise<void> };

/** Builds an inactive loopback server; callers must explicitly choose when to listen. */
export function createWebGateway(options: WebGatewayOptions): WebGateway {
	const origin = new URL(options.origin);
	if (
		origin.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(origin.hostname) ||
		origin.origin !== options.origin ||
		Buffer.byteLength(options.secret) < 32
	)
		throw new Error("Gateway requires an exact loopback HTTP origin and a secret of at least 32 bytes.");
	const sessions = new Map<string, Session>();
	let pairingFailures = 0;
	let pairingWindow = Date.now();
	let paired = false;
	const server = createServer(
		{ headersTimeout: 5000, requestTimeout: 10_000, maxHeaderSize: 8192 },
		(req, res) => {
			void handle(req, res).catch(() => {
				if (!res.headersSent) json(res, 400, { error: "Invalid request." });
				else res.destroy();
			});
		},
	);
	server.maxConnections = 32;
	server.maxHeadersCount = 32;
	const cleanup = setInterval(() => {
		for (const [id, session] of sessions) {
			if (session.expiresAt <= Date.now()) {
				session.abort.abort();
				sessions.delete(id);
			}
		}
	}, 1000);
	cleanup.unref();
	server.once("close", () => {
		clearInterval(cleanup);
		for (const session of sessions.values()) session.abort.abort();
		sessions.clear();
	});
	return {
		server,
		async close() {
			for (const session of sessions.values()) session.abort.abort();
			clearInterval(cleanup);
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		);
		res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
		// Browser headers and local TCP peers are independent trust boundaries; neither forwarded headers nor Host grants access.
		if (
			req.headers.host !== origin.host ||
			(req.headers.origin !== undefined && req.headers.origin !== options.origin) ||
			Object.keys(req.headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-")) ||
			!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
		)
			return json(res, 403, { error: "Origin is not permitted." });
		const path = req.url;
		const id = /(?:^|;\s*)unit_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
		const session = id === undefined ? undefined : sessions.get(id);
		const authenticated = session !== undefined && session.expiresAt > Date.now();
		if (req.method === "GET" && path === "/api/v1/session") {
			return json(
				res,
				200,
				authenticated
					? { authenticated: true, csrfToken: session.csrf, expiresAt: session.expiresAt }
					: { authenticated: false },
			);
		}
		if (req.method === "POST") {
			if (req.headers.origin !== options.origin || req.headers["content-type"] !== "application/json")
				return json(res, 403, { error: "Same-origin JSON is required." });
			if (path === "/api/v1/session") {
				if (Date.now() - pairingWindow >= 60_000) {
					pairingFailures = 0;
					pairingWindow = Date.now();
				}
				if (paired || pairingFailures >= 5)
					return json(res, 429, { error: "Pairing is temporarily unavailable." });
				const body = await readJson(req);
				if (paired) return json(res, 429, { error: "Pairing is temporarily unavailable." });
				const secret =
					typeof body === "object" && body !== null && "secret" in body ? body.secret : undefined;
				const supplied = Buffer.from(typeof secret === "string" ? secret : "");
				const expected = Buffer.from(options.secret);
				if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
					pairingFailures++;
					return json(res, 401, { error: "Pairing failed." });
				}
				const token = randomBytes(32).toString("hex");
				paired = true;
				const created: Session = {
					csrf: randomBytes(32).toString("hex"),
					expiresAt: Date.now() + 1_800_000,
					abort: new AbortController(),
					streams: 0,
					requests: new Map(),
					inFlight: 0,
				};
				sessions.set(token, created);
				res.setHeader("Set-Cookie", `unit_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
				return json(res, 200, { authenticated: true, csrfToken: created.csrf, expiresAt: created.expiresAt });
			}
		}
		if (path?.startsWith("/api/")) {
			if (!authenticated) return json(res, 401, { error: "Authentication required." });
			if (req.method === "GET" && path === "/api/v1/events") {
				if (session.streams >= 2) return json(res, 429, { error: "Stream limit reached." });
				session.streams++;
				const disconnected = new AbortController();
				const signal = AbortSignal.any([session.abort.signal, disconnected.signal]);
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.flushHeaders();
				const abort = () => res.destroy();
				signal.addEventListener("abort", abort, { once: true });
				res.once("close", () => disconnected.abort());
				const heartbeat = setInterval(() => {
					if (!res.write(": heartbeat\n\n")) disconnected.abort();
				}, 15_000);
				try {
					await options.client.watch((event) => {
						const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.type === "view" ? event.view : { message: "Owner reconnecting." })}\n\n`;
						if (Buffer.byteLength(frame) > 1_048_576 || res.writableLength > 1_048_576 || !res.write(frame))
							disconnected.abort();
					}, signal);
				} finally {
					clearInterval(heartbeat);
					signal.removeEventListener("abort", abort);
					session.streams--;
					res.end();
				}
				return;
			}
			if (req.method !== "POST" || req.headers["x-unit-csrf"] !== session.csrf)
				return json(res, 403, { error: "CSRF check failed." });
			if (path === "/api/v1/logout") {
				session.abort.abort();
				if (id !== undefined) sessions.delete(id);
				res.setHeader("Set-Cookie", "unit_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
				return json(res, 200, { authenticated: false });
			}
			if (path === "/api/v1/requests") {
				const parsed = parseWebRequest(await readJson(req));
				if (session.expiresAt <= Date.now() || session.abort.signal.aborted)
					return json(res, 401, { error: "Session expired." });
				const fingerprint = JSON.stringify(parsed.operation);
				let record = session.requests.get(parsed.requestId);
				if (record !== undefined && record.fingerprint !== fingerprint)
					return json(res, 409, { error: "Request ID already belongs to another operation." });
				if (record === undefined) {
					if (session.requests.size >= 32 || session.inFlight >= 4)
						return json(res, 429, { error: "Session request limit reached." });
					session.inFlight++;
					const result = options.client
						.request(parsed.operation, AbortSignal.any([session.abort.signal, AbortSignal.timeout(120_000)]))
						.then<WebResult>((response) => {
							if (Buffer.byteLength(JSON.stringify(response)) > 131_072)
								throw new Error("Response is too large.");
							const safeResponse =
								response.type === "error"
									? { type: "error" as const, message: "Owner rejected the operation." }
									: response.type === "reply" && response.reply.status === "failed"
										? { type: "error" as const, message: "Owner could not complete the operation." }
										: response;
							return { requestId: parsed.requestId, state: "completed", response: safeResponse };
						})
						.catch(
							(): WebResult => ({
								requestId: parsed.requestId,
								state: "unknown",
								message: "Owner outcome is unknown. Inspect current state before acting again.",
							}),
						)
						.finally(() => {
							session.inFlight--;
						});
					record = { fingerprint, result };
					session.requests.set(parsed.requestId, record);
				}
				const result = await record.result;
				if (session.expiresAt <= Date.now() || session.abort.signal.aborted)
					return json(res, 401, { error: "Session expired." });
				return json(res, 200, result);
			}
			return json(res, 404, { error: "Unknown endpoint." });
		}
		const asset = path === undefined ? undefined : options.assets.get(path);
		if (req.method !== "GET" || asset === undefined) return json(res, 404, { error: "Not found." });
		res.writeHead(200, { "Content-Type": asset.contentType });
		res.end(asset.body);
	}
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	let bytes = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += data.length;
		if (bytes > 65_536) throw new Error("Request exceeds 64 KiB.");
		chunks.push(data);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(value));
}
