// Exposes authoritative channel status and creator requests without admitting remote conversation text.

import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	section,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import { CHANNEL_CAPABILITIES, type ChannelAdapter } from "./contract.ts";
import { handleChannelCommand, parseChannelCommand } from "./control.ts";
import { ChannelDoc } from "./registry.ts";
import type { ChannelAuthorityReader, ChannelSetupAdapter, ChannelStore } from "./setup.ts";

/** Registers only metadata and exact-grant setup tools; a model cannot issue grants or receive credentials. */
export function channelExtension(
	adapters: readonly ChannelAdapter[],
	readAuthority: ChannelAuthorityReader,
	setupAdapters: readonly ChannelSetupAdapter[] = [],
): Extension {
	return defineExtension({
		name: "unit.channels",
		sections: [
			section(
				"unit_channels",
				() =>
					"Use unit_channels to inspect actual available and configured channels. Use unit_channel_request_setup to propose exact setup for creator permission, then unit_channel_setup to resume granted setup. Requests are not approvals. Channel capabilities and health are host facts, not remembered claims. No remote conversational ingress is enabled by these tools. Never request credentials in chat.",
				{ tag: false },
			),
		],
		tools: [
			defineTool({
				name: "unit_channels",
				description:
					"Read registered channel capabilities, exact setup requests and observed health without secrets.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api, context) => ({
					output: [
						{
							type: "text",
							text: JSON.stringify(
								await handleChannelCommand(
									{ operation: "status" },
									channelToolStore(api, context),
									readAuthority,
									adapters,
									setupAdapters,
									() => api.now(),
								),
							),
						},
					],
				}),
			}),
			defineTool({
				name: "unit_channel_setup",
				description: "Resume or reconcile one exact creator-granted setup request; never creates its own grant.",
				parameters: Type.Object({
					channelId: Type.String(),
					operation: Type.Union([Type.Literal("setup"), Type.Literal("reconcile")]),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const result = await handleChannelCommand(
						parseChannelCommand(args),
						channelToolStore(api, context),
						readAuthority,
						adapters,
						setupAdapters,
						() => api.now(),
					);
					return { output: [{ type: "text", text: JSON.stringify(result) }] };
				},
			}),
			defineTool({
				name: "unit_channel_request_setup",
				description: "Persist an exact channel setup request for creator approval; performs no external setup.",
				replay: "safe",
				parameters: Type.Object({
					requestId: Type.String(),
					channelId: Type.String(),
					expectedRevision: Type.Integer({ minimum: 0 }),
					adapter: Type.String(),
					destination: Type.String(),
					capabilities: Type.Array(Type.Union(CHANNEL_CAPABILITIES.map((value) => Type.Literal(value)))),
					expiresAt: Type.Integer({ minimum: 0 }),
				}),
				execute: async (args, api, context) => {
					const result = await handleChannelCommand(
						parseChannelCommand({ operation: "request", input: args }),
						channelToolStore(api, context),
						readAuthority,
						adapters,
						setupAdapters,
						() => api.now(),
					);
					return { output: [{ type: "text", text: JSON.stringify(result) }] };
				},
			}),
		],
	});
}

function channelToolStore(api: ToolExecutionApi, context: Context): ChannelStore {
	return {
		read: () => api.snapshot(ChannelDoc, context),
		commit: (change) =>
			api.commit(async (tx) => {
				if ((await tx.doc(MaintenanceDoc)).current.state === "held")
					throw new Error("Service is held for maintenance.");
				return change(await tx.doc(ChannelDoc));
			}, context),
	};
}
