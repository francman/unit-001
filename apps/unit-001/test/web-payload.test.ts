// The gateway's memory graph projection follows the rules it shares with the page (see web/port.test.ts for the page side).
import { describe, expect, it } from "vitest";
import { memoryGraphProblem, withinCodePoints } from "../src/web/payload.ts";
import { projectWebResponse } from "../src/web/post-response.ts";
import { memoryGraphCases } from "./fixtures/memory-graph-cases.ts";

function gatewayAccepts(result: unknown): boolean {
	try {
		projectWebResponse({ type: "memory", request: { operation: "graph" } }, { type: "memory", result });
		return true;
	} catch {
		return false;
	}
}

describe("memory graph rules shared by the gateway and the page", () => {
	for (const [name, result, accepted] of memoryGraphCases)
		it(`gateway ${accepted ? "accepts" : "rejects"} ${name}`, () => {
			expect(gatewayAccepts(result)).toBe(accepted);
		});

	it("counts code points exactly and finds no problem in an empty graph", () => {
		expect(withinCodePoints("😀😀", 2)).toBe(true);
		expect(withinCodePoints("😀😀😀", 2)).toBe(false);
		expect(memoryGraphProblem({ nodes: [], edges: [], total: 0, limited: false })).toBeNull();
	});
});
