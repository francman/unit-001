// Proves channel tools persist through the sole SQLite owner and Telegram setup stores no secret in the registry.

import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import { ChannelCredentials } from "../../src/channels/credentials.ts";
import { channelExtension } from "../../src/channels/extension.ts";
import { ChannelDoc } from "../../src/channels/registry.ts";
import { type ChannelStore, runChannelSetup } from "../../src/channels/setup.ts";
import { TELEGRAM_ADAPTER, TelegramClient } from "../../src/channels/telegram.ts";
import { telegramSetupAdapter } from "../../src/channels/telegram-setup.ts";
import { introspectionExtension } from "../../src/introspection/extension.ts";
import { grantFixture } from "./fixtures.ts";

let directory: string;
let server: Server | undefined;
const agents: Agent[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-channels-integration-"));
});
afterEach(async () => {
	for (const agent of agents) await agent.close(BACKGROUND_CONTEXT).catch(() => {});
	agents.length = 0;
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
	}
	await rm(directory, { recursive: true, force: true });
});

describe("channel integration", () => {
	it("#56 cancels and joins model-invoked setup before owner storage closes", async () => {
		const fixture = grantFixture();
		fixture.request.expiresAt = Date.now() + 60000;
		fixture.channels.grants[0].expiresAt = fixture.request.expiresAt;
		const database = join(directory, "model-close.sqlite");
		const seed = await Harness.open(
			await openNodeSqliteStorage(database),
			{ registry: createRegistry(), models: createModels() },
			BACKGROUND_CONTEXT,
		);
		await seed.commit(async (tx) => Object.assign(await tx.doc(ChannelDoc), fixture.state), BACKGROUND_CONTEXT);
		await seed.close(BACKGROUND_CONTEXT);
		let started = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let aborted = false;
		const adapter = {
			id: "telegram",
			prepare: async (_request: unknown, authorized: () => Promise<void>, signal?: AbortSignal) => {
				await authorized();
				started();
				return new Promise<never>((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("cancelled"));
						},
						{ once: true },
					);
				});
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("unit_channel_setup", { channelId: "creator", operation: "setup" }),
				{ stopReason: "toolUse" },
			),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = await Agent.open(
			{
				models,
				model: { provider: "faux", modelId: "faux-1" },
				cwd: directory,
				storage: await openNodeSqliteStorage(database),
				extensions: [channelExtension([TELEGRAM_ADAPTER], async () => fixture, [adapter])],
			},
			BACKGROUND_CONTEXT,
		);
		agents.push(agent);
		const asking = agent.ask("Resume the approved setup.", BACKGROUND_CONTEXT).catch(() => undefined);
		await running;
		await agent.close(BACKGROUND_CONTEXT);
		await asking;
		expect(aborted).toBe(true);
	});

	it("records a model setup proposal, preserves it across SQLite reopen and reports current grant absence", async () => {
		const fixture = grantFixture();
		const extension = channelExtension([TELEGRAM_ADAPTER], async () => ({
			creator: fixture.creator,
			channels: null,
		}));
		const model = { provider: "faux", modelId: "faux-1" };
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("unit_channel_request_setup", {
					requestId: "setup-1",
					channelId: "creator",
					expectedRevision: 0,
					adapter: "telegram",
					destination: "42",
					capabilities: ["status"],
					expiresAt: Date.now() + 60_000,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Setup request recorded; creator permission is pending.")]),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const options = { models, model, cwd: directory, extensions: [extension, introspectionExtension()] };
		const agent = await Agent.open(
			{ ...options, storage: await openNodeSqliteStorage(join(directory, "session.sqlite")) },
			BACKGROUND_CONTEXT,
		);
		agents.push(agent);
		expect((await agent.ask("Prepare a communication channel.", BACKGROUND_CONTEXT)).status).toBe("answered");
		await agent.close(BACKGROUND_CONTEXT);
		let observed = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("unit_channels", {}), { stopReason: "toolUse" }),
			(request) => {
				observed = JSON.stringify(request.messages);
				return fauxAssistantMessage([fauxText("Creator permission remains pending.")]);
			},
		]);
		const reopened = await Agent.open(
			{ ...options, storage: await openNodeSqliteStorage(join(directory, "session.sqlite")) },
			BACKGROUND_CONTEXT,
		);
		agents.push(reopened);
		await reopened.ask("Which channels are ready?", BACKGROUND_CONTEXT);
		expect(observed).toContain("setup-1");
		expect(observed).toContain("awaiting_creator");
		expect(observed).toContain("unit_channel_setup");
		expect(observed).toContain("You operate inside unit-001");
		expect(observed).toContain("unit_inspect_os");
		expect(observed).toContain("Never request credentials");
	});

	it("runs real managed-bot HTTP setup and keeps tokens solely in owner-private files", async () => {
		const fixture = grantFixture();
		const credentials = new ChannelCredentials(join(directory, "credentials"));
		await credentials.write("telegram-manager", {
			token: "12:manager_secret",
			creatorId: 42,
			username: "manager_bot",
		});
		const methods: string[] = [];
		let confirmed = false;
		server = createServer((request, response) => {
			const method = request.url?.split("/").at(-1);
			methods.push(method ?? "");
			const result =
				method === "getUpdates"
					? confirmed
						? [
								{
									update_id: 1,
									managed_bot: {
										user: { id: 42 },
										bot: {
											id: 81,
											is_bot: true,
											username: `unit_${fixture.request.digest.slice(0, 16)}_bot`,
										},
									},
								},
							]
						: []
					: method === "getManagedBotToken"
						? "81:child_secret"
						: { id: 81, is_bot: true };
			response.end(JSON.stringify({ ok: true, result }));
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test address.");
		const adapter = telegramSetupAdapter(
			credentials,
			new TelegramClient(`http://127.0.0.1:${address.port}`),
			() => 1000,
		);
		const store: ChannelStore = {
			read: async () => structuredClone(fixture.state),
			commit: async (change) => change(fixture.state),
		};
		const pending = await runChannelSetup(
			"creator",
			store,
			async () => fixture,
			[adapter],
			() => 1000,
		);
		expect(pending).toMatchObject({ kind: "awaiting_creator", step: "telegram-confirmation" });
		expect(pending.kind === "awaiting_creator" && pending.url).toContain("https://t.me/newbot/manager_bot/");
		confirmed = true;
		expect(
			await runChannelSetup(
				"creator",
				store,
				async () => fixture,
				[adapter],
				() => 1000,
			),
		).toEqual({ kind: "ready", observedAt: 1000, accountId: "81" });
		expect(methods).toEqual(["getUpdates", "getUpdates", "getManagedBotToken", "getMe"]);
		expect(JSON.stringify(fixture.state)).not.toContain("secret");
		const files = await readdir(join(directory, "credentials"));
		const child = files.find((file) => file !== "telegram-manager.json");
		expect(child).toBeDefined();
		expect((await stat(join(directory, "credentials", child ?? "missing"))).mode & 0o777).toBe(0o600);
		await chmod(join(directory, "credentials", "telegram-manager.json"), 0o644);
		await expect(credentials.read("telegram-manager")).rejects.toThrow("Untrusted");
		await expect(credentials.read("../escape")).rejects.toThrow("reference");
	});
});
