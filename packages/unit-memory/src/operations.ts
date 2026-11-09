// Transaction-local memory mutations and content-free operational counts.
import type { LiveMemory, MemoryProvenance, MemoryState } from "./memory.ts";

/** Validated statement and host-established provenance admitted under a stable replay key. */
export type RememberMemory = {
	writeKey: string;
	content: string;
	source?: string;
	importance?: number;
	kind?: LiveMemory["kind"];
	provenance: MemoryProvenance;
	now: number;
};

/** Store one statement, returning the original identity on every replay. */
export function rememberMemory(state: MemoryState, input: RememberMemory): string {
	const receipt = Object.hasOwn(state.receipts, input.writeKey) ? state.receipts[input.writeKey] : undefined;
	if (receipt !== undefined) {
		if (receipt.kind !== "remember") throw new Error("Memory write key already belongs to forget");
		return receipt.memoryId;
	}
	// Tool and operator input is a trust boundary; stored content is bounded in code points.
	if (input.content.trim().length === 0 || Array.from(input.content).length > 2000)
		throw new Error("Memory content must contain 1–2000 code points");
	const importance = input.importance ?? 0.5;
	if (!Number.isFinite(importance) || importance < 0 || importance > 1)
		throw new Error("Memory importance must be between 0 and 1");
	if (!Number.isFinite(input.now)) throw new Error("Memory timestamp must be finite");
	const id = `memory:${input.writeKey}`;
	state.records[id] = {
		state: "live",
		id,
		revision: 1,
		content: input.content,
		kind: input.kind ?? "fact",
		importance,
		createdAt: input.now,
		updatedAt: input.now,
		...(input.source === undefined ? {} : { source: input.source }),
		provenance: input.provenance,
		tier: { kind: "working", consolidation: { state: "pending" } },
	};
	state.receipts[input.writeKey] = { kind: "remember", memoryId: id };
	state.revision++;
	return id;
}

/** Forget a statement and dependent summaries atomically, preserving the first replay result. */
export function forgetMemory(state: MemoryState, input: { writeKey: string; id: string }): boolean {
	const receipt = Object.hasOwn(state.receipts, input.writeKey) ? state.receipts[input.writeKey] : undefined;
	if (receipt !== undefined) {
		if (receipt.kind !== "forget") throw new Error("Memory write key already belongs to remember");
		return receipt.removed;
	}
	const record = state.records[input.id];
	const removed = record?.state === "live";
	if (removed) {
		state.records[input.id] = { state: "forgotten", id: input.id, revision: record.revision + 1 };
		const forgotten = new Set([input.id]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const candidate of Object.values(state.records)) {
				if (
					candidate.state !== "live" ||
					candidate.tier.kind !== "episodic" ||
					!candidate.tier.summaryOf.some((source) => forgotten.has(source.id))
				)
					continue;
				state.records[candidate.id] = { state: "forgotten", id: candidate.id, revision: candidate.revision + 1 };
				forgotten.add(candidate.id);
				changed = true;
			}
		}
	}
	state.receipts[input.writeKey] = { kind: "forget", removed };
	state.revision++;
	return removed;
}

/** Return operational counts without exposing memory content or credentials. */
export function memoryStats(state: MemoryState | undefined) {
	const result = {
		working: 0,
		episodic: 0,
		tombstones: 0,
		pendingCaptures: 0,
		failedCaptures: 0,
		consolidation: state?.consolidation ?? { state: "idle" as const },
	};
	if (state === undefined) return result;
	for (const record of Object.values(state.records)) {
		if (record.state === "forgotten") result.tombstones++;
		else result[record.tier.kind]++;
	}
	for (const capture of Object.values(state.captures)) {
		if (capture.outcome.state === "pending") result.pendingCaptures++;
		if (capture.outcome.state === "failed") result.failedCaptures++;
	}
	return result;
}
