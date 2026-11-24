// Verifies replay-safe setup proposals and adapter-independent channel discovery.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { type ChannelAdapter, type ChannelState, parseChannelSetupInput } from "../../src/channels/contract.ts";
import { ChannelDoc, channelView, requestChannelSetup } from "../../src/channels/registry.ts";
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

	it("blocks replacing an unresolved request that can still be granted", () => {
		const state = empty();
		requestChannelSetup(state, input(), authority, adapters, 1000);
		const attempt = { id: "attempt-1", grantId: "grant-1", startedAt: 1000 };
		state.channels.creator.attempt = attempt;
		state.channels.creator.outcome = { kind: "unknown", attemptId: attempt.id };
		const unresolved = structuredClone(state);
		const replacement = { ...input(), requestId: "request-2", expectedRevision: 1, expiresAt: 6000 };
		expect(() => requestChannelSetup(state, replacement, authority, adapters, 4000)).toThrow("Reconcile");
		expect(state).toEqual(unresolved);
	});

	it.each([
		{ reason: "expired request", now: 5000, revision: authority.revision },
		{ reason: "superseded creator revision", now: 1000, revision: authority.revision + 1 },
	])("preserves the retired unknown evidence for a $reason", async ({ now, revision }) => {
		const context = BACKGROUND_CONTEXT;
		const harness = await Harness.open(
			new MemoryStorage(),
			{ registry: createRegistry(), models: createModels() },
			context,
		);
		try {
			const state = empty();
			const request = requestChannelSetup(state, input(), authority, adapters, 1000);
			const attempt = { id: "attempt-1", grantId: "grant-1", startedAt: 1000 };
			state.channels.creator.attempt = attempt;
			// Older owners could persist this permission observation without resolving the attempt.
			const awaitingGrant = { kind: "awaiting_creator", step: "grant" } as const;
			state.channels.creator.outcome = awaitingGrant;
			await harness.commit(async (tx) => Object.assign(await tx.doc(ChannelDoc), state), context);
			const replacement = { ...input(), requestId: "request-2", expectedRevision: 1, expiresAt: 6000 };
			const currentAuthority = { ...authority, revision };
			const request2 = await harness.commit(
				async (tx) => requestChannelSetup(await tx.doc(ChannelDoc), replacement, currentAuthority, adapters, now),
				context,
			);
			const committed = await harness.snapshot(ChannelDoc, context);
			expect(committed?.receipts[request.requestId].retiredSetup).toEqual({
				request,
				attempt,
				outcome: { kind: "unknown", attemptId: attempt.id },
			});
			expect(committed?.channels.creator).toEqual({
				request: request2,
				outcome: awaitingGrant,
				attempt: null,
				lastHealth: null,
			});
		} finally {
			await harness.close(context);
		}
	});
});
