// #72: A stored plan counts only as exactly what its receipts agreed, chained revision by revision.
import { describe, expect, it } from "vitest";
import type { Tx } from "@earendil-works/pi-durable";
import { checkPlanState, MAX_REVIEWS, saveReview, storedPlan } from "../../src/missions/plan-state.ts";
import { reviewNote } from "../../src/missions/plan-review.ts";
import { agreePlan, authority, emptyPlan, loopWithPurpose, planTerms } from "./fixtures/plan.ts";

function twoRevisions() {
	const auth = authority();
	const plan = emptyPlan();
	agreePlan(auth, plan, planTerms());
	agreePlan(auth, plan, planTerms({ overall: { ...planTerms().overall, scope: "Wider" } }));
	return plan;
}

describe("stored plan validation", () => {
	it("accepts the empty plan and agreed revisions that rebuild from their receipts", () => {
		expect(checkPlanState(emptyPlan())).toEqual(emptyPlan());
		expect(() => checkPlanState(twoRevisions())).not.toThrow();
	});

	it("refuses tampered terms, a broken predecessor chain and a revision counter that ran backwards", () => {
		const tampered = twoRevisions();
		tampered.agreed[1]!.terms.overall.scope = "Everything";
		expect(() => checkPlanState(tampered)).toThrow("Invalid stored plan agreement");
		const chain = twoRevisions();
		chain.agreed.reverse();
		expect(() => checkPlanState(chain)).toThrow();
		const counter = twoRevisions();
		counter.nextRevision = 2;
		expect(() => checkPlanState(counter)).toThrow("revision counter");
	});

	it("refuses a revision agreed for another mission", () => {
		const plan = twoRevisions();
		plan.missionId = "other";
		expect(() => checkPlanState(plan)).toThrow("history");
	});
});

describe("reading the plan inside a commit", () => {
	it("returns undefined instead of throwing when the document cannot be read, so a restrictive commit still lands", async () => {
		// As Durable does for a document version newer than this release knows.
		const tx = { doc: () => Promise.reject(new Error("Unsupported document version 2.")) } as unknown as Tx;
		await expect(storedPlan(tx)).resolves.toBeUndefined();
		const forged = { doc: async () => ({ ...twoRevisions(), nextRevision: 1 }) } as unknown as Tx;
		await expect(storedPlan(forged)).resolves.toBeUndefined();
	});
});

describe("malformed saved rows", () => {
	it("refuses a saved review note with extra or malformed fields", () => {
		const plan = twoRevisions();
		const head = plan.agreed.at(-1)!;
		const trigger = { kind: "owner" as const, key: "2:owner:r1", subject: "r1" };
		saveReview(plan, reviewNote(plan, head, loopWithPurpose(), trigger, 1), "r1");
		expect(() => checkPlanState(plan)).not.toThrow();
		const extra = structuredClone(plan);
		(extra.reviews[0] as unknown as Record<string, unknown>).html = "<b>";
		expect(() => checkPlanState(extra)).toThrow();
		const status = structuredClone(plan);
		(status.reviews[0]!.items[0] as unknown as Record<string, unknown>).status = "great";
		expect(() => checkPlanState(status)).toThrow();
		const request = structuredClone(plan);
		request.reviewRequests[0] = { requestId: "r1" } as never;
		expect(() => checkPlanState(request)).toThrow("review request");
	});

	it("refuses a draft that is not exactly its closed shape", () => {
		const plan = twoRevisions();
		plan.draft = {
			revision: 3,
			baseRevision: 2,
			status: "editing",
			terms: planTerms(),
			digest: null,
			savedBy: "owner",
			fromReview: null,
			requestId: "d3",
		};
		plan.nextRevision = 4;
		expect(() => checkPlanState(plan)).not.toThrow();
		expect(() => checkPlanState({ ...plan, draft: { ...plan.draft!, status: "proposed" } })).toThrow("draft");
		expect(() => checkPlanState({ ...plan, draft: { ...plan.draft!, savedBy: "root" as never } })).toThrow("draft");
		expect(() => checkPlanState({ ...plan, draft: { ...plan.draft!, extra: 1 } as never })).toThrow("draft");
	});
});

describe("saved reviews", () => {
	it("keep the newest notes within the bound", () => {
		const plan = twoRevisions();
		const head = plan.agreed.at(-1)!;
		for (let i = 0; i < MAX_REVIEWS + 2; i++) {
			const trigger = { kind: "owner" as const, key: `2:owner:r${i}`, subject: `r${i}` };
			saveReview(plan, reviewNote(plan, head, loopWithPurpose(), trigger, i), `r${i}`);
		}
		expect(plan.reviews).toHaveLength(MAX_REVIEWS);
		expect(plan.reviews[0]!.key).toBe("2:owner:r2");
		expect(() => checkPlanState(plan)).not.toThrow();
	});
});
