// #72: The review ledger charges every request once, never refunds, and never drops an unresolved turn.
import { describe, expect, it } from "vitest";
import type { ReviewAllowance } from "../../src/missions/plan-terms.ts";
import type { LoopState } from "../../src/missions/purpose-loop.ts";
import { MAX_REVIEW_TURNS } from "../../src/missions/plan-wire.ts";
import {
	checkReviewState,
	purposeUnsettled,
	type ReviewState,
	type ReviewTurn,
	recordTurn,
	releaseReviewAttempt,
	reserveReviewAttempt,
	reviewRequestDenial,
	settleReviewAttempt,
} from "../../src/missions/review-turn-state.ts";

function empty(): ReviewState {
	return {
		turns: [],
		ledger: { requests: 0, estimatedCost: 0, reservedCost: 0, unknownRequests: 0, unpricedResponses: 0, unboundedAttempts: 0 },
		task: null,
	};
}

function turn(key: string, state: ReviewTurn["state"] = { status: "running" }): ReviewTurn {
	return {
		key,
		planRevision: 1,
		trigger: { kind: "cadence", key, subject: null },
		reviewId: null,
		conversation: null,
		providerSession: null,
		attempts: [],
		state,
		at: 1,
	};
}

const allowance: ReviewAllowance = { maxRequests: 3, maxRequestsPerReview: 2, maxEstimatedCost: null };

describe("request admission", () => {
	it("charges each request once and stops at the per-review and lifetime caps", () => {
		const state = empty();
		const a = turn("1:cadence:w1");
		recordTurn(state, a);
		const first = reserveReviewAttempt(state, a, 0.5);
		expect(reviewRequestDenial(state, a, allowance, 0.5)).toMatch("reconciliation");
		settleReviewAttempt(state, first.attemptId, 0.2);
		reserveReviewAttempt(state, a, 0.5);
		settleReviewAttempt(state, a.attempts[1]!.attemptId, 0.1);
		expect(reviewRequestDenial(state, a, allowance, 0.5)).toMatch("used its requests");
		const b = turn("1:cadence:w2");
		recordTurn(state, b);
		reserveReviewAttempt(state, b, null);
		releaseReviewAttempt(state, b.attempts[0]!.attemptId);
		expect(reviewRequestDenial(state, b, allowance, 0.5)).toMatch("exhausted");
		expect(state.ledger).toMatchObject({ requests: 3, unknownRequests: 0, estimatedCost: 0.30000000000000004 });
		expect(() => checkReviewState(state)).not.toThrow();
	});

	it("needs a known request ceiling that fits under a spend cap", () => {
		const state = empty();
		const a = turn("1:cadence:w1");
		recordTurn(state, a);
		const capped = { ...allowance, maxEstimatedCost: 1 };
		expect(reviewRequestDenial(state, a, capped, null)).toMatch("spend");
		expect(reviewRequestDenial(state, a, capped, 2)).toMatch("spend");
		expect(reviewRequestDenial(state, a, capped, 0.5)).toBeUndefined();
	});

	it("keeps an unpriced response charged as reserved spend", () => {
		const state = empty();
		const a = turn("1:cadence:w1");
		recordTurn(state, a);
		const attempt = reserveReviewAttempt(state, a, 0.5);
		settleReviewAttempt(state, attempt.attemptId, null);
		settleReviewAttempt(state, attempt.attemptId, 0.1);
		expect(state.ledger).toMatchObject({ requests: 1, unknownRequests: 0, unpricedResponses: 1, reservedCost: 0.5 });
	});
});

describe("retained turns", () => {
	it("drops the oldest finished turns beyond the bound but never an unresolved one", () => {
		const state = empty();
		const blocked = turn("1:blocked:run-1", { status: "blocked", reason: "unknown_request_outcome" });
		recordTurn(state, blocked);
		reserveReviewAttempt(state, blocked, null);
		for (let i = 1; i <= MAX_REVIEW_TURNS + 3; i++) recordTurn(state, turn(`1:cadence:w${i}`, { status: "done", draftRevision: null }));
		expect(state.turns).toHaveLength(MAX_REVIEW_TURNS);
		expect(state.turns[0]!.key).toBe("1:blocked:run-1");
		expect(() => checkReviewState(state)).not.toThrow();
	});

	it("refuses a new record when every retained turn is unresolved", () => {
		const state = empty();
		for (let i = 1; i <= MAX_REVIEW_TURNS; i++) {
			const item = turn(`1:cadence:w${i}`);
			recordTurn(state, item);
			reserveReviewAttempt(state, item, null);
		}
		expect(() => recordTurn(state, turn("1:cadence:w99"))).toThrow("unresolved");
	});

	it("refuses a stored ledger that does not match its reserved attempts", () => {
		const state = empty();
		const a = turn("1:cadence:w1");
		recordTurn(state, a);
		reserveReviewAttempt(state, a, null);
		expect(() => checkReviewState({ ...state, ledger: { ...state.ledger, unknownRequests: 0 } })).toThrow("does not match");
		expect(() => checkReviewState({ ...state, ledger: { ...state.ledger, requests: 0 } })).toThrow();
	});
});

describe("codex 1b HOLD items", () => {
	it("item 3: an earlier request without a ceiling blocks capped spend, even after it settles unpriced", () => {
		const state = empty();
		const a = turn("1:cadence:w1");
		recordTurn(state, a);
		const unbounded = reserveReviewAttempt(state, a, null);
		settleReviewAttempt(state, unbounded.attemptId, null);
		const b = turn("1:cadence:w2");
		recordTurn(state, b);
		expect(reviewRequestDenial(state, b, { ...allowance, maxEstimatedCost: 10 }, 0.1)).toMatch("unbounded");
		expect(reviewRequestDenial(state, b, allowance, 0.1)).toBeUndefined();
	});

	it("item 4: refuses duplicate attempt IDs and retained spend above the ledger", () => {
		const state = empty();
		const a = turn("1:cadence:w1");
		recordTurn(state, a);
		const first = reserveReviewAttempt(state, a, 0.5);
		settleReviewAttempt(state, first.attemptId, 0.4);
		expect(() => checkReviewState(state)).not.toThrow();
		const duplicate = structuredClone(state);
		duplicate.turns[0]!.attempts.push({ ...duplicate.turns[0]!.attempts[0]! });
		duplicate.ledger.requests = 2;
		expect(() => checkReviewState(duplicate)).toThrow("Duplicate");
		const overspent = structuredClone(state);
		overspent.ledger.estimatedCost = 0.1;
		expect(() => checkReviewState(overspent)).toThrow("does not match");
		const priced = structuredClone(state);
		delete priced.turns[0]!.attempts[0]!.cost;
		expect(() => checkReviewState(priced)).toThrow("attempt");
	});

	it("blocks purpose effects until settlement or protected acknowledgment", () => {
		const run = { state: { status: "running" }, settlement: null, pendingTools: [], attempts: [] };
		const loop = (runs: unknown[]) => ({ runs }) as unknown as LoopState;
		expect(purposeUnsettled(loop([run]))).toBe(false);
		expect(purposeUnsettled(loop([{ ...run, pendingTools: ["task-1"] }]))).toBe(true);
		const reserved = { ...run, attempts: [{ status: "reserved" }] };
		expect(purposeUnsettled(loop([reserved]))).toBe(true);
		expect(purposeUnsettled(loop([{ ...run, settlement: "unsettled" }]))).toBe(true);
		const acknowledged = { ...reserved, pendingTools: ["task-1"], settlement: { acknowledged: "ack-1" } };
		expect(purposeUnsettled(loop([acknowledged]))).toBe(true);
		const terminal = { ...acknowledged, state: { status: "blocked" } };
		expect(purposeUnsettled(loop([terminal]))).toBe(false);
		expect(terminal.attempts[0]?.status).toBe("reserved");
		expect(terminal.pendingTools).toEqual(["task-1"]);
	});
});
