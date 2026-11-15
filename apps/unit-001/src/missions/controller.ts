// Runs explicit, finite mission cycles with durable submissions and host-verified completion.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
	AgentDoc,
	defineExtension,
	defineTask,
	type Harness,
	hook,
	ProviderDoc,
	type Registry,
	type TaskId,
	ToolTask,
	type Tx,
} from "@earendil-works/pi-durable";
import { MemoryInputEntry, recordMemoryInput } from "unit-memory";
import { MaintenanceDoc } from "../maintenance.ts";
import type { ModelChoice } from "../provider.ts";
import { MISSION_PROVIDER_PREFIX, type MissionAdmission } from "./admission.ts";
import { MANAGED_MISSION_ACTIONS, type MissionExecutionIntent } from "./contract.ts";
import { type MissionExecution, MissionExecutionDoc } from "./execution-state.ts";
import { MissionDoc } from "./state.ts";
import { supportedMissionCriteria, verifyMissionFiles } from "./verification.ts";

type Checkpoint = { phase: "cycle" } | { phase: "observe"; requestId: string } | { phase: "wake"; until: number };

/** Registers the execution task before opening storage; start remains an explicit host operation. */
export function missionController(admission: MissionAdmission, cwd: string) {
	const controller = defineTask<{ missionId: string; revision: number }, Checkpoint, null>({
		name: "unit.mission.controller",
		version: 1,
		initial: () => ({ phase: "cycle" }),
		phases: {
			cycle: async (task, runtime, context) => {
				const saved = (await runtime.snapshot(MissionExecutionDoc, context))?.current;
				if (!saved || saved.controller !== task.id) return runtime.commit(() => terminal(), context);
				const evidence = supportedMissionCriteria(saved.agreement.terms.successCriteria)
					? await verifyMissionFiles(saved.agreement.terms.successCriteria, cwd, runtime.now())
					: [];
				const authorized = await admission.authorized(saved);
				const conversation = await runtime.conversation(saved.conversation, context);
				if (!conversation) throw new Error("Mission execution conversation is unavailable.");
				await runtime.commit(async (tx) => {
					const current = (await tx.doc(MissionExecutionDoc)).current;
					if (
						!current ||
						current.controller !== task.id ||
						current.policyRevision !== task.input.revision ||
						!active(current)
					)
						return terminal();
					const policy = current.agreement.terms.policy;
					if (!authorized) return block(current, "authority");
					if (policy.deadlineAt <= runtime.now()) return block(current, "deadline");
					if (!supportedMissionCriteria(current.agreement.terms.successCriteria))
						return block(current, "unsupported_verification");
					if ((await tx.doc(MaintenanceDoc)).current.state === "held") {
						const until = Math.min(policy.deadlineAt, runtime.now() + current.agreement.terms.reviewEveryMs);
						current.state = { status: "waiting", reason: "maintenance", until };
						current.revision++;
						return { status: "sleeping", until, checkpoint: { phase: "wake", until } };
					}
					current.evidence = evidence;
					if (evidence.every((item) => item.accepted)) {
						current.state = { status: "completed", observedAt: runtime.now() };
						current.revision++;
						return terminal();
					}
					if (current.unknownRequests !== 0) return block(current, "unknown_request_outcome");
					if (current.pendingTools.length !== 0) return block(current, "unknown_tool_outcome");
					if (current.cycles >= policy.maxCycles) return block(current, "cycle_limit");
					if (current.requests >= policy.maxRequests) return block(current, "request_limit");
					if (current.noProgress >= policy.maxConsecutiveNoProgress) return block(current, "no_progress_limit");
					const requestId = `${current.agreement.missionId}:${current.agreement.revision}:${current.policyRevision}:${current.cycles + 1}`;
					const prompt = [
						`Autonomous mission cycle ${current.cycles + 1}. Choose and execute one bounded next step.`,
						`Objective: ${current.agreement.terms.objective}`,
						`Scope: ${current.agreement.terms.scope}`,
						`Approved criteria: ${JSON.stringify(current.agreement.terms.successCriteria)}`,
						`Host observations: ${JSON.stringify(evidence)}`,
						"A final answer is a progress report, never proof of success. Only the host verifier can complete this mission.",
					].join("\n");
					const submission = await conversation.submit(tx, {
						type: "input",
						content: prompt,
						requestId,
						entry: { kind: MemoryInputEntry.kind, data: { origin: "mission" } },
					});
					await recordMemoryInput(tx, current.conversation, submission, "mission", prompt);
					current.cycles++;
					current.revision++;
					current.submission = submission;
					current.state = { status: "running", phase: "execution" };
					return { status: "running", checkpoint: { phase: "observe", requestId } };
				}, context);
			},
			observe: async (task, runtime, context) => {
				const saved = (await runtime.snapshot(MissionExecutionDoc, context))?.current;
				if (!saved || saved.controller !== task.id || !active(saved))
					return runtime.commit(() => terminal(), context);
				const conversation = await runtime.conversation(saved.conversation, context);
				if (!conversation) throw new Error("Mission execution conversation is unavailable.");
				await conversation.waitForIdle(context);
				const evidence = await verifyMissionFiles(saved.agreement.terms.successCriteria, cwd, runtime.now());
				const authorized = await admission.authorized(saved);
				await runtime.commit(async (tx) => {
					const current = (await tx.doc(MissionExecutionDoc)).current;
					if (
						!current ||
						current.controller !== task.id ||
						current.policyRevision !== task.input.revision ||
						!active(current)
					)
						return terminal();
					const submission = await tx.submissionByRequest(current.conversation, task.state.checkpoint.requestId);
					if (!submission || submission.status === "queued" || submission.status === "placed")
						throw new Error("Mission submission has not settled.");
					current.lastAnswer =
						submission.status === "done" && submission.type !== "write" ? submission.answer : null;
					const progress =
						evidence.filter((item) => item.accepted).length >
						current.evidence.filter((item) => item.accepted).length;
					current.noProgress = progress ? 0 : current.noProgress + 1;
					current.evidence = evidence;
					current.revision++;
					if (!authorized) return block(current, "authority");
					if (runtime.now() >= current.agreement.terms.policy.deadlineAt) return block(current, "deadline");
					if (evidence.every((item) => item.accepted)) {
						current.state = { status: "completed", observedAt: runtime.now() };
						return terminal();
					}
					if (current.unknownRequests !== 0) return block(current, "unknown_request_outcome");
					if (current.pendingTools.length !== 0) return block(current, "unknown_tool_outcome");
					if (submission.status === "unanswered" && submission.reason !== "turn_limit") {
						if (current.retries >= current.agreement.terms.policy.maxRetries)
							return block(current, "retry_limit");
						current.retries++;
						const until = Math.min(
							current.agreement.terms.policy.deadlineAt,
							runtime.now() + current.agreement.terms.reviewEveryMs,
						);
						current.state = { status: "waiting", reason: "retry", until };
						return { status: "sleeping", until, checkpoint: { phase: "wake", until } };
					}
					current.state = { status: "ready" };
					return { status: "running", checkpoint: { phase: "cycle" } };
				}, context);
			},
			wake: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const current = (await tx.doc(MissionExecutionDoc)).current;
					if (
						!current ||
						current.controller !== task.id ||
						current.policyRevision !== task.input.revision ||
						!active(current)
					)
						return terminal();
					if (runtime.now() < task.state.checkpoint.until)
						return { status: "sleeping", until: task.state.checkpoint.until, checkpoint: task.state.checkpoint };
					current.state = { status: "ready" };
					current.revision++;
					return { status: "running", checkpoint: { phase: "cycle" } };
				}, context),
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				const current = (await tx.doc(MissionExecutionDoc)).current;
				if (current?.controller === task.id && active(current)) {
					current.state = { status: "stopped" };
					current.policyRevision++;
					current.revision++;
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
	return {
		controller,
		extension: defineExtension({
			name: "unit.mission.execution",
			tasks: [controller],
			hooks: [
				hook(ToolTask, {
					beforeTool: admission.beforeTool.bind(admission),
					afterTool: admission.afterTool.bind(admission),
				}),
			],
		}),
	};
}

/** Starts only an exact current agreement through a trusted host; browser/model callers have no start operation. */
export async function startMissionExecution(
	harness: Harness,
	engine: ReturnType<typeof missionController>,
	admission: MissionAdmission,
	registry: Registry,
	model: ModelChoice,
	context: Context,
	intent?: MissionExecutionIntent,
): Promise<TaskId<null>> {
	const state = await harness.snapshot(MissionDoc, context);
	const agreement = state?.formation.agreement;
	if (!agreement) throw new Error("No agreed mission is available.");
	if (agreement.terms.approvalBoundary.length !== 0)
		throw new Error("This mission needs an unsupported additional approval boundary.");
	if (agreement.terms.policy.allowedTools.some((tool) => !MANAGED_MISSION_ACTIONS.some((name) => name === tool)))
		throw new Error(
			"Executable missions support only the reviewed built-in action catalog; custom or spawning tools require separate admission support.",
		);
	if (state.current !== null) throw new Error("A legacy mission must be resolved before starting executable work.");
	const stub = { agreement, intent: intent ? { requestId: intent.requestId, sequence: intent.sequence } : null };
	if (!(await admission.authorized(stub))) throw new Error("Mission authority is invalid or expired.");
	const tools = registry
		.snapshot()
		.tools()
		.filter((item) => agreement.terms.policy.allowedTools.includes(item.tool.name));
	if (tools.length !== new Set(agreement.terms.policy.allowedTools).size)
		throw new Error("Mission contains an unavailable tool action.");
	return harness.commit(async (tx) => {
		if ((await tx.doc(MaintenanceDoc)).current.state === "held")
			throw new Error("Maintenance holds mission activation.");
		const mission = await tx.doc(MissionDoc);
		if (mission.current !== null)
			throw new Error("A legacy mission must be resolved before starting executable work.");
		const currentAgreement = mission.formation.agreement;
		if (!currentAgreement || currentAgreement.digest !== agreement.digest)
			throw new Error("Mission agreement changed.");
		const document = await tx.doc(MissionExecutionDoc);
		if (document.current !== null) throw new Error("A mission execution already exists.");
		const scope = await createExecutionScope(
			tx,
			engine,
			admission,
			model,
			agreement.missionId,
			1,
			tools.map((item) => item.tool.name),
		);
		document.current = {
			agreement,
			...scope,
			revision: 1,
			policyRevision: 1,
			intent: intent ? { requestId: intent.requestId, sequence: intent.sequence } : null,
			cycles: 0,
			requests: 0,
			retries: 0,
			noProgress: 0,
			estimatedCost: 0,
			reservedCost: 0,
			unknownRequests: 0,
			unpricedResponses: 0,
			pendingTools: [],
			evidence: [],
			lastAnswer: null,
			submission: null,
			state: { status: "ready" },
		};
		return scope.controller;
	}, context);
}

/** Replaces a fully drained paused scope without resetting the mission's work or spend counters. */
export async function resumeMissionExecution(
	harness: Harness,
	engine: ReturnType<typeof missionController>,
	admission: MissionAdmission,
	model: ModelChoice,
	intent: MissionExecutionIntent,
	context: Context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const current = (await tx.doc(MissionExecutionDoc)).current;
		if (!current || current.policyRevision !== intent.expectedPolicyRevision || current.state.status !== "paused")
			throw new Error("Only the exact paused mission can resume.");
		if (current.unknownRequests !== 0 || current.pendingTools.length !== 0)
			throw new Error("Uncertain mission effects need reconciliation before resume.");
		if ((await tx.task(current.controller))?.state.status !== "terminal")
			throw new Error("The previous mission controller has not drained.");
		if ((await tx.doc(MaintenanceDoc)).current.state === "held")
			throw new Error("Maintenance holds mission resumption.");
		current.policyRevision++;
		Object.assign(
			current,
			await createExecutionScope(
				tx,
				engine,
				admission,
				model,
				current.agreement.missionId,
				current.policyRevision,
				current.agreement.terms.policy.allowedTools,
			),
		);
		current.intent = { requestId: intent.requestId, sequence: intent.sequence };
		current.state = { status: "ready" };
		current.revision++;
	}, context);
}

async function createExecutionScope(
	tx: Tx,
	engine: ReturnType<typeof missionController>,
	admission: MissionAdmission,
	model: ModelChoice,
	missionId: string,
	revision: number,
	tools: string[],
) {
	const control = await tx.createConversation({ ownership: { kind: "ownerless" } });
	const controller = await tx.createTask(
		engine.controller,
		{ missionId, revision },
		{ conversationId: control.id, ownership: { kind: "conversation" }, background: true },
	);
	const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: controller } });
	admission.trackConversation(conversation.id);
	const agent = await tx.doc(AgentDoc, conversation.id);
	agent.model = model;
	agent.tools = tools;
	agent.maxTurns = 1;
	const providerSession = `${MISSION_PROVIDER_PREFIX}${randomUUID()}`;
	(await tx.doc(ProviderDoc, conversation.id)).sessionId = providerSession;
	return { controller, conversation: conversation.id, providerSession };
}

function active(execution: MissionExecution): boolean {
	return (
		execution.state.status === "ready" || execution.state.status === "running" || execution.state.status === "waiting"
	);
}

function terminal() {
	return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
}

function block(execution: MissionExecution, reason: string) {
	execution.state = { status: "blocked", reason };
	execution.revision++;
	return { status: "terminal" as const, outcome: { status: "failed" as const, error: { message: reason } } };
}
