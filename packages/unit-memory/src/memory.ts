// Session-owned memory records and durable replay bookkeeping.
import { type ConversationId, defineDoc, type EntryId, type TaskId } from "@earendil-works/pi-durable";

/** Host-established authorship and immutable source references for a memory. */
export type MemoryProvenance = {
	origin: "user" | "agent" | "tool";
	conversationId: ConversationId;
	entryIds: EntryId[];
	derivation: "explicit" | "capture" | "summary";
};

/** A live statement and its working or source-linked episodic tier. */
export type LiveMemory = {
	state: "live";
	id: string;
	/** Changes with content, provenance, or liveness, not consolidation bookkeeping. */
	revision: number;
	content: string;
	kind: "fact" | "preference" | "decision" | "observation";
	importance: number;
	createdAt: number;
	updatedAt: number;
	source?: string;
	provenance: MemoryProvenance;
	tier:
		| {
				kind: "working";
				consolidation: { state: "pending" } | { state: "done"; summaryIds: string[] };
		  }
		| { kind: "episodic"; summaryOf: { id: string; revision: number }[] };
};

/** Content-free deletion identity that mutation code uses to reject stale work. */
export type ForgottenMemory = { state: "forgotten"; id: string; revision: number };

/** Current live evidence or its content-free deletion marker. */
export type MemoryRecord = LiveMemory | ForgottenMemory;

/** Mutation receipts retain the result that replay-safe tools must return. */
export type MemoryReceipt = { kind: "remember"; memoryId: string } | { kind: "forget"; removed: boolean };

/** A run's scheduled capture and its observable terminal outcome. */
export type CaptureReceipt = {
	taskId: TaskId;
	outcome:
		| { state: "pending" }
		| { state: "completed"; memoryIds: string[] }
		| { state: "failed"; reason: string }
		| { state: "aborted" };
};

/** Current memory shared by every conversation and fork of one Durable Session. */
export type MemoryState = {
	revision: number;
	records: Record<string, MemoryRecord>;
	receipts: Record<string, MemoryReceipt>;
	captures: Record<string, CaptureReceipt>;
	consolidation: { state: "idle" } | { state: "scheduled"; taskId: TaskId };
};

/** Session memory has one current value; it is never copied or rewound by a fork. */
export const MemoryDoc = defineDoc<MemoryState>({
	kind: "unit.memory",
	version: 1,
	scope: "session",
	initial: () => ({ revision: 0, records: {}, receipts: {}, captures: {}, consolidation: { state: "idle" } }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});
