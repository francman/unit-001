// Short run-end dispatch and lifecycle reconciliation for durable memory maintenance.
import {
	type ConversationId,
	defineTask,
	type HookApi,
	type RunSummary,
	runEndTask,
	type TaskRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import { type CaptureInput, MemoryCapture } from "./capture.ts";
import { MemoryConsolidation, scheduleMemoryConsolidation } from "./consolidation.ts";
import { MemoryDoc } from "./memory.ts";

export { MemoryCapture } from "./capture.ts";
export { MemoryConsolidation, scheduleMemoryConsolidation } from "./consolidation.ts";

/** Commit the capture receipt and conversation-owned task before ending the run-end child. */
export const MemoryCaptureDispatcher = defineTask<CaptureInput, { phase: "dispatch" }, null>({
	name: "unit.memory.capture-dispatch",
	version: 1,
	initial: () => ({ phase: "dispatch" }),
	phases: {
		dispatch: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const state = await tx.doc(MemoryDoc);
				if (state.captures[task.input.generationTaskId] === undefined) {
					const taskId = await tx.createTask(MemoryCapture, task.input, {
						ownership: { kind: "conversation" },
						conversationId: task.input.conversationId,
						background: true,
					});
					state.captures[task.input.generationTaskId] = { taskId, outcome: { state: "pending" } };
					state.revision++;
				}
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/** Build constant-time run-end dispatch without extracting or reading transcript history. */
export function createMemoryBackground() {
	return {
		tasks: [MemoryCaptureDispatcher, MemoryCapture, MemoryConsolidation],
		afterRun: (run: RunSummary, api: HookApi) => ({
			tasks: [
				runEndTask(MemoryCaptureDispatcher, {
					...run,
					conversationId: api.conversationId,
					generationTaskId: api.taskId,
				}),
			],
		}),
	};
}

/** Identify only declared, conversation-owned memory background tasks for foreground draining. */
export function isMemoryBackgroundTask(
	record: Pick<TaskRecord<never, never, never>, "background" | "owner" | "version" | "kind">,
): boolean {
	return (
		record.background &&
		record.owner === undefined &&
		record.version === 1 &&
		(record.kind === MemoryCapture.definition.name || record.kind === MemoryConsolidation.definition.name)
	);
}

/** Replace an inactive consolidation guard while retaining its persisted terminal task diagnostics. */
export async function reconcileMemoryTasks(tx: Tx, conversationId: ConversationId, now: number) {
	const state = await tx.doc(MemoryDoc);
	for (const capture of Object.values(state.captures)) {
		if (capture.outcome.state !== "pending") continue;
		const task = await tx.task(capture.taskId);
		if (task !== undefined && task.state.status !== "terminal") continue;
		capture.outcome =
			task?.state.status === "terminal" && task.state.outcome.status === "aborted"
				? { state: "aborted" }
				: { state: "failed", reason: "Capture task ended without completing its receipt" };
		state.revision++;
	}
	if (state.consolidation.state === "scheduled") {
		const task = await tx.task(state.consolidation.taskId);
		if (
			task &&
			isMemoryBackgroundTask(task) &&
			task.kind === MemoryConsolidation.definition.name &&
			task.state.status !== "terminal" &&
			task.state.status !== "completing"
		)
			return task.id;
		await tx.appendEntry(conversationId, {
			kind: "unit.memory.consolidation-recovered",
			data: { taskId: state.consolidation.taskId, status: task?.state.status ?? "missing" },
		});
		state.consolidation = { state: "idle" };
		state.revision++;
	}
	return scheduleMemoryConsolidation(tx, conversationId, now);
}
