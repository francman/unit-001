// Sample memory graph for the preview build: 60 memories in six conversations with summary links; never part of a release.
import type { MemoryGraphView } from "./contract.ts";

type Node = MemoryGraphView["nodes"][number];
type Kind = Node["kind"];

interface Row {
	kind: Kind;
	text: string;
	/** Fixed id so the search sample and the map describe the same memory. */
	id?: string;
}

interface Conversation {
	key: string;
	working: readonly Row[];
	summaries: readonly [string, string];
}

const hour = 3_600_000;

const conversations: readonly Conversation[] = [
	{
		key: "c1a4",
		working: [
			{ kind: "fact", text: "Harbor pins undici 6.21 in package-lock.json." },
			{ kind: "fact", id: "m2", text: "Harbor's API runs behind a corporate proxy; proxy changes need explicit review." },
			{ kind: "decision", text: "Proxy changes need explicit review before they are merged." },
			{ kind: "observation", text: "Two proxy tests expect the old CONNECT header order." },
			{ kind: "preference", text: "The creator prefers updating assertions over pinning an old version." },
			{ kind: "fact", text: "Advisory GHSA-9f3q affects a dev-only dependency, not Harbor's runtime." },
			{ kind: "observation", text: "The undici 7 patch passes every test except the two proxy ones." },
			{ kind: "decision", id: "m3", text: "Security changes and merges always require explicit creator authorization." },
		],
		summaries: ["Weekly advisory triage: three advisories reviewed, one needs a decision on undici.", "Proxy behavior changed in undici 7; two tests need the new header order."],
	},
	{
		key: "d7b2",
		working: [
			{ kind: "preference", id: "m1", text: "The creator prefers a short weekly digest with links to sources." },
			{ kind: "fact", text: "Digests go out on Monday morning." },
			{ kind: "preference", text: "Keep digests under 200 words." },
			{ kind: "preference", text: "Link every claim to a source." },
			{ kind: "observation", text: "The digest was skipped last week because the feed was down." },
			{ kind: "fact", text: "Digest recipients are the creator and the security desk." },
			{ kind: "preference", text: "Use plain language and avoid jargon." },
			{ kind: "decision", text: "Draft digests are reviewed by the creator before they are sent." },
		],
		summaries: ["Digest format agreed: short, weekly, every claim sourced.", "Digest delivery problems: the feed outage on the 14th."],
	},
	{
		key: "e3c9",
		working: [
			{ kind: "fact", text: "The Project updates connection uses Telegram." },
			{ kind: "observation", text: "Setup identity was verified; message delivery has not been verified." },
			{ kind: "preference", text: "Quiet hours are 22:00 to 07:00; hold messages until then." },
			{ kind: "fact", text: "The bot token is kept by the owner and never shown in chat." },
			{ kind: "fact", text: "Messages over 4000 characters are split into parts." },
			{ kind: "decision", text: "Never claim a message was sent without delivery confirmation." },
			{ kind: "observation", text: "The last connection check ran 15 minutes ago and was healthy." },
			{ kind: "preference", text: "Answer questions in the same thread they were asked in." },
		],
		summaries: ["Telegram connection setup: identity verified, delivery still unconfirmed.", "Quiet hours and delivery rules for Telegram."],
	},
	{
		key: "f0d1",
		working: [
			{ kind: "fact", text: "Release 0.0.9 added browser access guidance." },
			{ kind: "decision", text: "Releases are cut from main after review." },
			{ kind: "fact", text: "The changelog lists new entries under Unreleased first." },
			{ kind: "preference", text: "Release notes should name the affected package." },
			{ kind: "observation", text: "A conflict in package-lock.json was resolved by regenerating it." },
			{ kind: "fact", text: "Pre-commit blocks lockfile commits unless explicitly allowed." },
			{ kind: "decision", text: "Version bumps go through a release branch." },
			{ kind: "observation", text: "The last release finished without a rollback." },
		],
		summaries: ["Release 0.0.9 prepared, reviewed and merged.", "Release rules for the lockfile and the changelog."],
	},
	{
		key: "a8e5",
		working: [
			{ kind: "fact", text: "The monthly model spend limit is five dollars." },
			{ kind: "fact", text: "Cost is an estimate, never a bill." },
			{ kind: "preference", text: "Use the cheaper model for routine summaries." },
			{ kind: "observation", text: "Costs rose after the long triage run on Tuesday." },
			{ kind: "decision", text: "Stop scheduled work when the estimated cost reaches the limit." },
			{ kind: "fact", text: "Responses with no price count as unknown and block scheduled work." },
			{ kind: "preference", text: "The creator reviews spend every Friday." },
			{ kind: "fact", text: "Cache reads cost a fraction of fresh input." },
		],
		summaries: ["Spend limit and estimate rules agreed.", "Review of Tuesday's triage cost."],
	},
	{
		key: "b6f2",
		working: [
			{ kind: "fact", text: "The creator is based in Berlin." },
			{ kind: "preference", text: "Write in British English." },
			{ kind: "preference", text: "No emojis in technical text." },
			{ kind: "observation", text: "The creator usually works in the morning." },
			{ kind: "preference", text: "Give bad news first, then the context." },
			{ kind: "decision", text: "Do not schedule work on Sundays." },
			{ kind: "fact", text: "The creator uses a dark theme on a laptop." },
			{ kind: "preference", text: "Short answers with one concrete example." },
		],
		summaries: ["Communication style: direct, short, British English.", "Working hours and availability."],
	},
];

const relations: readonly (readonly [string, string, "relates" | "supports" | "contradicts" | "updates", "explicit" | "consolidation"])[] = [
	["Keep digests under 200 words.", "Draft digests are reviewed", "relates", "consolidation"],
	["Never claim a message was sent", "Setup identity was verified", "supports", "explicit"],
	["Security changes and merges always require", "Releases are cut from main after review.", "supports", "explicit"],
	["Releases are cut from main after review.", "Version bumps go through a release branch.", "relates", "explicit"],
	["Pre-commit blocks lockfile commits", "Harbor pins undici 6.21", "relates", "consolidation"],
	["The creator prefers updating assertions", "The creator prefers a short weekly digest", "relates", "consolidation"],
	["Stop scheduled work when the estimated cost", "Do not schedule work on Sundays.", "relates", "consolidation"],
	["Quiet hours are 22:00 to 07:00", "The creator usually works in the morning.", "relates", "consolidation"],
	["Use the cheaper model for routine summaries.", "Costs rose after the long triage run", "updates", "explicit"],
	["Use plain language and avoid jargon.", "Communication style: direct, short, British English.", "relates", "explicit"],
	["Short answers with one concrete example.", "Keep digests under 200 words.", "supports", "explicit"],
	["Messages over 4000 characters are split into parts.", "Short answers with one concrete example.", "contradicts", "explicit"],
	["Digests go out on Monday morning.", "Do not schedule work on Sundays.", "supports", "consolidation"],
	["The last release finished without a rollback.", "The monthly model spend limit is five dollars.", "relates", "consolidation"],
	["The bot token is kept by the owner", "Security changes and merges always require", "supports", "explicit"],
	["The digest was skipped last week", "The last connection check ran 15 minutes ago", "relates", "consolidation"],
	["The creator reviews spend every Friday.", "The creator is based in Berlin.", "updates", "explicit"],
];

const origins = ["user", "agent", "tool"] as const;

function build(now: number): { nodes: Node[]; edges: MemoryGraphView["edges"][number][] } {
	const nodes: Node[] = [];
	const edges: MemoryGraphView["edges"][number][] = [];
	let serial = 0;
	conversations.forEach((conversation, c) => {
		const ids = conversation.working.map((row, index) => {
			serial += 1;
			const id = row.id ?? `g${serial}`;
			nodes.push({
				id,
				content: row.text,
				truncated: false,
				kind: row.kind,
				tier: "working",
				origin: row.kind === "observation" ? (index % 2 === 0 ? "agent" : "tool") : row.kind === "decision" || row.kind === "preference" ? "user" : (origins[(index + c) % 2] ?? "user"),
				importance: 0.25 + (((serial * 37) % 70) / 100),
				createdAt: now - (c * 9 + index * 2 + 1) * hour,
				conversation: conversation.key,
			});
			return id;
		});
		conversation.summaries.forEach((summary, s) => {
			serial += 1;
			const id = `g${serial}`;
			nodes.push({
				id,
				content: summary,
				truncated: false,
				kind: "observation",
				tier: "episodic",
				origin: "agent",
				importance: 0.7 + s * 0.1,
				createdAt: now - (c * 9 + 1 + s) * hour * 3,
				conversation: conversation.key,
			});
			// The first summary covers the first four memories, the second the last four plus one shared with the first.
			const covered = s === 0 ? ids.slice(0, 4) : [...ids.slice(3, 8)];
			for (const source of covered) edges.push({ from: id, to: source, kind: "summary" });
		});
	});
	// Relations between memories of different conversations: from states the relation, to is the older memory it refers to.
	const byText = (start: string): string => nodes.find((node) => node.content.startsWith(start))?.id ?? "";
	for (const [from, to, kind, derivation] of relations) {
		const source = byText(from);
		const target = byText(to);
		if (source && target && source !== target) edges.push({ from: source, to: target, kind, derivation });
	}
	// Newest first, as the backend returns it.
	nodes.sort((a, b) => b.createdAt - a.createdAt);
	return { nodes, edges };
}

// 300 memories: the sample repeated five times, each copy tied to the next by a few typed relations, for frame-time checks.
function large(now: number): MemoryGraphView {
	const base = build(now);
	const kinds = ["relates", "supports", "updates", "contradicts"] as const;
	const nodes: Node[] = [];
	const edges: MemoryGraphView["edges"][number][] = [];
	for (let copy = 0; copy < 5; copy++) {
		const suffix = copy === 0 ? "" : `-${copy}`;
		for (const node of base.nodes) nodes.push({ ...node, id: `${node.id}${suffix}`, content: copy === 0 ? node.content : `${node.content} (${copy + 1})`, createdAt: node.createdAt - copy * 5 * hour });
		for (const edge of base.edges) edges.push({ ...edge, from: `${edge.from}${suffix}`, to: `${edge.to}${suffix}` });
		if (copy === 0) continue;
		base.nodes.forEach((node, index) => {
			if (index % 4 !== 0) return;
			const other = base.nodes[(index * 7 + copy * 3) % base.nodes.length];
			if (!other) return;
			edges.push({ from: `${node.id}${suffix}`, to: `${other.id}${copy === 1 ? "" : `-${copy - 1}`}`, kind: kinds[(index + copy) % kinds.length] ?? "relates", derivation: "consolidation" });
		});
	}
	nodes.sort((a, b) => b.createdAt - a.createdAt);
	return { nodes, edges, total: nodes.length, limited: false };
}

// The first `count` memories reached from the newest one along relations (then the rest in order, if that is not enough), with the relations among them.
function connectedPart(graph: MemoryGraphView, count: number): MemoryGraphView {
	const next = new Map<string, string[]>();
	for (const edge of graph.edges) {
		next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
		next.set(edge.to, [...(next.get(edge.to) ?? []), edge.from]);
	}
	const chosen = new Set<string>();
	for (const first of graph.nodes) {
		const queue = [first.id];
		while (queue.length > 0 && chosen.size < count) {
			const id = queue.shift() ?? "";
			if (chosen.has(id)) continue;
			chosen.add(id);
			queue.push(...(next.get(id) ?? []));
		}
		if (chosen.size >= count) break;
	}
	const nodes = graph.nodes.filter((node) => chosen.has(node.id));
	return { nodes, edges: graph.edges.filter((edge) => chosen.has(edge.from) && chosen.has(edge.to)), total: nodes.length, limited: false };
}

/** The sample snapshot for `?graph=` (empty, small, mid, limited, large or the default full sample). */
export function sampleMemoryGraph(now: number, mode: string | null): MemoryGraphView {
	if (mode === "empty") return { nodes: [], edges: [], total: 0, limited: false };
	if (mode === "large") return large(now);
	const { nodes, edges } = build(now);
	// Too few memories for a brain (only the appearing animation), and enough for a brain whose outline carries the shape.
	if (mode === "small") return connectedPart({ nodes, edges, total: nodes.length, limited: false }, 8);
	if (mode === "mid") return connectedPart({ nodes, edges, total: nodes.length, limited: false }, 30);
	if (mode === "limited") {
		const shown = nodes.slice(0, 40);
		const ids = new Set(shown.map((node) => node.id));
		return { nodes: shown, edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), total: 1204, limited: true };
	}
	return { nodes, edges, total: nodes.length, limited: false };
}
