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

/** How two memories relate: `relates` is symmetric; the others read "from supports/contradicts/updates to". */
export type MemoryRelationKind = "relates" | "supports" | "contradicts" | "updates";

/** A memory identity pinned to the revision a relation or summary was made against. */
export type MemoryRef = { id: string; revision: number };

/** Who established a relation: the author of a memory that named it, or background consolidation. */
export type MemoryRelationProvenance =
	| {
			derivation: "explicit";
			origin: MemoryProvenance["origin"];
			conversationId: ConversationId;
			entryIds: EntryId[];
	  }
	| { derivation: "consolidation"; taskId: TaskId };

/** A typed link between two memories; it holds only while both endpoints are live at their pinned revisions. */
export type MemoryRelation = {
	id: string;
	kind: MemoryRelationKind;
	from: MemoryRef;
	to: MemoryRef;
	createdAt: number;
	provenance: MemoryRelationProvenance;
};

/** Current memory shared by every conversation and fork of one Durable Session. */
export type MemoryState = {
	revision: number;
	records: Record<string, MemoryRecord>;
	relations: Record<string, MemoryRelation>;
	receipts: Record<string, MemoryReceipt>;
	captures: Record<string, CaptureReceipt>;
	consolidation: { state: "idle" } | { state: "scheduled"; taskId: TaskId };
};

/** Session memory has one current value; it is never copied or rewound by a fork. */
export const MemoryDoc = defineDoc<MemoryState>({
	kind: "unit.memory",
	version: 2,
	scope: "session",
	initial: () => ({
		revision: 0,
		records: {},
		relations: {},
		receipts: {},
		captures: {},
		consolidation: { state: "idle" },
	}),
	// Version 1 is the same shape without relations; Durable has already checked the stored version.
	migrate: (value) => ({ ...(value as Omit<MemoryState, "relations">), relations: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});
