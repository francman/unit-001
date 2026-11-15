// Connects the workspace to the paired loopback gateway without replaying mutations.
import type { WorkspacePort, WorkspaceView } from "./contract.ts";

type JsonObject = Record<string, unknown>;

class OwnerRejection extends Error {}

/** Creates a port whose CSRF credential stays in memory and whose writes are never retried. */
export function browserWorkspacePort(csrfToken: string): WorkspacePort {
	let closed = false;
	let events: EventSource | null = null;
	const pending = new AbortController();
	const request = async (operation: JsonObject, requestId: string = crypto.randomUUID()): Promise<JsonObject> => {
		if (closed) throw new Error("Signed out.");
		const response = await fetch("/api/v1/requests", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Unit-CSRF": csrfToken },
			body: JSON.stringify({ requestId, operation }),
			signal: AbortSignal.any([pending.signal, AbortSignal.timeout(125_000)]),
		});
		if (!response.ok)
			throw new OwnerRejection(
				response.status === 401
					? "Session expired. Restart the operator web command, reload, and enter the new pairing code."
					: response.status === 429
						? "Request capacity reached. Wait for active requests; if the action budget is exhausted, restart the web command and pair again."
						: "The gateway rejected this request before dispatch. Check its size and arguments.",
			);
		const result = object(await response.json());
		if (closed || result.state !== "completed") throw new Error("Owner outcome is unknown.");
		const reply = object(result.response);
		if (reply.type === "error")
			throw new OwnerRejection("The owner could not complete this request. Inspect current work before retrying.");
		return reply;
	};
	return {
		watch(listener) {
			events?.close();
			events = new EventSource("/api/v1/events");
			const stream = events;
			stream.addEventListener("view", (event: MessageEvent<string>) => {
				if (closed) return;
				try {
					listener({ type: "view", view: parseWorkspaceView(JSON.parse(event.data)) });
				} catch {
					listener({ type: "connection", state: "offline" });
				}
			});
			stream.addEventListener("connecting", () => listener({ type: "connection", state: "connecting" }));
			stream.onerror = () => {
				if (closed) return;
				listener({ type: "connection", state: "offline" });
				void fetch("/api/v1/session", { cache: "no-store", signal: pending.signal })
					.then(async (response) => {
						const session = object(await response.json());
						if (!closed && session.authenticated === false) {
							stream.close();
							listener({ type: "connection", state: "expired" });
						}
					})
					.catch(() => {});
			};
			return () => stream.close();
		},
		async details() {
			const [missionReply, memoryReply, channelsReply] = await Promise.all([
				request({ type: "mission", request: { operation: "status" } }),
				request({ type: "memory", request: { operation: "stats" } }),
				request({ type: "channels", request: { operation: "status" } }),
			]);
			const mission = object(missionReply.result);
			const formation = object(mission.formation);
			const current = formation.agreement ?? formation.draft;
			const terms = current === null ? {} : object(object(current).terms);
			const stats = object(memoryReply.result);
			const channels = object(object(channelsReply.result).view).channels;
			if (!Array.isArray(channels)) throw new Error("Invalid channel response.");
			return {
				mission: {
					stage: text(mission.stage),
					objective: typeof terms.objective === "string" ? terms.objective : null,
					scope: typeof terms.scope === "string" ? terms.scope : null,
					missing: Array.isArray(mission.missing) ? mission.missing.map(text) : [],
					execution: text(mission.execution),
				},
				memory: {
					count:
						typeof stats.working === "number" && typeof stats.episodic === "number"
							? stats.working + stats.episodic
							: null,
					records: [],
				},
				channels: channels.slice(0, 64).map((value: unknown) => {
					const channel = object(value);
					const input = object(channel.request);
					const outcome = object(channel.outcome);
					return {
						id: text(input.channelId),
						adapter: text(input.adapter),
						status: text(outcome.kind),
						detail:
							outcome.kind === "ready"
								? "Setup identity verified. Message delivery has not been verified."
								: "Setup is pending or unavailable. Creator authority is required.",
					};
				}),
			};
		},
		async send(prompt, requestId) {
			try {
				await request({ type: "send", prompt }, requestId);
				return { state: "completed" };
			} catch (error) {
				if (error instanceof OwnerRejection) return { state: "failed", message: error.message };
				return { state: "unknown", message: "Inspect the current conversation before sending again." };
			}
		},
		async cancel(requestId) {
			await request({ type: "cancel" }, requestId);
		},
		async recall(query) {
			const reply = await request({ type: "memory", request: { operation: "recall", query } });
			const result = object(reply.result);
			if (reply.type !== "memory" || result.operation !== "recall" || !Array.isArray(result.records))
				throw new Error("Invalid memory response.");
			return {
				count: null,
				records: result.records.slice(0, 5).map((value: unknown) => {
					const record = object(value);
					return {
						id: text(record.id),
						content: text(record.content),
						source: `${text(record.origin)}/${text(record.tier)}`,
					};
				}),
			};
		},
		async forget(id, requestId) {
			try {
				await request({ type: "memory", request: { operation: "forget", id, confirmed: true } }, requestId);
				return { state: "completed" };
			} catch (error) {
				if (error instanceof OwnerRejection) return { state: "failed", message: error.message };
				return { state: "unknown", message: "Forget outcome not confirmed. Inspect memory before acting again." };
			}
		},
		async logout() {
			const response = await fetch("/api/v1/logout", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Unit-CSRF": csrfToken },
				body: "{}",
			});
			if (!response.ok && response.status !== 401) throw new Error("Sign out failed.");
			closed = true;
			events?.close();
			pending.abort();
		},
	};
}

/** Validates snapshots before displaying owner-provided text. */
export function parseWorkspaceView(value: unknown): WorkspaceView {
	const view = object(value);
	if (!Array.isArray(view.entries) || view.entries.length > 20 || !Array.isArray(view.tools) || view.tools.length > 32)
		throw new Error("Invalid view.");
	const model = view.model === null ? null : object(view.model);
	return {
		name: text(view.name),
		version: text(view.version),
		installationId: view.installationId === null ? null : text(view.installationId),
		busy: boolean(view.busy),
		model: model === null ? null : { provider: text(model.provider), modelId: text(model.modelId) },
		text: text(view.text),
		textTruncated: boolean(view.textTruncated),
		historyTruncated: boolean(view.historyTruncated),
		entries: view.entries.map((value: unknown) => {
			const entry = object(value);
			if (
				typeof entry.id !== "number" ||
				!Number.isSafeInteger(entry.id) ||
				(entry.role !== "user" && entry.role !== "assistant")
			)
				throw new Error("Invalid entry.");
			return {
				id: entry.id,
				role: entry.role,
				text: text(entry.text),
				truncated: boolean(entry.truncated),
				...(entry.source === "host" ? { source: "host" as const } : {}),
			};
		}),
		tools: view.tools.map((value: unknown) => {
			const tool = object(value);
			return { callId: text(tool.callId), name: text(tool.name), status: text(tool.status) };
		}),
	};
}

function object(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid owner object.");
	return value as JsonObject;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length > 32768) throw new Error("Invalid owner text.");
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("Invalid owner flag.");
	return value;
}
