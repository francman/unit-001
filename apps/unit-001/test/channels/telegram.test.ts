// Exercises the real Telegram HTTP protocol without external credentials or model calls.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramClient } from "../../src/channels/telegram.ts";

let server: Server | undefined;
afterEach(async () => {
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
	}
});

async function api(handler: (path: string, body: Record<string, unknown>) => { status?: number; result: unknown }) {
	server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const value = handler(request.url ?? "", JSON.parse(body));
		response.writeHead(value.status ?? 200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: (value.status ?? 200) === 200, result: value.result }));
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test listener.");
	return new TelegramClient(`http://127.0.0.1:${address.port}`);
}

describe("Telegram managed provisioning", () => {
	it("uses creator confirmation, managed token retrieval and exact bot verification", async () => {
		const calls: string[] = [];
		const client = await api((path, body) => {
			calls.push(path);
			if (path.endsWith("getUpdates")) {
				expect(body).toMatchObject({ offset: 0, allowed_updates: ["managed_bot"], limit: 100 });
				return {
					result: [
						{
							update_id: 10,
							managed_bot: { user: { id: 42 }, bot: { id: 81, is_bot: true, username: "agent_child_bot" } },
						},
					],
				};
			}
			if (path.endsWith("getManagedBotToken")) {
				expect(body).toEqual({ user_id: 81 });
				return { result: "81:child_secret" };
			}
			return { result: { id: 81, is_bot: true } };
		});
		expect(client.creationLink("manager_bot", "agent_child_bot", "unit-001")).toBe(
			"https://t.me/newbot/manager_bot/agent_child_bot?name=unit-001",
		);
		expect(await client.managedBots("12:manager_secret")).toEqual([
			{ botId: 81, creatorId: 42, username: "agent_child_bot" },
		]);
		const token = await client.managedToken("12:manager_secret", 81);
		await client.verifyBot(token, 81);
		expect(calls.map((path) => path.split("/").at(-1))).toEqual(["getUpdates", "getManagedBotToken", "getMe"]);
		expect(calls.join()).not.toContain("createBot");
	});

	it("rejects wrong bot identity and never exposes token-bearing provider errors", async () => {
		const client = await api((path) =>
			path.endsWith("getMe") ? { result: { id: 999, is_bot: true } } : { status: 401, result: "leaked_secret" },
		);
		await expect(client.verifyBot("81:child_secret", 81)).rejects.toThrow("identity");
		try {
			await client.managedToken("12:manager_secret", 81);
			throw new Error("Expected failure.");
		} catch (error) {
			expect(String(error)).toBe("Error: Telegram setup failed: credentials.");
		}
	});

	it("classifies a well-formed managed-bot identity mismatch apart from malformed provider data", async () => {
		const event = (bot: unknown, user: unknown = { id: 42 }) => ({ update_id: 1, managed_bot: { user, bot } });
		const responses: Record<string, unknown[]> = {
			identity: [event({ id: 81, is_bot: false, username: "agent_child_bot" })],
			creatorBot: [event({ id: 81, is_bot: true, username: "agent_child_bot" }, { id: 42, is_bot: true })],
			malformed: [event({ id: "81", is_bot: true, username: "agent_child_bot" })],
			noUpdateId: [
				{ managed_bot: { user: { id: 42 }, bot: { id: 81, is_bot: true, username: "agent_child_bot" } } },
			],
		};
		let current = "identity";
		const client = await api((path) =>
			path.endsWith("getMe") ? { result: "not-an-object" } : { result: responses[current] },
		);
		await expect(client.managedBots("12:manager_secret")).rejects.toThrow("identity");
		current = "creatorBot";
		await expect(client.managedBots("12:manager_secret")).rejects.toThrow("identity");
		current = "malformed";
		await expect(client.managedBots("12:manager_secret")).rejects.toThrow("provider");
		current = "noUpdateId";
		await expect(client.managedBots("12:manager_secret")).rejects.toThrow("provider");
		await expect(client.verifyBot("81:child_secret", 81)).rejects.toThrow("provider");
	});

	it("bounds malformed update batches and rejects public plaintext endpoints", async () => {
		const client = await api(() => ({ result: Array.from({ length: 101 }, () => ({})) }));
		await expect(client.managedBots("12:manager_secret")).rejects.toThrow("provider");
		expect(() => new TelegramClient("http://example.com")).toThrow("HTTPS");
		expect(() => client.creationLink("bad/path", "agent_child_bot", "agent")).toThrow("username");
	});
});
