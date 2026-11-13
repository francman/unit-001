// Hosts one agent with private administrator and authorized-operator control sockets.
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Agent, Reply } from "./agent.ts";
import { type CommandInterpretation, parseCommandInterpretation } from "./commands/interpretation.ts";
import { ConfigurationError, UsageError } from "./errors.ts";
import {
	authorizeManagedMaintenance,
	type MaintenanceResult,
	type MaintenanceState,
	validateOperationId,
} from "./maintenance.ts";
import { type MemoryRequest, type MemoryResult, parseMemoryRequest, parseMemoryResult } from "./memory-control.ts";
import type { MissionRequest, MissionView } from "./missions/contract.ts";
import { parseMissionRequest, parseMissionView } from "./missions/wire.ts";
import type { RuntimeFacts } from "./orientation.ts";
import { validateSessionName } from "./paths.ts";
import { parseServiceEvent, type ServiceView, serviceView } from "./service-view.ts";

export type { ServiceEvent, ServiceView } from "./service-view.ts";

export type ServiceRequest =
	| { readonly type: "resolve-command"; readonly input: string; readonly surface: "cli" | "slash" }
	| { readonly type: "mission"; readonly request: MissionRequest }
	| { readonly type: "memory"; readonly request: MemoryRequest }
	| { readonly type: "send"; readonly prompt: string; readonly requestId?: string }
	| { readonly type: "status" | "cancel" };

export type MaintenanceRequest =
	| { readonly type: "maintenance-enter"; readonly operationId: string; readonly timeoutMs: number }
	| { readonly type: "maintenance-release"; readonly operationId: string };

export type ServiceResponse =
	| { readonly type: "command-suggestions"; readonly result: CommandInterpretation }
	| { readonly type: "mission"; readonly result: MissionView }
	| { readonly type: "memory"; readonly result: MemoryResult }
	| MaintenanceResult
	| { readonly type: "reply"; readonly reply: Reply }
	| {
			readonly type: "status";
			readonly pid: number;
			readonly version: string;
			readonly name: string;
			readonly installationId: string | null;
			readonly busy: boolean;
			readonly inhibited: boolean;
			readonly maintenance: MaintenanceState;
			readonly runtime: RuntimeFacts;
	  }
	| { readonly type: "cancelled" }
	| { readonly type: "error"; readonly message: string };

const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;

/** Resolves a local service endpoint without opening its database. */
export function serviceEndpoint(directory: string, session: string, platform: NodeJS.Platform): string {
	if (platform === "win32") throw new ConfigurationError("Service mode currently requires Linux or macOS.");
	const path = join(directory, "control", `${validateSessionName(session)}.sock`);
	if (Buffer.byteLength(path) > 103)
		throw new ConfigurationError("The service socket path is too long. Use a shorter --data-dir or session name.");
	return path;
}

/** Resolves the installation's operator socket outside its private state directory. */
export function operatorEndpoint(id: string, session: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
		throw new ConfigurationError("Invalid operator installation identity.");
	const path = join(`/run/unit-001-${id}`, `${validateSessionName(session)}.sock`);
	if (Buffer.byteLength(path) > 103) throw new ConfigurationError("The operator socket path is too long.");
	return path;
}

/** Serves until shutdown or storage failure; disconnecting clients never cancels admitted work. */
export async function runService(
	agent: Agent,
	path: string,
	version: string,
	log: (text: string) => void,
	signal: AbortSignal,
	installationId: string | null = null,
	operatorPath?: string,
): Promise<void> {
	if (signal.aborted) return;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	// The caller holds the session lock, so an old endpoint cannot belong to another live owner.
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	const clients = new Set<Socket>();
	const createListener = (access: "administrator" | "operator") =>
		createServer((socket) => {
			clients.add(socket);
			socket.once("close", () => clients.delete(socket));
			socket.on("error", () => {});
			socket.setEncoding("utf8");
			socket.setTimeout(5_000, () => socket.destroy());
			let buffer = "";
			let handled = false;
			socket.on("data", (chunk: string) => {
				if (handled) return;
				buffer += chunk;
				if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
					handled = true;
					writeResponse(socket, { type: "error", message: "Service request exceeds 64 KiB." });
					return;
				}
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				handled = true;
				socket.setTimeout(0);
				socket.pause();
				let value: unknown;
				try {
					value = JSON.parse(buffer.slice(0, newline));
				} catch (error) {
					writeResponse(socket, {
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				if (typeof value === "object" && value !== null && "type" in value && value.type === "watch") {
					socket.resume();
					void streamViews(agent, socket, version, installationId).catch(() => socket.destroy());
					return;
				}
				// Suggestions are disposable; admitted mission work must survive client disconnection.
				const disconnected = new AbortController();
				socket.once("close", () => disconnected.abort());
				void handleRequest(agent, version, installationId, value, access, disconnected.signal).then(
					(response) => writeResponse(socket, response),
					(error: unknown) =>
						writeResponse(socket, {
							type: "error",
							message: error instanceof Error ? error.message : String(error),
						}),
				);
			});
		});
	const server = createListener("administrator");
	const operatorServer = operatorPath === undefined ? undefined : createListener("operator");
	let operatorPrepared = false;
	let onShutdown: () => void = () => {};
	const stopped = new Promise<void>((resolve, reject) => {
		onShutdown = resolve;
		signal.addEventListener("abort", onShutdown, { once: true });
		server.on("error", reject);
		operatorServer?.on("error", reject);
		void agent.closed.then((end) =>
			reject(end.kind === "failed" ? end.error : new Error("Agent closed unexpectedly.")),
		);
	});
	// A startup failure can precede awaiting stopped; keep its rejection observed during listen/chmod.
	void stopped.catch(() => {});
	try {
		if (operatorServer !== undefined && operatorPath !== undefined) {
			// systemd provisions this installation-owned directory; operators cannot replace its socket.
			const directory = await lstat(dirname(operatorPath)).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			if (directory === undefined) {
				// Old signed updaters preserve the old systemd unit; keep the existing owner available until admin migration.
				log(
					`Operator access is not configured. Stop ${agent.name}, run sudo ${agent.name} operator add USER, then start it.\n`,
				);
			} else {
				if (
					!directory.isDirectory() ||
					directory.isSymbolicLink() ||
					directory.uid !== process.getuid?.() ||
					directory.gid !== process.getgid?.() ||
					(directory.mode & 0o777) !== 0o750
				)
					throw new ConfigurationError(
						"Operator runtime directory must belong to the service account with mode 0750.",
					);
				await unlink(operatorPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
				operatorPrepared = true;
				await new Promise<void>((resolve, reject) => {
					operatorServer.once("error", reject);
					operatorServer.listen(operatorPath, () => {
						operatorServer.off("error", reject);
						resolve();
					});
				});
				await chmod(operatorPath, 0o660);
			}
		}
		// The updater's private readiness probe must not succeed before operator access is prepared.
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.off("error", reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		log(`${agent.name} service ready: ${path}\n`);
		if (signal.aborted) onShutdown();
		await stopped;
	} finally {
		signal.removeEventListener("abort", onShutdown);
		const closed = new Promise<void>((resolve) => {
			if (server.listening) server.close(() => resolve());
			else resolve();
		});
		const operatorClosed = new Promise<void>((resolve) => {
			if (operatorServer?.listening) operatorServer.close(() => resolve());
			else resolve();
		});
		for (const socket of clients) socket.destroy();
		await closed;
		await operatorClosed;
		await unlink(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (operatorPrepared && operatorPath !== undefined)
			await unlink(operatorPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
	}
}

async function streamViews(
	agent: Agent,
	socket: Socket,
	version: string,
	installationId: string | null,
): Promise<void> {
	const watch = await agent.watchConversation(BACKGROUND_CONTEXT);
	try {
		if (socket.destroyed) return;
		const closed = new Promise<void>((resolve) => socket.once("close", resolve));
		const publish = (view: Parameters<typeof serviceView>[0]) => {
			if (socket.destroyed) return;
			const wire = `${JSON.stringify({ type: "view", view: serviceView(view, { pid: process.pid, version, name: agent.name, installationId }) })}\n`;
			// A slow terminal must not accumulate unbounded snapshots or stall the session's watch.
			if (
				Buffer.byteLength(wire) > MAX_RESPONSE_BYTES ||
				socket.writableLength + Buffer.byteLength(wire) > 2 * MAX_RESPONSE_BYTES
			)
				socket.destroy();
			else socket.write(wire);
		};
		publish(watch.value);
		watch.start(async (call) => {
			if (call.kind === "value") publish(call.value);
			else socket.destroy();
		});
		await Promise.race([closed, watch.closed]);
	} finally {
		await watch.stop();
		socket.destroy();
	}
}

/** Watches the running owner's bounded views; abort detaches without cancelling admitted work. */
export function watchService(path: string, listener: (view: ServiceView) => void, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		let buffer = "";
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			socket.destroy();
			if (error === undefined) resolve();
			else reject(error);
		};
		const onAbort = () => finish();
		signal.addEventListener("abort", onAbort, { once: true });
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write('{"type":"watch"}\n'));
		socket.once("error", (error) =>
			finish(new ConfigurationError(`Cannot attach to the service at ${path}: ${error.message}`)),
		);
		socket.once("close", () => finish(new Error("The service disconnected. Reattach to observe continuing work.")));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			try {
				while (buffer.includes("\n")) {
					const newline = buffer.indexOf("\n");
					if (Buffer.byteLength(buffer.slice(0, newline)) > MAX_RESPONSE_BYTES)
						throw new Error("Service view exceeds 1 MiB.");
					const event = parseServiceEvent(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					listener(event.view);
					if (settled) return;
				}
				if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) throw new Error("Service view exceeds 1 MiB.");
			} catch (error) {
				finish(error);
			}
		});
		if (signal.aborted) onAbort();
	});
}

/** Sends one bounded local request; only the service owner accesses SQLite. */
export function requestService(
	path: string,
	request: ServiceRequest | MaintenanceRequest,
	signal: AbortSignal,
): Promise<ServiceResponse> {
	const wire = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(wire) > MAX_REQUEST_BYTES) throw new UsageError("Service request exceeds 64 KiB.");
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		let buffer = "";
		let settled = false;
		const finish = (error?: unknown, response?: ServiceResponse): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			socket.destroy();
			if (error !== undefined) reject(error);
			else if (response !== undefined) resolve(response);
		};
		const onAbort = () => finish(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(wire));
		socket.once("error", (error) =>
			finish(new ConfigurationError(`Cannot reach the service at ${path}: ${error.message}`)),
		);
		socket.once("close", () =>
			finish(
				new Error(
					"The service disconnected before replying; admitted work may still be running. Retry with the same --request-id.",
				),
			),
		);
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES)
				return finish(new Error("Service response exceeds 1 MiB."));
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				finish(undefined, parseResponse(buffer.slice(0, newline)));
			} catch (error) {
				finish(error);
			}
		});
		if (signal.aborted) onAbort();
	});
}

async function handleRequest(
	agent: Agent,
	version: string,
	installationId: string | null,
	value: unknown,
	access: "administrator" | "operator",
	disconnected: AbortSignal,
): Promise<ServiceResponse> {
	// Local wire input is untrusted even when the socket is restricted to its owner.
	if (typeof value !== "object" || value === null || !("type" in value))
		throw new UsageError("Invalid service request.");
	if (
		access === "operator" &&
		value.type !== "status" &&
		value.type !== "send" &&
		value.type !== "cancel" &&
		value.type !== "memory" &&
		value.type !== "mission" &&
		value.type !== "resolve-command"
	)
		throw new UsageError("This operation requires the administrator endpoint.");
	if (value.type === "resolve-command") {
		if (
			!("input" in value) ||
			typeof value.input !== "string" ||
			value.input.length === 0 ||
			value.input.length > 256 ||
			!("surface" in value) ||
			(value.surface !== "cli" && value.surface !== "slash")
		)
			throw new UsageError("Invalid command interpretation request.");
		return {
			type: "command-suggestions",
			result: await agent.resolveCommand(
				value.input,
				value.surface,
				BACKGROUND_CONTEXT,
				AbortSignal.any([disconnected, AbortSignal.timeout(9000)]),
			),
		};
	}
	if (value.type === "mission") {
		if (!("request" in value)) throw new UsageError("Missing mission request.");
		const request = parseMissionRequest(value.request);
		if (access === "operator" && (request.operation === "reconcile" || request.operation === "approve-local"))
			throw new UsageError("Mission approval requires its administrator authority.");
		return { type: "mission", result: await agent.mission(request, BACKGROUND_CONTEXT) };
	}
	if (value.type === "status")
		return {
			type: "status",
			pid: process.pid,
			version,
			name: agent.name,
			installationId,
			...(await agent.status(BACKGROUND_CONTEXT)),
		};
	if (value.type === "cancel") {
		await agent.abort(BACKGROUND_CONTEXT);
		return { type: "cancelled" };
	}
	if (value.type === "memory") {
		if (!("request" in value)) throw new UsageError("Missing memory request.");
		return { type: "memory", result: await agent.memory(parseMemoryRequest(value.request), BACKGROUND_CONTEXT) };
	}
	if (value.type === "maintenance-enter" || value.type === "maintenance-release") {
		const operationId = "operationId" in value ? value.operationId : undefined;
		validateOperationId(operationId);
		if (installationId !== null)
			await authorizeManagedMaintenance(
				installationId,
				version,
				operationId,
				value.type === "maintenance-release" ? "release" : "enter",
			);
		if (value.type === "maintenance-release") return agent.releaseMaintenance(operationId, BACKGROUND_CONTEXT);
		if (!("timeoutMs" in value) || typeof value.timeoutMs !== "number")
			throw new UsageError("Invalid maintenance timeout.");
		return agent.enterMaintenance(operationId, value.timeoutMs, BACKGROUND_CONTEXT);
	}
	if (value.type !== "send" || !("prompt" in value) || typeof value.prompt !== "string" || value.prompt.trim() === "")
		throw new UsageError("Invalid service prompt.");
	const requestId = "requestId" in value ? value.requestId : undefined;
	if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 200))
		throw new UsageError("Request ID must contain 1 to 200 characters.");
	return {
		type: "reply",
		reply: await agent.ask(value.prompt, BACKGROUND_CONTEXT, requestId === undefined ? {} : { requestId }),
	};
}

function writeResponse(socket: Socket, response: ServiceResponse): void {
	if (socket.destroyed) return;
	const wire = `${JSON.stringify(response)}\n`;
	socket.end(
		Buffer.byteLength(wire) <= MAX_RESPONSE_BYTES
			? wire
			: `${JSON.stringify({ type: "error", message: "Service response exceeds 1 MiB." })}\n`,
	);
}

function parseResponse(wire: string): ServiceResponse {
	const value: unknown = JSON.parse(wire);
	// A failed or different local service must not be mistaken for a valid reply.
	if (typeof value === "object" && value !== null && "type" in value) {
		if (value.type === "command-suggestions" && "result" in value)
			return { type: "command-suggestions", result: parseCommandInterpretation(value.result) };
		if (value.type === "mission" && "result" in value)
			return { type: "mission", result: parseMissionView(value.result) };
		if (value.type === "memory" && "result" in value)
			return { type: "memory", result: parseMemoryResult(value.result) };
		if (
			value.type === "maintenance" &&
			"protocol" in value &&
			value.protocol === 1 &&
			"state" in value &&
			"operationId" in value
		) {
			if (value.state === "open" && value.operationId === null)
				return { type: "maintenance", protocol: 1, state: "open", operationId: null };
			if (
				value.state === "held" &&
				typeof value.operationId === "string" &&
				"result" in value &&
				(value.result === "drained" || value.result === "deferred")
			)
				return {
					type: "maintenance",
					protocol: 1,
					state: "held",
					operationId: value.operationId,
					result: value.result,
				};
		}
		if (value.type === "cancelled") return { type: "cancelled" };
		if (
			value.type === "status" &&
			"pid" in value &&
			typeof value.pid === "number" &&
			"version" in value &&
			typeof value.version === "string" &&
			"name" in value &&
			typeof value.name === "string" &&
			"installationId" in value &&
			(value.installationId === null || typeof value.installationId === "string") &&
			"busy" in value &&
			typeof value.busy === "boolean" &&
			"inhibited" in value &&
			typeof value.inhibited === "boolean" &&
			"maintenance" in value &&
			"runtime" in value &&
			typeof value.runtime === "object" &&
			value.runtime !== null &&
			"application" in value.runtime &&
			value.runtime.application === "unit-001" &&
			"name" in value.runtime &&
			typeof value.runtime.name === "string" &&
			"provider" in value.runtime &&
			"modelId" in value.runtime &&
			(((("configuration" in value.runtime && value.runtime.configuration === "configured") ||
				// The published 0.0.7 owner predates the tag; remote clients still validate its configured fields.
				(value.version === "0.0.7" && !("configuration" in value.runtime))) &&
				typeof value.runtime.provider === "string" &&
				typeof value.runtime.modelId === "string") ||
				("configuration" in value.runtime &&
					value.runtime.configuration === "unconfigured" &&
					value.runtime.provider === null &&
					value.runtime.modelId === null)) &&
			"pid" in value.runtime &&
			typeof value.runtime.pid === "number" &&
			Number.isSafeInteger(value.runtime.pid) &&
			value.runtime.pid > 0 &&
			"startedAt" in value.runtime &&
			typeof value.runtime.startedAt === "number" &&
			Number.isSafeInteger(value.runtime.startedAt) &&
			value.runtime.startedAt > 0 &&
			"uptimeMs" in value.runtime &&
			typeof value.runtime.uptimeMs === "number" &&
			Number.isSafeInteger(value.runtime.uptimeMs) &&
			value.runtime.uptimeMs >= 0 &&
			"observedAt" in value.runtime &&
			typeof value.runtime.observedAt === "number" &&
			Number.isSafeInteger(value.runtime.observedAt) &&
			value.runtime.observedAt > 0 &&
			typeof value.maintenance === "object" &&
			value.maintenance !== null &&
			"protocol" in value.maintenance &&
			value.maintenance.protocol === 1 &&
			"state" in value.maintenance &&
			"operationId" in value.maintenance &&
			((value.maintenance.state === "open" && value.maintenance.operationId === null) ||
				(value.maintenance.state === "held" && typeof value.maintenance.operationId === "string"))
		)
			return {
				type: "status",
				pid: value.pid,
				version: value.version,
				name: value.name,
				installationId: value.installationId,
				busy: value.busy,
				inhibited: value.inhibited,
				runtime: {
					application: "unit-001",
					name: value.runtime.name,
					...("configuration" in value.runtime && value.runtime.configuration === "unconfigured"
						? { configuration: "unconfigured" as const, provider: null, modelId: null }
						: {
								configuration: "configured" as const,
								provider: String(value.runtime.provider),
								modelId: String(value.runtime.modelId),
							}),
					pid: value.runtime.pid,
					startedAt: value.runtime.startedAt,
					uptimeMs: value.runtime.uptimeMs,
					observedAt: value.runtime.observedAt,
				},
				maintenance:
					value.maintenance.state === "open"
						? { protocol: 1, state: "open", operationId: null }
						: { protocol: 1, state: "held", operationId: String(value.maintenance.operationId) },
			};
		if (value.type === "error" && "message" in value && typeof value.message === "string")
			return { type: "error", message: value.message };
		if (
			value.type === "reply" &&
			"reply" in value &&
			typeof value.reply === "object" &&
			value.reply !== null &&
			"status" in value.reply
		) {
			const reply = value.reply;
			if (reply.status === "answered" && "text" in reply && typeof reply.text === "string")
				return { type: "reply", reply: { status: "answered", text: reply.text } };
			if (reply.status === "failed" && "reason" in reply && typeof reply.reason === "string") {
				if (!("detail" in reply)) return { type: "reply", reply: { status: "failed", reason: reply.reason } };
				if (typeof reply.detail === "string")
					return { type: "reply", reply: { status: "failed", reason: reply.reason, detail: reply.detail } };
			}
		}
	}
	throw new Error("Invalid service response.");
}
