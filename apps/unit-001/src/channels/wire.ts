// Validates credential-free channel responses at the local service boundary.
import {
	type ChannelAdapter,
	type ChannelOutcome,
	channelIdentity,
	channelInteger,
	channelObject,
	channelText,
	parseChannelCapabilities,
	parseChannelRequest,
} from "./contract.ts";
import type { ChannelResult } from "./control.ts";

/** Reconstructs bounded public results rather than forwarding arbitrary owner fields. */
export function parseChannelResult(value: unknown): ChannelResult {
	const result = channelObject(value);
	if (result.operation === "request") return { operation: "request", request: parseChannelRequest(result.request) };
	if (result.operation === "setup" || result.operation === "reconcile")
		return { operation: result.operation, outcome: parseOutcome(result.outcome) };
	if (result.operation !== "status") throw new Error("Unknown channel result.");
	const view = channelObject(result.view);
	if (
		!Array.isArray(view.available) ||
		view.available.length > 16 ||
		!Array.isArray(view.channels) ||
		view.channels.length > 16
	)
		throw new Error("Channel response exceeds registry capacity.");
	return {
		operation: "status",
		observedAt: channelInteger(result.observedAt),
		view: {
			revision: channelInteger(view.revision),
			available: view.available.map(parseAdapter),
			channels: view.channels.map((value) => {
				const record = channelObject(value);
				let lastHealth = null;
				if (record.lastHealth !== null) {
					const health = channelObject(record.lastHealth);
					if (typeof health.healthy !== "boolean") throw new Error("Invalid channel health.");
					lastHealth = { observedAt: channelInteger(health.observedAt), healthy: health.healthy };
				}
				return { request: parseChannelRequest(record.request), outcome: parseOutcome(record.outcome), lastHealth };
			}),
		},
	};
}

function parseAdapter(value: unknown): ChannelAdapter {
	const adapter = channelObject(value);
	if (adapter.setup !== "managed-bot" && adapter.setup !== "external")
		throw new Error("Invalid channel adapter setup.");
	return {
		id: channelText(adapter.id),
		setup: adapter.setup,
		capabilities: parseChannelCapabilities(adapter.capabilities),
	};
}

function parseOutcome(value: unknown): ChannelOutcome {
	const outcome = channelObject(value);
	if (outcome.kind === "configured" || outcome.kind === "disabled") return { kind: outcome.kind };
	if (outcome.kind === "ready")
		return {
			kind: "ready",
			observedAt: channelInteger(outcome.observedAt),
			accountId: channelText(outcome.accountId),
		};
	if (outcome.kind === "unknown") return { kind: "unknown", attemptId: channelIdentity(outcome.attemptId) };
	if (
		outcome.kind === "failed" &&
		["authorization", "credentials", "transport", "provider", "identity"].includes(String(outcome.reason))
	)
		return {
			kind: "failed",
			reason: outcome.reason as "authorization" | "credentials" | "transport" | "provider" | "identity",
		};
	if (
		outcome.kind === "awaiting_creator" &&
		(outcome.step === "grant" || outcome.step === "manager-bootstrap" || outcome.step === "telegram-confirmation")
	) {
		if (outcome.url === undefined) return { kind: "awaiting_creator", step: outcome.step };
		const url = channelText(outcome.url, 2048);
		if (!url.startsWith("https://t.me/newbot/")) throw new Error("Invalid managed-bot confirmation URL.");
		return { kind: "awaiting_creator", step: outcome.step, url };
	}
	throw new Error("Invalid channel outcome.");
}
