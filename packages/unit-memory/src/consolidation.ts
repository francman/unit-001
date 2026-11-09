// Durable, extractive consolidation of compatible working memories.
import { createHash } from "node:crypto";
import { type ConversationId, defineTask, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { type LiveMemory, MemoryDoc, type MemoryState } from "./memory.ts";

type Source = { id: string; revision: number };
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
						phase: "summarize",
						sources: pending.slice(0, 50).map(({ id, revision }) => ({ id, revision })),
					},
				};
			}, context);
		},
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
				state.revision++;
				await tx.appendEntry(runtime.conversationId, {
					kind: "unit.memory.consolidated",
					data: { ids: summaries.map((summary) => summary.id) },
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
