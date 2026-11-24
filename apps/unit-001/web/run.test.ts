// Exercises the one explanation of a run that needs the owner, shared by the shell strip, Status and Mission.
import { describe, expect, it } from "vitest";
import type { MissionRunView } from "./contract.ts";
import { blockedExplanation, unknownSentence } from "./ui/run.ts";

const run: MissionRunView = {
	status: "waiting",
	blocker: null,
	nextWakeAt: null,
	cycles: 0,
	requests: 0,
	retries: 0,
	noProgress: 0,
	estimatedCost: 0,
	reservedCost: 0,
	unknownRequests: 0,
	unpricedResponses: 0,
	uncertainTools: 0,
	evidence: [],
	observedAt: 0,
};

describe("blocked run explanation", () => {
	it("says it for a single unpriced response, which the old Status count called them", () => {
		const unpriced = { ...run, unpricedResponses: 1 };
		expect(unknownSentence(unpriced)).toBe("1 response has no known price.");
		expect(blockedExplanation(unpriced, "Bob")).toEqual({
			blocked: false,
			body: "1 response has no known price. Bob will not continue until you review it in a terminal.",
		});
	});

	it("counts requests, tool calls and unpriced responses together", () => {
		const unknown = { ...run, unknownRequests: 1, uncertainTools: 1, unpricedResponses: 1 };
		expect(blockedExplanation(unknown, "Bob").body).toBe(
			"1 model request and 1 tool call have unknown results. 1 response has no known price. Bob will not continue until you review them in a terminal.",
		);
	});

	it("leads with the blocker of a blocked run and names the fallback when it has none", () => {
		expect(blockedExplanation({ ...run, status: "blocked", blocker: "Cost limit reached." }, "Bob")).toEqual({
			blocked: true,
			body: "Cost limit reached. Bob will not continue until you look at it in a terminal.",
		});
		expect(blockedExplanation({ ...run, status: "blocked" }, "Bob").body).toBe(
			"Bob reports it cannot continue. Bob will not continue until you look at it in a terminal.",
		);
	});
});
