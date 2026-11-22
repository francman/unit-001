// Verifies review terms extend the protected digest without changing older agreements.
import { describe, expect, it } from "vitest";
import { planDigest } from "../../src/missions/plan-authority.ts";
import type { PlanTerms } from "../../src/missions/plan-terms.ts";

const authority = {
	installationId: null,
	session: "default",
	revision: 1,
	creator: { kind: "human", id: "creator", uid: 501 },
} as const;
const terms: PlanTerms = {
	overall: {
		purpose: "Maintain reports",
		scope: "Workspace",
		askFirst: [],
		reviewEveryMs: 1000,
		reviewAllowance: null,
	},
	strategics: [],
	tacticals: [],
};

describe("mission plan digest", () => {
	it("preserves the slice-1 digest when the review allowance is disabled", () => {
		expect(planDigest(terms, "mission-1", 1, null, authority)).toBe(
			"57cb07a7b2b957dc8f576ba5bb4b31513148ccfcdb93216d3bd29fe4bd635fea",
		);
	});

	it("binds every approved review allowance field with a fixed key order", () => {
		const approved = { maxRequests: 10, maxRequestsPerReview: 2, maxEstimatedCost: 0.25 };
		const digest = (reviewAllowance: PlanTerms["overall"]["reviewAllowance"]) =>
			planDigest({ ...terms, overall: { ...terms.overall, reviewAllowance } }, "mission-1", 1, null, authority);

		expect(digest({ maxEstimatedCost: 0.25, maxRequestsPerReview: 2, maxRequests: 10 })).toBe(digest(approved));
		for (const allowance of [
			null,
			{ ...approved, maxRequests: 11 },
			{ ...approved, maxRequestsPerReview: 3 },
			{ ...approved, maxEstimatedCost: 0.5 },
		])
			expect(digest(allowance)).not.toBe(digest(approved));
	});
});
