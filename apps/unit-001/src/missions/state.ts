// Persists mission activation and ownership without admitting model or tool execution.
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";

export type MissionPolicy = {
	allowedTools: string[];
	maxCycles: number;
	maxRequests: number;
	maxRetries: number;
	maxConsecutiveNoProgress: number;
	deadlineAt: number;
	maxEstimatedCost?: number;
};

export type MissionIdentity = {
	missionId: string;
	policyRevision: number;
	controllerTaskId: TaskId<null>;
};

export type MissionRecord = MissionIdentity & {
	objective: string;
	successCriteria: string[];
	policy: MissionPolicy;
	revision: number;
	controlConversationId: ConversationId;
	executionConversationId: ConversationId;
	state:
		| { status: "waiting"; reason: "execution_support" }
		| { status: "blocked"; reason: "deadline" }
		| { status: "paused" }
		| { status: "stopped" };
};

export type MissionState = { current: MissionRecord | null };

export type MissionActivation = {
	missionId: string;
	objective: string;
	successCriteria: string[];
	policy: MissionPolicy;
};

/** Version-one current mission state; a Session and its conversation forks share this document. */
export const MissionDoc = defineDoc<MissionState>({
	kind: "unit.mission",
	version: 1,
	scope: "session",
	initial: () => ({ current: null }),
	checkpointWhen: () => true,
});

/** Atomically reserves one mission and its owned conversations, without admitting any execution. */
export async function activateMission(
	harness: Harness,
	activation: MissionActivation,
	context: Context,
): Promise<MissionIdentity> {
	validateActivation(activation);
	return harness.commit(async (tx) => {
		const document = await tx.doc(MissionDoc);
		if (document.current !== null) throw new Error("This Session already has a mission.");
		const control = await tx.createConversation({ ownership: { kind: "ownerless" } });
		const identity = {
			missionId: activation.missionId,
			policyRevision: 1,
			controllerTaskId: await tx.createTask(
				HoldTask,
				{ missionId: activation.missionId, policyRevision: 1 },
				{ conversationId: control.id, ownership: { kind: "conversation" }, background: true },
			),
		};
		const execution = await tx.createConversation({
			ownership: { kind: "task", taskId: identity.controllerTaskId },
		});
		document.current = {
			...activation,
			...identity,
			revision: 1,
			controlConversationId: control.id,
			executionConversationId: execution.id,
			state: { status: "waiting", reason: "execution_support" },
		};
		return identity;
	}, context);
}

/** Rejects stale mission/controller references inside a caller's atomic commit; grants no execution authority. */
export async function requireMissionIdentity(tx: Tx, identity: MissionIdentity): Promise<void> {
	const current = (await tx.doc(MissionDoc)).current;
	if (!matchesIdentity(current, identity.missionId, identity.policyRevision, identity.controllerTaskId))
		throw new Error("Stale mission policy or controller identity.");
}

const HoldTask = defineTask<
	{ missionId: string; policyRevision: number },
	{ phase: "hold" } | { phase: "deadline" },
	null
>({
	name: "unit.mission.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const current = (await tx.doc(MissionDoc)).current;
				if (
					!matchesIdentity(current, task.input.missionId, task.input.policyRevision, task.id) ||
					current.state.status !== "waiting"
				)
					return { status: "terminal", outcome: { status: "completed", result: null } };
				return { status: "sleeping", until: current.policy.deadlineAt, checkpoint: { phase: "deadline" } };
			}, context);
		},
		deadline: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const current = (await tx.doc(MissionDoc)).current;
				if (
					matchesIdentity(current, task.input.missionId, task.input.policyRevision, task.id) &&
					current.state.status === "waiting"
				) {
					if (runtime.now() < current.policy.deadlineAt)
						return { status: "sleeping", until: current.policy.deadlineAt, checkpoint: { phase: "deadline" } };
					current.revision++;
					current.state = { status: "blocked", reason: "deadline" };
				}
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Installs only the nonexecuting deadline holder; contains no tools, model hooks, or request producers. */
export const MissionFoundation = defineExtension({ name: "unit.mission.foundation", tasks: [HoldTask] });

function matchesIdentity(
	current: MissionRecord | null,
	missionId: string,
	policyRevision: number,
	controllerTaskId: TaskId<null>,
): current is MissionRecord {
	return (
		current !== null &&
		current.missionId === missionId &&
		current.policyRevision === policyRevision &&
		current.controllerTaskId === controllerTaskId
	);
}

function validateActivation(activation: MissionActivation): void {
	// Explicit operator activation is a trust boundary; absence of limits must never grant unbounded work.
	if (activation.missionId.trim() === "" || activation.objective.trim() === "")
		throw new Error("Mission identity and objective must not be empty.");
	if (
		activation.successCriteria.length === 0 ||
		activation.successCriteria.some((criterion) => criterion.trim() === "")
	)
		throw new Error("A mission needs nonempty success criteria.");
	const policy = activation.policy;
	for (const limit of [policy.maxCycles, policy.maxRequests, policy.maxConsecutiveNoProgress]) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Mission work limits must be positive integers.");
	}
	if (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0)
		throw new Error("The mission retry limit must be a nonnegative integer.");
	if (!Number.isFinite(policy.deadlineAt) || policy.deadlineAt < 0)
		throw new Error("A mission needs a finite nonnegative deadline.");
	if (
		policy.maxEstimatedCost !== undefined &&
		(!Number.isFinite(policy.maxEstimatedCost) || policy.maxEstimatedCost <= 0)
	)
		throw new Error("An estimated spend limit must be finite and positive.");
	if (policy.allowedTools.some((name) => name.trim() === ""))
		throw new Error("Tool capability names must not be empty.");
}
