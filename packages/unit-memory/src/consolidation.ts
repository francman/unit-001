// Durable, extractive consolidation of compatible working memories and their cross-conversation relations.
import { createHash } from "node:crypto";
import { type ConversationId, defineTask, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { type LiveMemory, MemoryDoc, type MemoryRef, type MemoryState } from "./memory.ts";
import { memoryTokens } from "./recall.ts";
import { addConsolidationRelations } from "./relations.ts";

type Source = MemoryRef;
type Summary = { id: string; content: string; sources: Source[] };
type ConsolidationCheckpoint =
	| { phase: "select" }
	| { phase: "summarize"; sources: Source[] }
	| { phase: "publish"; sources: Source[] };

const age = 12 * 60 * 60 * 1000;

/** Select pending statements in stable creation order. */
export function pendingMemories(state: MemoryState): LiveMemory[] {
	return Object.values(state.records)
		.filter(
			(record): record is LiveMemory =>
				record.state === "live" && record.tier.kind === "working" && record.tier.consolidation.state === "pending",
		)
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Produce exact source-labelled chunks without combining provenance or splitting statements. */
export function summarizeMemories(records: LiveMemory[]): Summary[] {
	const groups = new Map<string, LiveMemory[]>();
	for (const record of records) {
		const key = JSON.stringify([record.provenance.origin, record.provenance.conversationId, record.kind]);
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	const summaries: Summary[] = [];
	for (const group of groups.values()) {
		let content = "";
		let sources: Source[] = [];
		const texts = new Set<string>();
		const flush = () => {
			if (sources.length === 0) return;
			const id = `summary:${createHash("sha256").update(JSON.stringify(sources)).digest("hex")}`;
			summaries.push({ id, content, sources });
			content = "";
			sources = [];
			texts.clear();
		};
		for (const record of group) {
			const line = `[${record.id}] ${record.content}`;
			if (!texts.has(record.content) && content && Array.from(`${content}\n${line}`).length > 3000) flush();
			if (!texts.has(record.content)) content += `${content ? "\n" : ""}${line}`;
			texts.add(record.content);
			sources.push({ id: record.id, revision: record.revision });
		}
		flush();
	}
	return summaries;
}

/** Maximum `relates` pairs consolidation proposes per batch memory. */
export const MEMORY_RELATIONS_PER_CONSOLIDATED = 3;
// Lexical overlap that counts as related: at least two shared tokens and a Jaccard index of 0.3.
const relatedShared = 2;
const relatedJaccard = 0.3;

/**
 * Pair each batch memory with the most lexically related live working memories of other conversations.
 * Summaries stay per conversation so their provenance is exact; these pairs are the cross-conversation grouping.
 */
export function relatedMemories(
	state: MemoryState,
	batch: readonly LiveMemory[],
): { from: MemoryRef; to: MemoryRef }[] {
	// Background cost: one tokenization of every live working memory per published batch, never on a request path.
	const tokens = new Map<string, Set<string>>();
	const postings = new Map<string, string[]>();
	const working: LiveMemory[] = [];
	for (const record of Object.values(state.records)) {
		if (record.state !== "live" || record.tier.kind !== "working") continue;
		const words = memoryTokens(record.content);
		tokens.set(record.id, words);
		working.push(record);
		for (const word of words) {
			const posting = postings.get(word);
			if (posting === undefined) postings.set(word, [record.id]);
			else posting.push(record.id);
		}
	}
	const byId = new Map(working.map((record) => [record.id, record]));
	const pairs: { from: MemoryRef; to: MemoryRef }[] = [];
	const seen = new Set<string>();
	for (const record of batch) {
		const words = tokens.get(record.id) ?? memoryTokens(record.content);
		const shared = new Map<string, number>();
		for (const word of words)
			for (const id of postings.get(word) ?? []) if (id !== record.id) shared.set(id, (shared.get(id) ?? 0) + 1);
		const ranked: { other: LiveMemory; jaccard: number }[] = [];
		for (const [id, count] of shared) {
			const other = byId.get(id)!;
			if (count < relatedShared || other.provenance.conversationId === record.provenance.conversationId) continue;
			const jaccard = count / (words.size + tokens.get(id)!.size - count);
			if (jaccard >= relatedJaccard) ranked.push({ other, jaccard });
		}
		ranked.sort((a, b) => b.jaccard - a.jaccard || (a.other.id < b.other.id ? -1 : a.other.id > b.other.id ? 1 : 0));
		for (const { other } of ranked.slice(0, MEMORY_RELATIONS_PER_CONSOLIDATED)) {
			const key = JSON.stringify(record.id < other.id ? [record.id, other.id] : [other.id, record.id]);
			if (seen.has(key)) continue;
			seen.add(key);
			pairs.push({
				from: { id: record.id, revision: record.revision },
				to: { id: other.id, revision: other.revision },
			});
		}
	}
	return pairs;
}

/** Consolidate checkpoints survive close/reopen; publication rejects changed or forgotten sources. */
export const MemoryConsolidation = defineTask<null, ConsolidationCheckpoint, null>({
	name: "unit.memory.consolidation",
	version: 1,
	initial: () => ({ phase: "select" }),
	phases: {
		select: async (_task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const state = await tx.doc(MemoryDoc);
				const pending = pendingMemories(state);
				if (pending.length === 0) {
					if (state.consolidation.state === "scheduled" && state.consolidation.taskId === runtime.taskId) {
						state.consolidation = { state: "idle" };
						state.revision++;
					}
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}
				const now = runtime.now();
				if (pending.length < 100 && pending[0]!.createdAt + age > now)
					return {
						status: "sleeping",
						until: Math.min(pending[0]!.createdAt + age, now + 60_000),
						checkpoint: { phase: "select" },
					};
				return {
					status: "running",
					checkpoint: {
						phase: "publish",
						sources: pending.slice(0, 50).map(({ id, revision }) => ({ id, revision })),
					},
				};
			}, context);
		},
		// Released readers may have persisted this phase; new selections validate inside publication instead.
		summarize: async (task, runtime, context) => {
			const state = await runtime.snapshot(MemoryDoc, context);
			const sources = task.state.checkpoint.sources;
			const records = sources.map((source) => state?.records[source.id]);
			const valid = records.every(
				(record, i): record is LiveMemory => record?.state === "live" && record.revision === sources[i]!.revision,
			);
			await runtime.commit(
				() =>
					valid
						? { status: "running", checkpoint: { phase: "publish", sources } }
						: { status: "running", checkpoint: { phase: "select" } },
				context,
			);
		},
		publish: async (task, runtime, context) => {
			const { sources } = task.state.checkpoint;
			const snapshot = await runtime.snapshot(MemoryDoc, context);
			const records = sources.map((source) => snapshot?.records[source.id]);
			const valid = records.every(
				(record, i): record is LiveMemory => record?.state === "live" && record.revision === sources[i]!.revision,
			);
			// Deterministic text is rebuilt outside the transaction, never retained in task checkpoints.
			const summaries = valid ? summarizeMemories(records as LiveMemory[]) : [];
			const related = valid && snapshot !== undefined ? relatedMemories(snapshot, records as LiveMemory[]) : [];
			await runtime.commit(async (tx) => {
				const state = await tx.doc(MemoryDoc);
				if (
					!valid ||
					!sources.every((source) => {
						const record = state.records[source.id];
						return record?.state === "live" && record.revision === source.revision;
					})
				)
					return { status: "running", checkpoint: { phase: "select" } };
				for (const summary of summaries) {
					const records = summary.sources.map((source) => state.records[source.id] as LiveMemory);
					const first = records[0]!;
					// A tombstone is a permanent replay barrier, including deterministic summary identities.
					if (state.records[summary.id]?.state !== "forgotten") {
						state.records[summary.id] = {
							state: "live",
							id: summary.id,
							revision: 1,
							content: summary.content,
							kind: first.kind,
							importance: Math.max(...records.map((record) => record.importance)),
							createdAt: runtime.now(),
							updatedAt: runtime.now(),
							provenance: {
								origin: first.provenance.origin,
								conversationId: first.provenance.conversationId,
								entryIds: [...new Set(records.flatMap((record) => record.provenance.entryIds))],
								derivation: "summary",
							},
							tier: { kind: "episodic", summaryOf: summary.sources },
						};
					}
					for (const record of records)
						record.tier = { kind: "working", consolidation: { state: "done", summaryIds: [summary.id] } };
				}
				// Pairs were found on the snapshot; each endpoint is checked again at its pinned revision here.
				const relations = addConsolidationRelations(state, related, runtime.taskId, runtime.now());
				state.revision++;
				await tx.appendEntry(runtime.conversationId, {
					kind: "unit.memory.consolidated",
					data: { ids: summaries.map((summary) => summary.id), relations },
				});
				return { status: "running", checkpoint: { phase: "select" } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const state = await tx.doc(MemoryDoc);
			if (state.consolidation.state === "scheduled" && state.consolidation.taskId === runtime.taskId) {
				state.consolidation = { state: "idle" };
				state.revision++;
			}
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** Schedule one Session-wide maintenance task in the same transaction as the new memories. */
export async function scheduleMemoryConsolidation(
	tx: Tx,
	conversationId: ConversationId,
	_now: number,
): Promise<TaskId | undefined> {
	const state = await tx.doc(MemoryDoc);
	if (state.consolidation.state === "scheduled") return state.consolidation.taskId;
	if (pendingMemories(state).length === 0) return undefined;
	const taskId = await tx.createTask(MemoryConsolidation, null, {
		conversationId,
		ownership: { kind: "conversation" },
		background: true,
	});
	state.consolidation = { state: "scheduled", taskId };
	state.revision++;
	return taskId;
}
