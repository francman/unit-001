// Verifies the owner-internal side registry with local SQLite and faux messages only.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AgentDoc, AssistantEntry, createRegistry, defineExtension, defineTask, Harness, InboxDoc, LiveDoc,
	ProviderDoc, UserEntry, type Conversation, type HarnessOptions,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryDoc, MemoryInputsDoc } from "unit-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostFactEntry } from "../src/commands/facts.ts";
import { MaintenanceDoc } from "../src/maintenance.ts";
import { parseSideResult } from "../src/side-control.ts";
import { canStartSide, controlSides, initializeSideRegistry, resolveSideConversation, SideDoc, type SideOwner } from "../src/side.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };
const heldTask = defineTask<null, { phase: "hold" }, null>({
	name: "test.side.hold", version: 1, initial: () => ({ phase: "hold" }),
	phases: { hold: async () => { throw new Error("Test task must not be scheduled."); } },
	abort: async () => { throw new Error("Test task must not be scheduled."); },
});
let directory: string;
const opened = new Set<Harness>();

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "unit-side-")); });
afterEach(async () => {
	await Promise.all([...opened].map((harness) => harness.close(context)));
	opened.clear();
	await rm(directory, { recursive: true, force: true });
});

async function launch(conversationCreated?: HarnessOptions["conversationCreated"]) {
	let providerCalls = 0;
	const faux = fauxProvider();
	faux.setResponses([() => { providerCalls++; return fauxAssistantMessage([fauxText("Unexpected request")]); }]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.side", tasks: [heldTask] }));
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
		models, registry,
		...(conversationCreated === undefined ? {} : { conversationCreated }),
	}, context);
	opened.add(harness);
	const root = await harness.root(context, { agent: { model } });
	const owner: SideOwner = { harness, root, model, requireActive: () => {} };
	return { ...owner, owner, calls: () => providerCalls };
}

async function close(harness: Harness) {
	await harness.close(context);
	opened.delete(harness);
}

async function anchor(root: Conversation, text = "Completed reply") {
	return root.commit((tx) => tx.appendEntry(AssistantEntry, root.id, {
		model: [fauxAssistantMessage([fauxText(text)])],
	}), context);
}

async function start(owner: SideOwner, from: number, requestId = "start", title?: string) {
	const result = await controlSides(owner, { operation: "start", from, requestId, ...(title === undefined ? {} : { title }) }, context);
	if (result.operation !== "start") throw new Error("Expected start.");
	return result.conversationId;
}

describe("side registry", () => {
	it("lists a legacy Session without adopting unrelated conversations or creating registry documents", async () => {
		const { owner, harness, calls } = await launch();
		await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		expect(await controlSides(owner, { operation: "list" }, context)).toEqual({
			operation: "list", main: { conversationId: owner.root.id, state: "idle" }, sides: [],
		});
		expect(await harness.snapshot(SideDoc, context)).toBeUndefined();
		await initializeSideRegistry(owner, context);
		expect(await harness.snapshot(SideDoc, context)).toEqual({ sides: [] });
		expect(calls()).toBe(0);
	});

	it("forks only through the selected reply, with fresh execution state and shared memory", async () => {
		const { owner, root, harness, calls } = await launch();
		const earlier = await root.commit(async (tx) => {
			const entry = await tx.appendEntry(UserEntry, root.id, { model: [{ role: "user", content: "Earlier input", timestamp: 1 }] });
			(await tx.doc(MemoryInputsDoc, root.id)).inputs.old = { origin: "human", query: "Earlier input" };
			await tx.doc(MemoryDoc);
			return entry;
		}, context);
		const source = await anchor(root);
		for (let i = 0; i < 25; i++) await anchor(root, `Later reply ${i}`);
		await root.commit((tx) => tx.createTask(heldTask, null, { ownership: { kind: "conversation" }, background: true }), context);
		const before = await root.entries({}, 100, undefined, context);
		const tasks = (await harness.inspect(context)).tasks.length;
		const id = await start(owner, source.id);
		const child = await resolveSideConversation(owner, id, context);
		expect((await child.entries({}, 100, undefined, context)).items.map((entry) => entry.id)).toEqual([source.id, earlier.id]);
		expect(await root.entries({}, 100, undefined, context)).toEqual(before);
		expect(await harness.snapshot(LiveDoc, child.id, context)).toEqual({});
		expect(await harness.snapshot(InboxDoc, child.id, context)).toEqual({ items: [] });
		expect(await child.commit(async (tx) => copyJson(await tx.doc(MemoryInputsDoc, child.id)), context)).toEqual({ inputs: {} });
		expect((await harness.snapshot(ProviderDoc, child.id, context))?.sessionId).not.toBe((await harness.snapshot(ProviderDoc, root.id, context))?.sessionId);
		expect((await harness.inspect(context)).tasks.length).toBe(tasks);
		expect((await harness.inspect(context)).submissions).toHaveLength(0);
		expect(await child.commit(async (tx) => copyJson(await tx.doc(MemoryDoc)), context)).toEqual(await harness.snapshot(MemoryDoc, context));
		expect(calls()).toBe(0);
		expect(parseSideResult(await controlSides(owner, { operation: "list" }, context))).toMatchObject({ sides: [{ conversationId: id, parent: { at: source.id } }] });
	});

	it("replaces historical execution policy with all current main fields and the launch model", async () => {
		const { owner, root, harness } = await launch();
		await root.commit(async (tx) => Object.assign(await tx.doc(AgentDoc, root.id), {
			model: { provider: "old", modelId: "old" }, thinkingLevel: "high", instructions: "old", cwd: "/old",
			tools: ["old"], extensions: ["old"], modelTools: ["old"], maxTurns: 9,
		}), context);
		const source = await anchor(root);
		await root.commit(async (tx) => {
			const agent = await tx.doc(AgentDoc, root.id);
			delete agent.thinkingLevel;
			delete agent.instructions;
			delete agent.maxTurns;
			agent.cwd = directory;
			agent.tools = { remove: ["current"] };
			agent.extensions = { remove: ["disabled"] };
			agent.modelTools = { add: ["deferred"] };
		}, context);
		const child = await resolveSideConversation(owner, await start(owner, source.id), context);
		expect(await harness.snapshot(AgentDoc, child.id, context)).toEqual({
			model, cwd: directory, tools: { remove: ["current"] }, extensions: { remove: ["disabled"] }, modelTools: { add: ["deferred"] },
		});
		const unconfigured = await resolveSideConversation(owner, await start({ ...owner, model: null }, source.id, "null"), context);
		expect((await harness.snapshot(AgentDoc, unconfigured.id, context))?.model).toBeUndefined();
	});

	it("re-configures every side from the current owner model at reopen, clearing it for null", async () => {
		const first = await launch();
		const source = await anchor(first.root);
		const id = await start(first.owner, source.id);
		await close(first.harness);
		const modelB = { provider: "faux", modelId: "faux-2" };
		const second = await launch();
		const side = await resolveSideConversation(second.owner, id, context);
		await initializeSideRegistry({ ...second.owner, model: modelB }, context);
		expect((await second.harness.snapshot(AgentDoc, side.id, context))?.model).toEqual(modelB);
		await initializeSideRegistry({ ...second.owner, model: null }, context);
		expect((await second.harness.snapshot(AgentDoc, side.id, context))?.model).toBeUndefined();
		await initializeSideRegistry(second.owner, context);
		expect((await second.harness.snapshot(AgentDoc, side.id, context))?.model).toEqual(model);
	});

	it("retains exact normalized receipts across reopen and rejects conflicting starts", async () => {
		const first = await launch();
		const source = await anchor(first.root);
		const id = await start(first.owner, source.id, "receipt", "  Research  ");
		await close(first.harness);
		const second = await launch();
		expect(await start(second.owner, source.id, "receipt", "Research")).toBe(id);
		await expect(start(second.owner, source.id, "receipt", "Different")).rejects.toThrow("conflicts");
		const later = await anchor(second.root);
		await expect(start(second.owner, later.id, "receipt", "Research")).rejects.toThrow("conflicts");
		expect((await second.harness.snapshot(SideDoc, context))?.sides).toHaveLength(1);
	});

	it("serializes equal starts and competing starts at capacity; replay bypasses capacity and busy checks", async () => {
		const { owner, root, harness } = await launch();
		const source = await anchor(root);
		const equal = await Promise.all([start(owner, source.id), start(owner, source.id)]);
		expect(equal[0]).toBe(equal[1]);
		for (let i = 1; i < 15; i++) await start(owner, source.id, `r${i}`);
		const race = await Promise.allSettled([start(owner, source.id, "sixteenth"), start(owner, source.id, "seventeenth")]);
		expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect((await harness.snapshot(SideDoc, context))?.sides).toHaveLength(16);
		await root.commit((tx) => root.submit(tx, { type: "input", content: "Pending input" }), context);
		expect(await start(owner, source.id)).toBe(equal[0]);
	});

	it("rolls back a failure after the staged fork before registry publication, including after reopen", async () => {
		let fail = false;
		const first = await launch(async (tx, conversation) => {
			if (!fail || conversation.parent === undefined) return;
			await tx.doc(AgentDoc, conversation.id);
			throw new Error("Injected post-fork failure");
		});
		const source = await anchor(first.root);
		const before = await first.root.commit((tx) => tx.scanConversations({}, 100), context);
		fail = true;
		await expect(start(first.owner, source.id)).rejects.toThrow("Injected");
		await close(first.harness);
		const second = await launch();
		expect(await second.root.commit((tx) => tx.scanConversations({}, 100), context)).toEqual(before);
		expect((await second.harness.snapshot(SideDoc, context))?.sides ?? []).toEqual([]);
		await start(second.owner, source.id);
	});

	it("rejects unavailable targets uniformly and detects inconsistent ancestry without scheduling", async () => {
		const { owner, root, harness } = await launch();
		const source = await anchor(root);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		for (const target of [other.id, 999999, 0, "1", null])
			await expect(resolveSideConversation(owner, target, context)).rejects.toThrow("Chat is unavailable.");
		expect((await resolveSideConversation(owner, undefined, context)).id).toBe(root.id);
		expect((await resolveSideConversation(owner, root.id, context)).id).toBe(root.id);
		await start(owner, source.id);
		const later = await anchor(root, "Later reply");
		await root.commit(async (tx) => { (await tx.doc(SideDoc)).sides[0]!.parent.at = later.id; }, context);
		await expect(initializeSideRegistry(owner, context)).rejects.toThrow("inconsistent");
	});

	it("blocks a missing registered conversation before startup can resume anything", async () => {
		const { owner, root, harness, calls } = await launch();
		const source = await anchor(root);
		await start(owner, source.id);
		await root.commit(async (tx) => {
			const sides = await tx.doc(SideDoc);
			// A stored row referring to a missing ID models an incomplete restore.
			sides.sides[0]!.conversationId = 999999 as typeof root.id;
		}, context);
		await expect(initializeSideRegistry(owner, context)).rejects.toThrow("inconsistent");
		expect((await harness.snapshot(SideDoc, context))?.sides[0]!.conversationId).toBe(999999);
		expect(calls()).toBe(0);
	});

	it("rejects creation while main has foreground input, without appending a registry row", async () => {
		const { owner, root, harness, calls } = await launch();
		const source = await anchor(root);
		await root.commit((tx) => root.submit(tx, { type: "input", content: "Pending main" }), context);
		await expect(start(owner, source.id)).rejects.toThrow("foreground work");
		expect((await harness.snapshot(SideDoc, context))?.sides ?? []).toHaveLength(0);
		expect(calls()).toBe(0);
	});

	it("blocks new starts for main or side work and empty-live queued inputs", async () => {
		const { owner, root, harness } = await launch();
		const source = await anchor(root);
		const child = await resolveSideConversation(owner, await start(owner, source.id), context);
		await child.commit((tx) => child.submit(tx, { type: "input", content: "First" }), context);
		await child.commit((tx) => child.submit(tx, { type: "input", content: "Queued" }), context);
		await expect(start(owner, source.id, "busy")).rejects.toThrow("foreground work");
		expect(await controlSides(owner, { operation: "list" }, context)).toMatchObject({ sides: [{ state: "busy" }] });
		await child.commit(async (tx) => { delete (await tx.doc(LiveDoc, child.id)).run; }, context);
		expect(await controlSides(owner, { operation: "list" }, context)).toMatchObject({ sides: [{ state: "queued" }] });
		await expect(start(owner, source.id, "queued")).rejects.toThrow("foreground work");
		expect((await harness.snapshot(SideDoc, context))?.sides).toHaveLength(1);
	});

	it("checks active state both outside and inside admission and rejects held replays while permitting lists", async () => {
		const { owner, root } = await launch();
		const source = await anchor(root);
		await start(owner, source.id);
		let calls = 0;
		const inhibited = { ...owner, requireActive: () => { if (++calls === 2) throw new Error("inhibited"); } };
		await expect(start(inhibited, source.id, "inhibited")).rejects.toThrow("inhibited");
		expect(calls).toBe(2);
		await root.commit(async (tx) => { (await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "hold" }; }, context);
		await expect(start(owner, source.id)).rejects.toThrow("maintenance");
		expect(await controlSides(inhibited, { operation: "list" }, context)).toMatchObject({ operation: "list" });
	});

	it("rejects host facts, tool rounds, failed, aborted, cut-off and unrelated reply anchors", async () => {
		const { owner, root, harness } = await launch();
		const invalid = [];
		invalid.push(await root.commit((tx) => tx.appendEntry(HostFactEntry, root.id, {
			data: { role: "assistant", text: "Host fact", input: "OS?", facts: null },
		}), context));
		for (const stopReason of ["error", "aborted", "length", "toolUse"] as const)
			invalid.push(await root.commit((tx) => tx.appendEntry(AssistantEntry, root.id, {
				model: [fauxAssistantMessage([fauxText("Partial")], { stopReason })],
			}), context));
		invalid.push(await root.commit((tx) => tx.appendEntry(AssistantEntry, root.id, {
			model: [fauxAssistantMessage([fauxText("Tool"), fauxToolCall("test", {})])],
		}), context));
		invalid.push(await anchor(root, "   "));
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		invalid.push(await anchor(other));
		for (const entry of invalid) await expect(start(owner, entry.id, `invalid-${entry.id}`)).rejects.toThrow("completed main reply");
		expect(canStartSide(undefined)).toBe(false);
		expect((await harness.snapshot(SideDoc, context))?.sides ?? []).toHaveLength(0);
	});
});
