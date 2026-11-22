// Lets the agent save the mission terms it is forming with its owner as a draft revision; drafts grant nothing.
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { MissionRequest, MissionView } from "./contract.ts";

const count = (description: string) => Type.Optional(Type.Integer({ minimum: 0, description }));

/**
 * The `unit_mission_draft` tool: saves complete current draft terms as the next revision through the formation owner.
 * It cannot propose or agree; only the owner's explicit agreement on an exact proposed revision makes terms binding.
 */
export function missionDraftTool(handle: (request: MissionRequest, context: Context) => Promise<MissionView>) {
	return defineTool({
		name: "unit_mission_draft",
		description:
			"Save the mission terms you and your owner are forming as a new draft revision. Send every term agreed so far " +
			"(the draft is replaced, not merged) and the revision you last saw. Saving grants nothing: the owner reviews and " +
			"explicitly agrees to an exact proposed revision; chat words never count as agreement. The result lists the " +
			"terms still missing.",
		parameters: Type.Object({
			expectedRevision: Type.Integer({
				minimum: 0,
				description: "The draft or agreement revision you last saw in unit_mission_status; 0 when there is none.",
			}),
			terms: Type.Object({
				objective: Type.Optional(Type.String({ description: "What the mission is for, in the owner's words." })),
				scope: Type.Optional(Type.String({ description: "What is in and out of bounds." })),
				successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Checkable results, in order." })),
				approvalBoundary: Type.Optional(
					Type.Array(Type.String(), { description: "What to ask the owner first; [] means nothing extra." }),
				),
				reviewEveryMs: count("How often to review progress, in milliseconds."),
				policy: Type.Optional(
					Type.Object({
						allowedTools: Type.Optional(
							Type.Array(Type.String(), { description: "Registered tool actions the mission may use." }),
						),
						maxCycles: count("Most work cycles."),
						maxRequests: count("Most model requests."),
						maxRetries: count("Most retries."),
						maxConsecutiveNoProgress: count("Most consecutive steps without verified progress."),
						deadlineAt: count("Deadline, epoch milliseconds."),
						maxEstimatedCost: Type.Optional(Type.Number({ description: "Estimated spend limit; not a billing cap." })),
					}),
				),
			}),
		}),
		// Retrying the same call reuses its request ID, which the owner treats as the same draft or refuses as stale.
		replay: "safe",
		execute: async (args, api, ctx) => {
			const view = await handle(
				{
					operation: "draft",
					expectedRevision: args.expectedRevision,
					requestId: `tool:${api.taskId}:${api.callId}`,
					terms: args.terms,
				},
				ctx,
			);
			const draft = view.formation.draft;
			const saved = { stage: view.stage, revision: draft?.revision ?? null, missing: view.missing };
			return { output: [{ type: "text", text: JSON.stringify(saved) }] };
		},
	});
}
