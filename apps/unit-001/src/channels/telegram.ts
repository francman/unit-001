// Implements Telegram's supported managed-bot confirmation and token APIs without exposing secrets.
import { channelInteger, channelObject, channelText } from "./contract.ts";

export const TELEGRAM_ADAPTER = {
	id: "telegram",
	capabilities: ["status"] as const,
	setup: "managed-bot" as const,
};

export type TelegramManagedBot = { botId: number; creatorId: number; username: string };

export class TelegramFailure extends Error {
	readonly reason: "credentials" | "transport" | "provider" | "identity";

	constructor(reason: TelegramFailure["reason"]) {
		super(`Telegram setup failed: ${reason}.`);
		this.reason = reason;
	}
}

/** Uses a host-selected API origin; provider errors and token-bearing URLs never escape this client. */
export class TelegramClient {
	readonly #origin: string;

	constructor(origin = "https://api.telegram.org") {
		const url = new URL(origin);
		if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
			throw new Error("Invalid Telegram API origin.");
		if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
			throw new Error("Telegram API requires HTTPS.");
		this.#origin = url.origin;
	}

	/** Produces Telegram's creator-confirmed managed-bot link; it does not create a bot. */
	creationLink(managerUsername: string, suggestedUsername: string, name: string): string {
		if (![managerUsername, suggestedUsername].every((value) => /^[A-Za-z0-9_]{5,32}$/.test(value)))
			throw new Error("Invalid Telegram username.");
		return `https://t.me/newbot/${managerUsername}/${suggestedUsername}?${new URLSearchParams({ name: channelText(name, 64) })}`;
	}

	/** Reads a bounded update batch; the owner persists its cursor only after processing every event. */
	async managedBots(
		token: string,
		offset: number,
		signal?: AbortSignal,
	): Promise<{ nextOffset: number; bots: TelegramManagedBot[] }> {
		const result = await this.call(
			token,
			"getUpdates",
			{ offset: channelInteger(offset), limit: 100, timeout: 0, allowed_updates: ["managed_bot"] },
			signal,
		);
		if (!Array.isArray(result) || result.length > 100) throw new TelegramFailure("provider");
		let nextOffset = offset;
		const bots: TelegramManagedBot[] = [];
		try {
			for (const value of result) {
				const update = channelObject(value);
				nextOffset = Math.max(nextOffset, channelInteger(update.update_id) + 1);
				if (update.managed_bot === undefined) continue;
				const managed = channelObject(update.managed_bot);
				const bot = channelObject(managed.bot);
				const user = channelObject(managed.user);
				if (bot.is_bot !== true || user.is_bot === true) throw new TelegramFailure("identity");
				bots.push({
					botId: channelInteger(bot.id),
					creatorId: channelInteger(user.id),
					username: channelText(bot.username),
				});
			}
		} catch {
			throw new TelegramFailure("provider");
		}
		return { nextOffset, bots };
	}

	/** Retrieves only a managed bot's token; it never invokes user-only bots.createBot or rotates credentials. */
	async managedToken(managerToken: string, botId: number, signal?: AbortSignal): Promise<string> {
		const value = await this.call(managerToken, "getManagedBotToken", { user_id: channelInteger(botId) }, signal);
		if (typeof value !== "string" || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(value) || value.length > 256)
			throw new TelegramFailure("provider");
		return value;
	}

	/** Verifies that a retrieved credential belongs to the exact creator-confirmed bot. */
	async verifyBot(token: string, botId: number, signal?: AbortSignal): Promise<void> {
		const result = await this.call(token, "getMe", {}, signal);
		try {
			const bot = channelObject(result);
			if (bot.id !== botId || bot.is_bot !== true) throw new TelegramFailure("identity");
		} catch {
			throw new TelegramFailure("identity");
		}
	}

	private async call(
		token: string,
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token) || token.length > 256) throw new TelegramFailure("credentials");
		let response: Response;
		try {
			response = await fetch(`${this.#origin}/bot${token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(params),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
				redirect: "error",
			});
		} catch {
			throw new TelegramFailure("transport");
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel();
			throw new TelegramFailure("credentials");
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new TelegramFailure("provider");
		}
		try {
			if (!response.body) throw new Error("No Telegram response.");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 262144) {
					await reader.cancel();
					throw new Error("Oversize Telegram response.");
				}
				chunks.push(value);
			}
			const envelope = channelObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			if (envelope.ok !== true) throw new Error("Telegram rejected request.");
			return envelope.result;
		} catch {
			throw new TelegramFailure("provider");
		}
	}
}
