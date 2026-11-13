// Defines channel capabilities, setup requests and public operational state without credentials.
import { type MissionCreator, parseMissionCreator } from "../missions/contract.ts";

export const CHANNEL_CAPABILITIES = ["status", "notify", "mission_control", "trusted_operator_execution"] as const;

export type ChannelCapability = (typeof CHANNEL_CAPABILITIES)[number];

export type ChannelAdapter = {
	id: string;
	capabilities: readonly ChannelCapability[];
	setup: "managed-bot" | "external";
};

export type ChannelRequest = {
	requestId: string;
	channelId: string;
	revision: number;
	adapter: string;
	destination: string;
	capabilities: ChannelCapability[];
	expiresAt: number;
	installationId: string | null;
	session: "default";
	creator: MissionCreator;
	authorityRevision: number;
	digest: string;
};

export type ChannelOutcome =
	| { kind: "awaiting_creator"; step: "grant" | "manager-bootstrap" | "telegram-confirmation"; url?: string }
	| { kind: "configured" }
	| { kind: "ready"; observedAt: number; accountId: string }
	| { kind: "failed"; reason: "authorization" | "credentials" | "transport" | "provider" | "identity" }
	| { kind: "unknown"; attemptId: string }
	| { kind: "disabled" };

export type ChannelRecord = {
	request: ChannelRequest;
	outcome: ChannelOutcome;
	attempt: { id: string; grantId: string; startedAt: number } | null;
	lastHealth: { observedAt: number; healthy: boolean } | null;
};

export type ChannelState = {
	revision: number;
	channels: Record<string, ChannelRecord>;
	receipts: Record<string, { digest: string; channelId: string; revision: number }>;
};

export type ChannelSetupInput = {
	requestId: string;
	channelId: string;
	expectedRevision: number;
	adapter: string;
	destination: string;
	capabilities: ChannelCapability[];
	expiresAt: number;
};

/** Validates model and operator setup input; identity and authority are supplied only by the host. */
export function parseChannelSetupInput(value: unknown): ChannelSetupInput {
	const input = channelObject(value);
	const allowed = [
		"requestId",
		"channelId",
		"expectedRevision",
		"adapter",
		"destination",
		"capabilities",
		"expiresAt",
	];
	if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("Unknown channel setup field.");
	if (!Array.isArray(input.capabilities) || input.capabilities.length > CHANNEL_CAPABILITIES.length)
		throw new Error("Invalid channel capabilities.");
	const capabilities = input.capabilities.map((value) => {
		if (!CHANNEL_CAPABILITIES.some((capability) => capability === value))
			throw new Error("Unknown channel capability.");
		return value as ChannelCapability;
	});
	if (!capabilities.length || new Set(capabilities).size !== capabilities.length)
		throw new Error("Channel capabilities must be nonempty and unique.");
	return {
		requestId: channelIdentity(input.requestId),
		channelId: channelIdentity(input.channelId),
		expectedRevision: channelInteger(input.expectedRevision),
		adapter: channelText(input.adapter),
		destination: channelText(input.destination),
		capabilities,
		expiresAt: channelInteger(input.expiresAt),
	};
}

/** Validates dictionary identities at model and operator wire boundaries. */
export function channelIdentity(value: unknown): string {
	const key = channelText(value, 100);
	if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key))
		throw new Error("Invalid channel request identity.");
	return key;
}

/** Parses a saved owner proposal before a privileged issuer relies on its exact terms. */
export function parseChannelRequest(value: unknown): ChannelRequest {
	const input = channelObject(value);
	if (input.session !== "default") throw new Error("Invalid channel session.");
	const revision = channelInteger(input.revision);
	const authorityRevision = channelInteger(input.authorityRevision);
	const digest = channelText(input.digest, 64);
	if (revision < 1 || authorityRevision < 1 || !/^[a-f0-9]{64}$/.test(digest))
		throw new Error("Invalid channel proposal binding.");
	const terms = parseChannelSetupInput({
		requestId: input.requestId,
		channelId: input.channelId,
		expectedRevision: revision - 1,
		adapter: input.adapter,
		destination: input.destination,
		capabilities: input.capabilities,
		expiresAt: input.expiresAt,
	});
	return {
		requestId: terms.requestId,
		channelId: terms.channelId,
		revision,
		adapter: terms.adapter,
		destination: terms.destination,
		capabilities: terms.capabilities,
		expiresAt: terms.expiresAt,
		installationId: input.installationId === null ? null : channelText(input.installationId),
		session: "default",
		creator: parseMissionCreator(input.creator),
		authorityRevision,
		digest,
	};
}

/** Reads a bounded object at channel protocol and protected-file boundaries. */
export function channelObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected channel object.");
	return value as Record<string, unknown>;
}

/** Reads nonempty bounded identifiers and destination text from untrusted input. */
export function channelText(value: unknown, maximum = 200): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum)
		throw new Error("Invalid channel text.");
	return value;
}

/** Reads a nonnegative safe integer at a channel trust boundary. */
export function channelInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid channel integer.");
	return value;
}
