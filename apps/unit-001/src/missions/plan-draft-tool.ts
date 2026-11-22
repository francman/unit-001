// Lets the agent save a mission plan revision as a draft, for example from a review; drafts grant nothing.
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { MissionRequest, MissionView } from "./contract.ts";
import { parsePlanTerms } from "./plan-terms.ts";

const text = (description: string) => Type.String({ description });
const texts = (description: string) => Type.Array(Type.String(), { description });
const priority = Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]);

/**
 * The `unit_plan_draft` tool: saves complete plan terms as the next draft revision, recorded as saved by Bob. It cannot
 * propose, agree or open, and it never replaces a draft the owner saved; only the owner agrees an exact revision.
 */
export function planDraftTool(handle: (request: MissionRequest, context: Context) => Promise<MissionView>) {
	return defineTool({
		name: "unit_plan_draft",
		description:
			"Save a mission plan revision as a draft when your owner asks you to draft one, for example from a review note. " +
			"Send the whole plan (overall purpose, strategics, tacticals); the draft is replaced, not merged. Saving grants " +
			"nothing: the owner reviews and explicitly agrees an exact proposed revision, and chat words never count as " +
			"agreement. Keep the runnable tactical's binding exactly as unit_mission_status shows it; a new tactical " +
			"without a host verifier is mode 'planned'. The result lists what is still missing.",
		parameters: Type.Object({
			expectedRevision: Type.Integer({
				minimum: 0,
				description: "The plan draft or agreed revision you last saw in unit_mission_status; 0 when there is none.",
			}),
			fromReview: Type.Optional(text("The review note ID this draft answers, if any.")),
			terms: Type.Object({
				overall: Type.Object({
					purpose: text("The enduring purpose, in the owner's words."),
					scope: text("What is in and out of bounds."),
					askFirst: texts("What to ask the owner first; [] means nothing extra."),
					reviewEveryMs: Type.Integer({ minimum: 1, description: "How often to review the plan, in milliseconds." }),
				}),
				strategics: Type.Array(
					Type.Object({
						id: text("Stable lowercase slug."),
						title: text("Short title."),
						intent: text("The outcome this strategic aims at."),
						signals: texts("How a review can judge progress; prose, never host-verified."),
						priority,
					}),
					{ maxItems: 3 },
				),
				tacticals: Type.Array(
					Type.Object({
						id: text("Stable lowercase slug."),
						strategic: text("The id of the strategic this serves."),
						objective: text("The bounded result."),
						successCriteria: texts("Checkable results."),
						priority,
						deadlineAt: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
						mode: Type.Union([Type.Literal("runnable"), Type.Literal("parked"), Type.Literal("planned")]),
						binding: Type.Union([
							Type.Object({
								missionId: Type.String(),
								purposeRevision: Type.Integer({ minimum: 1 }),
								purposeDigest: Type.String(),
							}),
							Type.Null(),
						]),
					}),
					{ maxItems: 6 },
				),
			}),
		}),
		// Retrying the same call reuses its request ID, which the owner treats as the same draft or refuses as stale.
		replay: "safe",
		execute: async (args, api, ctx) => {
			const view = await handle(
				{
					operation: "plan-draft",
					expectedRevision: args.expectedRevision,
					requestId: `tool:${api.taskId}:${api.callId}`,
					// Schema-checked arguments still cross into owner records: the plan parser bounds every field.
					terms: parsePlanTerms(args.terms),
					savedBy: "bob",
					fromReview: args.fromReview ?? null,
				},
				ctx,
			);
			const draft = view.plan?.draft;
			const saved = { revision: draft?.revision ?? null, missing: draft?.missing ?? [] };
			return { output: [{ type: "text", text: JSON.stringify(saved) }] };
		},
	});
}
