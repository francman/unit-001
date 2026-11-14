// #56: Channel transport never forwards arbitrary credentials or invalid provider status.
import { describe, expect, it } from "vitest";
import { TELEGRAM_ADAPTER } from "../../src/channels/telegram.ts";
import { parseChannelResult } from "../../src/channels/wire.ts";
import { grantFixture } from "./fixtures.ts";

describe("channel result wire", () => {
	it("reconstructs public fields and rejects contradictory status, invalid health and oversized registries", () => {
		const fixture = grantFixture();
		const record = {
			request: fixture.request,
			status: "configured",
			outcome: { kind: "configured", token: "secret" },
			lastHealth: null,
		};
		const result = {
			operation: "status",
			observedAt: 1,
			view: { revision: 1, available: [TELEGRAM_ADAPTER], channels: [record] },
			token: "secret",
		};
		expect(JSON.stringify(parseChannelResult(result))).not.toContain("secret");
		expect(() =>
			parseChannelResult({ ...result, view: { ...result.view, channels: [{ ...record, status: "ready" }] } }),
		).toThrow("status");
		expect(() =>
			parseChannelResult({
				...result,
				view: { ...result.view, channels: [{ ...record, lastHealth: { healthy: "yes", observedAt: 1 } }] },
			}),
		).toThrow("health");
		expect(() =>
			parseChannelResult({ ...result, view: { ...result.view, channels: Array(17).fill(record) } }),
		).toThrow("capacity");
	});
	it("accepts closed setup outcomes and only managed-bot confirmation links", () => {
		for (const outcome of [
			{ kind: "configured" },
			{ kind: "ready", observedAt: 1, accountId: "42" },
			{ kind: "failed", reason: "transport" },
			{ kind: "unknown", attemptId: "attempt-1" },
			{ kind: "disabled" },
			{ kind: "awaiting_creator", step: "grant" },
			{
				kind: "awaiting_creator",
				step: "telegram-confirmation",
				url: "https://t.me/newbot/manager/name?name=Agent",
			},
		])
			expect(parseChannelResult({ operation: "setup", outcome })).toEqual({ operation: "setup", outcome });
		expect(() =>
			parseChannelResult({
				operation: "setup",
				outcome: { kind: "awaiting_creator", step: "telegram-confirmation", url: "https://example.com/token" },
			}),
		).toThrow("URL");
		expect(() =>
			parseChannelResult({ operation: "setup", outcome: { kind: "failed", reason: "secret provider failure" } }),
		).toThrow("outcome");
	});
});
