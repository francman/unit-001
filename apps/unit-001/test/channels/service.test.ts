// #56: The real owner serves registry facts without credentials, another writer or model configuration.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import { parseArguments } from "../../src/args.ts";
import { main } from "../../src/cli.ts";
import { requestService, runService, serviceEndpoint } from "../../src/service.ts";

describe("channel service", () => {
	it("serves deterministic registry state and rejects authority claims on wire input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-channel-service-"));
		const models = createModels();
		const agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
				cwd: directory,
				models,
				model: null,
			},
			BACKGROUND_CONTEXT,
		);
		const controller = new AbortController();
		const endpoint = serviceEndpoint(directory, "default", process.platform);
		let ready = () => {};
		const listening = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const running = runService(agent, endpoint, "fixture", ready, controller.signal);
		try {
			await Promise.race([listening, running]);
			expect(
				await requestService(endpoint, { type: "channels", request: { operation: "status" } }, controller.signal),
			).toMatchObject({
				type: "channels",
				result: { operation: "status", view: { available: [{ id: "telegram" }], channels: [] } },
			});
			const request = { operation: "status" as const, approved: true };
			expect(await requestService(endpoint, { type: "channels", request }, controller.signal)).toMatchObject({
				type: "error",
				message: "Unknown channel command field.",
			});
			expect(models.getProviders()).toEqual([]);
			const stdout = new PassThrough();
			let output = "";
			stdout.on("data", (chunk) => {
				output += String(chunk);
			});
			expect(
				await main(
					["channels", "status", "--data-dir", directory],
					{
						cwd: directory,
						home: directory,
						env: {},
						platform: process.platform,
						stdin: Readable.from([]),
						stdout,
						stderr: stdout,
						interactive: false,
					},
					controller.signal,
				),
			).toBe(0);
			expect(output).toMatch(/^Available adapters: telegram \(status\)\nNo channels configured\.\nObserved: /);
			expect(parseArguments(["channels", "status", "--session", "default"])).toEqual({
				kind: "channels",
				options: { session: "default" },
			});
		} finally {
			controller.abort();
			await running;
			await agent.close(BACKGROUND_CONTEXT);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
