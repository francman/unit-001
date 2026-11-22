// Defines the browser workspace projection independently of private owner storage.
import type { MissionRefusalCode } from "../src/missions/refusal.ts";

export type Connection = "connected" | "connecting" | "offline" | "expired";

/** Conversation-scope token usage; the cost is an estimate or unknown, never billing. */
export interface WorkspaceUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { kind: "estimate"; usd: number } | { kind: "unknown" };
}

export interface WorkspaceView {
	name: string;
	version: string;
	installationId: string | null;
	busy: boolean;
	model: { provider: string; modelId: string } | null;
	usage: WorkspaceUsage | null;
	entries: readonly { id: number; role: "user" | "assistant"; text: string; truncated: boolean; source?: "host" }[];
	text: string;
	textTruncated: boolean;
	historyTruncated: boolean;
	tools: readonly { callId: string; name: string; status: string }[];
}

/** At most five closed rows, oldest first; null means the retained start was reached. */
export interface ChatHistoryPage {
	entries: WorkspaceView["entries"];
	nextBefore: number | null;
}

/** The agreed purpose terms and its recorded approval. */
export interface MissionAgreementView {
	revision: number;
	successCriteria: readonly string[];
	approvalBoundary: readonly string[];
	reviewEveryMs: number;
	approvedAt: number;
	approvedBy: "local-creator" | "host-administrator" | "developer-local";
	allowedTools?: readonly string[];
	limits: {
		maxCycles: number;
		maxRequests: number;
		maxRetries: number;
		maxNoProgress: number;
		deadlineAt: number;
		maxEstimatedCost: number | null;
	};
}

/** Partial terms can be saved without granting permission or filling defaults. */
export interface MissionDraftTerms {
	objective?: string;
	scope?: string;
	successCriteria?: readonly string[];
	approvalBoundary?: readonly string[];
	reviewEveryMs?: number;
	policy?: {
		allowedTools?: readonly string[];
		maxCycles?: number;
		maxRequests?: number;
		maxRetries?: number;
		maxConsecutiveNoProgress?: number;
		deadlineAt?: number;
		maxEstimatedCost?: number;
	};
}

export type MissionDraftView = { revision: number; status: "editing" | "proposed"; digest: string | null } &
	({ missionId: string; terms: MissionDraftTerms } | { missionId?: never; terms?: never });

/** The gateway's exact review binding, not an authority claim from the draft. */
export type MissionReviewView = {
	missionId: string;
	revision: number;
	digest: string;
	authorityRevision: number;
	previousReceipt: string | null;
};

export type MissionMutation =
	| { operation: "draft"; expectedRevision: number; terms: MissionDraftTerms }
	| { operation: "propose"; expectedRevision: number }
	| { operation: "agree"; revision: number; digest: string; confirmed: true; previousReceipt?: string | null };

export type MissionMutationOutcome =
	| { state: "completed"; mission: WorkspaceDetails["mission"] }
	| { state: "issued"; receiptId: string; reconciled: boolean }
	| { state: "refused"; code: MissionRefusalCode }
	| { state: "rejected" }
	| { state: "unknown" };

/** The port always ends the local session, even when the gateway cannot confirm revocation. */
export type LogoutOutcome = "revoked" | "unconfirmed";

/** The one bounded work run the owner reports; it is not the purpose and not a planner. */
export interface MissionRunView {
	status: "ready" | "running" | "waiting" | "paused" | "blocked" | "completed" | "stopped";
	blocker: string | null;
	/** A retry or maintenance wake only; there is no planner observation time yet. */
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
	evidence: readonly { criterion: string; accepted: boolean; detail: string; observedAt: number }[];
	observedAt: number;
}

export interface MemoryStatsView {
	working: number;
	episodic: number;
	tombstones: number;
	pendingCaptures: number;
	failedCaptures: number;
	consolidation: "idle" | "scheduled";
}

/** How two memories relate: `relates` is symmetric; the others read "from supports/contradicts/updates to". */
export type MemoryRelationKind = "relates" | "supports" | "contradicts" | "updates";

/**
 * A summary link (from = episodic summary, to = working source), or a live relation between two memories
 * (from = the memory that states it, to = the memory it refers to). `derivation` says whether the agent named
 * the relation (`explicit`) or background consolidation found it across conversations (`consolidation`, always `relates`).
 */
export type MemoryGraphEdgeView =
	| { from: string; to: string; kind: "summary" }
	| { from: string; to: string; kind: MemoryRelationKind; derivation: "explicit" | "consolidation" };

/** Read-only snapshot of live memories, their summary links and their relations; bounded, newest first. */
export interface MemoryGraphView {
	nodes: readonly {
		id: string;
		/** Truncated server-side to 280 code points. */
		content: string;
		truncated: boolean;
		kind: "fact" | "preference" | "decision" | "observation";
		tier: "working" | "episodic";
		origin: "user" | "agent" | "tool";
		/** 0..1 as stored. */
		importance: number;
		/** Epoch ms. */
		createdAt: number;
		/** Opaque short key of the provenance conversation, for clustering only. */
		conversation: string;
	}[];
	/** Only between present nodes; summary links first, then relations newest first; at most 1000. */
	edges: readonly MemoryGraphEdgeView[];
	/** Live memories in storage. */
	total: number;
	/** True when nodes.length < total. */
	limited: boolean;
}

export interface WorkspaceDetails {
	/** From the owner `status` request; null when it could not be read. */
	owner: { uptimeMs: number | null; held: boolean; inhibited: boolean; configured: boolean } | null;
	mission: {
		stage: string;
		objective: string | null;
		scope: string | null;
		missing: readonly string[];
		execution: string;
		tools: readonly string[];
		agreement: MissionAgreementView | null;
		run: MissionRunView | null;
		creator: { kind: "human" | "elder" | "organization"; id: string } | null;
		authority: "managed-administrator" | "developer-local" | "unconfigured" | "invalid";
		agreementValid: boolean;
		authorityError: string | null;
		/** True only when the authenticated gateway projects the formation protocol. */
		formationAvailable: boolean;
		/** Affirmative authenticated server capability; an absent flag is false. */
		canAgree: boolean;
		/** The gateway's current protected receipt binding, if projected. */
		previousReceipt?: string | null;
		draft: MissionDraftView | null;
		review: MissionReviewView | null;
	};
	memory: {
		count: number | null;
		stats: MemoryStatsView | null;
		records: readonly { id: string; content: string; source: string }[];
	};
	channels: readonly {
		id: string;
		adapter: string;
		status: string;
		detail: string;
		/** When the owner last checked identity, and what it found; null when never checked. */
		lastHealth: { observedAt: number; healthy: boolean } | null;
		failure: "authorization" | "credentials" | "transport" | "provider" | "identity" | null;
		awaiting: "grant" | "manager-bootstrap" | "telegram-confirmation" | null;
	}[];
}

/** Only `failed` proves the send did not reach the owner. */
export type SendOutcome =
	| { state: "completed" }
	| { state: "failed" | "failed-after-admission" | "unknown"; message: string };

export interface WorkspacePort {
	watch(
		listener: (event: { type: "view"; view: WorkspaceView } | { type: "connection"; state: Connection }) => void,
	): () => void;
	/** Reads before an exclusive ID, or from newest with null; rejects on owner or wire failure. */
	history(before: number | null): Promise<ChatHistoryPage>;
	details(): Promise<WorkspaceDetails>;
	/** Reads only the current mission snapshot; never resends a mutation. */
	mission(): Promise<WorkspaceDetails["mission"]>;
	mutateMission(request: MissionMutation, requestId: string): Promise<MissionMutationOutcome>;
	send(prompt: string, requestId: string): Promise<SendOutcome>;
	cancel(requestId: string): Promise<void>;
	recall(query: string): Promise<WorkspaceDetails["memory"]>;
	/** Reads the bounded memory graph; rejects like `details()` on owner or wire failure. */
	memoryGraph(): Promise<MemoryGraphView>;
	forget(
		id: string,
		requestId: string,
	): Promise<{ state: "completed" } | { state: "unknown" | "failed"; message: string }>;
	logout(): Promise<LogoutOutcome>;
}
