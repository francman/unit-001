// Checks setup journaling, restart reconciliation and creator revocation across adapter steps.
import { describe, expect, it } from "vitest";
import type { ChannelState } from "../../src/channels/contract.ts";
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
		expect(
			await runChannelSetup(
				"creator",
				store,
				async () => fixture,
				adapters,
				() => 5000,
			),
		).toEqual({ kind: "awaiting_creator", step: "grant" });
	});
});
