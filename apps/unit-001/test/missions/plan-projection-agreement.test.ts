// The owner's plan parsers and the browser page's plan parsers accept and reject the same sizes.
import { describe, expect, it } from "vitest";
import { parsePlanTerms as parsePageTerms, parsePlanView as parsePagePlan } from "../../web/mission-plan.ts";
import { MAX_DUE_TRIGGERS, MAX_REVIEW_TURNS, PLAN_PROJECTION_LIMITS, PLAN_TERMS_LIMITS } from "../../src/missions/plan-limits.ts";
import { MAX_REQUESTS_PER_REVIEW, MAX_STRATEGICS, MAX_TACTICALS, parsePlanTerms as parseOwnerTerms } from "../../src/missions/plan-terms.ts";
import { MAX_PURPOSE_WORKS } from "../../src/missions/purpose-authority.ts";
import { parsePlanView as parseOwnerPlan } from "../../src/missions/plan-wire.ts";
import { planTerms } from "./fixtures/plan.ts";

type Json = Record<string, any>;

const digest = "a".repeat(64);

function accepts(parse: (value: unknown) => unknown, value: unknown): boolean {
	try {
		parse(value);
		return true;
	} catch {
		return false;
	}
}

// Both sides read the same JSON, so a parser that mutated its input would also show here.
const copy = (value: unknown): Json => JSON.parse(JSON.stringify(value));

describe("plan limits shared by the owner wire and the page", () => {
	it("keeps the dependency-free limits equal to the owner's own constants", () => {
		expect(PLAN_TERMS_LIMITS.strategics).toBe(MAX_STRATEGICS);
		expect(PLAN_TERMS_LIMITS.tacticals).toBe(MAX_TACTICALS);
		expect(PLAN_TERMS_LIMITS.requestsPerReview).toBe(MAX_REQUESTS_PER_REVIEW);
		expect(PLAN_PROJECTION_LIMITS.runs).toBe(MAX_PURPOSE_WORKS);
	});

	// Each row is [what, change that puts one field exactly at its limit, change that puts it one past].
	const strategic = (id: string): Json => ({ id, title: "T", intent: "I", signals: [], priority: "high" });
	const rows: [string, (terms: Json, size: number) => void, number][] = [
		["purpose text", (terms, size) => void (terms.overall.purpose = "x".repeat(size)), PLAN_TERMS_LIMITS.purposeText],
		["scope text", (terms, size) => void (terms.overall.scope = "x".repeat(size)), PLAN_TERMS_LIMITS.scopeText],
		["ask-first items", (terms, size) => void (terms.overall.askFirst = Array(size).fill("a")), PLAN_TERMS_LIMITS.askFirst],
		["ask-first text", (terms, size) => void (terms.overall.askFirst = ["x".repeat(size)]), PLAN_TERMS_LIMITS.askFirstText],
		["strategic title", (terms, size) => void (terms.strategics[0].title = "x".repeat(size)), PLAN_TERMS_LIMITS.titleText],
		["strategic intent", (terms, size) => void (terms.strategics[0].intent = "x".repeat(size)), PLAN_TERMS_LIMITS.intentText],
		["strategic signals", (terms, size) => void (terms.strategics[0].signals = Array(size).fill("s")), PLAN_TERMS_LIMITS.signals],
		["signal text", (terms, size) => void (terms.strategics[0].signals = ["x".repeat(size)]), PLAN_TERMS_LIMITS.signalText],
		["tactical objective", (terms, size) => void (terms.tacticals[1].objective = "x".repeat(size)), PLAN_TERMS_LIMITS.objectiveText],
		["success criteria", (terms, size) => void (terms.tacticals[1].successCriteria = Array(size).fill("c")), PLAN_TERMS_LIMITS.successCriteria],
		["criterion text", (terms, size) => void (terms.tacticals[1].successCriteria = ["x".repeat(size)]), PLAN_TERMS_LIMITS.criterionText],
		[
			"strategics",
			(terms, size) => {
				terms.strategics = Array.from({ length: size }, (_, index) => strategic(`s${index}`));
				terms.tacticals = [];
			},
			PLAN_TERMS_LIMITS.strategics,
		],
		[
			"tacticals",
			(terms, size) => {
				const base = terms.tacticals[1];
				terms.tacticals = Array.from({ length: size }, (_, index) => ({ ...base, id: `t${index}` }));
			},
			PLAN_TERMS_LIMITS.tacticals,
		],
		[
			"requests per review",
			(terms, size) => void (terms.overall.reviewAllowance = { maxRequests: 10, maxRequestsPerReview: size, maxEstimatedCost: null }),
			PLAN_TERMS_LIMITS.requestsPerReview,
		],
	];

	for (const [name, set, limit] of rows) {
		it(`agrees on the ${name} limit`, () => {
			const atLimit = copy(planTerms());
			set(atLimit, limit);
			expect(accepts(parseOwnerTerms, atLimit), "owner at limit").toBe(true);
			expect(accepts(parsePageTerms, atLimit), "page at limit").toBe(true);
			const pastLimit = copy(planTerms());
			set(pastLimit, limit + 1);
			expect(accepts(parseOwnerTerms, pastLimit), "owner past limit").toBe(false);
			expect(accepts(parsePageTerms, pastLimit), "page past limit").toBe(false);
		});
	}

	it("agrees on the byte limit of a whole terms document", () => {
		const terms = copy(planTerms());
		terms.overall.purpose = "x".repeat(PLAN_TERMS_LIMITS.purposeText);
		terms.overall.scope = "x".repeat(PLAN_TERMS_LIMITS.scopeText);
		terms.tacticals = Array.from({ length: 3 }, (_, index) => ({
			...copy(planTerms().tacticals[1]),
			id: `t${index}`,
			objective: "x".repeat(PLAN_TERMS_LIMITS.objectiveText),
			successCriteria: Array(PLAN_TERMS_LIMITS.successCriteria).fill("x".repeat(PLAN_TERMS_LIMITS.criterionText)),
		}));
		terms.overall.askFirst = [];
		// Fill with ask-first lines until the document is exactly one byte under, at and over the limit.
		const size = () => Buffer.byteLength(JSON.stringify(terms));
		while (size() + 2 + PLAN_TERMS_LIMITS.askFirstText < PLAN_TERMS_LIMITS.termsBytes && terms.overall.askFirst.length < PLAN_TERMS_LIMITS.askFirst)
			terms.overall.askFirst.push("x".repeat(PLAN_TERMS_LIMITS.askFirstText));
		const room = PLAN_TERMS_LIMITS.termsBytes - size() - 3;
		terms.overall.askFirst.push("x".repeat(room));
		expect(size()).toBe(PLAN_TERMS_LIMITS.termsBytes);
		expect(accepts(parseOwnerTerms, terms), "owner at limit").toBe(true);
		expect(accepts(parsePageTerms, terms), "page at limit").toBe(true);
		terms.overall.askFirst[terms.overall.askFirst.length - 1] += "x";
		expect(accepts(parseOwnerTerms, terms), "owner past limit").toBe(false);
		expect(accepts(parsePageTerms, terms), "page past limit").toBe(false);
	});
});

describe("plan status list limits", () => {
	const trigger = (index: number): Json => ({ kind: "owner", key: `1:owner:${index}`, subject: String(index) });
	const note = (index: number, from: Json): Json => ({
		reviewId: `review-${index}`,
		key: from.key,
		trigger: from,
		planRevision: 1,
		planDigest: digest,
		window: { from: 1, to: 2 },
		createdAt: 2,
		outcome: "attention",
		items: [],
		facts: { runsUsed: 0, runsLimit: PLAN_PROJECTION_LIMITS.runs, cycles: 0, maxCycles: 1, requests: 0, maxRequests: 1, estimatedCost: 0, maxEstimatedCost: null },
		uncertainty: [],
		disposition: null,
	});
	const turn = (index: number): Json => ({
		key: `1:turn:${index}`,
		planRevision: 1,
		trigger: trigger(index),
		state: "running",
		reason: null,
		reviewId: null,
		draftRevision: null,
		requests: 0,
		at: 1,
	});
	const view = (turns: number, due: number, reviews: number): Json => {
		const triggers = Array.from({ length: due }, (_, index) => trigger(index));
		return {
			missionId: "mission-1",
			adopted: true,
			head: { revision: 1, digest, previousDigest: null, terms: planTerms(), agreedAt: 1, receiptId: "receipt-1" },
			headValid: true,
			previous: null,
			history: [{ revision: 1, digest, agreedAt: 1 }],
			draft: null,
			gate: { state: "open", reason: null },
			runs: { used: 0, limit: PLAN_PROJECTION_LIMITS.runs },
			due: triggers,
			preview: due === 0 ? null : note(0, triggers[0]),
			reviews: Array.from({ length: reviews }, (_, index) => note(index + 1, trigger(index + 100))),
			allowance: null,
			turns: Array.from({ length: turns }, (_, index) => turn(index)),
			blocker: null,
		};
	};

	it("agrees on the review turn, due trigger and recorded review counts", () => {
		const cases: [string, number, number, number, boolean][] = [
			["turns at limit", MAX_REVIEW_TURNS, 0, 0, true],
			["turns past limit", MAX_REVIEW_TURNS + 1, 0, 0, false],
			["due at limit", 0, MAX_DUE_TRIGGERS, 0, true],
			["due past limit", 0, MAX_DUE_TRIGGERS + 1, 0, false],
			["reviews at limit", 0, 0, PLAN_PROJECTION_LIMITS.reviews, true],
			["reviews past limit", 0, 0, PLAN_PROJECTION_LIMITS.reviews + 1, false],
		];
		for (const [name, turns, due, reviews, accepted] of cases) {
			const value = view(turns, due, reviews);
			expect(accepts(parseOwnerPlan, value), `owner ${name}`).toBe(accepted);
			expect(accepts(parsePagePlan, value), `page ${name}`).toBe(accepted);
		}
	});
});
