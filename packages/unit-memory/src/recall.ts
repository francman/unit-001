// Owner-scoped lexical index and bounded deterministic memory retrieval, following relations one hop.
import type { LiveMemory, MemoryRelation, MemoryRelationKind, MemoryState } from "./memory.ts";
import { isLiveRelation } from "./relations.ts";

/** Why a record was recalled: it matched the query, or it is related to a record that did. */
export type MemoryRecallVia = { kind: "match" } | { kind: "relation"; relation: MemoryRelationKind; memoryId: string };

/** A bounded evidence record with its relevance score and how it was reached. */
export type MemoryRecallResult = LiveMemory & { score: number; via: MemoryRecallVia };

type Candidate = { record: LiveMemory; score: number; via: MemoryRecallVia };

// A related record ranks at half the score of the match that led to it, so direct matches win ties of relevance.
const relationWeight = 0.5;

const stopWords = new Set(
	"a an and are as at be by for from how i in is it of on or that the this to was what when where who with".split(" "),
);

/** Tokenize command flags atomically and retain whole identifiers plus underscore parts. */
export function memoryTokens(text: string): Set<string> {
	const normalized = text.normalize("NFKC").toLowerCase();
	const tokens = new Set<string>();
	const remaining = normalized.replace(/--?[\p{L}\p{N}][\p{L}\p{N}_-]*/gu, (flag) => {
		tokens.add(flag);
		return " ";
	});
	for (const match of remaining.matchAll(/[\p{L}\p{N}_]+/gu)) {
		const token = match[0];
		if (!stopWords.has(token)) tokens.add(token);
		if (token.includes("_")) for (const part of token.split("_")) if (part && !stopWords.has(part)) tokens.add(part);
	}
	return tokens;
}

/** Cache one Harness owner's index; clear it when that owner closes. */
export class MemoryRecall {
	private state: MemoryState | undefined;
	private revision = -1;
	private index = new Map<string, Set<string>>();
	private records = new Map<string, LiveMemory>();
	private relations: MemoryState["relations"] | undefined;
	private adjacency = new Map<string, MemoryRelation[]>();

	/** Prepare committed evidence before owner readiness; receipt-only snapshots retain their shared record index. */
	prepare(state: MemoryState | undefined): void {
		if (state === undefined) {
			this.clear();
			return;
		}
		if (this.state === state && this.revision === state.revision) return;
		// Durable shares unchanged document buckets. Same-object callers may instead mutate a transaction-local state.
		if (this.state === state || this.state?.records !== state.records) this.rebuild(state);
		if (this.state === state || this.relations !== state.relations) this.rebuildAdjacency(state);
		this.state = state;
		this.revision = state.revision;
	}

	/** Retrieve relevant evidence without writes, transcript scans, or external calls. */
	recall(
		state: MemoryState | undefined,
		query: string,
		options: { topK?: number; now: number },
	): MemoryRecallResult[] {
		const topK = options.topK ?? 5;
		if (!Number.isInteger(topK) || topK < 1 || topK > 20) throw new Error("Memory topK must be between 1 and 20");
		if (!Number.isFinite(options.now)) throw new Error("Memory timestamp must be finite");
		const tokens = memoryTokens(query);
		if (state === undefined || tokens.size === 0) return [];
		this.prepare(state);
		const matches = new Map<string, number>();
		for (const token of tokens)
			for (const id of this.index.get(token) ?? []) matches.set(id, (matches.get(id) ?? 0) + 1);
		const ranked: Candidate[] = [];
		for (const [id, count] of matches) {
			const record = this.records.get(id);
			if (record === undefined || hasStaleSources(state, record)) continue;
			const recency = Math.exp(-Math.max(0, options.now - record.updatedAt) / 3600000 / 72);
			const score = (count / tokens.size) * (0.8 + 0.2 * record.importance) * (0.7 + 0.3 * recency);
			ranked.push({ record, score, via: { kind: "match" } });
		}
		const direct = select(ranked, topK);
		const selected = this.adjacency.size === 0 ? direct : select(this.withRelated(state, direct), topK);
		return selected.map(({ record, score, via }) => {
			if (record.content.length <= 2000) return { ...record, score, via };
			const points = Array.from(record.content);
			const content = points.length > 2000 ? `${points.slice(0, 1999).join("")}…` : record.content;
			return { ...record, content, score, via };
		});
	}

	/** Release every cached record and posting when the owning Harness closes. */
	clear(): void {
		this.state = undefined;
		this.revision = -1;
		this.index.clear();
		this.records.clear();
		this.relations = undefined;
		this.adjacency.clear();
	}

	// One hop only: neighbours of the selected matches compete with them for the same top-K slots.
	private withRelated(state: MemoryState, direct: Candidate[]): Candidate[] {
		const pool = new Map(direct.map((candidate) => [candidate.record.id, candidate]));
		for (const match of direct) {
			for (const relation of this.adjacency.get(match.record.id) ?? []) {
				if (!isLiveRelation(state, relation)) continue;
				const otherId = relation.from.id === match.record.id ? relation.to.id : relation.from.id;
				const record = this.records.get(otherId);
				if (record === undefined || hasStaleSources(state, record)) continue;
				const score = match.score * relationWeight;
				const prior = pool.get(otherId);
				if (prior !== undefined && prior.score >= score) continue;
				pool.set(otherId, {
					record,
					score,
					via: { kind: "relation", relation: relation.kind, memoryId: match.record.id },
				});
			}
		}
		return [...pool.values()];
	}

	private rebuildAdjacency(state: MemoryState): void {
		this.adjacency.clear();
		for (const relation of Object.values(state.relations))
			for (const id of [relation.from.id, relation.to.id]) {
				const list = this.adjacency.get(id);
				if (list === undefined) this.adjacency.set(id, [relation]);
				else list.push(relation);
			}
		this.relations = state.relations;
	}

	private rebuild(state: MemoryState): void {
		// Document revisions may change only receipts or consolidation bookkeeping; unchanged content keeps its postings.
		for (const [id, previous] of this.records) {
			const current = state.records[id];
			if (current?.state === "live" && current.content === previous.content) continue;
			for (const token of memoryTokens(previous.content)) {
				const posting = this.index.get(token);
				posting?.delete(id);
				if (posting?.size === 0) this.index.delete(token);
			}
			this.records.delete(id);
		}
		for (const record of Object.values(state.records)) {
			if (record.state !== "live") continue;
			const existing = this.records.get(record.id);
			this.records.set(record.id, record);
			if (existing !== undefined) continue;
			for (const token of memoryTokens(record.content)) {
				let posting = this.index.get(token);
				if (posting === undefined) {
					posting = new Set();
					this.index.set(token, posting);
				}
				posting.add(record.id);
			}
		}
	}
}

// A summary whose sources changed or were forgotten no longer states current evidence.
function hasStaleSources(state: MemoryState, record: LiveMemory): boolean {
	return (
		record.tier.kind === "episodic" &&
		record.tier.summaryOf.some((source) => {
			const current = state.records[source.id];
			return current?.state !== "live" || current.revision !== source.revision;
		})
	);
}

// Heap construction is linear; a summary and its own source are never both returned.
function select(ranked: Candidate[], topK: number): Candidate[] {
	for (let index = Math.floor(ranked.length / 2) - 1; index >= 0; index--) rankDown(ranked, index);
	const selected: Candidate[] = [];
	while (ranked.length > 0 && selected.length < topK) {
		const candidate = ranked[0];
		const tail = ranked.pop();
		if (ranked.length > 0 && tail !== undefined) {
			ranked[0] = tail;
			rankDown(ranked, 0);
		}
		const record = candidate.record;
		if (
			record.tier.kind === "episodic" &&
			record.tier.summaryOf.some((source) => selected.some((prior) => prior.record.id === source.id))
		)
			continue;
		if (record.tier.kind === "working") {
			for (let index = selected.length - 1; index >= 0; index--) {
				const prior = selected[index].record;
				if (prior.tier.kind === "episodic" && prior.tier.summaryOf.some((source) => source.id === record.id))
					selected.splice(index, 1);
			}
		}
		selected.push(candidate);
	}
	return selected;
}

// Score, recency, then ID define a total order independent of insertion or posting order.
function rankBefore(a: Candidate, b: Candidate): boolean {
	return (
		a.score > b.score ||
		(a.score === b.score &&
			(a.record.updatedAt > b.record.updatedAt ||
				(a.record.updatedAt === b.record.updatedAt && a.record.id < b.record.id)))
	);
}

function rankDown(heap: Candidate[], start: number): void {
	let index = start;
	while (index * 2 + 1 < heap.length) {
		let next = index * 2 + 1;
		if (next + 1 < heap.length && rankBefore(heap[next + 1], heap[next])) next++;
		if (!rankBefore(heap[next], heap[index])) break;
		[heap[index], heap[next]] = [heap[next], heap[index]];
		index = next;
	}
}
