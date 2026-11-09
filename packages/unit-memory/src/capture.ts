// Bounded deterministic capture from host-authenticated human transcript entries.
import {
	type ConversationId,
	type Cursor,
	defineTask,
	type EntryId,
	type EntryRecord,
	type TaskId,
} from "@earendil-works/pi-durable";
import { scheduleMemoryConsolidation } from "./consolidation.ts";
import { MemoryInputEntry } from "./inputs.ts";
import { MemoryDoc } from "./memory.ts";
import { rememberMemory } from "./operations.ts";

export type CaptureInput = {
	first: EntryId;
	last: EntryId;
	answer: EntryId;
	conversationId: ConversationId;
	generationTaskId: TaskId;
};
type CaptureCheckpoint = { phase: "capture"; cursor?: Cursor; memoryIds: string[]; skipped: number };
export type CaptureCandidate = { content: string; kind: "fact" | "preference" };

/** Extract explicit memory requests and preferences, excluding code and quoted lines. */
export function captureCandidates(entry: EntryRecord): { candidates: CaptureCandidate[]; skipped: number } {
	if (!MemoryInputEntry.is(entry) || entry.data.origin !== "human") return { candidates: [], skipped: 0 };
	const candidates: CaptureCandidate[] = [];
	let skipped = 0;
	let fence: { marker: string; length: number } | undefined;
	for (const message of entry.model ?? []) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		for (const line of text.split(/\r?\n/u)) {
			const delimiter = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
			if (delimiter) {
				const marker = delimiter[1]!;
				if (fence === undefined) fence = { marker: marker[0]!, length: marker.length };
				else if (marker[0] === fence.marker && marker.length >= fence.length && delimiter[2]!.trim() === "")
					fence = undefined;
				continue;
			}
			if (fence !== undefined || /^\s*(?:>|["“'‘])/u.test(line)) continue;
			for (const sentence of line.split(/(?<=[.!?])\s+/u)) {
				const statement = sentence.trim();
				const explicit = /^remember(?:\s+that\s+|:\s*|\s+)(.+)$/iu.exec(statement);
				const preference = /^I (?:prefer|dislike)\s+.+/iu.test(statement);
				if (!explicit && !preference) continue;
				const content = explicit ? explicit[1]!.trim() : statement;
				if (content.length === 0 || Array.from(content).length > 2000) {
					skipped++;
					continue;
				}
				candidates.push({ content, kind: preference ? "preference" : "fact" });
			}
		}
	}
	return { candidates, skipped };
}

/** Capture one raw-history page per durable checkpoint using stable source-derived write keys. */
export const MemoryCapture = defineTask<CaptureInput, CaptureCheckpoint, { memoryIds: string[]; skipped: number }>({
	name: "unit.memory.capture",
	version: 1,
	initial: () => ({ phase: "capture", memoryIds: [], skipped: 0 }),
	phases: {
		capture: async (task, runtime, context) => {
			try {
				const checkpoint = task.state.checkpoint;
				const page = await runtime.entries(
					{ minEntryId: task.input.first, maxEntryId: task.input.last, order: "ascending" },
					100,
					checkpoint.cursor,
					context,
				);
				const extracted = page.items.map((entry) => ({ entry, ...captureCandidates(entry) }));
				await runtime.commit(async (tx) => {
					const state = await tx.doc(MemoryDoc);
					const ids = [...checkpoint.memoryIds];
					let skipped = checkpoint.skipped;
					for (const { entry, candidates, skipped: count } of extracted) {
						skipped += count;
						for (const [ordinal, candidate] of candidates.entries()) {
							const id = rememberMemory(state, {
								writeKey: `capture:${task.input.generationTaskId}:${entry.id}:${ordinal}`,
								...candidate,
								provenance: {
									origin: "user",
									conversationId: task.input.conversationId,
									entryIds: [entry.id],
									derivation: "capture",
								},
								now: runtime.now(),
							});
							if (!ids.includes(id)) ids.push(id);
						}
					}
					await scheduleMemoryConsolidation(tx, task.input.conversationId, runtime.now());
					if (page.next !== undefined)
						return {
							status: "running",
							checkpoint: { phase: "capture", cursor: page.next, memoryIds: ids, skipped },
						};
					state.captures[task.input.generationTaskId] = {
						taskId: task.id,
						outcome: { state: "completed", memoryIds: ids },
					};
					state.revision++;
					return { status: "terminal", outcome: { status: "completed", result: { memoryIds: ids, skipped } } };
				}, context);
			} catch (error) {
				if (runtime.signal.aborted) throw error;
				runtime.report(error);
				await runtime.commit(async (tx) => {
					const state = await tx.doc(MemoryDoc);
					state.captures[task.input.generationTaskId] = {
						taskId: task.id,
						outcome: { state: "failed", reason: "Capture failed; inspect task diagnostics" },
					};
					state.revision++;
					return {
						status: "terminal",
						outcome: {
							status: "completed",
							result: { memoryIds: task.state.checkpoint.memoryIds, skipped: task.state.checkpoint.skipped },
						},
					};
				}, context);
			}
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const state = await tx.doc(MemoryDoc);
			state.captures[task.input.generationTaskId] = { taskId: task.id, outcome: { state: "aborted" } };
			state.revision++;
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});
