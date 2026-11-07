// #18: Maintenance admission and inhibited recovery use real SQLite without model/network side effects.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { validateMaintenanceAuthorization } from "../src/maintenance.ts";

let directory: string;
const opened = new Set<Agent>();
const context = BACKGROUND_CONTEXT;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-maintenance-"));
});
afterEach(async () => {
	for (const agent of opened) await agent.close(context);
	opened.clear();
	await rm(directory, { recursive: true, force: true });
});
async function launch(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], inhibited = false) {
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
			startup: { kind: inhibited ? "inhibited" : "active" },
		},
		context,
	);
	opened.add(agent);
	return { agent, faux };
}
const answer = fauxAssistantMessage([fauxText("Done")]);

describe("maintenance barrier", () => {
	it("managed release never enables a candidate before the root commit decision", () => {
		// #18: A terminal command or tool cannot release a precommit candidate and invalidate rollback safety.
		const journal = {
			schemaVersion: 1,
			id: "installation",
			operationId: "update",
			previousRecord: { id: "installation", releaseVersion: "0.0.2" },
			candidateVersion: "0.0.3",
			phase: "candidate",
		};
		expect(() => validateMaintenanceAuthorization(journal, "installation", "0.0.3", "update", "enter")).not.toThrow();
		for (const phase of ["holding", "backed-up", "candidate"])
			expect(() =>
				validateMaintenanceAuthorization({ ...journal, phase }, "installation", "0.0.3", "update", "release"),
			).toThrow();
		expect(() =>
			validateMaintenanceAuthorization(
				{ ...journal, phase: "committed" },
				"installation",
				"0.0.3",
				"update",
				"release",
			),
		).not.toThrow();
		expect(() =>
			validateMaintenanceAuthorization(
				{ ...journal, phase: "committed" },
				"installation",
				"0.0.2",
				"update",
				"release",
			),
		).toThrow();
		expect(() =>
			validateMaintenanceAuthorization(
				{ ...journal, phase: "restored" },
				"installation",
				"0.0.2",
				"update",
				"release",
			),
		).not.toThrow();
		expect(() =>
			validateMaintenanceAuthorization(
				{ ...journal, phase: "restored" },
				"installation",
				"0.0.2",
				"stale",
				"release",
			),
		).toThrow();
	});
	it("serializes a simultaneous hold and admission on the session commit line", async () => {
		const { agent, faux } = await launch([answer]);
		const holding = agent.enterMaintenance("atomic", 1000, context);
		const admission = agent.submit("must not slip through", context);
		await expect(admission).rejects.toThrow("maintenance");
		expect(await holding).toMatchObject({ result: "drained" });
		expect(faux.state.callCount).toBe(0);
	});
	it("holds an idle session durably, rejects stale owners, and releases explicitly", async () => {
		const first = await launch([]);
		expect(await first.agent.enterMaintenance("update-1", 0, context)).toMatchObject({ result: "drained" });
		await expect(first.agent.submit("blocked", context)).rejects.toThrow("maintenance");
		await expect(first.agent.releaseMaintenance("other", context)).rejects.toThrow("does not own");
		await expect(first.agent.enterMaintenance("other", 0, context)).rejects.toThrow("Another maintenance");
		await first.agent.close(context);
		opened.delete(first.agent);
		const next = await launch([answer]);
		expect(await next.agent.status(context)).toMatchObject({
			inhibited: true,
			maintenance: { state: "held", operationId: "update-1" },
		});
		await expect(next.agent.submit("blocked", context)).rejects.toThrow("inhibited");
		expect(() => next.agent.abort(context)).toThrow("inhibited");
		await next.agent.releaseMaintenance("update-1", context);
		expect(await next.agent.ask("allowed", context)).toEqual({ status: "answered", text: "Done" });
	});
	it("defers busy work without cancelling it and drains after its answer", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { agent, faux } = await launch([
			async () => {
				await pending;
				return answer;
			},
		]);
		const submission = await agent.submit("work", context);
		await expect.poll(() => faux.state.callCount).toBe(1);
		expect(await agent.enterMaintenance("update", 0, context)).toMatchObject({ result: "deferred" });
		await expect(agent.submit("late", context)).rejects.toThrow("maintenance");
		expect(await agent.status(context)).toMatchObject({ busy: true });
		finish();
		await submission.wait(context);
		expect(await agent.enterMaintenance("update", 1000, context)).toMatchObject({ result: "drained" });
	});
	it("inhibited candidate opening unfinished work makes no requests until matching release", async () => {
		let started!: () => void;
		const requested = new Promise<void>((resolve) => {
			started = resolve;
		});
		const first = await launch([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					started();
					options?.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true });
				}),
		]);
		await first.agent.submit("persisted", context, { requestId: "same" });
		await requested;
		await first.agent.close(context);
		opened.delete(first.agent);
		const next = await launch([answer], true);
		expect(next.agent.interrupted).toBe(true);
		expect(await next.agent.enterMaintenance("candidate", 0, context)).toMatchObject({ result: "deferred" });
		expect(next.faux.state.callCount).toBe(0);
		await expect(next.agent.idle(context)).rejects.toThrow("inhibited");
		expect(() => next.agent.abort(context)).toThrow("inhibited");
		expect(next.faux.state.callCount).toBe(0);
		await next.agent.releaseMaintenance("candidate", context);
		expect(await next.agent.idle(context)).toBe("Done");
		expect(next.faux.state.callCount).toBe(1);
	});
	it("rejects invalid operation identities and timeout bounds", async () => {
		const { agent } = await launch([]);
		await expect(agent.enterMaintenance("", 0, context)).rejects.toThrow("operation ID");
		for (const timeout of [-1, 30001, NaN, 0.5])
			await expect(agent.enterMaintenance("id", timeout, context)).rejects.toThrow("timeout");
		expect(await agent.status(context)).toMatchObject({ maintenance: { state: "open" } });
	});
});
