// Charges a purpose's lifetime allowance where each effect is admitted, in the same commit, and settles attempts by ID.
import {
	attemptCapDenial,
	findAttempt,
	type ProviderAttempt,
	releaseLedgerAttempt,
	reserveLedgerAttempt,
	settleLedgerAttempt,
} from "./attempt-ledger.ts";
import type { ArtifactWorkTerms, PurposeLifetime, WorkTerms } from "./contract.ts";
import type { LoopRun, LoopState } from "./purpose-loop.ts";

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
export function chargeCycle(
	loop: LoopState,
	run: LoopRun,
	work: ArtifactWorkTerms,
	lifetime: PurposeLifetime,
): string | undefined {
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
): { attempt: ProviderAttempt } | { denial: string } {
	if (run.attempts.some((attempt) => attempt.status === "reserved"))
		return { denial: "An interrupted mission request needs reconciliation." };
	if (run.pendingTools.length !== 0) return { denial: "An interrupted mission tool needs reconciliation." };
	if (runRequests(run) >= work.maxRequests || loop.ledger.requests >= lifetime.maxRequests)
		return { denial: "Mission request allowance is exhausted." };
	const cap = lifetime.maxEstimatedCost;
	const spend = cap === undefined ? undefined : attemptCapDenial(loop.ledger, cap, ceiling);
	if (spend === "unbounded_history") return { denial: "unknown_historical_cost" };
	if (spend === "over_cap") return { denial: "Estimated mission spend cannot admit this request." };
	const attemptId = `${run.runId}:a${run.attempts.length + 1}`;
	return { attempt: reserveLedgerAttempt(loop.ledger, run.attempts, attemptId, ceiling) };
}

/** Settles one reserved attempt of any run from a completed provider response, by ID and at most once. */
export function settleAttempt(loop: LoopState, attemptId: string, cost: number | null): void {
	settleLedgerAttempt(loop.ledger, findAttempt(loop.runs, attemptId), cost);
}

/** Settles an attempt of any run that this process positively knows it never dispatched; the request stays charged. */
export function releaseAttempt(loop: LoopState, attemptId: string): void {
	releaseLedgerAttempt(loop.ledger, findAttempt(loop.runs, attemptId));
}
