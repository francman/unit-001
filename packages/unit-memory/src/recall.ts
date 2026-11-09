// Owner-scoped lexical index and bounded deterministic memory retrieval.
import type { LiveMemory, MemoryState } from "./memory.ts";

/** A bounded evidence record with its lexical relevance score. */
export type MemoryRecallResult = LiveMemory & { score: number };

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
		if (!stopWords.has(match[0])) tokens.add(match[0]);
		for (const part of match[0].split("_")) if (part && !stopWords.has(part)) tokens.add(part);
	}
	return tokens;
}

/** Cache one Harness owner's index; clear it when that owner closes. */
export class MemoryRecall {
	private state: MemoryState | undefined;
	private revision = -1;
	private index = new Map<string, Set<string>>();
	private records = new Map<string, LiveMemory>();

	/** Prepare committed evidence before owner readiness; receipt-only snapshots retain their shared record index. */
	prepare(state: MemoryState | undefined): void {
		if (state === undefined) {
			this.clear();
			return;
		}
		if (this.state === state && this.revision === state.revision) return;
		// Durable shares unchanged document buckets. Same-object callers may instead mutate a transaction-local state.
		if (this.state === state || this.state?.records !== state.records) this.rebuild(state);
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
		const ranked: { record: LiveMemory; score: number }[] = [];
		for (const [id, count] of matches) {
			const record = this.records.get(id);
			if (record === undefined) continue;
			if (
				record.tier.kind === "episodic" &&
				record.tier.summaryOf.some((source) => {
					const current = state.records[source.id];
					return current?.state !== "live" || current.revision !== source.revision;
				})
			)
				continue;
			const recency = Math.exp(-Math.max(0, options.now - record.updatedAt) / 3600000 / 72);
			const score = (count / tokens.size) * (0.8 + 0.2 * record.importance) * (0.7 + 0.3 * recency);
			ranked.push({ record, score });
		}
		// Heap construction is linear; only selected evidence is copied or clipped.
		for (let index = Math.floor(ranked.length / 2) - 1; index >= 0; index--) rankDown(ranked, index);
		const selected: { record: LiveMemory; score: number }[] = [];
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
		return selected.map(({ record, score }) => {
			if (record.content.length <= 2000) return { ...record, score };
			const points = Array.from(record.content);
			const content = points.length > 2000 ? `${points.slice(0, 1999).join("")}…` : record.content;
			return { ...record, content, score };
		});
	}

	/** Release every cached record and posting when the owning Harness closes. */
	clear(): void {
		this.state = undefined;
		this.revision = -1;
		this.index.clear();
		this.records.clear();
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

// Score, recency, then ID define a total order independent of insertion or posting order.
function rankBefore(a: { record: LiveMemory; score: number }, b: { record: LiveMemory; score: number }): boolean {
	return (
		a.score > b.score ||
		(a.score === b.score &&
			(a.record.updatedAt > b.record.updatedAt ||
				(a.record.updatedAt === b.record.updatedAt && a.record.id < b.record.id)))
	);
}

function rankDown(heap: { record: LiveMemory; score: number }[], start: number): void {
	let index = start;
	while (index * 2 + 1 < heap.length) {
		let next = index * 2 + 1;
		if (next + 1 < heap.length && rankBefore(heap[next + 1], heap[next])) next++;
		if (!rankBefore(heap[next], heap[index])) break;
		[heap[index], heap[next]] = [heap[next], heap[index]];
		index = next;
	}
}
