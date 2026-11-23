// Stores continuous operation of an approved purpose: agreements, operation, proposals, runs and the lifetime ledger.
import { isDeepStrictEqual } from "node:util";
import type { ConversationId, EntryId, TaskId } from "@earendil-works/pi-durable";
import { parseMissionApproval } from "./authority.ts";
import { type MissionApproval, missionObject, type PurposeTerms, type WorkTerms } from "./contract.ts";
import type { MissionEvidence } from "./execution-state.ts";
import { MAX_PURPOSE_WORKS, parsePurposeTerms, purposeDigest, workDigest } from "./purpose-authority.ts";

/** One approved purpose revision; valid only as exactly what its embedded protected receipt approved. */
export type PurposeReceiptAgreement = {
	missionId: string;
	revision: number;
	terms: PurposeTerms;
	digest: string;
	approval: MissionApproval;
};

/** The host's durable record, made once per observation, of the next work item or a reasoned wait. */
export type LoopProposal = {
	proposalId: string;
	observation: number;
	purposeRevision: number;
	sequence: number;
	decision: { kind: "work"; workId: string } | { kind: "wait"; reason: WaitReason; until: number | null };
	status: "recorded" | "admitted" | "stale";
	recordedAt: number;
};

export type WaitReason = "next_observation" | "maintenance" | "retry" | "all_listed_work_done";

/** One reserved provider attempt; its receipt settles this record once, by ID, never by run or totals. */
export type LoopAttempt = {
	attemptId: string;
	ceiling: number | null;
	status: "reserved" | "priced" | "unpriced" | "released";
	cost?: number;
};

/** One execution of one listed work item: identities, counters, uncertain effects, evidence and outcome. */
export type LoopRun = {
	runId: string;
	workId: string;
	workDigest: string;
	purposeRevision: number;
	sequence: number;
	conversation: ConversationId;
	providerSession: string;
	cycles: number;
	retries: number;
	noProgress: number;
	attempts: LoopAttempt[];
	pendingTools: TaskId[];
	evidence: MissionEvidence[];
	lastAnswer: EntryId | null;
	state:
		| { status: "running"; phase: "execution" | "verification" }
		| { status: "verified"; observedAt: number }
		| { status: "blocked"; reason: string }
		| { status: "aborted" };
	settlement: "settled" | "unsettled" | { acknowledged: string } | null;
};

/** What the open loop is doing, for status; the loop task's checkpoint is authoritative for scheduling. */
export type LoopActivity =
	| { kind: "observing" }
	| { kind: "working"; runId: string }
	| { kind: "waiting"; reason: Exclude<WaitReason, "all_listed_work_done">; until: number }
	| { kind: "idle"; reason: "all_listed_work_done" }
	| { kind: "blocked"; reason: string };

export type LoopOperation = {
	revision: number;
	applied: { requestId: string; sequence: number } | null;
	acknowledged: string[];
	state:
		| { status: "closed" }
		| { status: "open" | "suspended"; purposeRevision: number; purposeDigest: string; sequence: number };
	loop: TaskId<null> | null;
	drain: { loop: TaskId<null>; conversations: ConversationId[] } | null;
	nextObservationAt: number | null;
	activity: LoopActivity | null;
};

/** Cumulative consumption per mission; restarts, reopen and amendments never reset it, and nothing refunds it. */
export type LoopLedger = {
	workItems: number;
	cycles: number;
	requests: number;
	estimatedCost: number;
	reservedCost: number;
	unknownRequests: number;
	unpricedResponses: number;
	unboundedAttempts: number;
};

export type LoopState = {
	missionId: string | null;
	nextRevision: number;
	draft: { revision: number; terms: PurposeTerms; digest: string; requestId: string } | null;
	agreements: PurposeReceiptAgreement[];
	operation: LoopOperation;
	observations: number;
	proposals: LoopProposal[];
	runs: LoopRun[];
	ledger: LoopLedger;
};

const MAX_PROPOSALS = 72;
const MAX_ACKNOWLEDGED = 32;

/** The empty loop: no purpose approved for continuous operation, operation closed, nothing consumed. */
export function initialLoop(): LoopState {
	return {
		missionId: null,
		nextRevision: 1,
		draft: null,
		agreements: [],
		operation: {
			revision: 0,
			applied: null,
			acknowledged: [],
			state: { status: "closed" },
			loop: null,
			drain: null,
			nextObservationAt: null,
			activity: null,
		},
		observations: 0,
		proposals: [],
		runs: [],
		ledger: {
			workItems: 0,
			cycles: 0,
			requests: 0,
			estimatedCost: 0,
			reservedCost: 0,
			unknownRequests: 0,
			unpricedResponses: 0,
			unboundedAttempts: 0,
		},
	};
}

/** The work ID of a listed item: stable per purpose revision and position. */
export function listedWorkId(revision: number, index: number): string {
	return `p${revision}-w${index + 1}`;
}

/** A short label for a listed work item in status: its file path, or the research question's start. */
export function workLabel(work: WorkTerms): string {
	return work.kind === "artifact-digest" ? work.path : `research: ${work.question.slice(0, 120)}`;
}

/** The agreement an operation or run names, if stored. */
export function loopAgreement(loop: LoopState, revision: number): PurposeReceiptAgreement | undefined {
	return loop.agreements.find((agreement) => agreement.revision === revision);
}

/** Finds a listed work item of an agreement by its work ID. */
export function listedWork(agreement: PurposeReceiptAgreement, workId: string): WorkTerms | undefined {
	return agreement.terms.works.find((_work, index) => listedWorkId(agreement.revision, index) === workId);
}

/** Work digests already done: verified evidence, and settled or acknowledged effects. Acknowledgment alone is not done. */
export function doneWork(loop: LoopState): Set<string> {
	return new Set(
		loop.runs
			.filter((run) => run.state.status === "verified" && run.settlement !== "unsettled" && run.settlement !== null)
			.map((run) => run.workDigest),
	);
}

/** Records one approved purpose revision in the commit that reconciles its receipt; idempotent by revision. */
export function recordPurposeAgreement(loop: LoopState, agreement: PurposeReceiptAgreement): void {
	const exact = parseReceiptAgreement(agreement);
	const saved = loopAgreement(loop, exact.revision);
	if (saved) {
		if (!isDeepStrictEqual(saved, exact)) throw new Error("Conflicting purpose agreement.");
		return;
	}
	if (loop.agreements.some((item) => item.revision > exact.revision))
		throw new Error("A newer purpose revision is already agreed.");
	loop.agreements.push(exact);
	loop.missionId = exact.missionId;
	if (loop.draft?.revision === exact.revision) loop.draft = null;
}

/** Appends a proposal and prunes the oldest non-recorded ones beyond the bound. */
export function appendProposal(loop: LoopState, proposal: LoopProposal): void {
	loop.proposals.push(proposal);
	while (loop.proposals.length > MAX_PROPOSALS) {
		const index = loop.proposals.findIndex((item) => item.status !== "recorded");
		if (index < 0) break;
		loop.proposals.splice(index, 1);
	}
}

/** Remembers an applied acknowledgment request ID, newest kept. */
export function rememberAcknowledgment(loop: LoopState, requestId: string): void {
	loop.operation.acknowledged.push(requestId);
	if (loop.operation.acknowledged.length > MAX_ACKNOWLEDGED) loop.operation.acknowledged.shift();
}

/**
 * Validates a stored loop: Durable returns same-version fields as stored, so agreements must rebuild from their
 * receipt copies, runs must name agreed work, and the ledger must equal what its runs consumed.
 */
export function checkLoopState(value: unknown): LoopState {
	const loop = missionObject(value) as LoopState;
	// The fixed history cap, not the current ceiling: an amendment that lowers the ceiling keeps older runs.
	if (
		!Array.isArray(loop.agreements) ||
		!Array.isArray(loop.runs) ||
		!Array.isArray(loop.proposals) ||
		loop.runs.length > MAX_PURPOSE_WORKS
	)
		throw new Error("Invalid stored purpose loop.");
	let previous = 0;
	for (const agreement of loop.agreements) {
		const exact = parseReceiptAgreement(agreement);
		if (exact.revision <= previous || exact.missionId !== loop.missionId)
			throw new Error("Invalid stored purpose agreement order.");
		previous = exact.revision;
	}
	const totals = { cycles: 0, requests: 0, estimatedCost: 0, reservedCost: 0, unknown: 0, unpriced: 0, unbounded: 0 };
	for (const run of loop.runs) {
		const agreement = loopAgreement(loop, run.purposeRevision);
		const work = agreement && listedWork(agreement, run.workId);
		if (!work || run.workDigest !== workDigest(work)) throw new Error("Stored run names unagreed work.");
		// Run counters feed the cycle, retry and no-progress limits; a missing one compares false and would admit.
		if (
			![run.cycles, run.retries, run.noProgress].every(storedCount) ||
			!Array.isArray(run.attempts) ||
			!Array.isArray(run.pendingTools)
		)
			throw new Error("Invalid stored purpose run.");
		// A run's own approved work bounds its history, released attempts included: each one was a charged request.
		// Research runs make no artifact cycles; their requests are bounded by the same per-work cap.
		const maxCycles = work.kind === "artifact-digest" ? work.maxCycles : 0;
		if (run.cycles > maxCycles || run.attempts.length > work.maxRequests)
			throw new Error("Stored run exceeds its approved work.");
		totals.cycles += run.cycles;
		for (const attempt of run.attempts) {
			checkAttempt(attempt);
			totals.requests++;
			// Provably never sent: a charged request with zero cost, neither unknown nor unbounded spend.
			if (attempt.status === "released") continue;
			if (attempt.ceiling === null) totals.unbounded++;
			if (attempt.status === "reserved") totals.unknown++;
			if (attempt.status === "unpriced") totals.unpriced++;
			if (attempt.status === "priced") totals.estimatedCost += attempt.cost!;
			else totals.reservedCost += attempt.ceiling ?? 0;
		}
	}
	const ledger = loop.ledger;
	// Spend checks add and compare these totals against the cap; NaN or a missing total compares false and admits, so
	// each must be finite. Each must also be nonnegative before the tolerance applies: a reserved total of -5e-10
	// passes against a recomputed zero, yet lowers the balance enough to admit work at an exactly reached cap.
	if (
		!Number.isFinite(ledger.estimatedCost) ||
		!Number.isFinite(ledger.reservedCost) ||
		ledger.estimatedCost < 0 ||
		ledger.reservedCost < 0
	)
		throw new Error("Stored purpose ledger does not match its runs.");
	if (
		ledger.workItems !== loop.runs.length ||
		ledger.cycles !== totals.cycles ||
		ledger.requests !== totals.requests ||
		ledger.unknownRequests !== totals.unknown ||
		ledger.unpricedResponses !== totals.unpriced ||
		ledger.unboundedAttempts !== totals.unbounded ||
		Math.abs(ledger.estimatedCost - totals.estimatedCost) > 1e-9 ||
		Math.abs(ledger.reservedCost - totals.reservedCost) > 1e-9
	)
		throw new Error("Stored purpose ledger does not match its runs.");
	const state = loop.operation.state;
	if (state.status !== "closed") {
		const agreement = loopAgreement(loop, state.purposeRevision);
		if (!agreement || agreement.digest !== state.purposeDigest) throw new Error("Operation names no agreed purpose.");
	}
	return loop;
}

/**
 * The stored loop if its loop part validates, else undefined. Execution and status validate the whole document
 * (`validPurposeLoop` in purpose.ts); this loop-only check serves the agent's maintenance drain.
 */
export function validLoop(value: unknown): LoopState | undefined {
	try {
		return checkLoopState(value);
	} catch {
		return undefined;
	}
}

function storedCount(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

const ATTEMPT_STATUSES: readonly unknown[] = ["reserved", "priced", "unpriced", "released"];

// An attempt's ceiling and cost are what the ledger totals recompute from, so each must be a real amount; a priced
// attempt without its cost would count as free.
function checkAttempt(attempt: LoopAttempt): void {
	const input = missionObject(attempt);
	const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (
		typeof input.attemptId !== "string" ||
		!ATTEMPT_STATUSES.includes(input.status) ||
		(input.ceiling !== null && !amount(input.ceiling)) ||
		(input.status === "priced" ? !amount(input.cost) : input.cost !== undefined)
	)
		throw new Error("Invalid stored purpose attempt.");
}

function parseReceiptAgreement(value: unknown): PurposeReceiptAgreement {
	const input = missionObject(value);
	const terms = parsePurposeTerms(input.terms);
	const approval = parseMissionApproval(input.approval);
	if (approval.session !== "default") throw new Error("Invalid stored purpose agreement.");
	const exact: PurposeReceiptAgreement = {
		missionId: approval.missionId,
		revision: approval.revision,
		terms,
		digest: purposeDigest(terms, approval.missionId, approval.revision, {
			installationId: approval.installationId,
			session: approval.session,
			revision: approval.authorityRevision,
			creator: approval.creator,
		}),
		approval,
	};
	if (approval.digest !== exact.digest || !isDeepStrictEqual(value, exact))
		throw new Error("Invalid stored purpose agreement.");
	return exact;
}
