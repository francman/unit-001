// Stores replay-safe channel setup requests and projects observed channel state.
import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { MissionAuthority } from "../missions/contract.ts";
import type { ChannelAdapter, ChannelRequest, ChannelSetupInput, ChannelState } from "./contract.ts";

export const ChannelDoc = defineDoc<ChannelState>({
	kind: "unit.channels",
	version: 1,
	scope: "session",
	initial: () => ({ revision: 0, channels: {}, receipts: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});

/** Records an exact setup proposal without granting permission or performing external work. */
export function requestChannelSetup(
	state: ChannelState,
	input: ChannelSetupInput,
	authority: MissionAuthority,
	adapters: readonly ChannelAdapter[],
	now: number,
): ChannelRequest {
	const digest = channelRequestDigest(input, authority);
	const receipt = state.receipts[input.requestId];
	if (receipt) {
		if (receipt.digest !== digest) throw new Error("Conflicting channel request ID.");
		const existing = state.channels[receipt.channelId];
		if (existing.request.revision !== receipt.revision) throw new Error("Channel request has been superseded.");
		return existing.request;
	}
	const adapter = adapters.find((entry) => entry.id === input.adapter);
	if (!adapter || input.capabilities.some((capability) => !adapter.capabilities.includes(capability)))
		throw new Error("Channel adapter does not support the requested capabilities.");
	if (input.expiresAt <= now || input.expiresAt - now > 7 * 86_400_000)
		throw new Error("Channel request must expire within seven days.");
	const previous = state.channels[input.channelId];
	if ((previous?.request.revision ?? 0) !== input.expectedRevision) throw new Error("Stale channel revision.");
	if (Object.keys(state.receipts).length >= 1024 || (!previous && Object.keys(state.channels).length >= 16))
		throw new Error("Channel registry capacity reached; administrator review required.");
	if (previous?.attempt) throw new Error("Reconcile the active channel setup before changing its request.");
	const request: ChannelRequest = {
		requestId: input.requestId,
		channelId: input.channelId,
		revision: input.expectedRevision + 1,
		adapter: input.adapter,
		destination: input.destination,
		capabilities: input.capabilities,
		expiresAt: input.expiresAt,
		installationId: authority.installationId,
		session: "default",
		creator: authority.creator,
		authorityRevision: authority.revision,
		digest,
	};
	state.channels[input.channelId] = {
		request,
		outcome: { kind: "awaiting_creator", step: "grant" },
		attempt: null,
		lastHealth: null,
	};
	state.receipts[input.requestId] = { digest, channelId: input.channelId, revision: request.revision };
	state.revision++;
	return request;
}

/** Binds exact parsed request terms and creator identity for both proposal and protected grant issuance. */
export function channelRequestDigest(input: ChannelSetupInput, authority: MissionAuthority): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				input,
				installationId: authority.installationId,
				creator: authority.creator,
				authorityRevision: authority.revision,
			}),
		)
		.digest("hex");
}

/** Projects only host-observed facts; no stored credential or provider error is part of the schema. */
export function channelView(state: ChannelState | undefined, adapters: readonly ChannelAdapter[]) {
	return {
		revision: state?.revision ?? 0,
		available: adapters,
		channels: Object.values(state?.channels ?? {}).map((record) => ({
			request: record.request,
			status: record.outcome.kind === "unknown" ? "failed" : record.outcome.kind,
			outcome: record.outcome,
			lastHealth: record.lastHealth,
		})),
	};
}
