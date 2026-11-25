// Stores Bob's model review turns beside the plan: one record per due trigger, the lifetime review ledger, the task.
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import {
	type AttemptLedger,
	attemptCapDenial,
	countAttempt,
	emptyAttemptLedger,
	findAttempt,
	type ProviderAttempt,
	releaseLedgerAttempt,
	reserveLedgerAttempt,
	settleLedgerAttempt,
} from "./attempt-ledger.ts";
import { missionObject } from "./contract.ts";
import type { ReviewTrigger } from "./plan-review.ts";
import type { ReviewAllowance } from "./plan-terms.ts";
import { MAX_REVIEW_TURNS } from "./plan-wire.ts";
import type { LoopState } from "./purpose-loop.ts";
import { readDoc, storedDoc } from "./stored-doc.ts";

/** Where one review turn is; `skipped` turns run once their reason clears, and a turn is never run twice. */
export type ReviewTurnState =
	| { status: "running" }
	| { status: "done"; draftRevision: number | null }
	| { status: "skipped"; reason: "budget" | "hold" | "unsettled" }
	| { status: "blocked"; reason: "unknown_request_outcome" | "turn_failed" | "authority" };

/** One review turn for one due trigger key, under one agreed plan revision. */
export type ReviewTurn = {
	key: string;
	planRevision: number;
	trigger: ReviewTrigger;
	reviewId: string | null;
	conversation: ConversationId | null;
	providerSession: string | null;
	attempts: ProviderAttempt[];
	state: ReviewTurnState;
	at: number;
};

/**
 * Review turns, their ledger and the one live review task; additive, so a release without reviews ignores it. The
 * ledger is model spend on reviews over the mission's life, across every plan revision; never reset, never refunded.
 */
export type ReviewState = { turns: ReviewTurn[]; ledger: AttemptLedger; task: TaskId<null> | null };

/** Provider sessions of review turns; the mission prefix routes them through admission. */
export const REVIEW_PROVIDER_PREFIX = "unit-mission:review-";

/** The review document: absent reads as no turns, an empty ledger and no task. */
export const MissionReviewDoc = defineDoc<ReviewState>({
	kind: "unit.mission.review",
	version: 1,
	scope: "session",
	initial: () => ({ turns: [], ledger: emptyAttemptLedger(), task: null }),
	checkpointWhen: () => true,
});

/** Reads the stored review state after validation; throws on a malformed document. */
export async function readReviewState(harness: Harness, context: Context): Promise<ReviewState | undefined> {
	return readDoc(harness, context, MissionReviewDoc, checkReviewState);
}

/** The review state validated inside the caller's transaction; undefined when unreadable or invalid, which admits nothing. */
export async function storedReviewState(tx: Tx): Promise<ReviewState | undefined> {
	return storedDoc(tx, MissionReviewDoc, checkReviewState);
}

/** Whether a turn still holds a request of unknown outcome; such a turn blocks every later one and is never evicted. */
export function unresolvedTurn(turn: ReviewTurn): boolean {
	return turn.attempts.some((attempt) => attempt.status === "reserved");
}

/**
 * Whether a purpose run still needs disposition for an uncertain effect. An acknowledged terminal run retains its
 * charges, but its protected acknowledgment permits further work.
 */
export function purposeUnsettled(loop: LoopState): boolean {
	return loop.runs.some((run) => {
		if (run.state.status !== "running" && run.settlement !== null && typeof run.settlement === "object")
			return false;
		return (
			run.settlement === "unsettled" ||
			run.pendingTools.length !== 0 ||
			run.attempts.some((attempt) => attempt.status === "reserved")
		);
	});
}

/** The turn recorded for a key, if any. */
export function turnFor(state: ReviewState, key: string): ReviewTurn | undefined {
	return state.turns.find((turn) => turn.key === key);
}

/**
 * Records a new turn, dropping the oldest finished ones beyond the bound. A running or unresolved turn is never
 * dropped; with no room left the record is refused, so nothing runs without its record.
 */
export function recordTurn(state: ReviewState, turn: ReviewTurn): void {
	state.turns.push(turn);
	while (state.turns.length > MAX_REVIEW_TURNS) {
		const index = state.turns.findIndex((item) => item.state.status !== "running" && !unresolvedTurn(item));
		if (index < 0) throw new Error("Review turns are all unresolved; nothing new is recorded.");
		state.turns.splice(index, 1);
	}
}

/**
 * Why the review allowance cannot pay for one more request of this turn, if it cannot: per-review and lifetime request
 * caps, an unknown earlier outcome, and the spend cap, which a request without a cost ceiling can never fit.
 */
export function reviewRequestDenial(
	state: ReviewState,
	turn: ReviewTurn,
	allowance: ReviewAllowance,
	ceiling: number | null,
): string | undefined {
	if (state.turns.some((item) => item !== turn && unresolvedTurn(item)) || unresolvedTurn(turn))
		return "An interrupted review request needs reconciliation.";
	if (turn.attempts.length >= allowance.maxRequestsPerReview) return "This review has used its requests.";
	if (state.ledger.requests >= allowance.maxRequests) return "The review allowance is exhausted.";
	const cap = allowance.maxEstimatedCost;
	const spend = cap === null ? undefined : attemptCapDenial(state.ledger, cap, ceiling);
	if (spend === "unbounded_history") return "Earlier review spend is unbounded; a spend cap cannot admit more.";
	if (spend === "over_cap") return "Estimated review spend cannot admit this request.";
	return undefined;
}

/** Reserves one review request with its exact ceiling, charged now; the caller has checked `reviewRequestDenial`. */
export function reserveReviewAttempt(state: ReviewState, turn: ReviewTurn, ceiling: number | null): ProviderAttempt {
	return reserveLedgerAttempt(state.ledger, turn.attempts, `${turn.key}:a${turn.attempts.length + 1}`, ceiling);
}

/** Settles one reserved review request from a terminal provider receipt, once; an unpriced one stays reserved spend. */
export function settleReviewAttempt(state: ReviewState, attemptId: string, cost: number | null): void {
	settleLedgerAttempt(state.ledger, findAttempt(state.turns, attemptId), cost);
}

/** Settles a request this process knows it never sent: zero spend, the request itself stays charged. */
export function releaseReviewAttempt(state: ReviewState, attemptId: string): void {
	releaseLedgerAttempt(state.ledger, findAttempt(state.turns, attemptId));
}

/**
 * Validates stored review state: bounded turns with unique keys and attempt IDs, finite non-negative ledger totals, and
 * retained turns within the ledger. Reserved attempts are never evicted, so unknown requests match them exactly;
 * evicted turns can only have been charged earlier, so every other retained total is at most the ledger's.
 */
export function checkReviewState(value: unknown): ReviewState {
	const state = missionObject(value) as ReviewState;
	const ledger = missionObject(state.ledger) as AttemptLedger;
	if (!Array.isArray(state.turns) || state.turns.length > MAX_REVIEW_TURNS) throw new Error("Invalid stored review turns.");
	const counts = [ledger.requests, ledger.unknownRequests, ledger.unpricedResponses, ledger.unboundedAttempts];
	const amounts = [ledger.estimatedCost, ledger.reservedCost];
	if (
		!counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
		!amounts.every((amount) => Number.isFinite(amount) && amount >= 0)
	)
		throw new Error("Invalid stored review ledger.");
	const retained = emptyAttemptLedger();
	const ids = new Set<string>();
	for (const turn of state.turns) {
		const input = missionObject(turn);
		if (typeof input.key !== "string" || !Array.isArray(turn.attempts) || !Number.isSafeInteger(turn.planRevision))
			throw new Error("Invalid stored review turn.");
		for (const attempt of turn.attempts) {
			countAttempt(retained, attempt);
			if (ids.has(attempt.attemptId)) throw new Error("Duplicate stored review attempt.");
			ids.add(attempt.attemptId);
		}
	}
	const within = (part: number, whole: number) => part <= whole + 1e-9;
	if (
		new Set(state.turns.map((turn) => turn.key)).size !== state.turns.length ||
		retained.unknownRequests !== ledger.unknownRequests ||
		!within(retained.requests, ledger.requests) ||
		!within(retained.unpricedResponses, ledger.unpricedResponses) ||
		!within(retained.unboundedAttempts, ledger.unboundedAttempts) ||
		!within(retained.estimatedCost, ledger.estimatedCost) ||
		!within(retained.reservedCost, ledger.reservedCost)
	)
		throw new Error("Stored review ledger does not match its turns.");
	return state;
}
