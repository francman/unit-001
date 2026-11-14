// Completes only creator-confirmed Telegram managed-bot setup using private credential references.
import { createHash } from "node:crypto";
import { type ChannelOutcome, channelInteger, channelText } from "./contract.ts";
import type { ChannelCredentials } from "./credentials.ts";
import type { ChannelSetupAdapter } from "./setup.ts";
import { type TelegramClient, TelegramFailure } from "./telegram.ts";

/** Creates a bounded Telegram setup adapter; manager bootstrap remains an explicit creator dependency. */
export function telegramSetupAdapter(
	credentials: ChannelCredentials,
	client: TelegramClient,
	now: () => number,
): ChannelSetupAdapter {
	return {
		id: "telegram",
		prepare: async (request, authorized, signal): Promise<ChannelOutcome> => {
			try {
				await authorized();
				const manager = await credentials.read("telegram-manager");
				if (!manager) return { kind: "awaiting_creator", step: "manager-bootstrap" };
				const managerToken = channelText(manager.token, 256);
				const creatorId = channelInteger(manager.creatorId);
				const requestedBotId =
					manager.botId === null || manager.botId === undefined ? null : channelInteger(manager.botId);
				const suggestedUsername = `unit_${request.digest.slice(0, 16)}_bot`;
				const url =
					typeof manager.username === "string"
						? client.creationLink(manager.username, suggestedUsername, "unit-001")
						: undefined;
				// A managed_bot event is provider evidence of creator ownership, not a model-supplied bot identity.
				await authorized();
				const updates = await client.managedBots(managerToken, 0, signal);
				const matches = updates.bots.filter(
					(bot) =>
						bot.creatorId === creatorId &&
						(requestedBotId === null ? bot.username === suggestedUsername : bot.botId === requestedBotId),
				);
				if (!matches.length)
					return { kind: "awaiting_creator", step: "telegram-confirmation", ...(url ? { url } : {}) };
				if (new Set(matches.map((bot) => bot.botId)).size !== 1) return { kind: "failed", reason: "identity" };
				const botId = matches[0].botId;
				await authorized();
				const token = await client.managedToken(managerToken, botId, signal);
				await authorized();
				await client.verifyBot(token, botId, signal);
				await authorized();
				const reference = `telegram-${createHash("sha256").update(request.digest).digest("hex")}`;
				await credentials.write(reference, { token, botId, requestDigest: request.digest });
				return { kind: "ready", observedAt: now(), accountId: String(botId) };
			} catch (error) {
				if (error instanceof TelegramFailure) return { kind: "failed", reason: error.reason };
				// Unexpected errors are not persisted or shown; the journal retains an unknown outcome for reconciliation.
				throw new Error("Telegram setup requires reconciliation.");
			}
		},
	};
}
