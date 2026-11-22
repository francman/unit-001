// Runs Bob's bounded model review of the agreed plan: at a due trigger, one budget-counted turn that may save a draft.
import { randomUUID } from "node:crypto";
import { AgentDoc, defineTask, ProviderDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import type { ModelChoice } from "../provider.ts";
import type { MissionAdmission } from "./admission.ts";
import { planHeadValid } from "./plan-gate.ts";
import { dueTriggers, type ReviewNote, type ReviewTrigger, reviewNote } from "./plan-review.ts";
import { type PlanAgreement, type PlanState, saveReview, storedPlan } from "./plan-state.ts";
import type { ReviewAllowance } from "./plan-terms.ts";
import { storedLoop } from "./purpose.ts";
import type { LoopState } from "./purpose-loop.ts";
import {
	MissionReviewDoc,
	purposeUnsettled,
	REVIEW_PROVIDER_PREFIX,
	type ReviewState,
	type ReviewTurn,
	recordTurn,
	storedReviewState,
	turnFor,
	unresolvedTurn,
} from "./review-turn-state.ts";

export type ReviewInput = { model: ModelChoice };

type ReviewCheckpoint =
	| { phase: "check" }
	| { phase: "submit"; key: string }
	| { phase: "await"; key: string; requestId: string }
	| { phase: "wake"; until: number };

/** The only tools a review turn has: read the mission, save a plan draft. Neither runs work or agrees anything. */
export const REVIEW_TOOLS = ["unit_mission_status", "unit_plan_draft"];

/**
 * Registers the review task; the owner arms one live task while the agreed plan grants a review allowance. Each due
 * trigger is skipped with its reason, or admitted: the deterministic note (consuming the trigger's key) and a running
 * turn record commit together before any model request, so a crash or restart never reviews the same window twice.
 */
export function missionReview(admission: MissionAdmission) {
	return defineTask<ReviewInput, ReviewCheckpoint, null>({
		name: "unit.mission.review",
		version: 1,
		initial: () => ({ phase: "check" }),
		phases: {
			check: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const reviews = await storedReviewState(tx);
					const plan = await storedPlan(tx);
					if (!reviews || reviews.task !== task.id || !plan) return ended();
					const head = plan.agreed.at(-1);
					const allowance = head?.terms.overall.reviewAllowance;
					const authority = await admission.readAuthority();
					if (!head || !allowance || !authority || !planHeadValid(authority, plan)) {
						reviews.task = null;
						return ended();
					}
					const now = runtime.now();
					const loop = await storedLoop(tx);
					// Owner triggers are the owner's own deterministic reviews; a model turn answers only scheduled ones.
					const trigger = dueTriggers(plan, loop, now).find((item) => item.kind !== "owner");
					// A hold ends the task, so maintenance and a release switch find no live review task; release rearms it.
					if ((await tx.doc(MaintenanceDoc)).current.state === "held") {
						if (trigger) upsert(reviews, trigger, head, now, { status: "skipped", reason: "hold" });
						reviews.task = null;
						return ended();
					}
					if (!trigger) return sleep(nextWindow(head, now));
					const skip = skipReason(reviews, loop, allowance);
					if (skip) {
						upsert(reviews, trigger, head, now, { status: "skipped", reason: skip });
						return sleep(nextWindow(head, now));
					}
					const note = await admit(tx, task.id, task.input.model, plan, head, loop, reviews, trigger, now);
					return { status: "running", checkpoint: { phase: "submit", key: note.key } };
				}, context),
			submit: async (task, runtime, context) => {
				const saved = await runtime.snapshot(MissionReviewDoc, context);
				const turn = saved && turnFor(saved, task.state.checkpoint.key);
				if (!turn?.conversation || turn.state.status !== "running") return runtime.commit(() => back(), context);
				const conversation = await runtime.conversation(turn.conversation, context);
				if (!conversation) throw new Error("Review conversation is unavailable.");
				return runtime.commit(async (tx) => {
					const reviews = await storedReviewState(tx);
					const current = reviews && turnFor(reviews, task.state.checkpoint.key);
					if (!current || current.state.status !== "running") return back();
					const plan = await storedPlan(tx);
					const note = plan?.reviews.find((item) => item.reviewId === current.reviewId);
					if (!note) {
						current.state = { status: "blocked", reason: "turn_failed" };
						return back();
					}
					const requestId = `${current.key}:turn`;
					await conversation.submit(tx, { type: "input", content: reviewPrompt(note), requestId });
					return { status: "running", checkpoint: { phase: "await", key: current.key, requestId } };
				}, context);
			},
			await: async (task, runtime, context) => {
				const saved = await runtime.snapshot(MissionReviewDoc, context);
				const turn = saved && turnFor(saved, task.state.checkpoint.key);
				if (!turn?.conversation) return runtime.commit(() => back(), context);
				const conversation = await runtime.conversation(turn.conversation, context);
				if (!conversation) throw new Error("Review conversation is unavailable.");
				await conversation.waitForIdle(context);
				return runtime.commit(async (tx) => {
					const reviews = await storedReviewState(tx);
					const current = reviews && turnFor(reviews, task.state.checkpoint.key);
					if (!current || current.state.status !== "running") return back();
					const submission = await tx.submissionByRequest(current.conversation!, task.state.checkpoint.requestId);
					if (!submission || submission.status === "queued" || submission.status === "placed")
						throw new Error("Review submission has not settled.");
					current.state = finishedState(current, (await storedPlan(tx))?.draft, submission.status === "unanswered");
					return back();
				}, context);
			},
			wake: (task, runtime, context) =>
				runtime.commit(async () => {
					const { until } = task.state.checkpoint;
					// Durable fires early only after clock skew; the persisted wake stays authoritative.
					if (runtime.now() < until) return { status: "sleeping", until, checkpoint: task.state.checkpoint };
					return back();
				}, context),
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				const reviews = await storedReviewState(tx);
				if (!reviews) return { status: "terminal", outcome: { status: "aborted" } };
				for (const turn of reviews.turns)
					if (turn.state.status === "running")
						turn.state = { status: "blocked", reason: unresolvedTurn(turn) ? "unknown_request_outcome" : "turn_failed" };
				if (reviews.task === task.id) reviews.task = null;
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
}

// Why a due review cannot run now, if it cannot: effects of unknown outcome (purpose runs, an earlier review, or
// purpose records that cannot be read) or no allowance left for one request. Each is rechecked at every attempt.
function skipReason(
	reviews: ReviewState,
	loop: LoopState | undefined,
	allowance: ReviewAllowance,
): "unsettled" | "budget" | undefined {
	if (!loop || purposeUnsettled(loop) || reviews.turns.some(unresolvedTurn))
		return "unsettled";
	const ledger = reviews.ledger;
	// An earlier request without a cost ceiling makes a spend cap unpayable; skip before the trigger's key is consumed.
	if (
		ledger.requests >= allowance.maxRequests ||
		(allowance.maxEstimatedCost !== null && ledger.unboundedAttempts !== 0) ||
		(allowance.maxEstimatedCost !== null && ledger.estimatedCost + ledger.reservedCost >= allowance.maxEstimatedCost)
	)
		return "budget";
	return undefined;
}

// One commit: the note that consumes the key, the turn record, and the bounded conversation; no request yet.
async function admit(
	tx: Tx,
	taskId: TaskId<null>,
	model: ModelChoice,
	plan: PlanState,
	head: PlanAgreement,
	loop: LoopState | undefined,
	reviews: ReviewState,
	trigger: ReviewTrigger,
	now: number,
): Promise<ReviewNote> {
	const conversation = await tx.createConversation({ ownership: { kind: "task", taskId } });
	const agent = await tx.doc(AgentDoc, conversation.id);
	agent.model = model;
	agent.tools = [...REVIEW_TOOLS];
	agent.modelTools = [...REVIEW_TOOLS];
	agent.maxTurns = head.terms.overall.reviewAllowance!.maxRequestsPerReview;
	const providerSession = `${REVIEW_PROVIDER_PREFIX}${randomUUID()}`;
	(await tx.doc(ProviderDoc, conversation.id)).sessionId = providerSession;
	const note = reviewNote(plan, head, loop, trigger, now);
	saveReview(plan, note, null);
	upsert(reviews, trigger, head, now, { status: "running" }, {
		reviewId: note.reviewId,
		conversation: conversation.id,
		providerSession,
	});
	return note;
}

// One record per key, updated in place through the stored record: a skipped turn becomes the running one when its
// reason clears.
function upsert(
	reviews: ReviewState,
	trigger: ReviewTrigger,
	head: PlanAgreement,
	now: number,
	state: ReviewTurn["state"],
	binding: Pick<ReviewTurn, "reviewId" | "conversation" | "providerSession"> = {
		reviewId: null,
		conversation: null,
		providerSession: null,
	},
): void {
	const existing = turnFor(reviews, trigger.key);
	if (!existing) {
		recordTurn(reviews, { key: trigger.key, planRevision: head.revision, trigger, ...binding, attempts: [], state, at: now });
		return;
	}
	existing.state = state;
	existing.at = now;
	existing.reviewId = binding.reviewId;
	existing.conversation = binding.conversation;
	existing.providerSession = binding.providerSession;
}

// A turn with a request of unknown outcome is blocked, never replayed; a draft counts only if this review saved it.
function finishedState(turn: ReviewTurn, draft: PlanState["draft"] | undefined, unanswered: boolean): ReviewTurn["state"] {
	if (unresolvedTurn(turn)) return { status: "blocked", reason: "unknown_request_outcome" };
	if (unanswered) return { status: "blocked", reason: "turn_failed" };
	const drafted = draft?.savedBy === "bob" && draft.fromReview === turn.reviewId ? draft.revision : null;
	return { status: "done", draftRevision: drafted };
}

function reviewPrompt(note: ReviewNote): string {
	return [
		`Review the agreed mission plan (revision ${note.planRevision}) against this host-built review note.`,
		`Review note: ${JSON.stringify(note)}`,
		"Read unit_mission_status if you need the full plan. If the evidence calls for a change, save exactly one plan " +
			`draft with unit_plan_draft (fromReview "${note.reviewId}"); otherwise save nothing.`,
		"You cannot agree, open or run anything; only the owner agrees an exact revision. Reply with a short summary.",
	].join("\n");
}

// The next cadence window boundary after now; a review never wakes more often than the agreed cadence.
function nextWindow(head: PlanAgreement, now: number): number {
	const every = head.terms.overall.reviewEveryMs;
	const start = head.approval.approvedAt;
	return start + (Math.floor((now - start) / every) + 1) * every;
}

function sleep(until: number) {
	return { status: "sleeping" as const, until, checkpoint: { phase: "wake" as const, until } };
}

function back() {
	return { status: "running" as const, checkpoint: { phase: "check" as const } };
}

function ended() {
	return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
}
