// Exercises the one "connected" rule and the one "needs the owner" rule that the nav badge, Connections, About and the Activity pane share.
import { describe, expect, it } from "vitest";
import type { WorkspaceDetails } from "./contract.ts";
import { attentionCount, type Channel, channelConnected, channelNeedsOwner, createStore } from "./state.ts";
import { connectionSentence } from "./views/connections.ts";

const healthy = { observedAt: 1, healthy: true };
const channel = (overrides: Partial<Channel> = {}): Channel => ({
	id: "main", adapter: "telegram", status: "ready", detail: "", lastHealth: healthy, failure: null, awaiting: null, ...overrides,
});
const ready = channel();
const granting = channel({ id: "grant", status: "awaiting_creator", lastHealth: null, awaiting: "grant" });
const bootstrapping = channel({ id: "boot", status: "awaiting_creator", lastHealth: null, awaiting: "manager-bootstrap" });
const failing = channel({ id: "fail", status: "failed", failure: "transport" });
const unconfirmed = channel({ id: "unknown", status: "unknown", lastHealth: null });
const disabled = channel({ id: "off", status: "disabled", lastHealth: null });

function badge(channels: Channel[]): number {
	const { ui } = createStore({ theme: "system" });
	// attentionCount reads only the channels of a connections badge.
	ui.details = { channels } as unknown as WorkspaceDetails;
	return attentionCount(ui, "connections");
}

describe("connection rules", () => {
	it("connects only a verified, quiet connection whose last check passed", () => {
		expect(channelConnected(ready)).toBe(true);
		expect(channelConnected(channel({ lastHealth: null }))).toBe(true);
		for (const other of [granting, failing, unconfirmed, disabled, channel({ lastHealth: { observedAt: 2, healthy: false } })])
			expect(channelConnected(other)).toBe(false);
	});

	it("asks the owner for everything not connected except a connection switched off", () => {
		expect([ready, granting, bootstrapping, failing, unconfirmed, disabled, channel({ lastHealth: { observedAt: 2, healthy: false } })].map(channelNeedsOwner))
			.toEqual([false, true, true, true, true, false, true]);
	});

	// Before: the badge counted `status !== "ready"` (0 here), About counted ready as `status === "ready" && failure === null && awaiting === null` (0 ready of 1)
	// and the Activity pane said "all ready", so three surfaces disagreed with the "Not working" tag on the Connections page.
	it("treats a ready row that also reports a failure as not working everywhere", () => {
		const contradictory = channel({ failure: "transport" });
		expect(channelConnected(contradictory)).toBe(false);
		expect(badge([contradictory])).toBe(1);
		expect(connectionSentence([contradictory])).toBe("1 connection, 0 ready, 1 needs attention.");
	});

	// Before: the badge counted only status !== "ready", so a ready row whose last check failed showed 0 while the Connections tag said "Check failed".
	it("counts a ready row whose last check failed", () => {
		const checked = channel({ lastHealth: { observedAt: 2, healthy: false } });
		expect(badge([checked])).toBe(1);
		expect(connectionSentence([checked])).toBe("1 connection, 0 ready, 1 needs attention.");
	});

	it("counts the nav badge by the rule that decides the sentence", () => {
		const all = [ready, granting, bootstrapping, failing, unconfirmed, disabled];
		expect(badge(all)).toBe(all.filter(channelNeedsOwner).length);
		expect(badge([ready, disabled])).toBe(0);
	});

	it("says one sentence for About, the Activity pane and the Connections page", () => {
		expect(connectionSentence([])).toBe("No connections set up.");
		expect(connectionSentence([ready])).toBe("1 connection, all ready.");
		expect(connectionSentence([ready, ready])).toBe("2 connections, all ready.");
		expect(connectionSentence([ready, disabled])).toBe("2 connections, 1 ready.");
		expect(connectionSentence([ready, granting])).toBe("2 connections, 1 ready, 1 needs your approval.");
		expect(connectionSentence([granting, bootstrapping])).toBe("2 connections, 0 ready, 2 need attention.");
		expect(connectionSentence([granting, granting])).toBe("2 connections, 0 ready, 2 need your approval.");
		expect(connectionSentence([ready, failing, unconfirmed])).toBe("3 connections, 1 ready, 2 need attention.");
	});

	it("keeps an unconfirmed attempt unknown: neither connected nor failed", () => {
		expect(channelConnected(unconfirmed)).toBe(false);
		expect(channelNeedsOwner(unconfirmed)).toBe(true);
		expect(unconfirmed.failure).toBeNull();
	});
});
