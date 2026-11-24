// The closed vocabulary of the gateway's workspace payload: value lists and size rules the gateway writes and the page reads.

export const RUN_STATES = ["ready", "running", "waiting", "paused", "blocked", "completed", "stopped"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const MISSION_AUTHORITIES = ["managed-administrator", "developer-local", "unconfigured", "invalid"] as const;
export type MissionAuthority = (typeof MISSION_AUTHORITIES)[number];

export const CREATOR_KINDS = ["human", "elder", "organization"] as const;
export type CreatorKind = (typeof CREATOR_KINDS)[number];

export const APPROVER_KINDS = ["local-creator", "host-administrator", "developer-local"] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

export const DRAFT_STATUSES = ["editing", "proposed"] as const;

export const CHANNEL_OUTCOMES = ["awaiting_creator", "configured", "ready", "failed", "unknown", "disabled"] as const;
export const CHANNEL_STEPS = ["grant", "manager-bootstrap", "telegram-confirmation"] as const;
export type ChannelStep = (typeof CHANNEL_STEPS)[number];
export const CHANNEL_FAILURES = ["authorization", "credentials", "transport", "provider", "identity"] as const;
export type ChannelFailure = (typeof CHANNEL_FAILURES)[number];

export const MEMORY_KINDS = ["fact", "preference", "decision", "observation"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_TIERS = ["working", "episodic"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];
export const MEMORY_ORIGINS = ["user", "agent", "tool"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];
export const MEMORY_RELATIONS = ["relates", "supports", "contradicts", "updates"] as const;
export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];
export const MEMORY_DERIVATIONS = ["explicit", "consolidation"] as const;
export type MemoryDerivation = (typeof MEMORY_DERIVATIONS)[number];

/** Size limits of the memory graph reply. */
export const MEMORY_GRAPH_LIMITS = {
	nodes: 300,
	edges: 1000,
	/** The owner truncates a node's content to this many code points. */
	contentPoints: 280,
	idText: 1000,
} as const;

/** What the graph rules read of one node. */
export type GraphNodeFacts = { id: string; content: string; importance: number; conversation: string };

/** What the graph rules read of one edge. */
export type GraphEdgeFacts = { from: string; to: string; kind: string };

/** Returns why a parsed memory graph is not a consistent snapshot, or null when it is; the list caps are the reader's. */
export function memoryGraphProblem(graph: {
	nodes: readonly GraphNodeFacts[];
	edges: readonly GraphEdgeFacts[];
	total: number;
	limited: boolean;
}): string | null {
	const ids = new Set<string>();
	for (const node of graph.nodes) {
		if (!node.id.trim() || ids.has(node.id)) return "Invalid memory id.";
		if (node.content.length === 0 || !withinCodePoints(node.content, MEMORY_GRAPH_LIMITS.contentPoints))
			return "Invalid memory content.";
		if (node.importance > 1) return "Invalid memory importance.";
		if (!/^[a-f0-9]{12}$/.test(node.conversation)) return "Invalid memory conversation.";
		ids.add(node.id);
	}
	for (const edge of graph.edges) {
		if (!ids.has(edge.from) || !ids.has(edge.to) || (edge.kind !== "summary" && edge.from === edge.to))
			return "Invalid memory edge.";
	}
	if (graph.total < graph.nodes.length || graph.limited !== graph.nodes.length < graph.total)
		return "Invalid memory total.";
	return null;
}

/** Counts code points up to the limit, so oversize text is never walked past it. */
export function withinCodePoints(value: string, maximum: number): boolean {
	let points = 0;
	for (const _ of value) if (++points > maximum) return false;
	return true;
}
