// Advances an open purpose through its listed work: observe, record a proposal, admit, cycle, verify, then sleep.
import { randomUUID } from "node:crypto";
import { AgentDoc, defineTask, ProviderDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { MemoryInputEntry, recordMemoryInput } from "unit-memory";
import { MaintenanceDoc } from "../maintenance.ts";
import type { ModelChoice } from "../provider.ts";
import { MISSION_PROVIDER_PREFIX, type MissionAdmission } from "./admission.ts";
import { admitWork, chargeCycle, workAllowanceDenial } from "./allowance.ts";
import type { MissionAuthority } from "./contract.ts";
import { type MissionEvidence, MissionExecutionDoc } from "./execution-state.ts";
import { MissionPurposeDoc, storedLoop, validPurposeLoop } from "./purpose.ts";
import { matchingPurposeApproval, workDigest } from "./purpose-authority.ts";
import {
	appendProposal,
	doneWork,
	type LoopRun,
	type LoopState,
	listedWork,
	listedWorkId,
	loopAgreement,
	type PurposeReceiptAgreement,
} from "./purpose-loop.ts";
import { verifyMissionFiles } from "./verification.ts";
import { WORK_TOOL } from "./work-tool.ts";

export type LoopInput = { missionId: string; purposeRevision: number; sequence: number; model: ModelChoice };

type LoopCheckpoint =
	| { phase: "observe" }
	| { phase: "admit"; proposalId: string }
	| { phase: "cycle"; runId: string }
	| { phase: "await"; runId: string; requestId: string }
	| { phase: "wake"; until: number; next: "observe" | { runId: string } };

/** Registers the purpose loop task; one live loop per applied open intent or acknowledgment rearm. */
export function missionLoop(admission: MissionAdmission, cwd: string) {
	// Read inside each admitting commit: Durable runs commits one at a time, so a revocation published before this read
	// closes the admission even when the commit was queued before it.
	const authority = () => admission.readAuthority();
	return defineTask<LoopInput, LoopCheckpoint, null>({
		name: "unit.mission.loop",
		version: 1,
		initial: () => ({ phase: "observe" }),
		phases: {
			observe: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const loop = await currentLoop(tx, task.id, task.input.sequence);
					if (!loop) return terminal();
					const now = runtime.now();
					const agreement = loopAgreement(loop, task.input.purposeRevision)!;
					const denial = operationDenial(await authority(), loop, task.input.sequence, now);
					if (denial) return blocked(loop, denial);
					if (await held(tx)) return sleep(loop, agreement, now, "maintenance", "observe");
					if (loop.runs.some((run) => run.settlement === "unsettled"))
						return blocked(loop, "unsettled_effects");
					if (await legacyActive(tx)) return blocked(loop, "legacy_execution");
					// The persisted wake outlives the loop task: a reopen or rearm never observes before it.
					const due = loop.operation.nextObservationAt;
					if (due !== null && due > now) {
						loop.operation.activity = { kind: "waiting", reason: "next_observation", until: due };
						return { status: "sleeping", until: due, checkpoint: { phase: "wake", until: due, next: "observe" } };
					}
					const done = doneWork(loop);
					const index = agreement.terms.works.findIndex((work) => !done.has(workDigest(work)));
					loop.observations++;
					const proposalId = `${task.input.missionId}:${task.input.purposeRevision}:${task.input.sequence}:${loop.observations}`;
					if (index < 0) {
						appendProposal(loop, {
							proposalId,
							observation: loop.observations,
							purposeRevision: task.input.purposeRevision,
							sequence: task.input.sequence,
							decision: { kind: "wait", reason: "all_listed_work_done", until: null },
							status: "admitted",
							recordedAt: now,
						});
						return idle(loop);
					}
					const exhausted = workAllowanceDenial(loop, agreement.terms.lifetime);
					if (exhausted) return blocked(loop, exhausted);
					appendProposal(loop, {
						proposalId,
						observation: loop.observations,
						purposeRevision: task.input.purposeRevision,
						sequence: task.input.sequence,
						decision: { kind: "work", workId: listedWorkId(agreement.revision, index) },
						status: "recorded",
						recordedAt: now,
					});
					return { status: "running", checkpoint: { phase: "admit", proposalId } };
				}, context),
			admit: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const loop = await currentLoop(tx, task.id, task.input.sequence);
					const proposal = loop?.proposals.find((item) => item.proposalId === task.state.checkpoint.proposalId);
					if (!loop || !proposal || proposal.status !== "recorded") return terminal();
					const now = runtime.now();
					const agreement = loopAgreement(loop, task.input.purposeRevision)!;
					const denial = operationDenial(await authority(), loop, task.input.sequence, now);
					if (denial || proposal.purposeRevision !== task.input.purposeRevision) {
						proposal.status = "stale";
						return blocked(loop, denial ?? "stale_proposal");
					}
					if (await held(tx)) {
						// The proposal is not admitted under a hold; the next observation records a fresh one.
						proposal.status = "stale";
						return sleep(loop, agreement, now, "maintenance", "observe");
					}
					if (proposal.decision.kind !== "work") return terminal();
					const work = listedWork(agreement, proposal.decision.workId)!;
					const exhausted = admitWork(loop, agreement.terms.lifetime);
					if (exhausted) {
						proposal.status = "stale";
						return blocked(loop, exhausted);
					}
					const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					const agent = await tx.doc(AgentDoc, conversation.id);
					agent.model = task.input.model;
					agent.tools = [WORK_TOOL];
					agent.modelTools = [WORK_TOOL];
					agent.maxTurns = 1;
					const providerSession = `${MISSION_PROVIDER_PREFIX}${randomUUID()}`;
					(await tx.doc(ProviderDoc, conversation.id)).sessionId = providerSession;
					// Tracked before the commit lands; a rolled-back identity has no run record, so admission denies it.
					admission.trackLoopConversation(conversation.id);
					const run: LoopRun = {
						runId: proposal.proposalId,
						workId: proposal.decision.workId,
						workDigest: workDigest(work),
						purposeRevision: agreement.revision,
						sequence: task.input.sequence,
						conversation: conversation.id,
						providerSession,
						cycles: 0,
						retries: 0,
						noProgress: 0,
						attempts: [],
						pendingTools: [],
						evidence: [],
						lastAnswer: null,
						state: { status: "running", phase: "execution" },
						settlement: null,
					};
					loop.runs.push(run);
					proposal.status = "admitted";
					loop.operation.activity = { kind: "working", runId: run.runId };
					return { status: "running", checkpoint: { phase: "cycle", runId: run.runId } };
				}, context),
			cycle: async (task, runtime, context) => {
				const saved = validPurposeLoop(await runtime.snapshot(MissionPurposeDoc, context));
				const savedRun = saved?.runs.find((run) => run.runId === task.state.checkpoint.runId);
				if (!savedRun) return runtime.commit(() => terminal(), context);
				const evidence = await observe(saved!, savedRun, cwd, runtime.now());
				const conversation = await runtime.conversation(savedRun.conversation, context);
				if (!conversation) throw new Error("Purpose run conversation is unavailable.");
				return runtime.commit(async (tx) => {
					const loop = await currentLoop(tx, task.id, task.input.sequence);
					const run = loop?.runs.find((item) => item.runId === task.state.checkpoint.runId);
					if (!loop || !run || run.state.status !== "running") return terminal();
					const now = runtime.now();
					const agreement = loopAgreement(loop, run.purposeRevision)!;
					const work = listedWork(agreement, run.workId)!;
					run.evidence = evidence;
					if (evidence.every((item) => item.accepted)) return verified(loop, run, agreement, now);
					const denial = operationDenial(await authority(), loop, task.input.sequence, now);
					if (denial) return blockRun(loop, run, agreement, now, denial);
					if (await held(tx)) return sleep(loop, agreement, now, "maintenance", { runId: run.runId });
					if (run.attempts.some((attempt) => attempt.status === "reserved"))
						return blockRun(loop, run, agreement, now, "unknown_request_outcome");
					if (run.pendingTools.length !== 0) return blockRun(loop, run, agreement, now, "unknown_tool_outcome");
					const limit = chargeCycle(loop, run, work, agreement.terms.lifetime);
					if (limit) return blockRun(loop, run, agreement, now, limit);
					const requestId = `${run.runId}:c${run.cycles}`;
					const prompt = [
						`Purpose: ${agreement.terms.purpose}`,
						`Scope: ${agreement.terms.scope}`,
						`Work ${run.workId}, cycle ${run.cycles}: ${work.instructions}`,
						`Produce the file ${work.path} with the ${WORK_TOOL} tool; the host accepts it only if its SHA-256 is ${work.sha256}.`,
						`Host observations: ${JSON.stringify(evidence)}`,
						"A final answer is a progress report, never proof of success. Only the host verifier completes this work.",
					].join("\n");
					const submission = await conversation.submit(tx, {
						type: "input",
						content: prompt,
						requestId,
						entry: { kind: MemoryInputEntry.kind, data: { origin: "mission" } },
					});
					await recordMemoryInput(tx, run.conversation, submission, "mission", prompt);
					return { status: "running", checkpoint: { phase: "await", runId: run.runId, requestId } };
				}, context);
			},
			await: async (task, runtime, context) => {
				const saved = validPurposeLoop(await runtime.snapshot(MissionPurposeDoc, context));
				const savedRun = saved?.runs.find((run) => run.runId === task.state.checkpoint.runId);
				if (!savedRun) return runtime.commit(() => terminal(), context);
				const conversation = await runtime.conversation(savedRun.conversation, context);
				if (!conversation) throw new Error("Purpose run conversation is unavailable.");
				await conversation.waitForIdle(context);
				const evidence = await observe(saved!, savedRun, cwd, runtime.now());
				return runtime.commit(async (tx) => {
					const loop = await currentLoop(tx, task.id, task.input.sequence);
					const run = loop?.runs.find((item) => item.runId === task.state.checkpoint.runId);
					if (!loop || !run || run.state.status !== "running") return terminal();
					const now = runtime.now();
					const agreement = loopAgreement(loop, run.purposeRevision)!;
					const work = listedWork(agreement, run.workId)!;
					const submission = await tx.submissionByRequest(run.conversation, task.state.checkpoint.requestId);
					if (!submission || submission.status === "queued" || submission.status === "placed")
						throw new Error("Purpose run submission has not settled.");
					run.lastAnswer = submission.status === "done" && submission.type !== "write" ? submission.answer : null;
					const progress =
						evidence.filter((item) => item.accepted).length > run.evidence.filter((item) => item.accepted).length;
					run.noProgress = progress ? 0 : run.noProgress + 1;
					run.evidence = evidence;
					if (evidence.every((item) => item.accepted)) return verified(loop, run, agreement, now);
					const denial = operationDenial(await authority(), loop, task.input.sequence, now);
					if (denial) return blockRun(loop, run, agreement, now, denial);
					if (run.attempts.some((attempt) => attempt.status === "reserved"))
						return blockRun(loop, run, agreement, now, "unknown_request_outcome");
					if (run.pendingTools.length !== 0) return blockRun(loop, run, agreement, now, "unknown_tool_outcome");
					if (submission.status === "unanswered" && submission.reason !== "turn_limit") {
						if (run.retries >= work.maxRetries) return blockRun(loop, run, agreement, now, "retry_limit");
						run.retries++;
						return sleep(loop, agreement, now, "retry", { runId: run.runId });
					}
					return { status: "running", checkpoint: { phase: "cycle", runId: run.runId } };
				}, context);
			},
			wake: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const loop = await currentLoop(tx, task.id, task.input.sequence);
					if (!loop) return terminal();
					const { until, next } = task.state.checkpoint;
					// Durable fires early only after clock skew; the persisted deadline stays authoritative.
					if (runtime.now() < until) return { status: "sleeping", until, checkpoint: task.state.checkpoint };
					loop.operation.activity = next === "observe" ? { kind: "observing" } : { kind: "working", runId: next.runId };
					return {
						status: "running",
						checkpoint: next === "observe" ? { phase: "observe" } : { phase: "cycle", runId: next.runId },
					};
				}, context),
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				const loop = await storedLoop(tx);
				if (!loop) return { status: "terminal", outcome: { status: "aborted" } };
				if (ownedBy(loop, task.id)) abandonRuns(loop);
				if (loop.operation.loop === task.id && loop.operation.state.status === "open")
					loop.operation.activity = { kind: "blocked", reason: "aborted" };
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
}

/**
 * The protected decision for one admission: the latest purpose receipt still agrees the open revision, the protected
 * open intent is exactly the applied one (request ID and sequence), the authority revision is unchanged, and the
 * lifetime deadline has not passed.
 */
export function operationDenial(
	authority: MissionAuthority | null,
	loop: LoopState,
	sequence: number,
	now: number,
): string | undefined {
	const state = loop.operation.state;
	if (state.status !== "open" || state.sequence !== sequence) return "operation_closed";
	const agreement = loopAgreement(loop, state.purposeRevision);
	const intent = authority?.operationIntent;
	if (
		!authority ||
		!agreement ||
		!intent ||
		intent.action !== "open" ||
		intent.sequence !== sequence ||
		intent.requestId !== loop.operation.applied?.requestId ||
		intent.missionId !== agreement.missionId ||
		intent.purposeRevision !== agreement.revision ||
		intent.purposeDigest !== agreement.digest ||
		intent.authorityRevision !== authority.revision ||
		!matchingPurposeApproval(
			authority,
			agreement.approval.receiptId,
			agreement.missionId,
			agreement.revision,
			agreement.terms,
		)
	)
		return "authority";
	if (agreement.terms.lifetime.deadlineAt <= now) return "deadline";
	return undefined;
}

/**
 * Ends every run still running under a loop that has stopped: aborted, and unsettled while any of its effects is
 * uncertain. The abort handler and the drain both call it: a phase that sees a restrictive commit before the abort
 * mark ends the loop normally, so no abort handler runs, and its run would otherwise stay running.
 */
export function abandonRuns(loop: LoopState): void {
	for (const run of loop.runs) {
		if (run.state.status !== "running") continue;
		run.state = { status: "aborted" };
		run.settlement = uncertain(run) ? "unsettled" : "settled";
	}
}

/** Whether a run still holds an effect of unknown outcome: a reserved attempt or a pending tool intent. */
export function uncertain(run: LoopRun): boolean {
	return run.pendingTools.length !== 0 || run.attempts.some((attempt) => attempt.status === "reserved");
}

// A loop acts only on a stored loop that validates, while the operation is open under its own sequence and names this
// task as its live loop; anything else ends the loop with no effect.
async function currentLoop(tx: Tx, task: TaskId<null>, sequence: number): Promise<LoopState | undefined> {
	const loop = await storedLoop(tx);
	const state = loop?.operation.state;
	return state?.status === "open" && state.sequence === sequence && loop!.operation.loop === task ? loop : undefined;
}

function ownedBy(loop: LoopState, task: TaskId<null>): boolean {
	return loop.operation.loop === task || loop.operation.drain?.loop === task;
}

async function held(tx: Tx): Promise<boolean> {
	return (await tx.doc(MaintenanceDoc)).current.state === "held";
}

// The one-shot engine and the loop never run together; each admits against its own ledger.
async function legacyActive(tx: Tx): Promise<boolean> {
	const status = (await tx.doc(MissionExecutionDoc)).current?.state.status;
	return status === "ready" || status === "running" || status === "waiting" || status === "paused";
}

async function observe(loop: LoopState, run: LoopRun, cwd: string, now: number): Promise<MissionEvidence[]> {
	const work = listedWork(loopAgreement(loop, run.purposeRevision)!, run.workId)!;
	return verifyMissionFiles([`sha256:${work.sha256}:${work.path}`], cwd, now);
}

function nextObservation(agreement: PurposeReceiptAgreement, now: number): number {
	return Math.min(agreement.terms.lifetime.deadlineAt, now + agreement.terms.reviewEveryMs);
}

// Verified evidence and settled effects are stored apart: a verified run with an uncertain effect still blocks.
function verified(loop: LoopState, run: LoopRun, agreement: PurposeReceiptAgreement, now: number) {
	run.state = { status: "verified", observedAt: now };
	run.settlement = uncertain(run) ? "unsettled" : "settled";
	loop.operation.nextObservationAt = nextObservation(agreement, now);
	if (run.settlement === "unsettled") return blocked(loop, "unsettled_effects");
	const done = doneWork(loop);
	// No listed work remains: end now instead of sleeping for an observation that can only find nothing.
	if (agreement.terms.works.every((work) => done.has(workDigest(work)))) return idle(loop);
	return sleep(loop, agreement, now, "next_observation", "observe");
}

// The operation stays open with nothing to do; only an amendment and a new open intent create another loop.
function idle(loop: LoopState) {
	loop.operation.activity = { kind: "idle", reason: "all_listed_work_done" };
	loop.operation.loop = null;
	return terminal();
}

function blockRun(loop: LoopState, run: LoopRun, agreement: PurposeReceiptAgreement, now: number, reason: string) {
	run.state = { status: "blocked", reason };
	run.settlement = uncertain(run) ? "unsettled" : "settled";
	loop.operation.nextObservationAt = nextObservation(agreement, now);
	return blocked(loop, run.settlement === "unsettled" ? "unsettled_effects" : reason);
}

function blocked(loop: LoopState, reason: string) {
	loop.operation.activity = { kind: "blocked", reason };
	return { status: "terminal" as const, outcome: { status: "failed" as const, error: { message: reason } } };
}

function sleep(
	loop: LoopState,
	agreement: PurposeReceiptAgreement,
	now: number,
	reason: "next_observation" | "maintenance" | "retry",
	next: "observe" | { runId: string },
) {
	const until = nextObservation(agreement, now);
	if (reason === "next_observation") loop.operation.nextObservationAt = until;
	loop.operation.activity = { kind: "waiting", reason, until };
	return { status: "sleeping" as const, until, checkpoint: { phase: "wake" as const, until, next } };
}

function terminal() {
	return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
}
