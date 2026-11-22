// Charges a purpose's lifetime allowance where each effect is admitted, in the same commit, and settles attempts by ID.
import type { PurposeLifetime, WorkTerms } from "./contract.ts";
import type { LoopAttempt, LoopRun, LoopState } from "./purpose-loop.ts";

/** Charges one work admission; refuses, charging nothing, unless the lifetime allowance can pay for its first cycle. */
export function admitWork(loop: LoopState, lifetime: PurposeLifetime): string | undefined {
	const denial = workAllowanceDenial(loop, lifetime);
	if (denial === undefined) loop.ledger.workItems++;
	return denial;
}

/**
 * Why the lifetime allowance cannot pay for one more work item, if it cannot: a work slot, its first cycle and its
 * first request must all remain. A slot is never refunded, so it is charged only when the effect it pays for can follow.
 */
export function workAllowanceDenial(loop: LoopState, lifetime: PurposeLifetime): string | undefined {
	const ledger = loop.ledger;
	if (
		ledger.workItems >= lifetime.maxWorkItems ||
		ledger.cycles >= lifetime.maxCycles ||
		ledger.requests >= lifetime.maxRequests
	)
		return "allowance_exhausted";
	const cap = lifetime.maxEstimatedCost;
	if (cap === undefined) return undefined;
	if (ledger.unboundedAttempts !== 0) return "unknown_historical_cost";
	return ledger.estimatedCost + ledger.reservedCost >= cap ? "allowance_exhausted" : undefined;
}

/** Charges one cycle submission against the run's and the purpose's cycle allowances. */
export function chargeCycle(loop: LoopState, run: LoopRun, work: WorkTerms, lifetime: PurposeLifetime): string | undefined {
	if (run.cycles >= work.maxCycles) return "cycle_limit";
	if (run.noProgress >= work.maxConsecutiveNoProgress) return "no_progress_limit";
	if (loop.ledger.cycles >= lifetime.maxCycles) return "allowance_exhausted";
	run.cycles++;
	loop.ledger.cycles++;
	return undefined;
}

/** Request attempts a run has consumed: every reserved attempt, dispatched or not. */
export function runRequests(run: LoopRun): number {
	return run.attempts.length;
}

/**
 * Reserves one provider attempt with its exact ceiling; refuses on any uncertain earlier effect, an exhausted
 * allowance, or a spend cap that a known ceiling cannot fit or an unbounded earlier attempt makes uncomputable.
 */
export function reserveAttempt(
	loop: LoopState,
	run: LoopRun,
	work: WorkTerms,
	lifetime: PurposeLifetime,
	ceiling: number | null,
): { attempt: LoopAttempt } | { denial: string } {
	if (run.attempts.some((attempt) => attempt.status === "reserved"))
		return { denial: "An interrupted mission request needs reconciliation." };
	if (run.pendingTools.length !== 0) return { denial: "An interrupted mission tool needs reconciliation." };
	if (runRequests(run) >= work.maxRequests || loop.ledger.requests >= lifetime.maxRequests)
		return { denial: "Mission request allowance is exhausted." };
	const cap = lifetime.maxEstimatedCost;
	if (cap !== undefined) {
		// Spend charged without a ceiling cannot be bounded, so a cap added later fails closed instead of guessing.
		if (loop.ledger.unboundedAttempts !== 0) return { denial: "unknown_historical_cost" };
		if (ceiling === null || loop.ledger.estimatedCost + loop.ledger.reservedCost + ceiling > cap)
			return { denial: "Estimated mission spend cannot admit this request." };
	}
	const attempt: LoopAttempt = { attemptId: `${run.runId}:a${run.attempts.length + 1}`, ceiling, status: "reserved" };
	run.attempts.push(attempt);
	loop.ledger.requests++;
	loop.ledger.unknownRequests++;
	if (ceiling === null) loop.ledger.unboundedAttempts++;
	else loop.ledger.reservedCost += ceiling;
	return { attempt };
}

/**
 * Settles one reserved attempt from a completed provider response, at most once. A priced response replaces the
 * reservation with its cost; an unpriced one keeps the reservation charged. A duplicate does nothing. Errors and
 * aborts are not settled here: a lost or ambiguous receipt cannot prove the provider did nothing.
 */
export function settleAttempt(loop: LoopState, attemptId: string, cost: number | null): void {
	const attempt = findAttempt(loop, attemptId);
	if (!attempt || attempt.status !== "reserved") return;
	loop.ledger.unknownRequests--;
	if (cost === null) {
		attempt.status = "unpriced";
		loop.ledger.unpricedResponses++;
		return;
	}
	attempt.status = "priced";
	attempt.cost = cost;
	loop.ledger.estimatedCost += cost;
	unreserve(loop, attempt.ceiling ?? 0);
}

/**
 * Settles an attempt this process positively knows it never dispatched: its outcome is known and its cost zero, so
 * the reservation becomes zero spend and, without a ceiling, no longer unbounded spend. The request stays charged;
 * nothing is refunded once a reservation commits.
 */
export function releaseAttempt(loop: LoopState, attemptId: string): void {
	const attempt = findAttempt(loop, attemptId);
	if (!attempt || attempt.status !== "reserved") return;
	attempt.status = "released";
	loop.ledger.unknownRequests--;
	if (attempt.ceiling === null) loop.ledger.unboundedAttempts--;
	else unreserve(loop, attempt.ceiling);
}

// Floating subtraction can end a few ulps below zero (0.7 + 0.1 - 0.7 - 0.1 is -2.8e-17), and a stored negative
// total is invalid, so the reservation total stops at zero.
function unreserve(loop: LoopState, ceiling: number): void {
	loop.ledger.reservedCost = Math.max(0, loop.ledger.reservedCost - ceiling);
}

function findAttempt(loop: LoopState, attemptId: string): LoopAttempt | undefined {
	for (const run of loop.runs) {
		const attempt = run.attempts.find((item) => item.attemptId === attemptId);
		if (attempt) return attempt;
	}
	return undefined;
}
