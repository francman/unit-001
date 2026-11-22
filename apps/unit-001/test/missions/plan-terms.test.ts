// #72: Mission plan terms parse as closed, bounded shapes and propose only with valid ancestry and one exact binding.
import { describe, expect, it } from "vitest";
import { missingPlanTerms, type PlanTerms, parsePlanTerms, planTermsDenial } from "../../src/missions/plan-terms.ts";
import { loopWithPurpose, planned, planTerms, runnable } from "./fixtures/plan.ts";

describe("parsing plan terms", () => {
	it("accepts a complete plan and returns the same terms", () => {
		const terms = planTerms();
		expect(parsePlanTerms(JSON.parse(JSON.stringify(terms)))).toEqual(terms);
	});

	it("refuses unknown and missing fields instead of defaulting them", () => {
		expect(() => parsePlanTerms({ ...planTerms(), extra: 1 })).toThrow("needs exactly");
		const { binding: _binding, ...partial } = runnable();
		expect(() => parsePlanTerms(planTerms({ tacticals: [partial as never] }))).toThrow("needs exactly");
	});

	it("caps strategics at 3 and tacticals at 6", () => {
		const strategic = planTerms().strategics[0]!;
		const four = [1, 2, 3, 4].map((n) => ({ ...strategic, id: `s${n}` }));
		expect(() => parsePlanTerms(planTerms({ strategics: four }))).toThrow("at most 3 strategics");
		const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => planned({ id: `t${n}` }));
		expect(() => parsePlanTerms(planTerms({ tacticals: seven }))).toThrow("at most 6 tacticals");
	});

	it("needs slug IDs, known modes and priorities, and an exact binding digest", () => {
		expect(() => parsePlanTerms(planTerms({ tacticals: [planned({ id: "Bad ID" })] }))).toThrow("slugs");
		expect(() => parsePlanTerms(planTerms({ tacticals: [planned({ mode: "auto" as never })] }))).toThrow("mode");
		expect(() => parsePlanTerms(planTerms({ tacticals: [planned({ priority: "urgent" as never })] }))).toThrow(
			"priority",
		);
		const loose = runnable({ binding: { missionId: "m", purposeRevision: 1, purposeDigest: "short" } });
		expect(() => parsePlanTerms(planTerms({ tacticals: [loose] }))).toThrow("exact purpose digest");
	});
});

describe("missing plan terms", () => {
	it("lists what a draft still needs and nothing for a complete one", () => {
		expect(missingPlanTerms(planTerms())).toEqual([]);
		const terms: PlanTerms = planTerms({
			overall: { purpose: " ", scope: "", askFirst: [], reviewEveryMs: 0, reviewAllowance: null },
			tacticals: [planned({ objective: "" })],
		});
		expect(missingPlanTerms(terms)).toEqual(["purpose", "scope", "review cadence", "tactical readme"]);
	});
});

describe("proposal checks", () => {
	it("accepts a plan whose runnable tactical binds an exact agreed purpose", () => {
		expect(planTermsDenial(planTerms(), loopWithPurpose())).toBeUndefined();
	});

	it("refuses duplicate IDs, orphans and more than one runnable", () => {
		const loop = loopWithPurpose();
		expect(planTermsDenial(planTerms({ tacticals: [runnable(), planned({ id: "weekly" })] }), loop)).toMatch(
			"distinct",
		);
		expect(planTermsDenial(planTerms({ tacticals: [planned({ strategic: "gone" })] }), loop)).toMatch("names no");
		expect(planTermsDenial(planTerms({ tacticals: [runnable(), runnable({ id: "second" })] }), loop)).toMatch(
			"one tactical",
		);
	});

	it("binds only runnable tacticals, and the binding must name the exact agreed purpose", () => {
		const loop = loopWithPurpose();
		expect(planTermsDenial(planTerms({ tacticals: [runnable({ binding: null })] }), loop)).toMatch("must");
		const parkedBound = runnable({ mode: "parked" });
		expect(planTermsDenial(planTerms({ tacticals: [parkedBound] }), loop)).toMatch("only a runnable");
		const wrong = runnable({ binding: { ...runnable().binding!, purposeDigest: "c".repeat(64) } });
		expect(planTermsDenial(planTerms({ tacticals: [wrong] }), loop)).toMatch("exact agreed purpose");
		expect(planTermsDenial(planTerms(), undefined)).toMatch("exact agreed purpose");
	});
});
