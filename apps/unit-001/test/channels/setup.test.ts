// Checks setup journaling, restart reconciliation and creator revocation across adapter steps.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { issueChannelGrant } from "../../src/channels/authority.ts";
import { type ChannelState, parseChannelSetupInput } from "../../src/channels/contract.ts";
import { ChannelDoc, requestChannelSetup } from "../../src/channels/registry.ts";
import { type ChannelStore, runChannelSetup } from "../../src/channels/setup.ts";
import { grantFixture } from "./fixtures.ts";

function memoryStore(initial: ChannelState): ChannelStore & { value: ChannelState } {
	return {
		value: initial,
		async read() {
			return structuredClone(this.value);
		},
		async commit(change) {
			return change(this.value);
		},
	};
}

describe("channel setup journal", () => {
	it("executes under an exact grant and does not repeat completed setup", async () => {
		const fixture = grantFixture();
		const store = memoryStore(fixture.state);
		let calls = 0;
		const adapters = [
			{
				id: "telegram",
				prepare: async (_request: unknown, authorized: () => Promise<void>) => {
					calls++;
					await authorized();
					return { kind: "ready" as const, observedAt: 1001, accountId: "81" };
				},
			},
		];
		const result = await runChannelSetup(
			"creator",
			store,
			async () => fixture,
			adapters,
			() => 1000,
		);
		expect(result).toMatchObject({ kind: "ready", accountId: "81" });
		expect(store.value.channels.creator.attempt).toBeNull();
		expect(store.value.channels.creator.lastHealth).toEqual({ healthy: true, observedAt: 1001 });
		await runChannelSetup(
			"creator",
			store,
			async () => fixture,
			adapters,
			() => 1000,
		);
		expect(calls).toBe(1);
	});

	it("returns the exact Ready result when another caller finishes before a stale caller claims setup", async () => {
		const fixture = grantFixture();
		const context = BACKGROUND_CONTEXT;
		const harness = await Harness.open(
			new MemoryStorage(),
			{ registry: createRegistry(), models: createModels() },
			context,
		);
		try {
			await harness.commit(async (tx) => Object.assign(await tx.doc(ChannelDoc), fixture.state), context);
			const snapshotReady = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const store: ChannelStore = {
				read: () => harness.snapshot(ChannelDoc, context),
				commit: (change) => harness.commit(async (tx) => change(await tx.doc(ChannelDoc)), context),
			};
			let calls = 0;
			const adapters = [
				{
					id: "telegram",
					prepare: async () => {
						calls++;
						return calls === 1
							? { kind: "ready" as const, observedAt: 1001, accountId: "81" }
							: { kind: "failed" as const, reason: "provider" as const };
					},
				},
			];
			const readAuthority = async () => fixture;
			const now = () => 1000;
			const stale = runChannelSetup(
				"creator",
				{
					...store,
					commit: async (change) => {
						snapshotReady.resolve();
						await resume.promise;
						return store.commit(change);
					},
				},
				readAuthority,
				adapters,
				now,
			);
			await snapshotReady.promise;
			const ready = await runChannelSetup("creator", store, readAuthority, adapters, now);
			const completed = await store.read();
			resume.resolve();
			expect(ready).toEqual({ kind: "ready", observedAt: 1001, accountId: "81" });
			expect(await stale).toEqual(ready);
			expect(await store.read()).toEqual(completed);
			expect(calls).toBe(1);
		} finally {
			await harness.close(context);
		}
	});

	it("fences a late attempt after retirement and requires an exact grant for the replacement", async () => {
		const fixture = grantFixture();
		const store = memoryStore(fixture.state);
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let effects = 0;
		let time = 1000;
		const readAuthority = async () => fixture;
		const now = () => time;
		const adapters = [
			{
				id: "telegram",
				prepare: async () => {
					const accountId = ++effects === 1 ? "80" : "81";
					if (effects === 1) {
						started.resolve();
						await finish.promise;
					}
					return { kind: "ready" as const, observedAt: time, accountId };
				},
			},
		];
		const old = runChannelSetup("creator", store, readAuthority, adapters, now);
		await started.promise;
		const newRequest = parseChannelSetupInput({
			requestId: "request-2",
			channelId: "creator",
			expectedRevision: 1,
			adapter: "telegram",
			destination: "42",
			capabilities: ["notify"],
			expiresAt: 6000,
		});
		time = 2000;
		fixture.creator.revision++;
		fixture.channels.authorityRevision = fixture.creator.revision;
		const proposal = requestChannelSetup(
			store.value,
			newRequest,
			fixture.creator,
			[{ id: "telegram", capabilities: ["notify"], setup: "managed-bot" }],
			time,
		);
		// The retained grant still names the old request and must not authorize the replacement.
		expect(await runChannelSetup("creator", store, readAuthority, adapters, now)).toEqual({
			kind: "awaiting_creator",
			step: "grant",
		});
		expect(effects).toBe(1);
		fixture.channels = issueChannelGrant(proposal, fixture, 5500, fixture.creator.creator.uid ?? 0, time);
		expect(await runChannelSetup("creator", store, readAuthority, adapters, now)).toEqual({
			kind: "ready",
			observedAt: time,
			accountId: "81",
		});
		finish.resolve();
		await expect(old).rejects.toThrow("Channel setup superseded.");
		expect(store.value.channels.creator.outcome).toEqual({ kind: "ready", observedAt: time, accountId: "81" });
		expect(effects).toBe(2);
	});

	it("preserves unknown outcomes across reopen and requires explicit safe reconciliation", async () => {
		const fixture = grantFixture();
		const store = memoryStore(fixture.state);
		let calls = 0;
		const failing = [
			{
				id: "telegram",
				prepare: async () => {
					calls++;
					throw new Error("private-token-in-error");
				},
			},
		];
		expect(
			(
				await runChannelSetup(
					"creator",
					store,
					async () => fixture,
					failing,
					() => 1000,
				)
			).kind,
		).toBe("unknown");
		const reopened = memoryStore(JSON.parse(JSON.stringify(store.value)));
		await runChannelSetup(
			"creator",
			reopened,
			async () => fixture,
			failing,
			() => 1000,
		);
		expect(calls).toBe(1);
		expect(JSON.stringify(reopened.value)).not.toContain("private-token");
		await runChannelSetup(
			"creator",
			reopened,
			async () => fixture,
			[{ id: "telegram", prepare: async () => ({ kind: "configured" }) }],
			() => 1000,
			{ reconcile: true },
		);
		expect(reopened.value.channels.creator.outcome.kind).toBe("configured");
		expect(reopened.value.channels.creator.attempt).toBeNull();
	});

	it("denies expired grants and rechecks revocation before a second effect", async () => {
		const fixture = grantFixture();
		const store = memoryStore(fixture.state);
		let effects = 0;
		const adapters = [
			{
				id: "telegram",
				prepare: async (_request: unknown, authorized: () => Promise<void>) => {
					await authorized();
					effects++;
					fixture.channels.grants = [];
					await authorized();
					effects++;
					return { kind: "configured" as const };
				},
			},
		];
		expect(
			(
				await runChannelSetup(
					"creator",
					store,
					async () => fixture,
					adapters,
					() => 1000,
				)
			).kind,
		).toBe("unknown");
		expect(effects).toBe(1);
		const unresolved = await store.read();
		expect(
			await runChannelSetup(
				"creator",
				store,
				async () => fixture,
				adapters,
				() => 5000,
			),
		).toEqual({ kind: "awaiting_creator", step: "grant" });
		expect(await store.read()).toEqual(unresolved);
	});
});
