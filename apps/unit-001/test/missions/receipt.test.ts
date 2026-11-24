// Pins the receipt rule every approval kind shares. Before it was shared, the one-shot, purpose and plan matchers each
// checked the approver differently (rv-missions-6); the "approver" cases below are the ones the old copies disagreed on.
import { describe, expect, it } from "vitest";
import { matchingApproval, missionDigest } from "../../src/missions/authority.ts";
import type { MissionApproval, MissionAuthority, MissionTerms } from "../../src/missions/contract.ts";
import { matchingPlanApproval } from "../../src/missions/plan-authority.ts";
import { matchingPurposeApproval, purposeDigest } from "../../src/missions/purpose-authority.ts";
import { creatorApproved, developerReceipt, receiptBinds } from "../../src/missions/receipt.ts";
import { agreePlan, emptyPlan, loopWithPurpose, MISSION, authority as planAuthority, planTerms } from "./fixtures/plan.ts";

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const CREATOR = { kind: "human" as const, id: "creator", uid: 1001 };
const ONE_SHOT: MissionTerms = {
	objective: "Inspect a fixture",
	scope: "Read the supplied fixture only",
	successCriteria: ["Report the source evidence"],
	policy: { allowedTools: ["read"], maxCycles: 1, maxRequests: 1, maxRetries: 0, maxConsecutiveNoProgress: 1, deadlineAt: 9000 },
	approvalBoundary: [],
	reviewEveryMs: 1000,
};
const PURPOSE = loopWithPurpose().agreements[0].terms;

type Approver = MissionApproval["approvedBy"];

function host(managed: boolean): MissionAuthority {
	return { ...planAuthority(), installationId: managed ? INSTALLATION : null, creator: CREATOR };
}

function receipt(authority: MissionAuthority, digest: string, approvedBy: Approver): MissionApproval {
	return {
		receiptId: "r",
		requestId: "q",
		installationId: authority.installationId,
		session: "default",
		missionId: MISSION,
		revision: 1,
		digest,
		creator: authority.creator,
		authorityRevision: authority.revision,
		approvedAt: 1,
		provenance: authority.installationId === null ? "developer-local" : "managed-administrator",
		approvedBy,
	};
}

// Each kind's matcher on a receipt with exactly this approver and otherwise exact binding.
function oneShot(managed: boolean, approvedBy: Approver): boolean {
	const authority = host(managed);
	authority.approvals = [receipt(authority, missionDigest(ONE_SHOT, MISSION, 1, authority), approvedBy)];
	return matchingApproval(authority, "r", MISSION, 1, ONE_SHOT) !== undefined;
}

function purpose(managed: boolean, approvedBy: Approver): boolean {
	const authority = host(managed);
	authority.purposeApprovals = [receipt(authority, purposeDigest(PURPOSE, MISSION, 1, authority), approvedBy)];
	return matchingPurposeApproval(authority, "r", MISSION, 1, PURPOSE) !== undefined;
}

function plan(managed: boolean, approvedBy: Approver): boolean {
	const authority = host(managed);
	const head = agreePlan(authority, emptyPlan(), planTerms());
	const issued = authority.planApprovals![0];
	authority.planApprovals = [
		{ ...issued, installationId: authority.installationId, provenance: managed ? "managed-administrator" : "developer-local", approvedBy },
	];
	return matchingPlanApproval(authority, issued.receiptId, MISSION, head.revision, null, head.terms) !== undefined;
}

describe("shared receipt binding", () => {
	it("binds the authority epoch, provenance, creator and the exact expected terms", () => {
		const authority = host(false);
		const exact = receipt(authority, "d".repeat(64), { kind: "developer-local", uid: CREATOR.uid });
		const expected = { receiptId: "r", missionId: MISSION, revision: 1, digest: "d".repeat(64) };
		expect(receiptBinds(authority, exact, expected)).toBe(true);
		for (const changed of [
			{ ...exact, receiptId: "other" },
			{ ...exact, session: "other" },
			{ ...exact, missionId: "other" },
			{ ...exact, revision: 2 },
			{ ...exact, digest: "e".repeat(64) },
			{ ...exact, authorityRevision: 2 },
			{ ...exact, installationId: INSTALLATION },
			{ ...exact, provenance: "managed-administrator" as const },
			{ ...exact, creator: { ...CREATOR, uid: 1002 } },
			{ ...exact, creator: { ...CREATOR, id: "someone" } },
		])
			expect(receiptBinds(authority, changed, expected)).toBe(false);
	});

	it("names the creator's own assent by the creator's UID and the provenance's actor kind", () => {
		for (const managed of [false, true]) {
			const authority = host(managed);
			const kind = managed ? "local-creator" : "developer-local";
			const approval = (approvedBy: Approver) => creatorApproved(authority, receipt(authority, "d".repeat(64), approvedBy));
			expect(approval({ kind, uid: CREATOR.uid })).toBe(true);
			expect(approval({ kind, uid: 0 })).toBe(false);
			expect(approval({ kind: "host-administrator", uid: CREATOR.uid })).toBe(false);
		}
	});

	it("builds a developer-local receipt from the current authority epoch and this OS user", () => {
		const authority = host(false);
		const built = developerReceipt(authority, { requestId: "q", missionId: MISSION, revision: 1, digest: "d".repeat(64) }, 7);
		expect(built).toEqual({
			...receipt(authority, "d".repeat(64), { kind: "developer-local", uid: process.getuid?.() ?? null }),
			receiptId: built.receiptId,
			approvedAt: 7,
		});
		expect(built.receiptId).not.toBe(developerReceipt(authority, built, 7).receiptId);
	});
});

describe("approver rule per kind", () => {
	it("refuses a managed local-creator receipt with another UID for every kind", () => {
		// The one-shot matcher once accepted this one; purpose and plan refused it.
		const wrong = { kind: "local-creator" as const, uid: 2002 };
		expect([oneShot(true, wrong), purpose(true, wrong), plan(true, wrong)]).toEqual([false, false, false]);
		const own = { kind: "local-creator" as const, uid: CREATOR.uid };
		expect([oneShot(true, own), purpose(true, own), plan(true, own)]).toEqual([true, true, true]);
	});

	it("refuses a developer-local receipt from another UID for every kind", () => {
		// The one-shot and purpose matchers once accepted this one; plan refused it.
		const wrong = { kind: "developer-local" as const, uid: 2002 };
		expect([oneShot(false, wrong), purpose(false, wrong), plan(false, wrong)]).toEqual([false, false, false]);
		const own = { kind: "developer-local" as const, uid: CREATOR.uid };
		expect([oneShot(false, own), purpose(false, own), plan(false, own)]).toEqual([true, true, true]);
	});

	it("accepts the host administrator's own approval only for a managed one-shot mission", () => {
		// Decided: `mission approve` from a non-creator administrator issues a host-administrator receipt.
		const administrator = { kind: "host-administrator" as const, uid: 0 };
		expect([oneShot(true, administrator), purpose(true, administrator), plan(true, administrator)]).toEqual([
			true,
			false,
			false,
		]);
	});
});
