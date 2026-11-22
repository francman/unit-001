// #72: The plan view previews reviews without storing them and crosses the owner wire only in its pinned shape.
import { describe, expect, it } from "vitest";
import { storeReview } from "../../src/missions/plan-review.ts";
import { missionPlanView } from "../../src/missions/plan-view.ts";
import { MAX_DUE_TRIGGERS, parsePlanView } from "../../src/missions/plan-wire.ts";
import { workDigest } from "../../src/missions/purpose-authority.ts";
import type { LoopRun } from "../../src/missions/purpose-loop.ts";
import type { ReviewState, ReviewTurn } from "../../src/missions/review-turn-state.ts";
import { agreePlan, authority, emptyPlan, loopWithPurpose, planTerms } from "./fixtures/plan.ts";

function viewWithReview() {
	const auth = authority();
	const plan = emptyPlan();
	agreePlan(auth, plan, planTerms());
	const loop = loopWithPurpose();
	storeReview(plan, loop, "review-1", 11_000);
	return { auth, plan, loop, view: missionPlanView(plan, loop, auth, undefined, 21_000) };
}

describe("plan view", () => {
	it("previews the due review and leaves the stored plan unchanged", () => {
		const { plan, view } = viewWithReview();
		const before = structuredClone(plan);
		expect(view.due.map((trigger) => trigger.key)).toEqual(["1:cadence:w2"]);
		expect(view.preview).toMatchObject({ key: "1:cadence:w2" });
		expect(view.reviews.map((note) => note.key)).toEqual(["1:cadence:w1"]);
		expect(plan).toEqual(before);
	});

	it("lists why a proposed draft can no longer be agreed against the current loop", () => {
		const plan = emptyPlan();
		const terms = planTerms();
		plan.draft = {
			revision: 1,
			baseRevision: 0,
			status: "proposed",
			terms,
			digest: "d".repeat(64),
			savedBy: "owner",
			fromReview: null,
			requestId: "d1",
		};
		expect(missionPlanView(plan, loopWithPurpose(), authority(), undefined, 1).draft!.missing).toEqual([]);
		// The bound purpose revision is no longer agreed in the loop the managed writer will check against.
		const moved = loopWithPurpose();
		moved.agreements[0] = { ...moved.agreements[0]!, digest: "c".repeat(64) };
		expect(missionPlanView(plan, moved, authority(), undefined, 1).draft!.missing).toEqual([
			"The runnable tactical must bind an exact agreed purpose revision and digest.",
		]);
		plan.draft.status = "editing";
		expect(missionPlanView(plan, moved, authority(), undefined, 1).draft!.missing).toEqual([]);
	});

	it("judges the head from protected history even without a readable loop", () => {
		const auth = authority();
		const plan = emptyPlan();
		agreePlan(auth, plan, planTerms());
		agreePlan(auth, plan, planTerms({ overall: { ...planTerms().overall, scope: "Two" } }));
		agreePlan(auth, plan, planTerms({ overall: { ...planTerms().overall, scope: "Three" } }));
		expect(missionPlanView(plan, undefined, auth, undefined, 1)).toMatchObject({ headValid: true, gate: { reason: "binding" } });
		// The oldest binding is gone while the retained tail still matches.
		const broken = { ...auth, planRequests: auth.planRequests!.slice(1) };
		expect(missionPlanView(plan, undefined, broken, undefined, 1)).toMatchObject({
			headValid: false,
			gate: { state: "closed", reason: "receipt" },
		});
		expect(missionPlanView(plan, loopWithPurpose(), broken, undefined, 1).headValid).toBe(false);
	});

	it("pins only a finished turn with an unknown request as the blocker, never a running turn's in-flight request", () => {
		const auth = authority();
		const plan = emptyPlan();
		agreePlan(auth, plan, planTerms());
		const attempt = { attemptId: "a1", ceiling: null, status: "reserved" as const };
		const turn = (key: string, state: ReviewTurn["state"]): ReviewTurn => ({
			key,
			planRevision: 1,
			trigger: { kind: "cadence", key, subject: null },
			reviewId: null,
			conversation: null,
			providerSession: null,
			attempts: [{ ...attempt, attemptId: `${key}:a1` }],
			state,
			at: 1,
		});
		const ledger = { requests: 1, estimatedCost: 0, reservedCost: 0, unknownRequests: 1, unpricedResponses: 0, unboundedAttempts: 1 };
		const running: ReviewState = { turns: [turn("1:cadence:w1", { status: "running" })], ledger, task: null };
		expect(missionPlanView(plan, loopWithPurpose(), auth, running, 1).blocker).toBeNull();
		const stuck: ReviewState = {
			turns: [turn("1:cadence:w1", { status: "blocked", reason: "unknown_request_outcome" })],
			ledger,
			task: null,
		};
		expect(missionPlanView(plan, loopWithPurpose(), auth, stuck, 1).blocker).toMatchObject({
			key: "1:cadence:w1",
			state: "blocked",
			reason: "unknown_request_outcome",
			requests: 1,
		});
	});

	it("reports the gate as not adopted before any agreement", () => {
		expect(missionPlanView(emptyPlan(), loopWithPurpose(), authority(), undefined, 1).gate).toEqual({
			state: "not-adopted",
			reason: null,
		});
	});
});

describe("parsing the plan view", () => {
	it("round-trips the owner's own projection", () => {
		const { view } = viewWithReview();
		expect(parsePlanView(JSON.parse(JSON.stringify(view)))).toEqual(view);
	});

	it("keeps status parseable with more due triggers than the wire bound", () => {
		const auth = authority();
		const plan = emptyPlan();
		agreePlan(auth, plan, planTerms(), 1_000);
		const loop = loopWithPurpose(["a"]);
		const work = loop.agreements[0]!.terms.works[0]!;
		// 20 blocked runs, plus cadence and runs-low: well over the bound.
		for (let i = 1; i <= 20; i++)
			loop.runs.push({
				runId: `run-${i}`,
				workId: "p1-w1",
				workDigest: workDigest(work),
				purposeRevision: 1,
				state: { status: "blocked", reason: "retry_limit" },
				settlement: "settled",
			} as LoopRun);
		const view = missionPlanView(plan, loop, auth, undefined, 50_000);
		expect(view.due).toHaveLength(MAX_DUE_TRIGGERS);
		expect(view.due[0]!.key).toBe("1:blocked:run-1");
		expect(parsePlanView(JSON.parse(JSON.stringify(view)))).toEqual(view);
		// Review now consumes the most urgent key; the window advances and the next pending trigger becomes visible.
		const hidden = "1:blocked:run-17";
		expect(view.due.map((trigger) => trigger.key)).not.toContain(hidden);
		storeReview(plan, loop, "review-1", 50_000);
		const next = missionPlanView(plan, loop, auth, undefined, 50_000);
		expect(next.due[0]!.key).toBe("1:blocked:run-2");
		expect(next.due.map((trigger) => trigger.key)).toContain(hidden);
		expect(next.due).toHaveLength(MAX_DUE_TRIGGERS);
	});

	it("refuses extra or malformed review note fields instead of passing them on", () => {
		const { view } = viewWithReview();
		const wire = JSON.parse(JSON.stringify(view));
		wire.reviews[0].html = "<script>";
		expect(() => parsePlanView(wire)).toThrow("fields");
		const item = JSON.parse(JSON.stringify(view));
		item.reviews[0].items[0].status = "great";
		expect(() => parsePlanView(item)).toThrow("value");
		const facts = JSON.parse(JSON.stringify(view));
		facts.reviews[0].facts.extra = 1;
		expect(() => parsePlanView(facts)).toThrow("fields");
		const long = JSON.parse(JSON.stringify(view));
		long.reviews[0].uncertainty = ["x".repeat(401)];
		expect(() => parsePlanView(long)).toThrow("400 bytes");
	});
});
