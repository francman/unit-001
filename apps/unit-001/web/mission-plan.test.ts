// Exercises the closed Missions v2 browser projection, including stale heads and nested evidence.
import { describe, expect, it } from "vitest";
import type { PlanRevisionView, PlanTerms, PlanView, ReviewNote, ReviewTurnView } from "./mission-plan-contract.ts";
import { parsePlanTerms, parsePlanView, parseReviewNote } from "./mission-plan.ts";

const terms: PlanTerms = {
	overall: { purpose: "Record café\r\n<chart>", scope: "Repo", askFirst: ["shipping"], reviewEveryMs: 100, reviewAllowance: null },
	strategics: [{ id: "delivery", title: "Deliver", intent: "Build", signals: ["useful"], priority: "high" }],
	tacticals: [{
		id: "build", strategic: "delivery", objective: "Test", successCriteria: ["Green"], priority: "normal", deadlineAt: 500,
		mode: "runnable", binding: { missionId: "mission-a", purposeRevision: 1, purposeDigest: "c".repeat(64) },
	}],
};
const previous: PlanRevisionView = {
	revision: 2, digest: "a".repeat(64), previousDigest: null, terms, agreedAt: 100, receiptId: "receipt-a",
};
const head: PlanRevisionView = {
	revision: 4, digest: "b".repeat(64), previousDigest: previous.digest, terms, agreedAt: 200, receiptId: "receipt-b",
};
const review: ReviewNote = {
	reviewId: "review-a",
	key: "2:owner:click-a",
	trigger: { kind: "owner", key: "2:owner:click-a", subject: "click-a" },
	planRevision: previous.revision,
	planDigest: previous.digest,
	window: { from: 100, to: 135 },
	createdAt: 135,
	outcome: "attention",
	items: [{
		id: "build", level: "tactical", status: "blocked", verifiedWorks: 0, listedWorks: 1,
		runIds: ["run-a"], blockReasons: ["binding"], unsettled: 1, deadlineAt: 500,
	}],
	facts: {
		runsUsed: 1, runsLimit: 32, cycles: 0, maxCycles: 10, requests: 1, maxRequests: 10,
		estimatedCost: 0.125, maxEstimatedCost: null,
	},
	uncertainty: ["One unsettled effect."],
	disposition: { kind: "drafted", at: 150, draftRevision: 4 },
};
const trigger = { kind: "cadence", key: "4:cadence:w1", subject: "w1" } as const;
const preview: ReviewNote = {
	...review, reviewId: "review-b", key: trigger.key, trigger, planRevision: head.revision, planDigest: head.digest,
	window: { from: 200, to: 300 }, createdAt: 300, outcome: "no-change", disposition: null,
};
const draft = {
	revision: 5, baseRevision: 4, status: "proposed", terms, digest: "d".repeat(64), savedBy: "owner",
	fromReview: null, missing: ["Current purpose binding is stale."],
} as const;
const plan: PlanView = {
	missionId: "mission-a",
	adopted: true,
	head,
	headValid: false,
	previous,
	history: [head, previous].map(({ revision, digest, agreedAt }) => ({ revision, digest, agreedAt })),
	draft,
	gate: { state: "closed", reason: "receipt" },
	runs: { used: 1, limit: 32 },
	allowance: null,
	turns: [],
	blocker: null,
	due: [trigger],
	preview,
	reviews: [review],
};

describe("plan projection", () => {
	it("keeps exact prose, the stale approved head, the proposed draft's blocker and recorded versus preview reviews", () => {
		expect(parsePlanView(plan)).toEqual(plan);
	});

	it("accepts an unadopted closed gate when the first receipt was issued but not recorded", () => {
		const pending = {
			...plan, adopted: false, head: null, previous: null, history: [], draft: { ...draft, baseRevision: 0 },
			gate: { state: "closed", reason: "head-missing" }, due: [], preview: null, reviews: [],
		};
		expect(parsePlanView(pending)).toEqual(pending);
	});

	it("preserves a partial editing draft for correction", () => {
		const editing = {
			...plan,
			draft: { ...draft, status: "editing", digest: null, terms: { ...terms, overall: { ...terms.overall, purpose: "" } } },
		};
		expect(parsePlanView(editing)).toEqual(editing);
	});

	it.each([
		["private authority", { planApprovals: [] }],
		["numeric flag", { headValid: 1 }],
		["unknown gate reason", { gate: { state: "closed", reason: "future" } }],
		["open gate with stale head", { gate: { state: "open", reason: null } }],
		["missing gate reason", { gate: { state: "closed", reason: null } }],
		["too many used runs", { runs: { used: 33, limit: 32 } }],
		["invalid head digest chain", { head: { ...head, previousDigest: null } }],
		["history out of order", { history: [...plan.history].reverse() }],
		["head from another history", { head: { ...head, agreedAt: 999 } }],
		["non-summary history", { history: [head, previous] }],
		["fractional draft revision", { draft: { ...draft, revision: 5.5 } }],
		["editing draft with a digest", { draft: { ...draft, status: "editing" } }],
		["malformed proposal digest", { draft: { ...draft, digest: "not-a-digest" } }],
		["too many strategics", { draft: { ...draft, terms: { ...terms, strategics: Array(4).fill(terms.strategics[0]) } } }],
		["unbound runnable tactical", { draft: { ...draft, terms: { ...terms, tacticals: [{ ...terms.tacticals[0], binding: null }] } } }],
		["parked tactical with a binding", { draft: { ...draft, terms: { ...terms, tacticals: [{ ...terms.tacticals[0], mode: "parked" }] } } }],
		["oversize UTF-8 prose", { draft: { ...draft, terms: { ...terms, overall: { ...terms.overall, purpose: "é".repeat(2049) } } } }],
		["unprojected fields in terms", { head: { ...head, terms: { ...terms, installationId: "private" } } }],
		["unrelated preview", { preview: { ...preview, planDigest: previous.digest } }],
		["disposed preview", { preview: { ...preview, disposition: review.disposition } }],
		["unrelated review", { reviews: [{ ...review, planDigest: head.digest }] }],
		["too many saved notes", { reviews: Array(13).fill(review) }],
	])("rejects %s", (_name, patch) => {
		expect(() => parsePlanView({ ...plan, ...patch })).toThrow("Invalid mission plan projection.");
	});
});

describe("model review projection", () => {
	const allowance = { maxRequests: 10, maxRequestsPerReview: 4, maxEstimatedCost: null };
	const blocker: ReviewTurnView = {
		key: review.key, planRevision: review.planRevision, trigger: review.trigger, state: "blocked",
		reason: "unknown_request_outcome", reviewId: review.reviewId, draftRevision: null, requests: 1, at: 135,
	};
	const newest: ReviewTurnView = {
		key: trigger.key, planRevision: head.revision, trigger, state: "done",
		reason: null, reviewId: null, draftRevision: 5, requests: 2, at: 300,
	};
	const projected = {
		...plan,
		allowance: { ...allowance, requests: 12, estimatedCost: 0.25, reservedCost: 0.125 },
		turns: [newest],
		blocker,
	};
	it("keeps the lifetime usage and a pinned blocker outside the retained turns", () => {
		const turns = Array.from({ length: 16 }, (_, index) => {
			const key = `cadence:${index}`;
			return { ...newest, key, trigger: { ...trigger, key }, at: 300 - index };
		});
		expect(parsePlanView({ ...projected, turns })).toEqual({ ...projected, turns });
	});

	it("keeps an explicit null allowance and an explicit allowance in plan terms", () => {
		const withAllowance = { ...terms, overall: { ...terms.overall, reviewAllowance: allowance } };
		expect(parsePlanTerms(withAllowance)).toEqual(withAllowance);
		expect(parsePlanTerms(terms).overall.reviewAllowance).toBeNull();
	});

	it.each([
		["plan terms without reviewAllowance", () => {
			const { purpose, scope, askFirst, reviewEveryMs } = terms.overall;
			return parsePlanTerms({ ...terms, overall: { purpose, scope, askFirst, reviewEveryMs } });
		}],
		["a plan without the model review fields", () => {
			const { allowance: _allowance, turns: _turns, blocker: _blocker, ...old } = plan;
			return parsePlanView(old);
		}],
		["a plan with only some model review fields", () => {
			const { allowance: _allowance, blocker: _blocker, ...partial } = plan;
			return parsePlanView(partial);
		}],
	])("rejects %s", (_name, parse) => {
		expect(parse).toThrow("Invalid mission plan projection.");
	});

	it.each([
		["undefined allowance", { allowance: undefined }],
		["null turn list", { turns: null }],
		["more than 16 turns", { turns: Array(17).fill(newest) }],
		["unknown skip reason", { turns: [{ ...newest, state: "skipped", reason: "future", draftRevision: null }] }],
		["wrong reason for state", { blocker: { ...blocker, reason: "budget" } }],
		["unknown blocker state", { blocker: { ...blocker, state: "failed" } }],
		["draft on running turn", { turns: [{ ...newest, state: "running" }] }],
		["unsafe request count", { turns: [{ ...newest, requests: Number.MAX_SAFE_INTEGER + 1 }] }],
		["nested provider data", { blocker: { ...blocker, providerSession: "private" } }],
		["nested trigger data", { blocker: { ...blocker, trigger: { ...blocker.trigger, conversation: "private" } } }],
		["negative reserved cost", { allowance: { ...projected.allowance, reservedCost: -0.01 } }],
		["nonfinite cost", { allowance: { ...projected.allowance, estimatedCost: Infinity } }],
	])("rejects %s", (_name, patch) => {
		expect(() => parsePlanView({ ...projected, ...patch })).toThrow("Invalid mission plan projection.");
	});

	it.each([
		["zero lifetime requests", { maxRequests: 0 }],
		["fractional requests", { maxRequestsPerReview: 1.5 }],
		["too many requests per turn", { maxRequestsPerReview: 5 }],
		["per-turn requests over lifetime cap", { maxRequests: 3 }],
		["zero spend cap", { maxEstimatedCost: 0 }],
		["nonfinite spend cap", { maxEstimatedCost: Infinity }],
		["unknown allowance field", { totalRequests: 12 }],
	])("rejects authored allowance with %s", (_name, patch) => {
		expect(() => parsePlanTerms({
			...terms, overall: { ...terms.overall, reviewAllowance: { ...allowance, ...patch } },
		})).toThrow("Invalid mission plan projection.");
	});
});

describe("review note projection", () => {
	const item = review.items[0];
	it.each([
		["unexpected nested field", { items: [{ ...item, rawEvidence: { token: "private" } }] }],
		["object instead of run ID", { items: [{ ...item, runIds: [{ id: "run-a" }] }] }],
		["unknown item status", { items: [{ ...item, status: "released" }] }],
		["uncertainty outside run list", { items: [{ ...item, unsettled: 2 }] }],
		["verified count above listed count", { items: [{ ...item, verifiedWorks: 2 }] }],
		["string usage", { facts: { ...review.facts, runsUsed: "1" } }],
		["non-finite cost", { facts: { ...review.facts, estimatedCost: Infinity } }],
		["negative cost cap", { facts: { ...review.facts, maxEstimatedCost: -1 } }],
		["fractional timestamp", { window: { from: 5.5, to: 10 } }],
		["wrong trigger key", { trigger: { ...review.trigger, key: "another-trigger" } }],
		["object uncertainty", { uncertainty: [{}] }],
		["drafted without draft revision", { disposition: { kind: "drafted", at: 100, draftRevision: null } }],
		["dismissed with draft revision", { disposition: { kind: "dismissed", at: 100, draftRevision: 1 } }],
	])("rejects %s", (_name, patch) => {
		expect(() => parseReviewNote({ ...review, ...patch })).toThrow("Invalid mission plan projection.");
	});
});
