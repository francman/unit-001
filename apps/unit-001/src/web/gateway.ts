// Creates a loopback-only browser gateway without opening agent state or granting creator authority.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgreementClick, AgreementOutcome } from "../missions/browser-agreement.ts";
import type { MissionView } from "../missions/contract.ts";
import { parseMissionRefusalCode } from "../missions/refusal.ts";
import type { ServiceView } from "../service.ts";
import type { ServiceClient } from "../service-client.ts";
import { parseWebRequest } from "./contract.ts";
import {
	isWebMissionMutation,
	type ManagedMissionReview,
	projectWebResponse,
	type WebResult,
} from "./post-response.ts";

export type WebGatewayOptions = {
	client: ServiceClient;
	origin: string;
	secret: string;
	assets: ReadonlyMap<string, { contentType: string; body: Uint8Array }>;
	managed?: boolean;
	managedAgreement?: ManagedWebAgreement;
};

export type ManagedWebAgreement = {
	review(view: MissionView): Promise<ManagedMissionReview | undefined>;
	agree(click: AgreementClick, signal: AbortSignal, isLive: () => boolean): Promise<AgreementOutcome>;
	lookup?(click: AgreementClick, signal: AbortSignal): Promise<AgreementOutcome | undefined>;
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
	const managed = options.managed === true || options.managedAgreement !== undefined;
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
	let pairingResetAt = 0;
	let paired = false;
	const server = createServer({ headersTimeout: 5000, requestTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) json(res, 400, { error: "Invalid request." });
			else res.destroy();
		});
	});
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
			return json(res, 403, {
				error: `Origin is not permitted. Open ${options.origin} exactly. SSH forwarding must use the same local and remote port.`,
			});
		const path = req.url;
		if (req.method === "POST") {
			if (req.headers.origin !== options.origin || req.headers["content-type"] !== "application/json")
				return json(res, 403, { error: "Same-origin JSON is required." });
			if (path === "/api/v1/session") {
				if (pairingUnavailable(res)) return;
				const body = await readJson(req);
				// Another body may have finished and consumed the code or started a cooldown.
				if (pairingUnavailable(res)) return;
				const secret = typeof body === "object" && body !== null && "secret" in body ? body.secret : undefined;
				const supplied = Buffer.from(typeof secret === "string" ? secret : "");
				const expected = Buffer.from(options.secret);
				if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
					pairingFailures++;
					// The first failure starts the counting window. The fifth starts a full minute of cooldown.
					if (pairingFailures === 1 || pairingFailures === 5) pairingResetAt = Date.now() + 60_000;
					if (pairingUnavailable(res)) return;
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
				return json(res, 200, {
					authenticated: true,
					sessionToken: token,
					csrfToken: created.csrf,
					expiresAt: created.expiresAt,
				});
			}
		}
		if (path?.startsWith("/api/")) {
			const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization ?? "")?.[1];
			const session = token === undefined ? undefined : sessions.get(token);
			const authenticated = session !== undefined && session.expiresAt > Date.now();
			if (req.method === "GET" && path === "/api/v1/session")
				return json(
					res,
					200,
					authenticated
						? { authenticated: true, csrfToken: session.csrf, expiresAt: session.expiresAt }
						: { authenticated: false },
				);
			if (!authenticated || token === undefined) return json(res, 401, { error: "Authentication required." });
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
				const writeFrame = (frame: string) => {
					if (
						signal.aborted ||
						session.expiresAt <= Date.now() ||
						res.writableLength + Buffer.byteLength(frame) > 1_048_576
					)
						disconnected.abort();
					else res.write(frame);
				};
				const heartbeat = setInterval(() => writeFrame(": heartbeat\n\n"), 15_000);
				try {
					await options.client.watch((event) => {
						const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.type === "view" ? browserView(event.view) : { message: "Owner reconnecting." })}\n\n`;
						writeFrame(frame);
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
				sessions.delete(token);
				return json(res, 200, { authenticated: false });
			}
			if (path === "/api/v1/requests") {
				const parsed = parseWebRequest(await readJson(req));
				if (session.expiresAt <= Date.now() || session.abort.signal.aborted)
					return json(res, 401, { error: "Session expired." });
				const fingerprint = JSON.stringify(parsed);
				const agree =
					parsed.operation.type === "mission" && parsed.operation.request.operation === "agree"
						? parsed.operation.request
						: undefined;
				const click =
					agree !== undefined && parsed.previousReceipt !== undefined
						? {
								requestId: agree.requestId,
								revision: agree.revision,
								digest: agree.digest,
								previousReceipt: parsed.previousReceipt,
							}
						: undefined;
				const missionMutation = isWebMissionMutation(parsed.operation);
				const mutation =
					parsed.operation.type === "send" ||
					parsed.operation.type === "cancel" ||
					missionMutation ||
					(parsed.operation.type === "memory" && parsed.operation.request.operation === "forget");
				// A full memory graph (300 nodes of 280 code points) exceeds the general browser limit; it stays within the owner's 1 MiB frame.
				const limit =
					parsed.operation.type === "memory" && parsed.operation.request.operation === "graph"
						? 1_048_576
						: 131_072;
				let record = mutation ? session.requests.get(parsed.requestId) : undefined;
				const retry = record !== undefined;
				if (record !== undefined && record.fingerprint !== fingerprint)
					return json(res, 409, { error: "Request ID already belongs to another operation." });
				if (record === undefined) {
					if ((mutation && session.requests.size >= 32) || session.inFlight >= 4)
						return json(res, 429, { error: "Session request limit reached." });
					session.inFlight++;
					const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(120_000)]);
					const isLive = () => !signal.aborted && session.expiresAt > Date.now();
					const result = (async (): Promise<WebResult> => {
						if (
							parsed.operation.type === "mission" &&
							parsed.operation.request.operation === "agree" &&
							(managed || parsed.previousReceipt !== undefined)
						) {
							if (options.managedAgreement === undefined) {
								if (managed && click !== undefined)
									throw new Error("Protected agreement history is unavailable.");
								return { requestId: parsed.requestId, state: "refused", code: "not-enabled" };
							}
							if (click === undefined)
								return { requestId: parsed.requestId, state: "refused", code: "stale-authority" };
							const { requestId } = click;
							const outcome = await options.managedAgreement.agree(click, signal, isLive);
							if (outcome.status === "refused") return { requestId, state: "refused", code: outcome.code };
							if (outcome.status === "issued")
								return {
									requestId,
									state: "issued",
									receiptId: outcome.receiptId,
									reconciled: outcome.reconciled,
								};
							throw new Error("Protected agreement outcome is unknown.");
						}
						const response = await options.client.request(parsed.operation, signal);
						if (missionMutation && response.type === "mission-refused")
							return {
								requestId: parsed.requestId,
								state: "refused",
								code: parseMissionRefusalCode(response.code),
							};
						// An owner error can follow a committed mutation; it does not prove refusal.
						if (mutation && response.type === "error") throw new Error("Owner mutation outcome is unknown.");
						if (parsed.operation.type === "mission" && parsed.operation.request.operation === "agree") {
							if (
								response.type !== "mission" ||
								response.result.authority !== "developer-local" ||
								!response.result.agreementValid ||
								response.result.formation.agreement?.revision !== parsed.operation.request.revision ||
								response.result.formation.agreement.digest !== parsed.operation.request.digest
							)
								throw new Error("Owner agreement outcome is unknown.");
						}
						// The service transport bounds the owner frame. This limit covers the entire browser reply.
						const completed: WebResult = {
							requestId: parsed.requestId,
							state: "completed",
							response: projectWebResponse(
								parsed.operation,
								response,
								managed && response.type === "mission"
									? { review: await options.managedAgreement?.review(response.result) }
									: undefined,
							),
						};
						if (Buffer.byteLength(JSON.stringify(completed)) > limit)
							return {
								requestId: parsed.requestId,
								state: "unknown",
								message: "Owner response exceeded the browser limit. Inspect current work before acting again.",
							};
						return completed;
					})()
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
					if (mutation) session.requests.set(parsed.requestId, record);
				}
				let result = await record.result;
				if (
					retry &&
					click !== undefined &&
					options.managedAgreement?.lookup !== undefined &&
					(result.state === "unknown" || (result.state === "issued" && !result.reconciled)) &&
					!session.abort.signal.aborted &&
					session.expiresAt > Date.now() &&
					session.inFlight < 4
				) {
					session.inFlight++;
					try {
						const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(10_000)]);
						const observed = await options.managedAgreement.lookup(click, signal).catch(() => undefined);
						if (observed?.status === "issued")
							result = {
								requestId: click.requestId,
								state: "issued",
								receiptId: observed.receiptId,
								reconciled: observed.reconciled,
							};
					} finally {
						session.inFlight--;
					}
				}
				if (session.expiresAt <= Date.now() || session.abort.signal.aborted)
					return json(res, 200, {
						requestId: parsed.requestId,
						state: "unknown",
						message: "Session ended after dispatch. Inspect the owner before acting again.",
					});
				return json(res, 200, result);
			}
			return json(res, 404, { error: "Unknown endpoint." });
		}
		const asset = path === undefined ? undefined : options.assets.get(path);
		if ((req.method !== "GET" && req.method !== "HEAD") || asset === undefined)
			return json(res, 404, { error: "Not found." });
		res.writeHead(200, { "Content-Type": asset.contentType, "Content-Length": asset.body.byteLength });
		res.end(req.method === "HEAD" ? undefined : asset.body);
	}

	function pairingUnavailable(res: ServerResponse): boolean {
		const remaining = pairingResetAt - Date.now();
		if (remaining <= 0) pairingFailures = 0;
		if (!paired && pairingFailures < 5) return false;
		if (!paired) res.setHeader("Retry-After", Math.ceil(remaining / 1000));
		json(res, 429, { error: "Pairing is temporarily unavailable." });
		return true;
	}
}

// The browser contract (web/contract.ts `WorkspaceView`) is closed: an owner frame field reaches the browser only when
// it is named here, so owner-only fields (failure reasons, retry state, the owner's PID) never do by default.
function browserView(view: ServiceView) {
	const { usage, model } = view;
	return {
		name: view.name,
		version: view.version,
		installationId: view.installationId,
		busy: view.busy,
		model: model === null ? null : { provider: model.provider, modelId: model.modelId },
		usage:
			usage === null
				? null
				: {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.totalTokens,
						cost:
							usage.cost.kind === "estimate" ? { kind: "estimate", usd: usage.cost.usd } : { kind: "unknown" },
					},
		entries: view.entries.map((entry) => ({
			id: entry.id,
			role: entry.role,
			text: entry.text,
			truncated: entry.truncated,
			...(entry.source === undefined ? {} : { source: entry.source }),
		})),
		text: view.text,
		textTruncated: view.textTruncated,
		historyTruncated: view.historyTruncated,
		tools: view.tools.map((tool) => ({ callId: tool.callId, name: tool.name, status: tool.status })),
	};
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
