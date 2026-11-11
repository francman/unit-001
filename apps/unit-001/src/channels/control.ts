// Shares exact channel status and setup operations between model tools and trusted local owner commands.
import { matchingChannelGrant } from "./authority.ts";
import { type ChannelAdapter, channelIdentity, channelObject, parseChannelSetupInput } from "./contract.ts";
import { channelView, requestChannelSetup } from "./registry.ts";
import { type ChannelAuthorityReader, type ChannelSetupAdapter, type ChannelStore, runChannelSetup } from "./setup.ts";

export type ChannelCommand =
	| { operation: "status" }
	| { operation: "request"; input: ReturnType<typeof parseChannelSetupInput> }
	| { operation: "setup" | "reconcile"; channelId: string };

/** Rejects channel authority, credential or principal claims supplied through local or model wire input. */
export function parseChannelCommand(value: unknown): ChannelCommand {
	const input = channelObject(value);
	const fields =
		input.operation === "status"
			? ["operation"]
			: input.operation === "request"
				? ["operation", "input"]
				: ["operation", "channelId"];
	if (Object.keys(input).some((field) => !fields.includes(field))) throw new Error("Unknown channel command field.");
	if (input.operation === "status") return { operation: "status" };
	if (input.operation === "request") return { operation: "request", input: parseChannelSetupInput(input.input) };
	if (input.operation !== "setup" && input.operation !== "reconcile") throw new Error("Unknown channel operation.");
	return { operation: input.operation, channelId: channelIdentity(input.channelId) };
}

/** Performs only channel metadata and creator-granted setup; never admits remote text to the coding conversation. */
export async function handleChannelCommand(
	command: ChannelCommand,
	store: ChannelStore,
	readAuthority: ChannelAuthorityReader,
	adapters: readonly ChannelAdapter[],
	setupAdapters: readonly ChannelSetupAdapter[],
	now: () => number,
) {
	if (command.operation === "setup" || command.operation === "reconcile")
		return {
			operation: command.operation,
			outcome: await runChannelSetup(command.channelId, store, readAuthority, setupAdapters, now, {
				reconcile: command.operation === "reconcile",
			}),
		};
	const authority = await readAuthority();
	if (command.operation === "request") {
		if (!authority) throw new Error("Configure the protected creator before requesting channel setup.");
		return {
			operation: "request" as const,
			request: await store.commit((state) =>
				requestChannelSetup(state, command.input, authority.creator, adapters, now()),
			),
		};
	}
	const view = channelView(await store.read(), adapters);
	for (const channel of view.channels) {
		if (authority?.channels?.disabled.includes(channel.request.channelId)) {
			channel.status = "disabled";
			channel.outcome = { kind: "disabled" };
			continue;
		}
		if (channel.status !== "disabled" && (!authority || !matchingChannelGrant(channel.request, authority, now()))) {
			channel.status = "awaiting_creator";
			channel.outcome = { kind: "awaiting_creator", step: "grant" };
		}
	}
	return { operation: "status" as const, observedAt: now(), view };
}

export type ChannelResult = Awaited<ReturnType<typeof handleChannelCommand>>;
