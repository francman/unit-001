// Raising an owner plan limit once moves the owner wire and the page together; the page keeps no private copy.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/missions/plan-limits.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/missions/plan-limits.ts")>()),
	MAX_REVIEW_TURNS: 32,
}));

const { parsePlanView: parsePagePlan } = await import("../../web/mission-plan.ts");
const { parsePlanView: parseOwnerPlan } = await import("../../src/missions/plan-wire.ts");
const { planTerms } = await import("./fixtures/plan.ts");

describe("raised review turn limit", () => {
	it("is accepted by the owner wire and the page, and 33 turns still fail both", () => {
		const digest = "a".repeat(64);
		const turn = (index: number) => ({
			key: `1:turn:${index}`,
			planRevision: 1,
			trigger: { kind: "owner", key: `1:owner:${index}`, subject: null },
			state: "running",
			reason: null,
			reviewId: null,
			draftRevision: null,
			requests: 0,
			at: 1,
		});
		const view = (turns: number) => ({
			missionId: "mission-1",
			adopted: true,
			head: { revision: 1, digest, previousDigest: null, terms: planTerms(), agreedAt: 1, receiptId: "receipt-1" },
			headValid: true,
			previous: null,
			history: [{ revision: 1, digest, agreedAt: 1 }],
			draft: null,
			gate: { state: "open", reason: null },
			runs: { used: 0, limit: 32 },
			due: [],
			preview: null,
			reviews: [],
			allowance: null,
			turns: Array.from({ length: turns }, (_, index) => turn(index)),
			blocker: null,
		});
		expect(parseOwnerPlan(view(32)).turns).toHaveLength(32);
		expect(parsePagePlan(view(32)).turns).toHaveLength(32);
		expect(() => parseOwnerPlan(view(33))).toThrow();
		expect(() => parsePagePlan(view(33))).toThrow();
	});
});
