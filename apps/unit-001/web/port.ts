// Connects the workspace to the paired loopback gateway without replaying mutations.
import type {
	MemoryGraphEdgeView,
	MemoryGraphView,
	MemoryStatsView,
	MissionAgreementView,
	MissionRunView,
	WorkspaceDetails,
	WorkspacePort,
	WorkspaceUsage,
	WorkspaceView,
} from "./contract.ts";

type JsonObject = Record<string, unknown>;

class GatewayRejection extends Error {}

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
		if (!response.ok) {
			// Only statuses the gateway uses before dispatch can establish that the owner was not called.
			if (![400, 401, 403, 409, 429].includes(response.status)) throw new Error("Owner outcome is unknown.");
			throw new GatewayRejection(
				response.status === 401
					? "Session expired. Restart the operator web command, reload, and enter the new pairing code."
					: response.status === 429
						? "Request capacity reached. Wait for active requests; if the action budget is exhausted, restart the web command and pair again."
						: "The gateway rejected this request before dispatch. Check its size and arguments.",
			);
		}
		const result = object(await response.json());
		if (closed || result.requestId !== requestId || result.state !== "completed")
			throw new Error("Owner outcome is unknown.");
		const reply = object(result.response);
		if (reply.type === "error" && typeof reply.message === "string")
			throw new Error("The owner could not complete this request.");
		if (operation.type === "send") {
			if (reply.type !== "sent" && reply.type !== "send-failed") throw new Error("Unexpected operation response.");
		} else if (reply.type !== (operation.type === "cancel" ? "cancelled" : operation.type)) {
			throw new Error("Unexpected operation response.");
		}
		if (operation.type === "memory" || operation.type === "channels") {
			const body = object(reply.result);
			if (body.operation !== object(operation.request).operation) throw new Error("Unexpected operation response.");
			if (body.operation === "forget") boolean(body.removed);
		}
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
			const [missionReply, memoryReply, channelsReply, owner] = await Promise.all([
				request({ type: "mission", request: { operation: "status" } }),
				request({ type: "memory", request: { operation: "stats" } }),
				request({ type: "channels", request: { operation: "status" } }),
				// A failed status read must not hide mission, memory or channel details.
				request({ type: "status" }).then(parseOwner, () => null),
			]);
			const mission = object(missionReply.result);
			const formation = object(mission.formation);
			const current = formation.agreement ?? formation.draft;
			const terms = current === null ? {} : object(object(current).terms);
			const stats = object(memoryReply.result);
			const channels = object(object(channelsReply.result).view).channels;
			if (!Array.isArray(channels)) throw new Error("Invalid channel response.");
			return {
				owner,
				mission: {
					stage: text(mission.stage),
					objective: typeof terms.objective === "string" ? terms.objective : null,
					scope: typeof terms.scope === "string" ? terms.scope : null,
					missing: Array.isArray(mission.missing) ? mission.missing.map(text) : [],
					execution: text(mission.execution),
					tools: list(mission.tools, 128, text),
					agreement: formation.agreement === null ? null : parseAgreement(formation.agreement),
					run: mission.runtime === undefined || mission.runtime === null ? null : parseRun(mission.runtime),
					creator: mission.creator === null ? null : parseCreator(mission.creator),
					authority: oneOf(mission.authority, AUTHORITIES),
					agreementValid: boolean(mission.agreementValid),
					authorityError: mission.authorityError === null ? null : text(mission.authorityError),
					draft: formation.draft === null ? null : parseDraft(formation.draft),
				},
				memory: {
					count:
						typeof stats.working === "number" && typeof stats.episodic === "number"
							? stats.working + stats.episodic
							: null,
					stats: parseMemoryStats(stats),
					records: [],
				},
				channels: channels.slice(0, 64).map((value: unknown) => {
					const channel = object(value);
					const input = object(channel.request);
					const outcome = object(channel.outcome);
					// The confirmation url on awaiting_creator outcomes is a credential-bearing link; it is never read.
					return {
						id: text(input.channelId),
						adapter: text(input.adapter),
						status: text(outcome.kind),
						detail:
							outcome.kind === "ready"
								? "Setup identity verified. Message delivery has not been verified."
								: "Setup is pending or unavailable. Creator authority is required.",
						lastHealth: channel.lastHealth === null || channel.lastHealth === undefined ? null : parseHealth(channel.lastHealth),
						failure: outcome.kind === "failed" ? oneOf(outcome.reason, FAILURES) : null,
						awaiting: outcome.kind === "awaiting_creator" ? oneOf(outcome.step, AWAITING) : null,
					};
				}),
			} satisfies WorkspaceDetails;
		},
		async send(prompt, requestId) {
			try {
				const reply = await request({ type: "send", prompt }, requestId);
				if (reply.type === "send-failed")
					return {
						state: "failed-after-admission",
						message: "The owner could not complete this request. Your message was sent.",
					};
				return { state: "completed" };
			} catch (error) {
				if (error instanceof GatewayRejection) return { state: "failed", message: error.message };
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
				stats: null,
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
		async memoryGraph() {
			const reply = await request({ type: "memory", request: { operation: "graph" } });
			if (reply.type !== "memory") throw new Error("Invalid memory response.");
			return parseMemoryGraph(reply.result);
		},
		async forget(id, requestId) {
			try {
				await request({ type: "memory", request: { operation: "forget", id, confirmed: true } }, requestId);
				return { state: "completed" };
			} catch (error) {
				if (error instanceof GatewayRejection) return { state: "failed", message: error.message };
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

// Failure reasons and retry state are owner-terminal fields; the gateway's projection never forwards them.
const OWNER_ONLY = ["failure", "retry"];

/** Validates snapshots before displaying owner-provided text. */
export function parseWorkspaceView(value: unknown): WorkspaceView {
	const view = object(value);
	if (
		!Array.isArray(view.entries) ||
		view.entries.length > 20 ||
		!Array.isArray(view.tools) ||
		view.tools.length > 32 ||
		OWNER_ONLY.some((key) => key in view)
	)
		throw new Error("Invalid view.");
	const model = view.model === null ? null : object(view.model);
	return {
		name: text(view.name),
		version: text(view.version),
		installationId: view.installationId === null ? null : text(view.installationId),
		busy: boolean(view.busy),
		model: model === null ? null : { provider: text(model.provider), modelId: text(model.modelId) },
		usage: view.usage === null ? null : parseUsage(view.usage),
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
			if (Object.keys(tool).some((key) => key !== "callId" && key !== "name" && key !== "status"))
				throw new Error("Invalid tool.");
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

const FAILURES = ["authorization", "credentials", "transport", "provider", "identity"] as const;
const AWAITING = ["grant", "manager-bootstrap", "telegram-confirmation"] as const;
const APPROVERS = ["local-creator", "host-administrator", "developer-local"] as const;
const RUN_STATUSES = ["ready", "running", "waiting", "paused", "blocked", "completed", "stopped"] as const;

function parseUsage(value: unknown): WorkspaceUsage {
	const usage = object(value);
	const cost = object(usage.cost);
	return {
		input: number(usage.input),
		output: number(usage.output),
		cacheRead: number(usage.cacheRead),
		cacheWrite: number(usage.cacheWrite),
		totalTokens: number(usage.totalTokens),
		cost:
			cost.kind === "estimate"
				? { kind: "estimate", usd: number(cost.usd) }
				: cost.kind === "unknown"
					? { kind: "unknown" }
					: fail("Invalid owner cost."),
	};
}

function parseOwner(reply: JsonObject): NonNullable<WorkspaceDetails["owner"]> {
	if (reply.type !== "status") throw new Error("Invalid status response.");
	const runtime = object(reply.runtime);
	const maintenance = object(reply.maintenance);
	return {
		uptimeMs: number(runtime.uptimeMs),
		held: maintenance.state === "held",
		inhibited: boolean(reply.inhibited),
		configured: runtime.configuration === "configured",
	};
}

function parseAgreement(value: unknown): MissionAgreementView {
	const agreement = object(value);
	const terms = object(agreement.terms);
	const policy = object(terms.policy);
	const approval = object(agreement.approval);
	return {
		revision: number(agreement.revision),
		successCriteria: list(terms.successCriteria, 32, text),
		approvalBoundary: list(terms.approvalBoundary, 32, text),
		reviewEveryMs: number(terms.reviewEveryMs),
		approvedAt: number(approval.approvedAt),
		approvedBy: oneOf(object(approval.approvedBy).kind, APPROVERS),
		limits: {
			maxCycles: number(policy.maxCycles),
			maxRequests: number(policy.maxRequests),
			maxRetries: number(policy.maxRetries),
			maxNoProgress: number(policy.maxConsecutiveNoProgress),
			deadlineAt: number(policy.deadlineAt),
			maxEstimatedCost: policy.maxEstimatedCost === undefined ? null : number(policy.maxEstimatedCost),
		},
	};
}

function parseRun(value: unknown): MissionRunView {
	const run = object(value);
	return {
		status: oneOf(run.status, RUN_STATUSES),
		blocker: run.blocker === null ? null : text(run.blocker),
		nextWakeAt: run.nextWakeAt === null ? null : number(run.nextWakeAt),
		cycles: number(run.cycles),
		requests: number(run.requests),
		retries: number(run.retries),
		noProgress: number(run.noProgress),
		estimatedCost: number(run.estimatedCost),
		reservedCost: number(run.reservedCost),
		unknownRequests: number(run.unknownRequests),
		unpricedResponses: number(run.unpricedResponses),
		uncertainTools: number(run.uncertainTools),
		evidence: list(run.evidence, 32, (item) => {
			const evidence = object(item);
			return {
				criterion: text(evidence.criterion),
				accepted: boolean(evidence.accepted),
				detail: text(evidence.detail),
				observedAt: number(evidence.observedAt),
			};
		}),
		observedAt: number(run.observedAt),
	};
}

function parseMemoryStats(stats: JsonObject): MemoryStatsView {
	return {
		working: number(stats.working),
		episodic: number(stats.episodic),
		tombstones: number(stats.tombstones),
		pendingCaptures: number(stats.pendingCaptures),
		failedCaptures: number(stats.failedCaptures),
		consolidation: oneOf(stats.consolidation, ["idle", "scheduled"] as const),
	};
}

const GRAPH_NODES = 300;
const GRAPH_EDGES = 1000;
const GRAPH_CONTENT = 280;
const MEMORY_KINDS = ["fact", "preference", "decision", "observation"] as const;
const MEMORY_TIERS = ["working", "episodic"] as const;
const MEMORY_ORIGINS = ["user", "agent", "tool"] as const;
const MEMORY_RELATIONS = ["relates", "supports", "contradicts", "updates"] as const;
const MEMORY_DERIVATIONS = ["explicit", "consolidation"] as const;

/** Validates a memory graph reply; rejects oversize lists, unknown values, self relations and edges to absent nodes. */
export function parseMemoryGraph(value: unknown): MemoryGraphView {
	const graph = object(value);
	if (graph.operation !== "graph") throw new Error("Invalid memory response.");
	const ids = new Set<string>();
	const nodes = list(graph.nodes, GRAPH_NODES, (item) => {
		const node = object(item);
		const id = text(node.id);
		const content = text(node.content);
		if (id.length === 0 || id.length > 1000 || ids.has(id)) throw new Error("Invalid memory id.");
		if (content.length === 0 || Array.from(content).length > GRAPH_CONTENT) throw new Error("Invalid memory content.");
		const importance = number(node.importance);
		if (importance > 1) throw new Error("Invalid memory importance.");
		const conversation = text(node.conversation);
		if (!/^[a-f0-9]{12}$/.test(conversation)) throw new Error("Invalid memory conversation.");
		ids.add(id);
		return {
			id,
			content,
			truncated: boolean(node.truncated),
			kind: oneOf(node.kind, MEMORY_KINDS),
			tier: oneOf(node.tier, MEMORY_TIERS),
			origin: oneOf(node.origin, MEMORY_ORIGINS),
			importance,
			createdAt: number(node.createdAt),
			conversation,
		};
	});
	const edges = list(graph.edges, GRAPH_EDGES, (item): MemoryGraphEdgeView => {
		const edge = object(item);
		const from = text(edge.from);
		const to = text(edge.to);
		if (!ids.has(from) || !ids.has(to)) throw new Error("Invalid memory edge.");
		if (edge.kind === "summary") return { from, to, kind: "summary" };
		if (from === to) throw new Error("Invalid memory edge.");
		return {
			from,
			to,
			kind: oneOf(edge.kind, MEMORY_RELATIONS),
			derivation: oneOf(edge.derivation, MEMORY_DERIVATIONS),
		};
	});
	const total = number(graph.total);
	if (!Number.isSafeInteger(total) || total < nodes.length || boolean(graph.limited) !== nodes.length < total)
		throw new Error("Invalid memory total.");
	return { nodes, edges, total, limited: nodes.length < total };
}

function parseHealth(value: unknown): { observedAt: number; healthy: boolean } {
	const health = object(value);
	return { observedAt: number(health.observedAt), healthy: boolean(health.healthy) };
}

const AUTHORITIES = ["managed-administrator", "developer-local", "unconfigured", "invalid"] as const;
const CREATOR_KINDS = ["human", "elder", "organization"] as const;
const DRAFT_STATUSES = ["editing", "proposed"] as const;

function parseCreator(value: unknown): NonNullable<WorkspaceDetails["mission"]["creator"]> {
	const creator = object(value);
	// The creator's local uid stays in the owner; the page shows who, not which account.
	return { kind: oneOf(creator.kind, CREATOR_KINDS), id: text(creator.id) };
}

function parseDraft(value: unknown): NonNullable<WorkspaceDetails["mission"]["draft"]> {
	const draft = object(value);
	return {
		revision: number(draft.revision),
		status: oneOf(draft.status, DRAFT_STATUSES),
		digest: draft.digest === null ? null : text(draft.digest),
	};
}

function list<T>(value: unknown, max: number, item: (value: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > max) throw new Error("Invalid owner list.");
	return value.map(item);
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("Invalid owner value.");
	return value as T;
}

function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error("Invalid owner number.");
	return value;
}

function fail(message: string): never {
	throw new Error(message);
}
