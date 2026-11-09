// Issue #9: summaries preserve source text, provenance and stable identities.
import { describe, expect, it } from "vitest";
import { pendingMemories, summarizeMemories } from "../src/consolidation.ts";
import { type LiveMemory, MemoryDoc } from "../src/memory.ts";
import { rememberMemory } from "../src/operations.ts";

describe("extractive consolidation", () => {
	it("groups provenance and kinds, deduplicates exact text and bounds chunks", () => {
		const state = MemoryDoc.definition.initial!();
		for (let index = 0; index < 5; index++)
			rememberMemory(state, {
				writeKey: `${index}`,
				content: index < 2 ? "same" : "a".repeat(1800),
				now: index,
				kind: index === 4 ? "preference" : "fact",
				provenance: {
					origin: "user",
					conversationId: 1 as LiveMemory["provenance"]["conversationId"],
					entryIds: [],
					derivation: "explicit",
				},
			});
		const records = pendingMemories(state);
		const summaries = summarizeMemories(records);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]!.sources).toHaveLength(4);
		expect(summaries[0]!.content.match(/same/gu)).toHaveLength(1);
		for (const summary of summaries) expect(Array.from(summary.content).length).toBeLessThanOrEqual(3000);
		expect(summarizeMemories(records)).toEqual(summaries);
	});
});
