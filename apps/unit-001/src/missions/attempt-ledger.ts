// Accounts mission-paid provider requests: reserve before dispatch, settle or release once, recount from attempts.
import { missionObject } from "./contract.ts";

/** One reserved provider attempt; its receipt settles this record once, by ID, never by run or totals. */
export type ProviderAttempt = {
	attemptId: string;
	ceiling: number | null;
	status: "reserved" | "priced" | "unpriced" | "released";
	cost?: number;
};

/** Request and spend totals every mission ledger keeps; one-shot execution keeps them inline, without attempts. */
export type SpendTotals = {
	requests: number;
	estimatedCost: number;
	reservedCost: number;
	unknownRequests: number;
	unpricedResponses: number;
};

/** Totals of a ledger that records each attempt, so requests charged without a cost ceiling are counted too. */
export type AttemptLedger = SpendTotals & {
	/** Requests charged without a known cost ceiling; while any remains, a spend cap cannot admit more. */
	unboundedAttempts: number;
};

/** The empty attempt ledger: nothing requested, reserved or spent. */
export function emptyAttemptLedger(): AttemptLedger {
	return { requests: 0, estimatedCost: 0, reservedCost: 0, unknownRequests: 0, unpricedResponses: 0, unboundedAttempts: 0 };
}

/** Charges one request now with its reserved amount; its outcome stays unknown until settled or released. */
export function reserveSpend(totals: SpendTotals, amount: number): void {
	totals.requests++;
	totals.unknownRequests++;
	totals.reservedCost += amount;
}

/**
 * Settles one reserved request from a provider receipt. A priced receipt replaces the reservation with its cost; an
 * unpriced one keeps the reservation charged. The request itself is never refunded.
 */
export function settleSpend(totals: SpendTotals, amount: number, cost: number | null): void {
	totals.unknownRequests--;
	if (cost === null) {
		totals.unpricedResponses++;
		return;
	}
	totals.estimatedCost += cost;
	unreserve(totals, amount);
}

/** Settles a request this process positively knows it never dispatched: zero spend, the request stays charged. */
export function releaseSpend(totals: SpendTotals, amount: number): void {
	totals.unknownRequests--;
	unreserve(totals, amount);
}

/** Whether one more request cannot fit a spend cap: a request without a ceiling never fits one. */
export function exceedsCap(totals: SpendTotals, cap: number, ceiling: number | null): boolean {
	return ceiling === null || totals.estimatedCost + totals.reservedCost + ceiling > cap;
}

/** Why a spend cap cannot admit one more recorded attempt, if it cannot. */
export function attemptCapDenial(
	ledger: AttemptLedger,
	cap: number,
	ceiling: number | null,
): "unbounded_history" | "over_cap" | undefined {
	// Spend charged without a ceiling cannot be bounded, so a cap added later fails closed instead of guessing.
	if (ledger.unboundedAttempts !== 0) return "unbounded_history";
	return exceedsCap(ledger, cap, ceiling) ? "over_cap" : undefined;
}

/** Records and charges one attempt with its exact ceiling; the caller has checked its allowance. */
export function reserveLedgerAttempt(
	ledger: AttemptLedger,
	attempts: ProviderAttempt[],
	attemptId: string,
	ceiling: number | null,
): ProviderAttempt {
	const attempt: ProviderAttempt = { attemptId, ceiling, status: "reserved" };
	attempts.push(attempt);
	reserveSpend(ledger, ceiling ?? 0);
	if (ceiling === null) ledger.unboundedAttempts++;
	return attempt;
}

/**
 * Settles one reserved attempt from a completed provider response, at most once; a duplicate or unknown ID does
 * nothing. Errors and aborts are not settled here: a lost or ambiguous receipt cannot prove the provider did nothing.
 */
export function settleLedgerAttempt(ledger: AttemptLedger, attempt: ProviderAttempt | undefined, cost: number | null): void {
	if (!attempt || attempt.status !== "reserved") return;
	settleSpend(ledger, attempt.ceiling ?? 0, cost);
	if (cost === null) {
		attempt.status = "unpriced";
		return;
	}
	attempt.status = "priced";
	attempt.cost = cost;
}

/**
 * Settles an attempt this process positively knows it never dispatched: its cost is zero, so without a ceiling it is
 * no longer unbounded spend. The request stays charged; nothing is refunded once a reservation commits.
 */
export function releaseLedgerAttempt(ledger: AttemptLedger, attempt: ProviderAttempt | undefined): void {
	if (!attempt || attempt.status !== "reserved") return;
	attempt.status = "released";
	releaseSpend(ledger, attempt.ceiling ?? 0);
	if (attempt.ceiling === null) ledger.unboundedAttempts--;
}

/** The attempt with this ID among runs or turns, if any. */
export function findAttempt(
	owners: readonly { attempts: readonly ProviderAttempt[] }[],
	attemptId: string,
): ProviderAttempt | undefined {
	for (const owner of owners) {
		const attempt = owner.attempts.find((item) => item.attemptId === attemptId);
		if (attempt) return attempt;
	}
	return undefined;
}

/**
 * Validates one stored attempt and adds what it consumed to totals recounted from attempts, which a stored ledger is
 * then checked against. A released attempt is a charged request with zero cost, neither unknown nor unbounded.
 */
export function countAttempt(totals: AttemptLedger, attempt: ProviderAttempt): void {
	checkAttempt(attempt);
	totals.requests++;
	if (attempt.status === "released") return;
	if (attempt.ceiling === null) totals.unboundedAttempts++;
	if (attempt.status === "reserved") totals.unknownRequests++;
	if (attempt.status === "unpriced") totals.unpricedResponses++;
	if (attempt.status === "priced") totals.estimatedCost += attempt.cost!;
	else totals.reservedCost += attempt.ceiling ?? 0;
}

const ATTEMPT_STATUSES: readonly unknown[] = ["reserved", "priced", "unpriced", "released"];

// An attempt's ceiling and cost are what the ledger totals recompute from, so each must be a real amount; a priced
// attempt without its cost would count as free.
function checkAttempt(attempt: ProviderAttempt): void {
	const input = missionObject(attempt);
	const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (
		typeof input.attemptId !== "string" ||
		!ATTEMPT_STATUSES.includes(input.status) ||
		(input.ceiling !== null && !amount(input.ceiling)) ||
		(input.status === "priced" ? !amount(input.cost) : input.cost !== undefined)
	)
		throw new Error("Invalid stored mission attempt.");
}

// Floating subtraction can end a few ulps below zero (0.7 + 0.1 - 0.7 - 0.1 is -2.8e-17), and a stored negative
// total is invalid, so the reservation total stops at zero.
function unreserve(totals: SpendTotals, amount: number): void {
	totals.reservedCost = Math.max(0, totals.reservedCost - amount);
}
