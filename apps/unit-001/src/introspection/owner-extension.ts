// Gives the model access to the same explicit read-only owner queries used by operators.
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { INSPECTION_SCOPES, type InspectionQuery, type InspectionReport, parseInspectionQuery } from "./contract.ts";

export type InspectionReader = (query: InspectionQuery, context: Context) => Promise<InspectionReport>;

/** Installs bounded inspection without tools that mutate state, read credentials or escalate privileges. */
export function ownerInspectionExtension(inspect: InspectionReader): Extension {
	return defineExtension({
		name: "unit.owner.inspection",
		sections: [
			section(
				"owner_inspection",
				() =>
					"Use unit_inspect for fresh runtime, configuration, tool, channel, mission, task, resource or public implementation-file facts. Reports cover only the requested query and the service account's current access. Registration is not health; stored configuration is not observed enforcement. Credentials, environment values and private state files are excluded. File excerpts are bounded public implementation views, not arbitrary filesystem access. Read-only inspection never grants authority or repairs the host.",
				{ tag: false },
			),
		],
		tools: [
			defineTool({
				name: "unit_inspect",
				description:
					"Read current authoritative owner facts or an allowed public implementation excerpt, without model inference, secrets or elevation.",
				parameters: Type.Union([
					...INSPECTION_SCOPES.map((scope) => Type.Object({ scope: Type.Literal(scope) })),
					Type.Object({
						scope: Type.Literal("file"),
						path: Type.String({ maxLength: 300 }),
						offset: Type.Optional(Type.Integer({ minimum: 0 })),
					}),
				]),
				replay: "safe",
				execute: async (args, _api, context) => ({
					output: [{ type: "text", text: JSON.stringify(await inspect(parseInspectionQuery(args), context)) }],
				}),
			}),
		],
	});
}
