// The agent's mission draft tool saves revisions through formation, refuses stale ones and can never agree.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionControl } from "../../src/missions/control.ts";
import { missionDraftTool } from "../../src/missions/draft-tool.ts";
import { MissionFoundation } from "../../src/missions/state.ts";

let directory: string;
let harness: Harness;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-draft-tool-"));
	const registry = createRegistry();
	registry.install(MissionFoundation);
	harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "default.sqlite")),
		{ registry, models: createModels(), now: () => 1000, setTimer: () => () => {} },
		context,
	);
});
afterEach(async () => {
	await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

function setup() {
	const mission = new MissionControl(harness, { kind: "developer-local", directory, session: "default" }, ["read"], () => 1000);
	const tool = missionDraftTool((request, ctx) => mission.handle(request, ctx));
	// The tool reads only the call identity from its API.
	const call = (callId: string, args: Parameters<typeof tool.execute>[0]) =>
		tool.execute(args, { taskId: "task-1", callId } as unknown as ToolExecutionApi, context);
	return { mission, tool, call };
}

function saved(result: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>) {
	const [first] = result.output ?? [];
	return JSON.parse(first?.type === "text" ? first.text : "null") as { stage: string; revision: number; missing: string[] };
}

describe("unit_mission_draft", () => {
	it("saves a draft revision and lists what is still missing", async () => {
		const { mission, call } = setup();
		const result = saved(await call("c1", { expectedRevision: 0, terms: { objective: "Keep the docs current" } }));
		expect(result).toMatchObject({ stage: "awaiting_creator", revision: 1 });
		expect(result.missing).toContain("scope");
		const view = await mission.inspect(context);
		expect(view.formation.draft).toMatchObject({ revision: 1, status: "editing", terms: { objective: "Keep the docs current" } });
	});

	it("replays the same call as the same draft and refuses a stale revision", async () => {
		const { call } = setup();
		await call("c1", { expectedRevision: 0, terms: { objective: "First" } });
		expect(saved(await call("c1", { expectedRevision: 0, terms: { objective: "First" } })).revision).toBe(1);
		await expect(call("c2", { expectedRevision: 0, terms: { objective: "Second" } })).rejects.toMatchObject({
			code: "stale-revision",
		});
	});

	it("offers no way to propose or agree", () => {
		const { tool } = setup();
		expect(Object.keys(tool.parameters.properties).sort()).toEqual(["expectedRevision", "terms"]);
		expect(tool.name).toBe("unit_mission_draft");
	});
});
