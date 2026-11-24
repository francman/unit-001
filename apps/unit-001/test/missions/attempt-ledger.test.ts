// Pins the one attempt ledger that purpose runs, review turns and one-shot execution share (rv-missions-2).
import { describe, expect, it } from "vitest";
import {
	attemptCapDenial,
	countAttempt,
	emptyAttemptLedger,
	exceedsCap,
	findAttempt,
	type ProviderAttempt,
	releaseLedgerAttempt,
	releaseSpend,
	reserveLedgerAttempt,
	reserveSpend,
	settleLedgerAttempt,
	settleSpend,
	type SpendTotals,
} from "../../src/missions/attempt-ledger.ts";

describe("attempt accounting", () => {
	it("charges each request once and never refunds it, whatever its outcome", () => {
		const ledger = emptyAttemptLedger();
		const attempts: ProviderAttempt[] = [];
		const priced = reserveLedgerAttempt(ledger, attempts, "a1", 2);
		const unpriced = reserveLedgerAttempt(ledger, attempts, "a2", 3);
		const released = reserveLedgerAttempt(ledger, attempts, "a3", null);
		expect(ledger).toEqual({ ...emptyAttemptLedger(), requests: 3, unknownRequests: 3, reservedCost: 5, unboundedAttempts: 1 });
		settleLedgerAttempt(ledger, priced, 0.5);
		settleLedgerAttempt(ledger, unpriced, null);
		releaseLedgerAttempt(ledger, released);
		// Duplicates and unknown IDs change nothing.
		settleLedgerAttempt(ledger, priced, 9);
		releaseLedgerAttempt(ledger, unpriced);
		settleLedgerAttempt(ledger, undefined, 1);
		expect(ledger).toEqual({
			requests: 3,
			estimatedCost: 0.5,
			reservedCost: 3,
			unknownRequests: 0,
			unpricedResponses: 1,
			unboundedAttempts: 0,
		});
		expect(attempts.map((attempt) => attempt.status)).toEqual(["priced", "unpriced", "released"]);
	});

	it("stops the reservation total at zero when floating subtraction ends a few ulps below it", () => {
		const ledger = emptyAttemptLedger();
		const attempts: ProviderAttempt[] = [];
		const first = reserveLedgerAttempt(ledger, attempts, "a1", 0.7);
		const second = reserveLedgerAttempt(ledger, attempts, "a2", 0.1);
		releaseLedgerAttempt(ledger, first);
		settleLedgerAttempt(ledger, second, 0);
		expect(ledger.reservedCost).toBe(0);
	});

	it("keeps one-shot inline totals equal to an attempt ledger fed the same requests", () => {
		const inline: SpendTotals = { requests: 0, estimatedCost: 0, reservedCost: 0, unknownRequests: 0, unpricedResponses: 0 };
		const ledger = emptyAttemptLedger();
		const attempts: ProviderAttempt[] = [];
		reserveSpend(inline, 2);
		settleSpend(inline, 2, 0.5);
		reserveSpend(inline, 3);
		settleSpend(inline, 3, null);
		reserveSpend(inline, 1);
		releaseSpend(inline, 1);
		settleLedgerAttempt(ledger, reserveLedgerAttempt(ledger, attempts, "a1", 2), 0.5);
		settleLedgerAttempt(ledger, reserveLedgerAttempt(ledger, attempts, "a2", 3), null);
		releaseLedgerAttempt(ledger, reserveLedgerAttempt(ledger, attempts, "a3", 1));
		const { unboundedAttempts: _unbounded, ...totals } = ledger;
		expect(inline).toEqual(totals);
	});
});

describe("spend cap", () => {
	it("admits only a known ceiling that fits, and fails closed after unbounded spend", () => {
		const ledger = { ...emptyAttemptLedger(), estimatedCost: 1, reservedCost: 1 };
		expect(exceedsCap(ledger, 3, 1)).toBe(false);
		expect(exceedsCap(ledger, 3, 1.5)).toBe(true);
		expect(exceedsCap(ledger, 3, null)).toBe(true);
		expect(attemptCapDenial(ledger, 3, 1)).toBeUndefined();
		expect(attemptCapDenial(ledger, 3, 2)).toBe("over_cap");
		expect(attemptCapDenial({ ...ledger, unboundedAttempts: 1 }, 100, 1)).toBe("unbounded_history");
	});
});

describe("recount from attempts", () => {
	it("recounts exactly what reserve, settle and release charged", () => {
		const ledger = emptyAttemptLedger();
		const runs = [{ attempts: [] as ProviderAttempt[] }, { attempts: [] as ProviderAttempt[] }];
		settleLedgerAttempt(ledger, reserveLedgerAttempt(ledger, runs[0].attempts, "a1", 2), 0.25);
		reserveLedgerAttempt(ledger, runs[0].attempts, "a2", null);
		settleLedgerAttempt(ledger, reserveLedgerAttempt(ledger, runs[1].attempts, "b1", 1), null);
		releaseLedgerAttempt(ledger, reserveLedgerAttempt(ledger, runs[1].attempts, "b2", 4));
		const totals = emptyAttemptLedger();
		for (const run of runs) for (const attempt of run.attempts) countAttempt(totals, attempt);
		expect(totals).toEqual(ledger);
		expect(findAttempt(runs, "b2")?.status).toBe("released");
		expect(findAttempt(runs, "c1")).toBeUndefined();
	});

	it("refuses a stored attempt whose amounts cannot be recounted", () => {
		for (const attempt of [
			{ attemptId: "a", ceiling: -1, status: "reserved" },
			{ attemptId: "a", ceiling: 1, status: "priced" },
			{ attemptId: "a", ceiling: 1, status: "reserved", cost: 1 },
			{ attemptId: "a", ceiling: 1, status: "lost" },
			{ ceiling: 1, status: "reserved" },
		])
			expect(() => countAttempt(emptyAttemptLedger(), attempt as ProviderAttempt)).toThrow("Invalid stored mission attempt.");
	});
});
