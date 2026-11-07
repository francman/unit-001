// Conversation-local host provenance and recall queries for admitted inputs.
import { defineDoc, defineEntry } from "@earendil-works/pi-durable";

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
