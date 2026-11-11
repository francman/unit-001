// Builds a channel request and its separately provisioned creator grant for contract tests.
import type { ChannelAuthority } from "../../src/channels/authority.ts";
import { type ChannelState, parseChannelSetupInput } from "../../src/channels/contract.ts";
import { requestChannelSetup } from "../../src/channels/registry.ts";
import type { MissionAuthority } from "../../src/missions/contract.ts";

export function grantFixture() {
	const creator: MissionAuthority = {
		schemaVersion: 1,
		installationId: null,
		session: "default",
		revision: 1,
		creator: { kind: "elder", id: "creator-1", uid: process.getuid?.() ?? null },
		ceiling: {
			allowedTools: [],
			maxCycles: 1,
			maxRequests: 1,
			maxRetries: 0,
			maxConsecutiveNoProgress: 1,
			maxDurationMs: 1000,
		},
		approvals: [],
	};
	const state: ChannelState = { revision: 0, channels: {}, receipts: {} };
	const request = requestChannelSetup(
		state,
		parseChannelSetupInput({
			requestId: "request-1",
			channelId: "creator",
			expectedRevision: 0,
			adapter: "telegram",
			destination: "42",
			capabilities: ["notify"],
			expiresAt: 5000,
		}),
		creator,
		[{ id: "telegram", capabilities: ["notify"], setup: "managed-bot" }],
		1000,
	);
	const channels: ChannelAuthority = {
		schemaVersion: 1,
		installationId: null,
		session: "default",
		authorityRevision: 1,
		creator: creator.creator,
		disabled: [],
		ceiling: [{ adapter: "telegram", destinations: ["42"], capabilities: ["notify"] }],
		grants: [
			{
				id: "grant-1",
				requestId: request.requestId,
				digest: request.digest,
				expiresAt: 4000,
				adapter: "telegram",
				destination: "42",
				capabilities: ["notify"],
			},
		],
	};
	return { creator, channels, request, state };
}
