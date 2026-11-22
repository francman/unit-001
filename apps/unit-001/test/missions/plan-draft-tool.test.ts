// #72: Bob's plan draft tool saves a draft as Bob, never anything stronger, and bounds its arguments.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { MissionRequest, MissionView } from "../../src/missions/contract.ts";
import { planDraftTool } from "../../src/missions/plan-draft-tool.ts";
import { planTerms } from "./fixtures/plan.ts";

function setup() {
	const requests: MissionRequest[] = [];
	const tool = planDraftTool(async (request) => {
		requests.push(request);
		// The tool reads only the saved draft's revision and missing list from the returned view.
		return { plan: { draft: { revision: 3, missing: ["scope"] } } } as unknown as MissionView;
	});
	// The tool reads only the call identity from its API.
	const call = (callId: string, args: Parameters<typeof tool.execute>[0]) =>
		tool.execute(args, { taskId: "task-1", callId, conversationId: "conversation-1" } as unknown as ToolExecutionApi, context);
	return { requests, call };
}

describe("unit_plan_draft", () => {
	it("saves a plan draft as Bob with the call's request ID and reports what is missing", async () => {
		const { requests, call } = setup();
		const result = await call("c1", { expectedRevision: 2, fromReview: "review-1", terms: planTerms() });
		expect(requests).toEqual([
			{
				operation: "plan-draft",
				expectedRevision: 2,
				requestId: "tool:task-1:c1",
				terms: planTerms(),
				savedBy: "bob",
				fromReview: "review-1",
				reviewConversation: "conversation-1",
			},
		]);
		const [first] = result.output ?? [];
		expect(JSON.parse(first?.type === "text" ? first.text : "null")).toEqual({ revision: 3, missing: ["scope"] });
	});

	it("only ever sends a draft operation", async () => {
		const { requests, call } = setup();
		await call("c1", { expectedRevision: 0, terms: planTerms() });
		expect(requests.map((request) => request.operation)).toEqual(["plan-draft"]);
		expect(requests[0]).toMatchObject({ fromReview: null });
	});

	it("bounds its arguments with the plan parser before they reach the owner", async () => {
		const { requests, call } = setup();
		const terms = planTerms({ tacticals: [{ ...planTerms().tacticals[0]!, id: "Not A Slug" }] });
		await expect(call("c1", { expectedRevision: 0, terms })).rejects.toThrow("slugs");
		expect(requests).toEqual([]);
	});
});

describe("codex 1b HOLD item 8", () => {
	it("lets Bob send the plan's review allowance, so a draft keeps the agreed value", () => {
		const tool = planDraftTool(async () => ({}) as MissionView);
		const overall = (tool.parameters as { properties: { terms: { properties: { overall: { properties: object } } } } })
			.properties.terms.properties.overall.properties;
		expect(Object.keys(overall)).toContain("reviewAllowance");
	});
});
