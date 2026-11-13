// #56: The default owner exposes actual setup capability without a model and drains direct setup transports.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import { issueChannelGrant, writeChannelAuthority } from "../../src/channels/authority.ts";
import { channelExtension } from "../../src/channels/extension.ts";
import { ChannelOwner } from "../../src/channels/owner.ts";
import { ChannelDoc } from "../../src/channels/registry.ts";
import { TELEGRAM_ADAPTER } from "../../src/channels/telegram.ts";
import { writeMissionAuthority } from "../../src/missions/authority.ts";
import { grantFixture } from "./fixtures.ts";

let directory: string;
const owners: { close(context: typeof BACKGROUND_CONTEXT): Promise<void> }[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-channel-owner-"));
});
afterEach(async () => {
	for (const owner of owners.splice(0)) await owner.close(BACKGROUND_CONTEXT);
	await rm(directory, { recursive: true, force: true });
});

describe("channel owner", () => {
	it("reports default capability, journals an exact request and reopens without model configuration", async () => {
		const models = createModels();
		const options = { models, model: null, cwd: directory };
		const database = join(directory, "session.sqlite");
		const first = await Agent.open(
			{ ...options, storage: await openNodeSqliteStorage(database) },
			BACKGROUND_CONTEXT,
		);
		const status = await first.channels({ operation: "status" }, BACKGROUND_CONTEXT);
		expect(status.operation === "status" && status.view.available).toEqual([TELEGRAM_ADAPTER]);
		const fixture = grantFixture();
		const location = { kind: "developer-local" as const, directory, session: "default" };
		await writeMissionAuthority(location, fixture.creator);
		await writeChannelAuthority(location, {
			...fixture.channels,
			ceiling: [{ adapter: "telegram", destinations: ["42"], capabilities: ["status"] }],
			grants: [],
		});
		const proposal = await first.channels(
			{
				operation: "request",
				input: {
					requestId: "default-setup",
					channelId: "creator",
					expectedRevision: 0,
					adapter: "telegram",
					destination: "42",
					capabilities: ["status"],
					expiresAt: Date.now() + 60000,
				},
			},
			BACKGROUND_CONTEXT,
		);
		if (proposal.operation !== "request") throw new Error("Missing owner proposal.");
		await writeChannelAuthority(
			location,
			issueChannelGrant(
				proposal.request,
				{
					creator: fixture.creator,
					channels: {
						...fixture.channels,
						ceiling: [{ adapter: "telegram", destinations: ["42"], capabilities: ["status"] }],
						grants: [],
					},
				},
				proposal.request.expiresAt,
				process.getuid?.() ?? 0,
				Date.now(),
			),
		);
		expect(await first.channels({ operation: "setup", channelId: "creator" }, BACKGROUND_CONTEXT)).toEqual({
			operation: "setup",
			outcome: { kind: "awaiting_creator", step: "manager-bootstrap" },
		});
		await first.close(BACKGROUND_CONTEXT);
		const reopened = await Agent.open(
			{ ...options, storage: await openNodeSqliteStorage(database) },
			BACKGROUND_CONTEXT,
		);
		owners.push(reopened);
		const result = await reopened.channels({ operation: "status" }, BACKGROUND_CONTEXT);
		expect(result.operation === "status" && result.view.channels[0].outcome).toEqual({
			kind: "awaiting_creator",
			step: "manager-bootstrap",
		});
		expect(models.getProviders()).toEqual([]);
	});

	it("joins direct setup cancellation before closing storage, retaining an unknown outcome", async () => {
		const fixture = grantFixture();
		fixture.request.expiresAt = Date.now() + 60000;
		fixture.channels.grants[0].expiresAt = fixture.request.expiresAt;
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "setup.sqlite")),
			{ registry: createRegistry(), models: createModels() },
			BACKGROUND_CONTEXT,
		);
		owners.push(harness);
		await harness.commit(async (tx) => Object.assign(await tx.doc(ChannelDoc), fixture.state), BACKGROUND_CONTEXT);
		let signalStarted = () => {};
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const readAuthority = async () => fixture;
		const setupAdapters = [
			{
				id: "telegram",
				prepare: async (_request: unknown, authorized: () => Promise<void>, signal?: AbortSignal) => {
					await authorized();
					signalStarted();
					return new Promise<never>((_resolve, reject) =>
						signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
					);
				},
			},
		];
		const owner = new ChannelOwner(harness, {
			readAuthority,
			setupAdapters,
			extension: channelExtension([TELEGRAM_ADAPTER], readAuthority, setupAdapters),
		});
		const pending = owner.request({ operation: "setup", channelId: "creator" }, BACKGROUND_CONTEXT);
		await started;
		expect(owner.pending).toBe(1);
		await owner.drain();
		expect((await pending).operation).toBe("setup");
		expect(owner.pending).toBe(0);
		expect((await harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT))?.channels.creator.outcome.kind).toBe("unknown");
	});
});
