// Defines the browser workspace projection independently of private owner storage.
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

/** The agreed purpose terms and who approved them; display only, approval stays in the terminal. */
export interface MissionAgreementView {
	revision: number;
	successCriteria: readonly string[];
	approvalBoundary: readonly string[];
	reviewEveryMs: number;
	approvedAt: number;
	approvedBy: "local-creator" | "host-administrator" | "developer-local";
	limits: {
		maxCycles: number;
		maxRequests: number;
		maxRetries: number;
		maxNoProgress: number;
		deadlineAt: number;
		maxEstimatedCost: number | null;
	};
}

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
		/** The saved draft's revision, status and digest; the digest is set once the draft is proposed. */
		draft: { revision: number; status: "editing" | "proposed"; digest: string | null } | null;
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

export interface WorkspacePort {
	watch(
		listener: (event: { type: "view"; view: WorkspaceView } | { type: "connection"; state: Connection }) => void,
	): () => void;
	details(): Promise<WorkspaceDetails>;
	send(
		prompt: string,
		requestId: string,
	): Promise<{ state: "completed" } | { state: "unknown" | "failed"; message: string }>;
	cancel(requestId: string): Promise<void>;
	recall(query: string): Promise<WorkspaceDetails["memory"]>;
	/** Reads the bounded memory graph; rejects like `details()` on owner or wire failure. */
	memoryGraph(): Promise<MemoryGraphView>;
	forget(
		id: string,
		requestId: string,
	): Promise<{ state: "completed" } | { state: "unknown" | "failed"; message: string }>;
	logout(): Promise<void>;
}
