// Checks channel command admission, fresh authority projections and interchangeable setup ports.
import { describe, expect, it } from "vitest";
import { parseChannelSetupInput } from "../../src/channels/contract.ts";
import { handleChannelCommand, parseChannelCommand } from "../../src/channels/control.ts";
import { requestChannelSetup } from "../../src/channels/registry.ts";
import type { ChannelStore } from "../../src/channels/setup.ts";
import { grantFixture } from "./fixtures.ts";

describe("channel control", () => {
	it("rejects wire authority and dangerous dictionary identities", () => {
		expect(() => parseChannelCommand({ operation: "setup", channelId: "creator", approved: true })).toThrow(
			"Unknown",
		);
		expect(() => parseChannelCommand({ operation: "grant", channelId: "creator" })).toThrow("Unknown");
		expect(() => parseChannelCommand({ operation: "setup", channelId: "__proto__" })).toThrow("identity");
	});

	it("does not report a historical ready channel as authorized after revocation, expiry or disable", async () => {
		const fixture = grantFixture();
		fixture.state.channels.creator.outcome = { kind: "ready", accountId: "81", observedAt: 1000 };
		const store: ChannelStore = {
			read: async () => structuredClone(fixture.state),
			commit: async (change) => change(fixture.state),
		};
		const adapters = [{ id: "telegram", capabilities: ["notify"] as const, setup: "managed-bot" as const }];
		const inspect = (now: number) =>
			handleChannelCommand(
				{ operation: "status" },
				store,
				async () => fixture,
				adapters,
				[],
				() => now,
			);
		const ready = await inspect(1000);
		expect(ready.operation === "status" && ready.view.channels[0].status).toBe("ready");
		const expired = await inspect(5000);
		expect(expired.operation === "status" && expired.view.channels[0].status).toBe("awaiting_creator");
		fixture.channels.disabled = ["creator"];
		const disabled = await inspect(1000);
		expect(disabled.operation === "status" && disabled.view.channels[0].status).toBe("disabled");
		fixture.channels.disabled = [];
		fixture.creator.revision++;
		const changed = await inspect(1000);
		expect(changed.operation === "status" && changed.view.channels[0].status).toBe("awaiting_creator");
	});

	it("runs a second host-registered adapter through the same request, grant and journal contract", async () => {
		const fixture = grantFixture();
		const adapters = [{ id: "test-mail", capabilities: ["notify"] as const, setup: "external" as const }];
		const request = requestChannelSetup(
			fixture.state,
			parseChannelSetupInput({
				requestId: "request-2",
				channelId: "creator",
				expectedRevision: 1,
				adapter: "test-mail",
				destination: "42",
				capabilities: ["notify"],
				expiresAt: 5000,
			}),
			fixture.creator,
			adapters,
			1000,
		);
		fixture.channels.ceiling = [{ adapter: "test-mail", destinations: ["42"], capabilities: ["notify"] }];
		fixture.channels.grants = [
			{ ...fixture.channels.grants[0], requestId: request.requestId, digest: request.digest, adapter: "test-mail" },
		];
		const store: ChannelStore = {
			read: async () => structuredClone(fixture.state),
			commit: async (change) => change(fixture.state),
		};
		const result = await handleChannelCommand(
			{ operation: "setup", channelId: "creator" },
			store,
			async () => fixture,
			adapters,
			[
				{
					id: "test-mail",
					prepare: async (_request, authorized) => {
						await authorized();
						return { kind: "configured" };
					},
				},
			],
			() => 1000,
		);
		expect(result).toEqual({ operation: "setup", outcome: { kind: "configured" } });
	});
});
