// Projects only fields used by the workspace from a dispatched operation's owner reply.
import type { ServiceRequest } from "../service.ts";

type PostResponse =
	| { type: "error"; message: "Owner rejected the operation." }
	| { type: "sent" }
	| { type: "send-failed" }
	| { type: "cancelled" }
	| StatusResponse
	| { type: "mission"; result: MissionStatus }
	| { type: "channels"; result: ChannelStatus }
	| { type: "memory"; result: MemoryResult };

export type WebResult =
	| { requestId: string; state: "completed"; response: PostResponse }
	| { requestId: string; state: "unknown"; message: string };

type StatusResponse = {
	type: "status";
	inhibited: boolean;
	maintenance: { state: "open" | "held" };
	runtime: { configuration: "configured" | "unconfigured"; uptimeMs: number };
};

type MissionStatus = {
	stage: "awaiting_creator" | "drafting" | "awaiting_approval" | "agreed";
	formation: { agreement: Agreement | null; draft: Draft | null };
	creator: { kind: "human" | "elder" | "organization"; id: string } | null;
	authority: "managed-administrator" | "developer-local" | "unconfigured" | "invalid";
	authorityError: string | null;
	agreementValid: boolean;
	missing: string[];
	execution: "not-implemented" | "not-started" | RunState;
	runtime: Run | null;
	tools: string[];
};

type Agreement = {
	revision: number;
	terms: {
		objective: string;
		scope: string;
		successCriteria: string[];
		approvalBoundary: string[];
		reviewEveryMs: number;
		policy: {
			maxCycles: number;
			maxRequests: number;
			maxRetries: number;
			maxConsecutiveNoProgress: number;
			deadlineAt: number;
			maxEstimatedCost?: number;
		};
	};
	approval: {
		approvedAt: number;
		approvedBy: { kind: "local-creator" | "host-administrator" | "developer-local" };
	};
};

type Draft = {
	revision: number;
	status: "editing" | "proposed";
	digest: string | null;
	terms: { objective?: string; scope?: string };
};

type RunState = "ready" | "running" | "waiting" | "paused" | "blocked" | "completed" | "stopped";
type Run = {
	status: RunState;
	blocker: string | null;
	nextWakeAt: number | null;
	cycles: number;
	requests: number;
	retries: number;
	noProgress: number;
	estimatedCost: number;
	reservedCost: number;
	unknownRequests: number;
	unpricedResponses: number;
	uncertainTools: number;
	evidence: { criterion: string; accepted: boolean; detail: string; observedAt: number }[];
	observedAt: number;
};

type ChannelStatus = {
	operation: "status";
	view: {
		channels: {
			request: { channelId: string; adapter: string };
			outcome: ChannelOutcome;
			lastHealth: { observedAt: number; healthy: boolean } | null;
		}[];
	};
};

type ChannelOutcome =
	| { kind: "awaiting_creator"; step: "grant" | "manager-bootstrap" | "telegram-confirmation" }
	| { kind: "failed"; reason: "authorization" | "credentials" | "transport" | "provider" | "identity" }
	| { kind: "configured" | "ready" | "unknown" | "disabled" };

type MemoryRecord = { id: string; content: string; origin: "user" | "agent" | "tool"; tier: "working" | "episodic" };

type MemoryResult =
	| {
			operation: "stats";
			working: number;
			episodic: number;
			tombstones: number;
			pendingCaptures: number;
			failedCaptures: number;
			consolidation: "idle" | "scheduled";
	  }
	| { operation: "recall"; records: MemoryRecord[] }
	| { operation: "forget"; removed: boolean }
	| MemoryGraph;

type MemoryGraph = {
	operation: "graph";
	nodes: (MemoryRecord & {
		truncated: boolean;
		kind: "fact" | "preference" | "decision" | "observation";
		importance: number;
		createdAt: number;
		conversation: string;
	})[];
	edges: (
		| { from: string; to: string; kind: "summary" }
		| {
				from: string;
				to: string;
				kind: "relates" | "supports" | "contradicts" | "updates";
				derivation: "explicit" | "consolidation";
		  }
	)[];
	total: number;
	limited: boolean;
};

/** Rejects unexpected owner replies; the gateway still knows the operation was dispatched. */
export function projectWebResponse(operation: ServiceRequest, value: unknown): PostResponse {
	const response = object(value);
	if (response.type === "error" && typeof response.message === "string")
		return { type: "error", message: "Owner rejected the operation." };
	switch (operation.type) {
		case "send":
			if (response.type === "reply") {
				const reply = object(response.reply);
				if (reply.status === "answered" && typeof reply.text === "string") return { type: "sent" };
				if (
					reply.status === "failed" &&
					typeof reply.reason === "string" &&
					(reply.detail === undefined || typeof reply.detail === "string")
				)
					return { type: "send-failed" };
			}
			break;
		case "cancel":
			if (response.type === "cancelled") return { type: "cancelled" };
			break;
		case "status":
			if (response.type === "status") return status(response);
			break;
		case "mission":
			if (operation.request.operation === "status" && response.type === "mission")
				return { type: "mission", result: mission(object(response.result)) };
			break;
		case "channels":
			if (operation.request.operation === "status" && response.type === "channels")
				return { type: "channels", result: channels(object(response.result)) };
			break;
		case "memory":
			if (response.type === "memory") {
				const result = object(response.result);
				if (result.operation === operation.request.operation) return { type: "memory", result: memory(result) };
			}
			break;
	}
	return invalid();
}

function status(response: Record<string, unknown>): StatusResponse {
	const maintenance = object(response.maintenance);
	const runtime = object(response.runtime);
	return {
		type: "status",
		inhibited: flag(response.inhibited),
		maintenance: { state: oneOf(maintenance.state, ["open", "held"]) },
		runtime: {
			configuration: oneOf(runtime.configuration, ["configured", "unconfigured"]),
			uptimeMs: count(runtime.uptimeMs),
		},
	};
}

const RUN_STATES = ["ready", "running", "waiting", "paused", "blocked", "completed", "stopped"] as const;

function mission(result: Record<string, unknown>): MissionStatus {
	const formation = object(result.formation);
	const creator = result.creator === null ? null : object(result.creator);
	return {
		stage: oneOf(result.stage, ["awaiting_creator", "drafting", "awaiting_approval", "agreed"]),
		formation: {
			agreement: formation.agreement === null ? null : agreement(object(formation.agreement)),
			draft: formation.draft === null ? null : draft(object(formation.draft)),
		},
		creator:
			creator === null
				? null
				: { kind: oneOf(creator.kind, ["human", "elder", "organization"]), id: text(creator.id, 200) },
		authority: oneOf(result.authority, ["managed-administrator", "developer-local", "unconfigured", "invalid"]),
		authorityError: result.authorityError === null ? null : text(result.authorityError, 1000),
		agreementValid: flag(result.agreementValid),
		missing: rows(result.missing, 32, (item) => text(item, 200)),
		execution: oneOf(result.execution, ["not-implemented", "not-started", ...RUN_STATES]),
		runtime: result.runtime == null ? null : run(object(result.runtime)),
		tools: rows(result.tools, 128, (item) => text(item, 100)),
	};
}

function agreement(value: Record<string, unknown>): Agreement {
	const terms = object(value.terms);
	const policy = object(terms.policy);
	const approval = object(value.approval);
	return {
		revision: count(value.revision),
		terms: {
			objective: text(terms.objective, 4096),
			scope: text(terms.scope, 4096),
			successCriteria: rows(terms.successCriteria, 32, (item) => text(item, 2000)),
			approvalBoundary: rows(terms.approvalBoundary, 32, (item) => text(item, 2000)),
			reviewEveryMs: count(terms.reviewEveryMs),
			policy: {
				maxCycles: count(policy.maxCycles),
				maxRequests: count(policy.maxRequests),
				maxRetries: count(policy.maxRetries),
				maxConsecutiveNoProgress: count(policy.maxConsecutiveNoProgress),
				deadlineAt: number(policy.deadlineAt),
				maxEstimatedCost: policy.maxEstimatedCost === undefined ? undefined : number(policy.maxEstimatedCost),
			},
		},
		approval: {
			approvedAt: number(approval.approvedAt),
			approvedBy: {
				kind: oneOf(object(approval.approvedBy).kind, ["local-creator", "host-administrator", "developer-local"]),
			},
		},
	};
}

function draft(value: Record<string, unknown>): Draft {
	const terms = object(value.terms);
	return {
		revision: count(value.revision),
		status: oneOf(value.status, ["editing", "proposed"]),
		digest: value.digest === null ? null : text(value.digest, 64),
		terms: {
			objective: terms.objective === undefined ? undefined : text(terms.objective, 4096),
			scope: terms.scope === undefined ? undefined : text(terms.scope, 4096),
		},
	};
}

function run(value: Record<string, unknown>): Run {
	return {
		status: oneOf(value.status, RUN_STATES),
		blocker: value.blocker === null ? null : text(value.blocker, 200),
		nextWakeAt: value.nextWakeAt === null ? null : number(value.nextWakeAt),
		cycles: count(value.cycles),
		requests: count(value.requests),
		retries: count(value.retries),
		noProgress: count(value.noProgress),
		estimatedCost: number(value.estimatedCost),
		reservedCost: number(value.reservedCost),
		unknownRequests: count(value.unknownRequests),
		unpricedResponses: count(value.unpricedResponses),
		uncertainTools: count(value.uncertainTools),
		evidence: rows(value.evidence, 32, (item) => {
			const evidence = object(item);
			return {
				criterion: text(evidence.criterion, 2000),
				accepted: flag(evidence.accepted),
				detail: text(evidence.detail, 1000),
				observedAt: number(evidence.observedAt),
			};
		}),
		observedAt: number(value.observedAt),
	};
}

function channels(result: Record<string, unknown>): ChannelStatus {
	if (result.operation !== "status") return invalid();
	return {
		operation: "status",
		view: {
			channels: rows(object(result.view).channels, 16, (item) => {
				const channel = object(item);
				const request = object(channel.request);
				const health = channel.lastHealth === null ? null : object(channel.lastHealth);
				return {
					request: { channelId: text(request.channelId, 100), adapter: text(request.adapter, 200) },
					outcome: channelOutcome(object(channel.outcome)),
					lastHealth:
						health === null ? null : { observedAt: count(health.observedAt), healthy: flag(health.healthy) },
				};
			}),
		},
	};
}

const CHANNEL_OUTCOMES = ["awaiting_creator", "configured", "ready", "failed", "unknown", "disabled"] as const;
const CHANNEL_STEPS = ["grant", "manager-bootstrap", "telegram-confirmation"] as const;
const CHANNEL_FAILURES = ["authorization", "credentials", "transport", "provider", "identity"] as const;

function channelOutcome(value: Record<string, unknown>): ChannelOutcome {
	const kind = oneOf(value.kind, CHANNEL_OUTCOMES);
	if (kind === "awaiting_creator") return { kind, step: oneOf(value.step, CHANNEL_STEPS) };
	if (kind === "failed") return { kind, reason: oneOf(value.reason, CHANNEL_FAILURES) };
	return { kind };
}

const ORIGINS = ["user", "agent", "tool"] as const;
const TIERS = ["working", "episodic"] as const;

function memory(result: Record<string, unknown>): MemoryResult {
	switch (result.operation) {
		case "stats":
			return {
				operation: "stats",
				working: count(result.working),
				episodic: count(result.episodic),
				tombstones: count(result.tombstones),
				pendingCaptures: count(result.pendingCaptures),
				failedCaptures: count(result.failedCaptures),
				consolidation: oneOf(result.consolidation, ["idle", "scheduled"]),
			};
		case "recall":
			return {
				operation: "recall",
				records: rows(result.records, 5, (item) => {
					const record = object(item);
					return {
						id: text(record.id, 1000),
						content: text(record.content, 2000),
						origin: oneOf(record.origin, ORIGINS),
						tier: oneOf(record.tier, TIERS),
					};
				}),
			};
		case "forget":
			return { operation: "forget", removed: flag(result.removed) };
		case "graph":
			return graph(result);
		default:
			return invalid();
	}
}

const MEMORY_KINDS = ["fact", "preference", "decision", "observation"] as const;
const RELATION_KINDS = ["relates", "supports", "contradicts", "updates"] as const;
const RELATION_DERIVATIONS = ["explicit", "consolidation"] as const;

function graph(result: Record<string, unknown>): MemoryGraph {
	const ids = new Set<string>();
	const nodes = rows(result.nodes, 300, (item) => {
		const node = object(item);
		const id = text(node.id, 1000);
		const content = text(node.content, 560);
		const importance = number(node.importance);
		const conversation = text(node.conversation, 12);
		if (!id.trim() || ids.has(id) || content.length === 0 || importance > 1 || !/^[a-f0-9]{12}$/.test(conversation))
			return invalid();
		let points = 0;
		for (const _ of content) if (++points > 280) return invalid();
		ids.add(id);
		return {
			id,
			content,
			importance,
			conversation,
			truncated: flag(node.truncated),
			kind: oneOf(node.kind, MEMORY_KINDS),
			tier: oneOf(node.tier, TIERS),
			origin: oneOf(node.origin, ORIGINS),
			createdAt: number(node.createdAt),
		};
	});
	const edges = rows<MemoryGraph["edges"][number]>(result.edges, 1000, (item) => {
		const edge = object(item);
		const from = text(edge.from, 1000);
		const to = text(edge.to, 1000);
		if (!ids.has(from) || !ids.has(to)) return invalid();
		if (edge.kind === "summary") return { from, to, kind: "summary" };
		if (from === to) return invalid();
		return {
			from,
			to,
			kind: oneOf(edge.kind, RELATION_KINDS),
			derivation: oneOf(edge.derivation, RELATION_DERIVATIONS),
		};
	});
	const total = count(result.total);
	const limited = flag(result.limited);
	const expectedLimited = nodes.length < total;
	if (total < nodes.length || limited !== expectedLimited) return invalid();
	return { operation: "graph", nodes, edges, total, limited };
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}

function rows<T>(value: unknown, max: number, row: (value: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > max) return invalid();
	return Array.from(value, row);
}

function text(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length > max) return invalid();
	return value;
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
	return value;
}

function number(value: unknown): number {
	if (typeof value !== "number" || !(value >= 0 && value <= Number.MAX_SAFE_INTEGER)) return invalid();
	return value;
}

function flag(value: unknown): boolean {
	if (typeof value !== "boolean") return invalid();
	return value;
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T {
	for (const member of allowed) if (value === member) return member;
	return invalid();
}

function invalid(): never {
	throw new Error("Unexpected owner response.");
}
