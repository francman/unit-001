// Verifies the one mission conversation setup with local SQLite and no model requests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	ProviderDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMissionConversation } from "../../src/missions/conversation.ts";

const model = { provider: "faux", modelId: "faux-1" };
const heldTask = defineTask<null, { phase: "hold" }, null>({
	name: "test.mission.conversation.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async () => {
			throw new Error("Test task must not be scheduled.");
		},
	},
	abort: async () => {
		throw new Error("Test task must not be scheduled.");
	},
});
let directory: string;
let harness: Harness | undefined;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-conversation-"));
});
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	await rm(directory, { recursive: true, force: true });
});

async function create(terms: { tools: readonly string[]; modelTools: readonly string[] | null }) {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.mission.conversation", tasks: [heldTask] }));
	harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models: createModels(), registry },
		context,
	);
	const root = await harness.root(context, { agent: { model } });
	const created = await root.commit(async (tx) => {
		const task = await tx.createTask(heldTask, null, { ownership: { kind: "conversation" }, background: true });
		return createMissionConversation(tx, task, { model, ...terms, maxTurns: 3, prefix: "unit-test-" });
	}, context);
	return {
		created,
		agent: await harness.snapshot(AgentDoc, created.id, context),
		provider: await harness.snapshot(ProviderDoc, created.id, context),
	};
}

describe("createMissionConversation", () => {
	it("sets exactly the given model, tools, offered tools, turn cap and a prefixed provider session", async () => {
		const tools = ["unit_mission_status", "unit_plan_draft"];
		const { created, agent, provider } = await create({ tools, modelTools: tools });
		expect(agent).toEqual({ model, tools, modelTools: tools, maxTurns: 3 });
		expect(created.providerSession).toMatch(/^unit-test-[0-9a-f-]{36}$/);
		expect(provider?.sessionId).toBe(created.providerSession);
	});

	it("leaves modelTools unset for null, so Durable offers every enabled non-deferred tool", async () => {
		const { agent } = await create({ tools: ["read"], modelTools: null });
		expect(agent).toEqual({ model, tools: ["read"], maxTurns: 3 });
	});
});
