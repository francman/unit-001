// Persists the bounded execution ledger separately from formation and legacy deadline holders.
import {
	type ConversationId,
	defineDoc,
	type EntryId,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import type { MissionAgreement } from "./contract.ts";

export type MissionEvidence = { criterion: string; observedAt: number; accepted: boolean; detail: string };

export type MissionExecution = {
	agreement: MissionAgreement;
	controller: TaskId<null>;
	conversation: ConversationId;
	providerSession: string;
	revision: number;
	policyRevision: number;
	intent: { requestId: string; sequence: number } | null;
	cycles: number;
	requests: number;
	retries: number;
	noProgress: number;
	estimatedCost: number;
	reservedCost: number;
	unknownRequests: number;
	unpricedResponses: number;
	pendingTools: TaskId[];
	evidence: MissionEvidence[];
	lastAnswer: EntryId | null;
	submission: SubmissionId | null;
	state:
		| { status: "ready" }
		| { status: "running"; phase: "execution" | "verification" }
		| { status: "waiting"; reason: "retry" | "maintenance"; until: number }
		| { status: "paused" }
		| { status: "blocked"; reason: string }
		| { status: "completed"; observedAt: number }
		| { status: "stopped" };
};

/** Stores finite execution counters, evidence and admission identity in the owner's Session. */
export const MissionExecutionDoc = defineDoc<{ current: MissionExecution | null }>({
	kind: "unit.mission.execution",
	version: 2,
	scope: "session",
	initial: () => ({ current: null }),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`Unsupported mission execution document version ${fromVersion}.`);
		// Version one is the reviewed inactive engine ledger; preserve every counter and lifecycle decision.
		const current = value.current as Omit<MissionExecution, "intent"> | null;
		return { current: current === null ? null : { ...current, intent: null } };
	},
	checkpointWhen: () => true,
});
