// The managed browser agreement helper: exact arguments, the creator only, protected compare-and-swap and replay.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_ISSUED_AGREEMENTS, missionDigest, parseMissionAuthority } from "../../src/missions/authority.ts";
import {
	type AgreementClick,
	type AgreementHost,
	agreementActor,
	agreementInvocation,
	agreementReview,
	browserAgreementArmed,
	formatAgreementOutcome,
	issueBrowserAgreement,
	lookupIssuedAgreement,
	parseAgreementArguments,
	parseAgreementOutcome,
} from "../../src/missions/browser-agreement.ts";
import type {
	BrowserAgreementGrant,
	MissionAgreement,
	MissionAuthority,
	MissionDraft,
	MissionRequest,
	MissionTerms,
	MissionView,
} from "../../src/missions/contract.ts";

const installationId = "11111111-1111-4111-8111-111111111111";
const missionId = "22222222-2222-4222-8222-222222222222";
const creatorUid = 1000;
const serviceUid = 990;
const now = 1_000_000;
const grant = (overrides: Partial<BrowserAgreementGrant> = {}): BrowserAgreementGrant => ({
	enabled: true,
	creatorUid,
	serviceUid,
	authorityRevision: 3,
	generation: 1,
	issued: [],
	...overrides,
});
const terms: MissionTerms = {
	objective: "Keep the docs current",
	scope: "docs/ only",
	successCriteria: ["Docs build"],
	policy: {
		allowedTools: ["read"],
		maxCycles: 2,
		maxRequests: 4,
		maxRetries: 1,
		maxConsecutiveNoProgress: 2,
		deadlineAt: now + 5000,
	},
	approvalBoundary: [],
	reviewEveryMs: 1000,
};

function authority(overrides: Partial<MissionAuthority> = {}): MissionAuthority {
	return {
		schemaVersion: 1,
		installationId,
		session: "default",
		revision: 3,
		creator: { kind: "human", id: "owner", uid: creatorUid },
		ceiling: {
			allowedTools: ["read"],
			maxCycles: 3,
			maxRequests: 5,
			maxRetries: 1,
			maxConsecutiveNoProgress: 2,
			maxDurationMs: 10_000,
		},
		approvals: [],
		browserAgreement: grant(),
		...overrides,
	};
}

function proposal(revision: number, saved: MissionAuthority): MissionDraft {
	return { missionId, revision, status: "proposed", terms, digest: missionDigest(terms, missionId, revision, saved) };
}

function fixture(saved = authority(), revision = 4) {
	const state = {
		authority: saved as MissionAuthority | null,
		draft: proposal(revision, saved) as MissionDraft | null,
		agreed: null as MissionAgreement | null,
		/** What a lying owner reports as the agreed terms after reconciling. */
		reportedTerms: terms,
		execution: "not-implemented" as MissionView["execution"],
		held: false,
		writes: 0,
		failWrite: false,
		failStatus: false,
		failReconcile: false,
		ownerCalls: [] as string[],
		heldSignals: [] as AbortSignal[],
		ids: 0,
		clock: now,
	};
	const view = (): MissionView => ({
		stage: state.draft ? "awaiting_approval" : "agreed",
		formation: { nextRevision: 9, draft: state.draft, agreement: state.agreed, lastOperation: null },
		creator: saved.creator,
		authority: "managed-administrator",
		authorityError: null,
		agreementValid: state.agreed !== null,
		missing: [],
		execution: state.execution,
		runtime: state.execution === "running" ? ({ status: "running" } as MissionView["runtime"]) : null,
		tools: ["read"],
	});
	// The real management lock serializes protected writers; this one does too, so concurrent clicks interleave as on a host.
	let tail = Promise.resolve();
	const host: AgreementHost = {
		installationId,
		serviceUid,
		lock: (signal, work) => {
			const run = tail.then(() => {
				signal.throwIfAborted();
				return work();
			});
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
		readAuthority: async () => state.authority,
		writeAuthority: async (next) => {
			if (state.failWrite) throw new Error("rename interrupted");
			// Round-trip through the protected parser, as the next reader would.
			state.authority = parseMissionAuthority(JSON.parse(JSON.stringify(next)));
			state.writes++;
		},
		held: async (signal) => {
			state.heldSignals.push(signal);
			return state.held;
		},
		owner: async (request) => {
			state.ownerCalls.push(request.operation);
			if (request.operation === "status") {
				if (state.failStatus) throw new Error("owner unavailable");
				return view();
			}
			if (request.operation !== "reconcile" || state.failReconcile) throw new Error("owner unavailable");
			const approval = state.authority!.approvals.find((item) => item.receiptId === request.receiptId)!;
			state.agreed = {
				missionId: approval.missionId,
				revision: approval.revision,
				terms: state.reportedTerms,
				digest: approval.digest,
				approval,
				execution: "not-implemented",
			};
			state.draft = null;
			return view();
		},
		now: () => state.clock,
		receiptId: () => `33333333-3333-4333-8333-${String(state.ids++).padStart(12, "0")}`,
	};
	const click = (overrides: Partial<AgreementClick> = {}): AgreementClick => ({
		revision: revision,
		digest: state.draft?.digest ?? "0".repeat(64),
		requestId: "click-1",
		previousReceipt: null,
		...overrides,
	});
	const issue = (request: AgreementClick, actor: number | null = creatorUid, deadline = now + 1000) =>
		issueBrowserAgreement(request, actor, host, deadline);
	return { state, host, click, issue, view };
}

describe("helper arguments", () => {
	const digest = "a".repeat(64);
	const argv = ["--revision", "4", "--digest", digest, "--request-id", "click-1", "--previous-receipt", "none"];

	it("parses exactly the four canonical options", () => {
		expect(parseAgreementArguments(argv)).toEqual({
			revision: 4,
			digest,
			requestId: "click-1",
			previousReceipt: null,
		});
		const previous = "33333333-3333-4333-8333-333333333330";
		expect(parseAgreementArguments([...argv.slice(0, 6), "--previous-receipt", previous]).previousReceipt).toBe(
			previous,
		);
	});

	it.each([
		["a duplicate", ["--revision", "4", "--revision", "4", "--request-id", "x", "--previous-receipt", "none"]],
		["an unknown option", [...argv.slice(0, 6), "--id", "none"]],
		["a missing option", argv.slice(0, 6)],
		["an extra positional", [...argv, "approve"]],
		["a non-canonical revision", ["--revision", "04", ...argv.slice(2)]],
		["revision zero", ["--revision", "0", ...argv.slice(2)]],
		["an uppercase digest", ["--revision", "4", "--digest", "A".repeat(64), ...argv.slice(4)]],
		["a request ID with separators", [...argv.slice(0, 4), "--request-id", "a b", ...argv.slice(6)]],
	])("rejects %s", (_name, args) => {
		expect(() => parseAgreementArguments(args)).toThrow();
	});
});

describe("helper actor", () => {
	const account = (uid: number) => (uid === creatorUid ? { name: "owner", uid } : null);

	it("accepts sudo's UID only when the account database agrees with its user name", () => {
		expect(agreementActor({ SUDO_UID: "1000", SUDO_USER: "owner" }, account)).toBe(creatorUid);
		expect(agreementActor({ SUDO_UID: "1000", SUDO_USER: "other" }, account)).toBeNull();
		expect(agreementActor({ SUDO_UID: "1001", SUDO_USER: "owner" }, account)).toBeNull();
		expect(agreementActor({ SUDO_UID: "0", SUDO_USER: "root" }, () => ({ name: "root", uid: 0 }))).toBeNull();
		expect(agreementActor({}, account)).toBeNull();
	});
});

describe("protected issuance", () => {
	it("publishes one creator receipt for the exact proposal and reconciles it", async () => {
		const { state, click, issue } = fixture();
		const outcome = await issue(click());
		expect(outcome).toEqual({
			status: "issued",
			receiptId: "33333333-3333-4333-8333-000000000000",
			reconciled: true,
		});
		expect(state.writes).toBe(1);
		expect(state.authority?.approvals).toEqual([
			expect.objectContaining({
				requestId: "click-1",
				revision: 4,
				provenance: "managed-administrator",
				approvedBy: { kind: "local-creator", uid: creatorUid },
				authorityRevision: 3,
			}),
		]);
		expect(state.authority?.browserAgreement?.issued).toEqual([
			expect.objectContaining({ requestId: "click-1", revision: 4, previousReceipt: null, issuedAt: now }),
		]);
	});

	it("is closed unless enabled for this creator and authority revision", async () => {
		for (const saved of [
			authority({ browserAgreement: grant({ enabled: false }) }),
			authority({ browserAgreement: grant({ creatorUid: 1001 }) }),
			// Creator rotation or a ceiling change bumps the revision and closes the old grant.
			authority({ revision: 4, browserAgreement: grant() }),
		]) {
			const { state, click, issue } = fixture(saved);
			expect(await issue(click())).toEqual({ status: "refused", code: "not-enabled" });
			expect(state.writes).toBe(0);
		}
	});

	it("never falls back to another account, replays included", async () => {
		const { state, click, issue } = fixture();
		expect(await issue(click(), null)).toEqual({ status: "refused", code: "creator-mismatch" });
		expect(await issue(click(), 0)).toEqual({ status: "refused", code: "creator-mismatch" });
		await issue(click());
		expect(await issue(click(), 1001)).toEqual({ status: "refused", code: "creator-mismatch" });
		expect(state.writes).toBe(1);
	});

	it("lets only the first of two competing tabs issue", async () => {
		const { state, click, issue } = fixture();
		// Both tabs rendered the same review before either clicked.
		const first = click({ requestId: "tab-a" });
		const second = click({ requestId: "tab-b" });
		expect((await issue(first)).status).toBe("issued");
		expect(await issue(second)).toEqual({ status: "refused", code: "stale-authority" });
		const current = state.authority!.approvals.at(-1)!.receiptId;
		expect(await issue({ ...second, previousReceipt: current })).toEqual({
			status: "refused",
			code: "already-issued",
		});
		expect(state.writes).toBe(1);
	});

	it("replays a request ID as its own receipt, refuses it with other terms, and reports it unknown once superseded", async () => {
		const { state, click, issue } = fixture();
		const request = click();
		const first = await issue(request);
		state.agreed = null;
		expect(await issue(request)).toEqual(first);
		expect(await issue({ ...request, digest: "b".repeat(64) })).toEqual({
			status: "refused",
			code: "conflicting-request",
		});
		expect(state.writes).toBe(1);
		// Issued, so never a refusal: a receipt another agreement replaced is unknown for the creator to inspect.
		const newer = {
			...state.authority!.approvals.at(-1)!,
			receiptId: "44444444-4444-4444-8444-444444444444",
			revision: 5,
		};
		state.authority = { ...state.authority!, approvals: [newer] };
		expect(await issue(request)).toEqual({ status: "unknown" });
		expect(state.writes).toBe(1);
	});

	it("refuses redrafted, misdigested, held and running proposals before writing", async () => {
		const redrafted = fixture();
		redrafted.state.draft = { ...redrafted.state.draft!, revision: 5 };
		expect(await redrafted.issue(redrafted.click({ revision: 4 }))).toEqual({
			status: "refused",
			code: "stale-revision",
		});
		const forged = fixture();
		expect(await forged.issue(forged.click({ digest: "c".repeat(64) }))).toEqual({
			status: "refused",
			code: "stale-digest",
		});
		// The service-owned draft can claim a digest; the helper recomputes it from protected authority.
		const lying = fixture();
		lying.state.draft = { ...lying.state.draft!, terms: { ...terms, scope: "everything" } };
		expect(await lying.issue(lying.click())).toEqual({ status: "refused", code: "stale-digest" });
		const held = fixture();
		held.state.held = true;
		expect(await held.issue(held.click())).toEqual({ status: "refused", code: "held" });
		const running = fixture();
		running.state.execution = "running";
		expect(await running.issue(running.click())).toEqual({ status: "refused", code: "execution-active" });
		const expired = fixture();
		expired.state.clock = now + 6000;
		expect(await expired.issue(expired.click(), creatorUid, now + 7000)).toEqual({
			status: "refused",
			code: "outside-authority",
		});
		for (const item of [redrafted, forged, lying, held, running, expired]) expect(item.state.writes).toBe(0);
	});

	it("reports a definite refusal before the write and unknown once it may have happened", async () => {
		const unreachable = fixture();
		unreachable.state.failStatus = true;
		expect(await unreachable.issue(unreachable.click())).toEqual({ status: "unknown" });
		const late = fixture();
		expect(await late.issue(late.click(), creatorUid, now)).toEqual({ status: "refused", code: "unavailable" });
		const interrupted = fixture();
		interrupted.state.failWrite = true;
		expect(await interrupted.issue(interrupted.click())).toEqual({ status: "unknown" });
		const pending = fixture();
		pending.state.failReconcile = true;
		const request = pending.click();
		expect(await pending.issue(request)).toMatchObject({ status: "issued", reconciled: false });
		// Delayed reconciliation: the same request ID later reconciles the same receipt without a second write.
		pending.state.failReconcile = false;
		expect(await pending.issue(request)).toMatchObject({ status: "issued", reconciled: true });
		expect(pending.state.writes).toBe(1);
	});

	it("serializes concurrent tabs under the lock: one receipt, the other refused before writing", async () => {
		const { state, click, issue } = fixture();
		const outcomes = await Promise.all([issue(click({ requestId: "tab-a" })), issue(click({ requestId: "tab-b" }))]);
		expect(outcomes.map((item) => item.status).sort()).toEqual(["issued", "refused"]);
		expect(outcomes).toContainEqual({ status: "refused", code: "stale-authority" });
		expect(state.writes).toBe(1);
		expect(state.authority?.browserAgreement?.issued).toHaveLength(1);
	});

	it("reports unknown when a published request cannot be looked up under the lock", async () => {
		const { state, host, click, issue } = fixture();
		const request = click();
		expect(await issue(request)).toMatchObject({ status: "issued" });
		const blocked = {
			...host,
			lock: <T>(signal: AbortSignal, _work: () => Promise<T>) =>
				new Promise<T>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				),
		};
		expect(await issueBrowserAgreement(request, creatorUid, blocked, now + 20)).toEqual({ status: "unknown" });
		const unreadable = {
			...host,
			readAuthority: async () => {
				throw new Error("protected record unavailable");
			},
		};
		expect(await issueBrowserAgreement(request, creatorUid, unreadable, now + 20)).toEqual({ status: "unknown" });
		const saved = state.authority!;
		for (const missing of [null, { ...saved, browserAgreement: undefined }]) {
			state.authority = missing;
			expect(await issue(request)).toEqual({ status: "unknown" });
		}
		expect(state.writes).toBe(1);
	});
});

// Review A3-1 and G1: once a request's receipt exists, no answer for that request is a definite refusal.
describe("issued receipts after a crash, restart or hold", () => {
	it("reads a published click after disable and requires agreement digest for reconciliation", async () => {
		const { state, view, click, issue } = fixture();
		const request = click();
		const requestId = createHash("sha256").update(request.requestId).digest("hex");
		const published = await issue({ ...request, requestId });
		expect(published).toMatchObject({ status: "issued", reconciled: true });
		expect(state.draft).toBeNull();
		const protectedRecord = state.authority!;
		const disabled = {
			...protectedRecord,
			browserAgreement: { ...protectedRecord.browserAgreement!, enabled: false },
		};
		expect(lookupIssuedAgreement(request, disabled, creatorUid, view())).toEqual(published);
		expect(lookupIssuedAgreement(request, null, creatorUid, view())).toEqual({ status: "unknown" });
		expect(lookupIssuedAgreement(request, disabled, serviceUid, view())).toEqual({ status: "unknown" });
		state.agreed = { ...state.agreed!, digest: "f".repeat(64) };
		expect(lookupIssuedAgreement(request, disabled, creatorUid, view())).toMatchObject({
			status: "issued",
			reconciled: false,
		});
		expect(
			lookupIssuedAgreement(request, { ...disabled, revision: disabled.revision + 1 }, creatorUid, view()),
		).toEqual({ status: "unknown" });
		expect(state.writes).toBe(1);
	});

	it("recovers a lost helper reply after the owner cleared the draft, without asking for it or writing again", async () => {
		const { state, click, issue } = fixture();
		const request = click();
		const first = await issue(request);
		// The helper's reply was lost; the owner reconciled and cleared the draft; the gateway restarted and retries.
		expect(state.draft).toBeNull();
		state.ownerCalls.length = 0;
		expect(await issue(request)).toEqual(first);
		expect(state.ownerCalls).toEqual(["reconcile"]);
		expect(state.writes).toBe(1);
	});

	it("reconciles a receipt whose helper crashed after publishing it, on replay", async () => {
		const { state, host, click, issue } = fixture();
		const request = click();
		// The crash boundary: the write committed, then the helper died before reconciling or answering.
		const crashed = {
			...host,
			owner: async (input: MissionRequest, signal: AbortSignal) => {
				if (input.operation === "reconcile") throw new Error("helper killed");
				return host.owner(input, signal);
			},
		};
		expect(await issueBrowserAgreement(request, creatorUid, crashed, now + 1000)).toMatchObject({
			reconciled: false,
		});
		expect(state.agreed).toBeNull();
		expect(await issue(request)).toMatchObject({ status: "issued", reconciled: true });
		expect(state.writes).toBe(1);
	});

	it("still answers a replay as issued after the grant was disabled", async () => {
		const { state, click, issue } = fixture();
		const request = click();
		const first = await issue(request);
		state.authority = {
			...state.authority!,
			browserAgreement: { ...state.authority!.browserAgreement!, enabled: false },
		};
		expect(await issue(request)).toEqual(first);
		expect(await issue(click({ requestId: "new" }))).toEqual({ status: "refused", code: "not-enabled" });
	});

	it("reports a replay unknown after creator rotation instead of reconciling or refusing it", async () => {
		const { state, click, issue } = fixture();
		const request = click();
		await issue(request);
		state.authority = { ...state.authority!, revision: 4 };
		state.agreed = null;
		state.ownerCalls.length = 0;
		expect(await issue(request)).toEqual({ status: "unknown" });
		expect(state.ownerCalls).toEqual([]);
	});

	it("returns issued and pending during a hold, without asking the owner, on first issuance and on replay", async () => {
		const { state, host, click, issue } = fixture();
		const request = click();
		// Maintenance begins between the protected write and reconciliation.
		const holding = {
			...host,
			writeAuthority: async (next: MissionAuthority) => {
				await host.writeAuthority(next);
				state.held = true;
			},
		};
		expect(await issueBrowserAgreement(request, creatorUid, holding, now + 1000)).toMatchObject({
			status: "issued",
			reconciled: false,
		});
		state.ownerCalls.length = 0;
		expect(await issue(request)).toMatchObject({ status: "issued", reconciled: false });
		expect(state.ownerCalls).toEqual([]);
		state.held = false;
		expect(await issue(request)).toMatchObject({ status: "issued", reconciled: true });
		expect(state.writes).toBe(1);
	});

	it("passes the absolute deadline to every hold check", async () => {
		const { state, click, issue } = fixture();
		await issue(click(), creatorUid, now + 1000);
		expect(state.heldSignals.length).toBeGreaterThanOrEqual(2);
		// One signal, created from the absolute deadline before the lock, bounds every wait.
		expect(new Set(state.heldSignals).size).toBe(1);
		const late = fixture();
		late.host.held = async (signal) => {
			await new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
			return false;
		};
		expect(await late.issue(late.click(), creatorUid, now + 20)).toEqual({ status: "unknown" });
		expect(late.state.writes).toBe(0);
	});
});

// Review A3-4: reconciled means the owner recorded exactly the protected receipt, not merely its receipt ID.
describe("exact reconciliation evidence", () => {
	it("does not count an owner that reports the receipt ID with other terms as reconciled", async () => {
		const { state, click, issue } = fixture();
		state.reportedTerms = { ...terms, scope: "everything" };
		expect(await issue(click())).toMatchObject({ status: "issued", reconciled: false });
	});

	it("does not count an owner that reports another revision or digest as reconciled", async () => {
		for (const tamper of [
			(agreement: MissionAgreement) => ({ ...agreement, revision: 5 }),
			(agreement: MissionAgreement) => ({ ...agreement, digest: "d".repeat(64) }),
			(agreement: MissionAgreement) => ({ ...agreement, missionId: "other" }),
		]) {
			const { state, host, click } = fixture();
			const lying = {
				...host,
				owner: async (input: MissionRequest, signal: AbortSignal) => {
					const view = await host.owner(input, signal);
					if (input.operation !== "reconcile") return view;
					return { ...view, formation: { ...view.formation, agreement: tamper(view.formation.agreement!) } };
				},
			};
			expect(await issueBrowserAgreement(click(), creatorUid, lying, now + 1000)).toMatchObject({
				reconciled: false,
			});
			expect(state.writes).toBe(1);
		}
	});
});

// Review A3-2: Bob's tools run as the service UID, which never agrees, not even by replaying a click.
describe("service UID exclusion", () => {
	it("refuses the service UID as actor before issuance and before replay", async () => {
		const { state, click, issue } = fixture();
		expect(await issue(click(), serviceUid)).toEqual({ status: "refused", code: "creator-mismatch" });
		expect(state.writes).toBe(0);
		await issue(click());
		state.ownerCalls.length = 0;
		expect(await issue(click(), serviceUid)).toEqual({ status: "refused", code: "creator-mismatch" });
		expect(state.ownerCalls).toEqual([]);
	});

	it("refuses when protected authority names the service UID as creator, even with a matching actor", async () => {
		const saved = authority({ creator: { kind: "human", id: "bob", uid: serviceUid } });
		const { state, click, issue } = fixture({ ...saved, browserAgreement: undefined });
		expect(await issue(click(), serviceUid)).toEqual({ status: "refused", code: "creator-mismatch" });
		expect(state.writes).toBe(0);
	});

	it("is closed when the grant names another service UID than the installation record", async () => {
		const { state, click, issue } = fixture(authority({ browserAgreement: grant({ serviceUid: 991 }) }));
		expect(await issue(click())).toEqual({ status: "refused", code: "not-enabled" });
		expect(state.writes).toBe(0);
	});

	it("never arms the service UID and rejects a grant whose creator is the service UID", () => {
		const saved = authority({ creator: { kind: "human", id: "bob", uid: serviceUid } });
		expect(
			browserAgreementArmed({ ...saved, browserAgreement: { ...grant(), creatorUid: serviceUid } }, serviceUid),
		).toBe(false);
		const stored = JSON.parse(JSON.stringify(authority({ browserAgreement: grant({ creatorUid: serviceUid }) })));
		expect(() => parseMissionAuthority(stored)).toThrow("service account");
	});
});

// Review A3-3: a request ID stays bound to its exact click; a full grant refuses new IDs instead of evicting old ones.
describe("request-ID binding at capacity", () => {
	const filler = (index: number) => ({
		requestId: `old-${index}`,
		receiptId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
		missionId,
		revision: index + 1,
		digest: "e".repeat(64),
		authorityRevision: 3,
		previousReceipt: null,
		issuedAt: now,
	});

	it("refuses a new request ID when the grant is full and keeps every binding", async () => {
		const issued = Array.from({ length: MAX_ISSUED_AGREEMENTS }, (_item, index) => filler(index));
		const { state, click, issue } = fixture(authority({ browserAgreement: grant({ issued }) }), 40);
		expect(await issue(click())).toEqual({ status: "refused", code: "agreement-limit" });
		expect(state.writes).toBe(0);
		// The oldest ID still names its own click: reused with other terms it is a conflict, never a new receipt.
		expect(await issue(click({ requestId: "old-0", revision: 40 }))).toEqual({
			status: "refused",
			code: "conflicting-request",
		});
		expect(state.authority?.browserAgreement?.issued).toEqual(issued);
	});

	it("fills to exactly the capacity, then refuses", async () => {
		const issued = Array.from({ length: MAX_ISSUED_AGREEMENTS - 1 }, (_item, index) => filler(index));
		const { state, click, issue } = fixture(authority({ browserAgreement: grant({ issued }) }), 40);
		expect((await issue(click())).status).toBe("issued");
		expect(state.authority?.browserAgreement?.issued).toHaveLength(MAX_ISSUED_AGREEMENTS);
		expect(state.authority?.browserAgreement?.issued[0]?.requestId).toBe("old-0");
		state.draft = proposal(41, state.authority!);
		const head = state.authority!.approvals.at(-1)!.receiptId;
		expect(
			await issue(click({ requestId: "next", revision: 41, digest: state.draft.digest!, previousReceipt: head })),
		).toEqual({
			status: "refused",
			code: "agreement-limit",
		});
		expect(state.writes).toBe(1);
	});

	it("rejects a protected record that binds one request ID twice", () => {
		const stored = JSON.parse(
			JSON.stringify(authority({ browserAgreement: grant({ issued: [filler(0), filler(0)] }) })),
		);
		expect(() => parseMissionAuthority(stored)).toThrow("Duplicate");
	});
});

describe("gateway seam", () => {
	it("arms only the creator's own non-root account at the current authority revision", () => {
		expect(browserAgreementArmed(authority(), creatorUid)).toBe(true);
		expect(browserAgreementArmed(authority(), 1001)).toBe(false);
		expect(browserAgreementArmed(authority({ revision: 4 }), creatorUid)).toBe(false);
		expect(browserAgreementArmed(authority({ browserAgreement: undefined }), creatorUid)).toBe(false);
		expect(browserAgreementArmed(null, creatorUid)).toBe(false);
		const root = authority({ creator: { kind: "human", id: "root", uid: 0 } });
		expect(
			browserAgreementArmed({ ...root, browserAgreement: { ...root.browserAgreement!, creatorUid: 0 } }, 0),
		).toBe(false);
	});

	it("reviews with its own digest and the protected receipt head, never the owner's claimed digest", () => {
		const saved = authority();
		const draft = { ...proposal(4, saved), digest: "f".repeat(64) };
		expect(agreementReview(draft, saved)).toEqual({
			missionId,
			revision: 4,
			digest: missionDigest(terms, missionId, 4, saved),
			authorityRevision: 3,
			previousReceipt: null,
		});
		expect(agreementReview({ ...draft, status: "editing" }, saved)).toBeNull();
		expect(agreementReview({ ...draft, terms: { objective: "only" } }, saved)).toBeNull();
		expect(agreementReview(null, saved)).toBeNull();
	});

	it("builds the fixed sudo call that the helper's parser accepts and a retried click replays", () => {
		const review = { revision: 4, digest: "a".repeat(64), previousReceipt: null };
		const call = agreementInvocation(installationId, review, "browser-request-1");
		expect(call.file).toBe("/usr/bin/sudo");
		expect(call.args.slice(0, 2)).toEqual(["-n", `/usr/lib/unit-001/agents/${installationId}/mission-agree`]);
		expect(call.env).toEqual({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" });
		const parsed = parseAgreementArguments(call.args.slice(2));
		expect(parsed).toMatchObject({ revision: 4, digest: "a".repeat(64), previousReceipt: null });
		expect(agreementInvocation(installationId, review, "browser-request-1").args).toEqual(call.args);
		expect(() => agreementInvocation("../etc", review, "x")).toThrow("installation");
	});

	it("reads only a clean exit with one outcome line as definite", () => {
		const issued = { status: "issued", receiptId: "r", reconciled: false } as const;
		expect(parseAgreementOutcome(formatAgreementOutcome(issued), 0)).toEqual(issued);
		expect(parseAgreementOutcome(formatAgreementOutcome({ status: "refused", code: "stale-digest" }), 0)).toEqual({
			status: "refused",
			code: "stale-digest",
		});
		for (const [stdout, code] of [
			[formatAgreementOutcome(issued), 1],
			[formatAgreementOutcome(issued), null],
			[JSON.stringify(issued), 0],
			[`${formatAgreementOutcome(issued)}${formatAgreementOutcome(issued)}`, 0],
			['{"status":"refused","code":"invented"}\n', 0],
			['{"status":"issued","receiptId":"r","reconciled":true,"extra":1}\n', 0],
			["not json\n", 0],
		] as const)
			expect(parseAgreementOutcome(stdout, code)).toEqual({ status: "unknown" });
	});
});

describe("protected grant record", () => {
	const stored = () => JSON.parse(JSON.stringify(authority())) as Record<string, unknown>;

	it("round-trips the grant and rejects unknown fields and a root creator", () => {
		expect(parseMissionAuthority(stored()).browserAgreement).toEqual(authority().browserAgreement);
		const extra = stored();
		extra.browserAgreement = { ...(extra.browserAgreement as object), helper: "/tmp/x" };
		expect(() => parseMissionAuthority(extra)).toThrow("Unknown browser agreement field");
		const root = stored();
		root.browserAgreement = { ...(root.browserAgreement as object), creatorUid: 0 };
		expect(() => parseMissionAuthority(root)).toThrow();
	});
});
