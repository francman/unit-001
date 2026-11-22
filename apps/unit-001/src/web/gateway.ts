// Creates a trusted-workstation browser gateway without opening agent state or granting creator authority.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MissionView } from "../missions/contract.ts";
import { parseMissionRefusalCode } from "../missions/refusal.ts";
import type { ServiceView } from "../service.ts";
import type { ServiceClient } from "../service-client.ts";
import { parseWebRequest, type WebSession } from "./contract.ts";
import {
	isWebMissionMutation,
	type ManagedMissionReview,
	projectWebResponse,
	type WebResult,
} from "./post-response.ts";

export type WebGatewayOptions = {
	client: ServiceClient;
	workspaceId?: string;
	origin: string;
	assets: ReadonlyMap<string, { contentType: string; body: Uint8Array }>;
	managed?: boolean;
	managedReview?: (view: MissionView) => Promise<ManagedMissionReview | undefined>;
};

export type WebGateway = { server: Server; close(): Promise<void> };

/** Builds an inactive server for developer-local TCP or managed filesystem socket connections. */
export function createWebGateway(options: WebGatewayOptions): WebGateway {
	const managed = options.managed === true || options.managedReview !== undefined;
	const origin = new URL(options.origin);
	if (
		origin.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(origin.hostname) ||
		origin.origin !== options.origin
	)
		throw new Error("Gateway requires an exact loopback HTTP origin.");
	const session: WebSession = { csrfToken: randomBytes(32).toString("hex") };
	const shutdown = new AbortController();
	const requests = new Map<string, { fingerprint: string; result: Promise<WebResult> }>();
	let streams = 0;
	let inFlight = 0;
	const server = createServer({ headersTimeout: 5000, requestTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) json(res, 400, { error: "Invalid request." });
			else res.destroy();
		});
	});
	server.maxConnections = 32;
	// Node truncates the header list at this count. Keep one extra so oversized lists can be rejected.
	server.maxHeadersCount = 33;
	server.once("close", () => shutdown.abort());
	return {
		server,
		async close() {
			shutdown.abort();
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
		if (req.rawHeaders.length > 32 * 2) return json(res, 431, { error: "Too many headers." });
		// Verify the actual listening transport and accepted peer independently of HTTP headers.
		const listener = server.address();
		const allowedPeer = managed
			? process.platform !== "win32" &&
				typeof listener === "string" &&
				listener.length > 0 &&
				!listener.startsWith("\0") &&
				req.socket.localAddress === undefined &&
				req.socket.remoteAddress === undefined
			: listener !== null &&
				typeof listener === "object" &&
				["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
		if (
			req.headersDistinct.host?.length !== 1 ||
			req.headers.host !== origin.host ||
			(req.headers.origin !== undefined && req.headers.origin !== options.origin) ||
			Object.keys(req.headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-")) ||
			!allowedPeer
		)
			return json(res, 403, {
				error: `Origin is not permitted. Open ${options.origin} exactly.`,
			});
		const path = req.url;
		if (path?.startsWith("/api/")) {
			if (req.method === "GET" && (path === "/api/v1/session" || path === "/api/v1/events")) {
				if (options.workspaceId !== undefined) res.setHeader("X-Unit-Workspace", options.workspaceId);
			}
			if (req.method === "GET" && path === "/api/v1/session") return json(res, 200, session);
			if (req.method === "GET" && path === "/api/v1/events") {
				if (streams >= 2) return json(res, 429, { error: "Stream limit reached." });
				streams++;
				const disconnected = new AbortController();
				const signal = AbortSignal.any([shutdown.signal, disconnected.signal]);
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.flushHeaders();
				const abort = () => res.destroy();
				signal.addEventListener("abort", abort, { once: true });
				res.once("close", () => disconnected.abort());
				const writeFrame = (frame: string) => {
					if (signal.aborted || res.writableLength + Buffer.byteLength(frame) > 1_048_576) disconnected.abort();
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
					streams--;
					res.end();
				}
				return;
			}
			if (req.method === "POST" && path === "/api/v1/requests") {
				if (
					req.headers.origin !== options.origin ||
					req.headersDistinct["content-type"]?.length !== 1 ||
					req.headers["content-type"] !== "application/json"
				)
					return json(res, 403, { error: "Same-origin JSON is required." });
				if (req.headers["x-unit-csrf"] !== session.csrfToken) return json(res, 403, { error: "CSRF check failed." });
				const parsed = parseWebRequest(await readJson(req));
				if (shutdown.signal.aborted) return json(res, 503, { error: "Gateway is closing." });
				const fingerprint = JSON.stringify(parsed);
				const missionMutation = isWebMissionMutation(parsed.operation);
				const mutation =
					parsed.operation.type === "send" ||
					parsed.operation.type === "cancel" ||
					missionMutation ||
					(parsed.operation.type === "memory" && parsed.operation.request.operation === "forget");
				// A full memory graph (300 nodes of 280 code points) exceeds the general browser limit; it stays within the owner's 1 MiB frame.
				const limit =
					parsed.operation.type === "memory" && parsed.operation.request.operation === "graph" ? 1_048_576 : 131_072;
				let record = mutation ? requests.get(parsed.requestId) : undefined;
				if (record !== undefined && record.fingerprint !== fingerprint)
					return json(res, 409, { error: "Request ID already belongs to another operation." });
				if (record === undefined) {
					if ((mutation && requests.size >= 32) || inFlight >= 4)
						return json(res, 429, { error: "Session request limit reached." });
					inFlight++;
					const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(120_000)]);
					const result = (async (): Promise<WebResult> => {
						if (
							parsed.operation.type === "mission" &&
							parsed.operation.request.operation === "agree" &&
							(managed || parsed.previousReceipt !== undefined)
						)
							return { requestId: parsed.requestId, state: "refused", code: "not-enabled" };
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
						const review =
							managed && response.type === "mission" ? await options.managedReview?.(response.result) : undefined;
						const completed: WebResult = {
							requestId: parsed.requestId,
							state: "completed",
							response: projectWebResponse(
								parsed.operation,
								response,
								managed ? { review: review && { ...review, armed: false } } : undefined,
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
							inFlight--;
						});
					record = { fingerprint, result };
					if (mutation) requests.set(parsed.requestId, record);
				}
				const result = await record.result;
				if (shutdown.signal.aborted)
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
						cost: usage.cost.kind === "estimate" ? { kind: "estimate", usd: usage.cost.usd } : { kind: "unknown" },
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
