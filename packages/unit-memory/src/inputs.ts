// Conversation-local host provenance and recall queries for admitted inputs.
import { type ConversationId, defineDoc, defineEntry, type SubmissionId, type Tx } from "@earendil-works/pi-durable";

/** Input origin supplied by the host rather than inferred from model text. */
export type InputOrigin = "human" | "mission";

/** Host query kept under its Durable submission ID; admission enforces its size bound. */
export type MemoryInput = { origin: InputOrigin; query: string };

/** Pending/current input metadata belongs only to its original conversation. */
export type MemoryInputsState = { inputs: Record<string, MemoryInput> };

/** Immutable transcript provenance distinguishes human input from synthetic mission input. */
export const MemoryInputEntry = defineEntry<{ origin: InputOrigin }>("unit.input");

/** Input metadata survives reopen but starts empty in a fork instead of inheriting pending input. */
export const MemoryInputsDoc = defineDoc<MemoryInputsState>({
	kind: "unit.memory.inputs",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ inputs: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});

/** Record host metadata after conversation.submit, inside the same admission transaction. */
export async function recordMemoryInput(
	tx: Tx,
	conversationId: ConversationId,
	submissionId: SubmissionId,
	origin: InputOrigin,
	query: string,
): Promise<void> {
	const inputs = await tx.doc(MemoryInputsDoc, conversationId);
	const boundedQuery = Array.from(query).slice(0, 2000).join("");
	const existing = inputs.inputs[submissionId];
	// A deduplicated submission may be retried with different wire input; its first provenance is immutable.
	if (existing !== undefined) {
		if (existing.origin !== origin || existing.query !== boundedQuery)
			throw new Error("Memory input admission conflicts with the original submission");
		return;
	}
	inputs.inputs[submissionId] = { origin, query: boundedQuery };
}
