// Reviews an agreed mission plan from stored facts alone: which triggers are due and what the evidence shows.
import { createHash } from "node:crypto";
import { type PlanAgreement, type PlanState, saveReview } from "./plan-state.ts";
import type { PlanTactical } from "./plan-terms.ts";
import { MAX_DUE_TRIGGERS } from "./plan-wire.ts";
import { MAX_PURPOSE_WORKS, workDigest } from "./purpose-authority.ts";
import { doneWork, type LoopState, loopAgreement, type PurposeReceiptAgreement } from "./purpose-loop.ts";
import { MissionRefusal } from "./refusal.ts";

export type ReviewTriggerKind = "cadence" | "completed" | "blocked" | "runs-low" | "deadline-near" | "owner";

/** Why a review is due; `key` deduplicates it per plan revision, trigger and window or subject. */
export type ReviewTrigger = { kind: ReviewTriggerKind; key: string; subject: string | null };

export type ReviewItemStatus = "on-track" | "at-risk" | "blocked" | "done" | "planned" | "parked";

/** One plan item as the stored evidence shows it. */
export type ReviewItem = {
	id: string;
	level: "strategic" | "tactical" | "legacy";
	status: ReviewItemStatus;
	verifiedWorks: number;
	listedWorks: number;
	runIds: string[];
	blockReasons: string[];
	unsettled: number;
	deadlineAt: number | null;
};

/** Consumption from the lifetime ledger against the bound purpose's caps; nothing here is refunded. */
export type ReviewFacts = {
	runsUsed: number;
	runsLimit: number;
	cycles: number;
	maxCycles: number;
	requests: number;
	maxRequests: number;
	estimatedCost: number;
	maxEstimatedCost: number | null;
};

/** A review note built deterministically from stored state; model text never enters it. */
export type ReviewNote = {
	reviewId: string;
	key: string;
	trigger: ReviewTrigger;
	planRevision: number;
	planDigest: string;
	window: { from: number; to: number };
	createdAt: number;
	outcome: "no-change" | "attention";
	items: ReviewItem[];
	facts: ReviewFacts;
	uncertainty: string[];
	disposition: null | { kind: "dismissed" | "drafted"; at: number; draftRevision: number | null };
};

/** Runs left at or below this count make a review due. */
const RUNS_LOW = 4;

/**
 * The review triggers due now for the agreed head, most urgent first, leaving out every key already used. Nothing is
 * stored: status calls this for a preview, and only an explicit review stores a note under one of these keys.
 */
export function dueTriggers(plan: PlanState, loop: LoopState | undefined, now: number): ReviewTrigger[] {
	const head = plan.agreed.at(-1);
	if (!head) return [];
	const triggers: ReviewTrigger[] = [];
	const add = (kind: ReviewTriggerKind, subject: string | null) => triggers.push(reviewTrigger(head, kind, subject));
	const tacticals = head.terms.tacticals.map((tactical) => tacticalEvidence(tactical, loop, head, now));
	for (const item of tacticals) for (const runId of item.blockedRuns) add("blocked", runId);
	if (loop?.operation.activity?.kind === "blocked" && !tacticals.some((item) => item.blockedRuns.length !== 0))
		add("blocked", `loop-${loop.operation.activity.reason}`);
	for (const item of tacticals) if (item.status === "done") add("completed", item.id);
	for (const item of tacticals) if (item.deadlineNear) add("deadline-near", item.id);
	if (loop && MAX_PURPOSE_WORKS - loop.runs.length <= RUNS_LOW) add("runs-low", null);
	const window = cadenceWindow(head, now);
	if (window > 0) add("cadence", `w${window}`);
	// Most urgent first, so the bound drops only the least urgent; a dropped one is due again once these are used.
	return triggers.filter((trigger) => !plan.reviewKeys.includes(trigger.key)).slice(0, MAX_DUE_TRIGGERS);
}

// The trigger an explicit owner review uses when nothing else is due; its request ID keeps it distinct.
function ownerTrigger(head: PlanAgreement, requestId: string): ReviewTrigger {
	return reviewTrigger(head, "owner", requestId);
}

/** Builds the review note for one trigger from the plan head, the stored loop and the time; the same inputs give the same note. */
export function reviewNote(
	plan: PlanState,
	head: PlanAgreement,
	loop: LoopState | undefined,
	trigger: ReviewTrigger,
	now: number,
): ReviewNote {
	const tacticals = head.terms.tacticals.map((tactical) => tacticalEvidence(tactical, loop, head, now));
	const strategics = head.terms.strategics.map((strategic) =>
		strategicItem(
			strategic.id,
			tacticals.filter((item) => head.terms.tacticals.find((tactical) => tactical.id === item.id)?.strategic === strategic.id),
		),
	);
	const items = [...strategics, ...tacticals.map(({ blockedRuns: _runs, deadlineNear: _near, ...item }) => item)];
	const uncertainty = uncertainties(head, loop);
	const attention =
		tacticals.some((item) => item.status === "blocked" || item.status === "at-risk" || item.status === "done") ||
		uncertainty.some((line) => line.startsWith("Run ") || line.includes("unknown outcome"));
	const previous = plan.reviews.findLast((note) => note.planRevision === head.revision);
	return {
		reviewId: `review-${createHash("sha256").update(trigger.key).digest("hex").slice(0, 16)}`,
		key: trigger.key,
		trigger,
		planRevision: head.revision,
		planDigest: head.digest,
		window: { from: previous?.window.to ?? head.approval.approvedAt, to: now },
		createdAt: now,
		outcome: attention ? "attention" : "no-change",
		items,
		facts: reviewFacts(head, loop),
		uncertainty,
		disposition: null,
	};
}

/**
 * Stores the review for an explicit request: the most urgent due trigger, else an owner trigger. A replayed request ID
 * returns its first note; a key already used never stores a second note. Returns the stored note.
 */
export function storeReview(plan: PlanState, loop: LoopState | undefined, requestId: string, now: number): ReviewNote {
	const head = plan.agreed.at(-1);
	if (!head) throw new MissionRefusal("incomplete", "Agree a mission plan before reviewing it.");
	const replay = plan.reviewRequests.find((item) => item.requestId === requestId);
	if (replay) {
		const replayed = plan.reviews.find((note) => note.reviewId === replay.reviewId);
		// The ID keeps naming its first note after that note is evicted; it never names a second one.
		if (!replayed)
			throw new MissionRefusal("conflicting-request", "That review request's note is no longer stored; use a new request ID.");
		return replayed;
	}
	const trigger = dueTriggers(plan, loop, now)[0] ?? ownerTrigger(head, requestId);
	const note = reviewNote(plan, head, loop, trigger, now);
	saveReview(plan, note, requestId);
	return note;
}

/** Records the owner's dismissal of a stored note; it changes no terms, and a drafted note keeps its disposition. */
export function dismissReview(plan: PlanState, reviewId: string, now: number): void {
	const note = plan.reviews.find((item) => item.reviewId === reviewId);
	if (!note) throw new MissionRefusal("stale-revision", "That review note is no longer stored.");
	note.disposition ??= { kind: "dismissed", at: now, draftRevision: null };
}

function reviewTrigger(head: PlanAgreement, kind: ReviewTriggerKind, subject: string | null): ReviewTrigger {
	return { kind, key: `${head.revision}:${kind}:${subject ?? "-"}`, subject };
}

// Whole review periods since the head was agreed; each period is one window and one cadence key.
function cadenceWindow(head: PlanAgreement, now: number): number {
	const every = head.terms.overall.reviewEveryMs;
	return every > 0 ? Math.floor((now - head.approval.approvedAt) / every) : 0;
}

type TacticalEvidence = ReviewItem & { blockedRuns: string[]; deadlineNear: boolean };

function tacticalEvidence(
	tactical: PlanTactical,
	loop: LoopState | undefined,
	head: PlanAgreement,
	now: number,
): TacticalEvidence {
	const base = {
		id: tactical.id,
		level: "tactical" as const,
		deadlineAt: tactical.deadlineAt,
		blockedRuns: [],
		deadlineNear: false,
	};
	const empty = { verifiedWorks: 0, listedWorks: 0, runIds: [], blockReasons: [], unsettled: 0 };
	if (tactical.mode !== "runnable") return { ...base, ...empty, status: tactical.mode };
	const agreement = loop && tactical.binding && loopAgreement(loop, tactical.binding.purposeRevision);
	if (!loop || !agreement || agreement.digest !== tactical.binding?.purposeDigest)
		return { ...base, ...empty, status: "blocked", blockReasons: ["binding"] };
	const done = doneWork(loop);
	const listed = agreement.terms.works.length;
	const verified = agreement.terms.works.filter((work) => done.has(workDigest(work))).length;
	const runs = loop.runs.filter((run) => run.purposeRevision === agreement.revision);
	const blocked = runs.filter((run) => run.state.status === "blocked");
	const latest = runs.at(-1);
	const near = deadlineNear(tactical, head, now, verified, listed);
	const status: ReviewItemStatus =
		verified === listed
			? "done"
			: latest?.state.status === "blocked" || loop.operation.activity?.kind === "blocked"
				? "blocked"
				: near || MAX_PURPOSE_WORKS - loop.runs.length <= RUNS_LOW
					? "at-risk"
					: "on-track";
	return {
		...base,
		status,
		verifiedWorks: verified,
		listedWorks: listed,
		runIds: runs.map((run) => run.runId),
		blockReasons: [...new Set(blocked.map((run) => (run.state.status === "blocked" ? run.state.reason : "")))],
		unsettled: runs.filter((run) => run.settlement === "unsettled").length,
		blockedRuns: blocked.map((run) => run.runId),
		deadlineNear: near,
	};
}

// Less than a fifth of the tactical's time left while under half its works are verified.
function deadlineNear(tactical: PlanTactical, head: PlanAgreement, now: number, verified: number, listed: number) {
	if (tactical.deadlineAt === null || listed === 0) return false;
	const total = tactical.deadlineAt - head.approval.approvedAt;
	return total > 0 && tactical.deadlineAt - now < total / 5 && verified * 2 < listed;
}

function strategicItem(id: string, tacticals: ReviewItem[]): ReviewItem {
	const active = tacticals.filter((item) => item.status !== "planned" && item.status !== "parked");
	const status: ReviewItemStatus = tacticals.some((item) => item.status === "blocked")
		? "blocked"
		: tacticals.some((item) => item.status === "at-risk")
			? "at-risk"
			: active.length === 0
				? "planned"
				: active.every((item) => item.status === "done")
					? "done"
					: "on-track";
	return {
		id,
		level: "strategic",
		status,
		verifiedWorks: tacticals.reduce((sum, item) => sum + item.verifiedWorks, 0),
		listedWorks: tacticals.reduce((sum, item) => sum + item.listedWorks, 0),
		runIds: tacticals.flatMap((item) => item.runIds),
		blockReasons: [...new Set(tacticals.flatMap((item) => item.blockReasons))],
		unsettled: tacticals.reduce((sum, item) => sum + item.unsettled, 0),
		deadlineAt: null,
	};
}

function reviewFacts(head: PlanAgreement, loop: LoopState | undefined): ReviewFacts {
	const binding = head.terms.tacticals.find((tactical) => tactical.mode === "runnable")?.binding;
	const agreement: PurposeReceiptAgreement | undefined =
		loop && (binding ? loopAgreement(loop, binding.purposeRevision) : loop.agreements.at(-1));
	const lifetime = agreement?.terms.lifetime;
	return {
		runsUsed: loop?.runs.length ?? 0,
		runsLimit: MAX_PURPOSE_WORKS,
		cycles: loop?.ledger.cycles ?? 0,
		maxCycles: lifetime?.maxCycles ?? 0,
		requests: loop?.ledger.requests ?? 0,
		maxRequests: lifetime?.maxRequests ?? 0,
		estimatedCost: loop?.ledger.estimatedCost ?? 0,
		maxEstimatedCost: lifetime?.maxEstimatedCost ?? null,
	};
}

// What the stored facts cannot show; a review that hid these would read as more certain than it is.
function uncertainties(head: PlanAgreement, loop: LoopState | undefined): string[] {
	if (!loop) return ["The purpose records failed validation, so nothing about runs is known."];
	const lines = loop.runs
		.filter((run) => run.settlement === "unsettled")
		.map((run) => `Run ${run.runId} has effects of unknown outcome.`);
	if (loop.ledger.unknownRequests > 0) lines.push(`${loop.ledger.unknownRequests} model requests have unknown outcome.`);
	if (loop.ledger.unpricedResponses > 0) lines.push(`${loop.ledger.unpricedResponses} model responses carry no price.`);
	if (head.terms.strategics.length > 0) lines.push("Strategic signals are prose; the host verifies none of them.");
	if (head.terms.tacticals.some((tactical) => tactical.mode === "planned"))
		lines.push("Planned tacticals have no host verifier; their progress is not observed.");
	return lines;
}
