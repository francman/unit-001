// In-process memory tools and request hooks owned by one Harness host.
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	GenerationTask,
	hook,
} from "@earendil-works/pi-durable";
import { createMemoryBackground, scheduleMemoryConsolidation } from "./background.ts";
import { memoryBeforeRequest } from "./injection.ts";
import { MemoryDoc } from "./memory.ts";
import { forgetMemory, memoryStats, rememberMemory } from "./operations.ts";
import { MemoryRecall } from "./recall.ts";

/** One host's extension and disposable recall cache. */
export type MemoryService = { extension: Extension; recall: MemoryRecall; close(): void };

/** Build memory without external providers; custom clocks must match the Harness clock. */
export function createMemoryExtension(options: { now?: () => number } = {}): MemoryService {
	const recall = new MemoryRecall();
	const background = createMemoryBackground();
	const extension = defineExtension({
		name: "unit.memory",
		tasks: background.tasks,
		hooks: [
			hook(GenerationTask, {
				beforeRequest: memoryBeforeRequest(recall, options.now ?? Date.now),
				afterRun: background.afterRun,
			}),
		],
		tools: [
			defineTool({
				name: "remember",
				description:
					"Store a statement as agent-authored memory evidence. Stored statements are not authoritative host facts.",
				replay: "safe",
				parameters: Type.Object({
					content: Type.String(),
					source: Type.Optional(Type.String()),
					importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				}),
				execute: async (args, api, context) => {
					const now = api.now();
					const task = await api.getTask(api.taskId, context);
					const input = task?.input;
					// The stored ToolTask input is schema-owned; its model variant references the immutable assistant call.
					const entryIds =
						input !== null &&
						typeof input === "object" &&
						!Array.isArray(input) &&
						input.kind === "model" &&
						typeof input.assistant === "number"
							? [input.assistant as EntryId]
							: [];
					const id = await api.commit(async (tx) => {
						const state = await tx.doc(MemoryDoc);
						const id = rememberMemory(state, {
							writeKey: `tool:${api.taskId}`,
							content: args.content,
							source: args.source,
							importance: args.importance,
							now,
							provenance: {
								origin: "agent",
								conversationId: api.conversationId,
								entryIds,
								derivation: "explicit",
							},
						});
						await scheduleMemoryConsolidation(tx, api.conversationId, now);
						return id;
					}, context);
					return { output: [{ type: "text", text: JSON.stringify({ id }) }] };
				},
			}),
			defineTool({
				name: "recall",
				description: "Retrieve matching stored evidence by whole words or exact command flags.",
				replay: "safe",
				parameters: Type.Object({
					query: Type.String(),
					top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
				}),
				execute: async (args, api, context) => ({
					output: [
						{
							type: "text",
							text: JSON.stringify(
								recall.recall(await api.snapshot(MemoryDoc, context), args.query, {
									topK: args.top_k,
									now: api.now(),
								}),
							),
						},
					],
				}),
			}),
			defineTool({
				name: "forget",
				description: "Forget a stored memory and invalidate summaries derived from it. Transcript history remains.",
				replay: "safe",
				parameters: Type.Object({ id: Type.String() }),
				execute: async (args, api, context) => {
					const removed = await api.commit(
						async (tx) => forgetMemory(await tx.doc(MemoryDoc), { writeKey: `tool:${api.taskId}`, id: args.id }),
						context,
					);
					return { output: [{ type: "text", text: JSON.stringify({ removed }) }] };
				},
			}),
			defineTool({
				name: "stats",
				description: "Inspect persistent memory counts and capture/consolidation status without content.",
				replay: "safe",
				parameters: Type.Object({}),
				execute: async (_args, api, context) => ({
					output: [{ type: "text", text: JSON.stringify(memoryStats(await api.snapshot(MemoryDoc, context))) }],
				}),
			}),
		],
	});
	return { extension, recall, close: () => recall.clear() };
}
