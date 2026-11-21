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
export {
	MEMORY_GRAPH_CONTENT_LIMIT,
	MEMORY_GRAPH_EDGE_LIMIT,
	MEMORY_GRAPH_NODE_LIMIT,
	type MemoryGraph,
	type MemoryGraphEdge,
	type MemoryGraphNode,
	type MemoryGraphRelationEdge,
	memoryGraph,
} from "./graph.ts";
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
	type MemoryRef,
	type MemoryRelation,
	type MemoryRelationKind,
	type MemoryRelationProvenance,
	type MemoryState,
} from "./memory.ts";
export { forgetMemory, memoryStats, type RememberMemory, rememberMemory } from "./operations.ts";
export { MemoryRecall, type MemoryRecallResult, type MemoryRecallVia, memoryTokens } from "./recall.ts";
export {
	isLiveRelation,
	MEMORY_RELATION_DEGREE_LIMIT,
	MEMORY_RELATION_KINDS,
	MEMORY_RELATION_LIMIT,
	MEMORY_RELATIONS_PER_REMEMBER,
	type MemoryRelationRequest,
} from "./relations.ts";
