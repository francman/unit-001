// #72: The plan gate only restricts: once adopted, admission needs the protected head, its binding and a plan-bound open.
import { describe, expect, it } from "vitest";
import type { MissionAuthority } from "../../src/missions/contract.ts";
import { planReceiptsRecorded } from "../../src/missions/plan-authority.ts";
import { planGate } from "../../src/missions/plan-gate.ts";
import type { PlanState } from "../../src/missions/plan-state.ts";
import type { LoopState } from "../../src/missions/purpose-loop.ts";
import { agreePlan, authority, emptyPlan, loopWithPurpose, MISSION, PURPOSE_DIGEST, planTerms } from "./fixtures/plan.ts";

function openLoop(): LoopState {
	const loop = loopWithPurpose();
	loop.operation.state = { status: "open", purposeRevision: 1, purposeDigest: PURPOSE_DIGEST, sequence: 1 };
	return loop;
}

function openIntent(auth: MissionAuthority, planDigest?: string): void {
	auth.operationIntent = {
		requestId: "open-1",
		sequence: 1,
		missionId: MISSION,
		purposeRevision: 1,
		purposeDigest: PURPOSE_DIGEST,
		authorityRevision: 1,
		expectedOperationRevision: 0,
		action: "open",
		issuedAt: 1,
		...(planDigest === undefined ? {} : { planDigest }),
	};
}

function adopted(): { auth: MissionAuthority; plan: PlanState; loop: LoopState } {
	const auth = authority();
	const plan = emptyPlan();
	const head = agreePlan(auth, plan, planTerms());
	openIntent(auth, head.digest);
	return { auth, plan, loop: openLoop() };
}

describe("before adoption", () => {
	it("stays off without receipts or agreed revisions, so legacy operation is unchanged", () => {
		const auth = authority();
		openIntent(auth);
		expect(planGate(auth, emptyPlan(), openLoop())).toBe("not-adopted");
	});

	it("closes in the crash window: a protected receipt exists but the owner has not recorded it", () => {
		const auth = authority();
		agreePlan(auth, emptyPlan(), planTerms());
		expect(planGate(auth, emptyPlan(), openLoop())).toBe("head-missing");
	});

	it("treats a retained request record as adoption even when a rotation cleared the receipts", () => {
		const auth = authority();
		agreePlan(auth, emptyPlan(), planTerms());
		const rotated = { ...auth, revision: 2, planApprovals: undefined };
		expect(planGate(rotated, emptyPlan(), openLoop())).toBe("head-missing");
	});

	it("closes when the stored plan failed validation", () => {
		expect(planGate(authority(), undefined, openLoop())).toBe("head-missing");
	});
});

describe("after adoption", () => {
	it("is open for an open issued under the exact head whose runnable binds the open purpose", () => {
		const { auth, plan, loop } = adopted();
		expect(planGate(auth, plan, loop)).toBe("open");
	});

	it("needs a fresh open after every newly agreed revision; the older open never arms it", () => {
		const { auth, plan, loop } = adopted();
		const next = agreePlan(auth, plan, planTerms({ overall: { ...planTerms().overall, scope: "Wider" } }));
		expect(planGate(auth, plan, loop)).toBe("reopen-needed");
		openIntent(auth, next.digest);
		expect(planGate(auth, plan, loop)).toBe("open");
	});

	it("closes on an open without a plan digest, as an older writer would issue", () => {
		const { auth, plan, loop } = adopted();
		openIntent(auth);
		expect(planGate(auth, plan, loop)).toBe("reopen-needed");
	});

	it("closes when a newer protected receipt is not recorded yet", () => {
		const { auth, plan, loop } = adopted();
		agreePlan(auth, structuredClone(plan), planTerms({ tacticals: [] }));
		expect(planGate(auth, plan, loop)).toBe("receipt");
	});

	it("closes when a legacy writer dropped the receipts or the request bindings", () => {
		const { auth, plan, loop } = adopted();
		expect(planGate({ ...auth, planApprovals: undefined }, plan, loop)).toBe("receipt");
		const unbound = { ...auth, planRequests: undefined };
		expect(planReceiptsRecorded(unbound)).toBe(false);
		expect(planGate(unbound, plan, loop)).toBe("receipt");
	});

	it("closes when any recorded revision lost its protected request binding, not only the retained tail", () => {
		const { auth, plan, loop } = adopted();
		const second = agreePlan(auth, plan, planTerms({ overall: { ...planTerms().overall, scope: "Two" } }));
		const third = agreePlan(auth, plan, planTerms({ overall: { ...planTerms().overall, scope: "Three" } }));
		openIntent(auth, third.digest);
		expect(second.revision).toBe(2);
		expect(planGate(auth, plan, loop)).toBe("open");
		expect(planGate({ ...auth, planRequests: auth.planRequests!.slice(1) }, plan, loop)).toBe("receipt");
	});

	it("closes when the head binds another purpose, or has no runnable tactical", () => {
		const auth = authority();
		const plan = emptyPlan();
		const head = agreePlan(auth, plan, planTerms({ tacticals: [] }));
		openIntent(auth, head.digest);
		expect(planGate(auth, plan, openLoop())).toBe("binding");
		const loop = openLoop();
		loop.operation.state = { status: "open", purposeRevision: 2, purposeDigest: "d".repeat(64), sequence: 1 };
		expect(planGate(adopted().auth, adopted().plan, loop)).toBe("binding");
	});

	it("reports a closed operation as needing an open when the head binds an agreed purpose", () => {
		const { auth, plan } = adopted();
		expect(planGate(auth, plan, loopWithPurpose())).toBe("reopen-needed");
	});
});
