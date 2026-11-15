// Verifies #57 inspection shares the owner, excludes private inputs and remains available during maintenance.
import { chmod, chown, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import { parseArguments } from "../../src/args.ts";
import { parseInspectionQuery, parseInspectionReport } from "../../src/introspection/contract.ts";
import { requestService, runService, serviceEndpoint } from "../../src/service.ts";

async function owner(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const directory = await mkdtemp(join(tmpdir(), "u1-inspect-"));
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
		},
		BACKGROUND_CONTEXT,
	);
	return {
		agent,
		faux,
		directory,
		async close() {
			await agent.close(BACKGROUND_CONTEXT);
			await rm(directory, { recursive: true, force: true });
		},
	};
}

describe("authoritative owner inspection", () => {
	it("#57 reads every non-file selector with no provider calls and during a maintenance hold", async () => {
		const f = await owner([]);
		try {
			for (const scope of ["runtime", "configuration", "tools", "channels", "mission", "tasks", "host"] as const) {
				const report = await f.agent.inspect({ scope }, BACKGROUND_CONTEXT);
				expect(report.data.scope).toBe(scope);
				expect(report.observedAt).toBeGreaterThan(0);
				expect(report.coverage).toBe("selected-query-only");
				expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(32768);
			}
			await f.agent.enterMaintenance("inspect-hold", 0, BACKGROUND_CONTEXT);
			expect((await f.agent.inspect({ scope: "runtime" }, BACKGROUND_CONTEXT)).data).toMatchObject({
				facts: { pid: process.pid },
			});
			expect(f.faux.state.callCount).toBe(0);
		} finally {
			await f.close();
		}
	});
	it("#57 model tool uses the same bounded collector and denies private file selectors", async () => {
		let observed = "";
		const f = await owner([
			fauxAssistantMessage(
				[fauxToolCall("unit_inspect", { scope: "file", path: "auth.json" }, { id: "inspect-private" })],
				{ stopReason: "toolUse" },
			),
			(request) => {
				const result = request.messages.findLast((message) => message.role === "toolResult");
				if (result?.role === "toolResult")
					observed = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
				return fauxAssistantMessage([fauxText("Private state is outside the inspection allowlist.")]);
			},
		]);
		try {
			expect(await f.agent.ask("Inspect the private file safely.", BACKGROUND_CONTEXT)).toMatchObject({
				status: "answered",
			});
			expect(observed).toContain('"reason":"denied"');
			expect(f.faux.state.callCount).toBe(2);
		} finally {
			await f.close();
		}
	});
	it("#57 task projection omits model prompts and queued submission payloads", async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const f = await owner([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					started();
					options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
		]);
		try {
			const answer = f.agent.ask("private-task-input-marker", BACKGROUND_CONTEXT);
			await ready;
			const report = await f.agent.inspect({ scope: "tasks" }, BACKGROUND_CONTEXT);
			expect(report.data).toMatchObject({ scope: "tasks" });
			expect(JSON.stringify(report)).not.toContain("private-task-input-marker");
			await f.agent.abort(BACKGROUND_CONTEXT);
			await answer;
		} finally {
			await f.close();
		}
	});
	it("#57 reaches the operator endpoint without allowing private files or authority fields", async () => {
		const f = await owner([]);
		const stop = new AbortController();
		let listening!: () => void;
		const ready = new Promise<void>((resolve) => {
			listening = resolve;
		});
		const directory = join(f.directory, "operator");
		await mkdir(directory);
		await chown(directory, process.getuid!(), process.getgid!());
		await chmod(directory, 0o750);
		const endpoint = join(directory, "default.sock");
		const running = runService(
			f.agent,
			serviceEndpoint(f.directory, "default", process.platform),
			"fixture",
			listening,
			stop.signal,
			null,
			endpoint,
		);
		void running.catch(() => {});
		try {
			await Promise.race([running, ready]);
			expect(
				await requestService(endpoint, { type: "inspection", query: { scope: "runtime" } }, stop.signal),
			).toMatchObject({ type: "inspection", report: { data: { scope: "runtime" } } });
			expect(
				await requestService(
					endpoint,
					{ type: "inspection", query: { scope: "file", path: "auth.json", offset: 0 } },
					stop.signal,
				),
			).toMatchObject({ report: { data: { result: { kind: "unavailable", reason: "denied" } } } });
			expect(f.faux.state.callCount).toBe(0);
		} finally {
			stop.abort();
			await running;
			await f.close();
		}
	});
	it("#57 parses only explicit bounded selectors and clean JSON output options", () => {
		expect(parseArguments(["inspect", "host", "--json"])).toMatchObject({
			kind: "inspection",
			query: { scope: "host" },
			json: true,
		});
		expect(parseArguments(["inspect", "file", "src/agent.ts", "--offset", "8192"])).toMatchObject({
			query: { scope: "file", path: "src/agent.ts", offset: 8192 },
		});
		for (const query of [{ scope: "host", sudo: true }, { scope: "file", path: "x", offset: -1 }, { scope: "repair" }])
			expect(() => parseInspectionQuery(query)).toThrow();
		expect(() => parseInspectionReport({ schemaVersion: 1, data: { scope: "repair" } })).toThrow();
		const envelope = {
			schemaVersion: 1,
			observedAt: Date.now(),
			access: "service-account-read-only",
			coverage: "selected-query-only",
			summary: "observed",
			data: { scope: "runtime" },
		};
		for (const invalid of [
			{ ...envelope, observedAt: Number.MAX_SAFE_INTEGER },
			{ ...envelope, summary: "x".repeat(2049) },
			{ ...envelope, data: [] },
		])
			expect(() => parseInspectionReport(invalid)).toThrow();
	});
});
