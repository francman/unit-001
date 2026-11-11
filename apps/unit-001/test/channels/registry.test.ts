// Verifies replay-safe setup proposals and adapter-independent channel discovery.
import { describe, expect, it } from "vitest";
import { type ChannelAdapter, type ChannelState, parseChannelSetupInput } from "../../src/channels/contract.ts";
import { channelView, requestChannelSetup } from "../../src/channels/registry.ts";
import type { MissionAuthority } from "../../src/missions/contract.ts";

const authority: MissionAuthority = {
	schemaVersion: 1,
	installationId: null,
	session: "default",
	revision: 1,
	creator: { kind: "organization", id: "example", uid: 501 },
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
const adapters: ChannelAdapter[] = [
	{ id: "telegram", capabilities: ["status", "notify"], setup: "managed-bot" },
	{ id: "test-mail", capabilities: ["notify"], setup: "external" },
];
const proposal = {
	requestId: "request-1",
	channelId: "creator",
	expectedRevision: 0,
	adapter: "telegram",
	destination: "42",
	capabilities: ["notify"] as const,
	expiresAt: 5000,
};
const input = () => parseChannelSetupInput(proposal);
const empty = (): ChannelState => ({ revision: 0, channels: {}, receipts: {} });

describe("channel registry", () => {
	it("lists multiple host adapters, creates no implicit channel and preserves exact retry receipts", () => {
		const state = empty();
		expect(channelView(state, adapters)).toEqual({ revision: 0, available: adapters, channels: [] });
		const request = requestChannelSetup(state, input(), authority, adapters, 1000);
		expect(request.creator.kind).toBe("organization");
		expect(requestChannelSetup(state, input(), authority, adapters, 1000)).toBe(request);
		expect(state.revision).toBe(1);
		expect(channelView(state, adapters).channels[0]).toMatchObject({
			status: "awaiting_creator",
			outcome: { step: "grant" },
		});
	});

	it("rejects request conflicts, stale revisions, unsupported permissions and model identity claims", () => {
		const state = empty();
		requestChannelSetup(state, input(), authority, adapters, 1000);
		expect(() => requestChannelSetup(state, { ...input(), destination: "43" }, authority, adapters, 1000)).toThrow(
			"Conflicting",
		);
		expect(() =>
			requestChannelSetup(state, { ...input(), requestId: "request-2" }, authority, adapters, 1000),
		).toThrow("Stale");
		expect(() =>
			requestChannelSetup(
				empty(),
				{ ...input(), capabilities: ["trusted_operator_execution"] },
				authority,
				adapters,
				1000,
			),
		).toThrow("support");
		expect(() => parseChannelSetupInput({ ...proposal, creator: { kind: "human", id: "root" } })).toThrow("Unknown");
	});

	it("bounds requests and records superseded receipts instead of replaying old setup", () => {
		const state = empty();
		requestChannelSetup(state, input(), authority, adapters, 1000);
		requestChannelSetup(
			state,
			{ ...input(), requestId: "request-2", expectedRevision: 1, adapter: "test-mail" },
			authority,
			adapters,
			1000,
		);
		expect(() => requestChannelSetup(state, input(), authority, adapters, 1000)).toThrow("superseded");
		expect(() => requestChannelSetup(empty(), { ...input(), expiresAt: 1000 }, authority, adapters, 1000)).toThrow(
			"expire",
		);
		expect(() => parseChannelSetupInput({ ...proposal, capabilities: ["notify", "notify"] })).toThrow("unique");
	});
});
