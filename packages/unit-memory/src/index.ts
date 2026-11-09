// Public memory document contracts for unit-001 hosts and extensions.

export {
	createMemoryBackground,
	isMemoryBackgroundTask,
	MemoryCapture,
	MemoryCaptureDispatcher,
	MemoryConsolidation,
	reconcileMemoryTasks,
	scheduleMemoryConsolidation,
} from "./background.ts";
export { createMemoryExtension, type MemoryService } from "./extension.ts";
export { memoryBeforeRequest, memoryEvidence } from "./injection.ts";
export {
	type InputOrigin,
	type MemoryInput,
	MemoryInputEntry,
	MemoryInputsDoc,
	type MemoryInputsState,
	recordMemoryInput,
} from "./inputs.ts";
export {
	type CaptureReceipt,
	type ForgottenMemory,
	type LiveMemory,
	MemoryDoc,
	type MemoryProvenance,
	type MemoryReceipt,
	type MemoryRecord,
	type MemoryState,
} from "./memory.ts";
export { forgetMemory, memoryStats, type RememberMemory, rememberMemory } from "./operations.ts";
export { MemoryRecall, type MemoryRecallResult, memoryTokens } from "./recall.ts";
