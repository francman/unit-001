// #72: Plan reviews come from stored facts alone; status previews them, an explicit request stores one per key.
import { describe, expect, it } from "vitest";
import { dismissReview, dueTriggers, reviewNote, storeReview } from "../../src/missions/plan-review.ts";
import type { PlanState } from "../../src/missions/plan-state.ts";
import { workDigest } from "../../src/missions/purpose-authority.ts";
import type { LoopRun, LoopState } from "../../src/missions/purpose-loop.ts";
import { MissionRefusal } from "../../src/missions/refusal.ts";
import { agreePlan, authority, emptyPlan, loopWithPurpose, planTerms, runnable } from "./fixtures/plan.ts";

function adoptedAt(approvedAt = 1_000): { plan: PlanState; loop: LoopState } {
	const plan = emptyPlan();
	agreePlan(authority(), plan, planTerms(), approvedAt);
	return { plan, loop: loopWithPurpose(["a", "b"]) };
}

function run(loop: LoopState, index: number, state: LoopRun["state"], settlement: LoopRun["settlement"]): LoopRun {
	const work = loop.agreements[0]!.terms.works[index]!;
	const entry = {
		runId: `run-${loop.runs.length + 1}`,
		workId: `p1-w${index + 1}`,
		workDigest: workDigest(work),
		purposeRevision: 1,
		state,
		settlement,
	} as LoopRun;
	loop.runs.push(entry);
	return entry;
}

describe("due triggers", () => {
	it("are empty before a plan is agreed", () => {
		expect(dueTriggers(emptyPlan(), loopWithPurpose(), 50_000)).toEqual([]);
	});

	it("include one cadence key per whole review period since the head was agreed", () => {
		const { plan, loop } = adoptedAt();
		expect(dueTriggers(plan, loop, 10_999)).toEqual([]);
		expect(dueTriggers(plan, loop, 11_000)).toEqual([{ kind: "cadence", key: "1:cadence:w1", subject: "w1" }]);
		expect(dueTriggers(plan, loop, 21_000).map((trigger) => trigger.key)).toEqual(["1:cadence:w2"]);
	});

	it("put a blocked run before a completed tactical, and completion before cadence", () => {
		const { plan, loop } = adoptedAt();
		run(loop, 0, { status: "blocked", reason: "retry_limit" }, "settled");
		expect(dueTriggers(plan, loop, 11_000).map((trigger) => trigger.key)).toEqual([
			"1:blocked:run-1",
			"1:cadence:w1",
		]);
		const done = adoptedAt();
		run(done.loop, 0, { status: "verified", observedAt: 1 }, "settled");
		run(done.loop, 1, { status: "verified", observedAt: 2 }, "settled");
		expect(dueTriggers(done.plan, done.loop, 2_000).map((trigger) => trigger.key)).toEqual(["1:completed:weekly"]);
	});

	it("include runs-low when four or fewer of the 32 lifetime runs remain", () => {
		const { plan, loop } = adoptedAt();
		for (let i = 0; i < 28; i++) run(loop, 0, { status: "aborted" }, "settled");
		expect(dueTriggers(plan, loop, 2_000).map((trigger) => trigger.kind)).toContain("runs-low");
	});

	it("include deadline-near when under a fifth of the time is left with under half the works verified", () => {
		const plan = emptyPlan();
		agreePlan(authority(), plan, planTerms({ tacticals: [runnable({ deadlineAt: 11_000 })] }), 1_000);
		const loop = loopWithPurpose(["a", "b"]);
		expect(dueTriggers(plan, loop, 8_000)).toEqual([]);
		expect(dueTriggers(plan, loop, 9_500).map((trigger) => trigger.key)).toEqual(["1:deadline-near:weekly"]);
	});

	it("leave out keys already used", () => {
		const { plan, loop } = adoptedAt();
		plan.reviewKeys.push("1:cadence:w1");
		expect(dueTriggers(plan, loop, 11_000)).toEqual([]);
	});
});

describe("review notes", () => {
	it("are deterministic and end in no-change when nothing needs attention", () => {
		const { plan, loop } = adoptedAt();
		const head = plan.agreed[0]!;
		const trigger = dueTriggers(plan, loop, 11_000)[0]!;
		const note = reviewNote(plan, head, loop, trigger, 11_000);
		expect(reviewNote(plan, head, loop, trigger, 11_000)).toEqual(note);
		expect(note).toMatchObject({
			key: "1:cadence:w1",
			planRevision: 1,
			planDigest: head.digest,
			window: { from: 1_000, to: 11_000 },
			outcome: "no-change",
			disposition: null,
		});
		expect(note.items.map((item) => [item.id, item.level, item.status])).toEqual([
			["reports", "strategic", "on-track"],
			["weekly", "tactical", "on-track"],
			["readme", "tactical", "planned"],
		]);
		expect(note.facts).toMatchObject({ runsUsed: 0, runsLimit: 32, maxCycles: 6, maxRequests: 6 });
		expect(note.uncertainty).toContain("Planned tacticals have no host verifier; their progress is not observed.");
	});

	it("need attention and list the run when effects are unsettled", () => {
		const { plan, loop } = adoptedAt();
		run(loop, 0, { status: "blocked", reason: "unknown_request_outcome" }, "unsettled");
		const note = reviewNote(plan, plan.agreed[0]!, loop, dueTriggers(plan, loop, 2_000)[0]!, 2_000);
		expect(note.outcome).toBe("attention");
		expect(note.items.find((item) => item.id === "weekly")).toMatchObject({
			status: "blocked",
			blockReasons: ["unknown_request_outcome"],
			unsettled: 1,
			runIds: ["run-1"],
		});
		expect(note.uncertainty).toContain("Run run-1 has effects of unknown outcome.");
	});
});

describe("storing reviews", () => {
	it("stores the most urgent due trigger once and returns it again for the same request ID", () => {
		const { plan, loop } = adoptedAt();
		const first = storeReview(plan, loop, "review-1", 11_000);
		expect(first.key).toBe("1:cadence:w1");
		expect(storeReview(plan, loop, "review-1", 12_000)).toEqual(first);
		expect(plan.reviews).toHaveLength(1);
		expect(dueTriggers(plan, loop, 12_000)).toEqual([]);
	});

	it("uses an owner trigger when nothing is due, distinct per request", () => {
		const { plan, loop } = adoptedAt();
		const a = storeReview(plan, loop, "review-a", 2_000);
		const b = storeReview(plan, loop, "review-b", 2_000);
		expect([a.trigger.kind, b.trigger.kind]).toEqual(["owner", "owner"]);
		expect(a.reviewId).not.toBe(b.reviewId);
	});

	it("refuses before a plan is agreed", () => {
		expect(() => storeReview(emptyPlan(), loopWithPurpose(), "review-1", 1)).toThrow(MissionRefusal);
	});

	it("keeps at most 12 notes while a used key never fires again", () => {
		const { plan, loop } = adoptedAt();
		for (let i = 1; i <= 14; i++) storeReview(plan, loop, `review-${i}`, 1_000 + i * 10_000);
		expect(plan.reviews).toHaveLength(12);
		expect(plan.reviewKeys).toContain("1:cadence:w1");
		expect(dueTriggers(plan, loop, 141_000).map((trigger) => trigger.key)).not.toContain("1:cadence:w1");
	});

	it("refuses a request ID whose note was evicted instead of storing a second note under it", () => {
		const { plan, loop } = adoptedAt();
		for (let i = 1; i <= 13; i++) storeReview(plan, loop, `review-${i}`, 2_000);
		expect(plan.reviews.some((note) => note.trigger.subject === "review-1")).toBe(false);
		expect(() => storeReview(plan, loop, "review-1", 2_000)).toThrow(MissionRefusal);
		expect(plan.reviews).toHaveLength(12);
	});

	it("dismissal records a disposition and changes no terms", () => {
		const { plan, loop } = adoptedAt();
		const terms = structuredClone(plan.agreed[0]!.terms);
		const note = storeReview(plan, loop, "review-1", 11_000);
		dismissReview(plan, note.reviewId, 12_000);
		dismissReview(plan, note.reviewId, 13_000);
		expect(plan.reviews[0]!.disposition).toEqual({ kind: "dismissed", at: 12_000, draftRevision: null });
		expect(plan.agreed[0]!.terms).toEqual(terms);
		expect(() => dismissReview(plan, "review-gone", 1)).toThrow(MissionRefusal);
	});
});
