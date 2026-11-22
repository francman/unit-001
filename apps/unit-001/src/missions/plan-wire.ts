// Parses the mission plan projection at the owner wire; imports no owner runtime, so privileged clients can use it.
import { missionNumber, missionObject, missionText, missionTextList } from "./contract.ts";
import type { ReviewFacts, ReviewItem, ReviewNote, ReviewTrigger } from "./plan-review.ts";
import { type PlanTerms, parsePlanTerms } from "./plan-terms.ts";

/** Most due review triggers status lists; the producer keeps the most urgent ones, so a valid status always parses. */
export const MAX_DUE_TRIGGERS = 16;

/** One agreed plan revision as status shows it. */
export type PlanRevisionView = {
	revision: number;
	digest: string;
	previousDigest: string | null;
	terms: PlanTerms;
	agreedAt: number;
	receiptId: string;
};

/** The plan as status shows it; `due` and `preview` are computed on read and never stored. */
export type PlanView = {
	missionId: string | null;
	adopted: boolean;
	head: PlanRevisionView | null;
	headValid: boolean;
	previous: PlanRevisionView | null;
	history: { revision: number; digest: string; agreedAt: number }[];
	draft: {
		revision: number;
		baseRevision: number;
		status: "editing" | "proposed";
		terms: PlanTerms;
		digest: string | null;
		savedBy: "bob" | "owner";
		fromReview: string | null;
		missing: string[];
	} | null;
	gate: { state: "not-adopted" | "open" | "closed"; reason: null | "receipt" | "binding" | "reopen-needed" | "head-missing" };
	runs: { used: number; limit: number };
	due: ReviewTrigger[];
	preview: ReviewNote | null;
	reviews: ReviewNote[];
};

/**
 * Validates a plan view crossing the owner wire before a terminal or the gateway reads it: terms reparse fully and
 * review notes are rebuilt from their closed, bounded shape, so nothing unlisted passes through.
 */
export function parsePlanView(value: unknown): PlanView {
	const input = missionObject(value);
	const gate = missionObject(input.gate);
	const runs = missionObject(input.runs);
	if (gate.state !== "not-adopted" && gate.state !== "open" && gate.state !== "closed")
		throw new Error("Invalid plan gate projection.");
	const reason = gate.reason;
	if (
		reason !== null &&
		reason !== "receipt" &&
		reason !== "binding" &&
		reason !== "reopen-needed" &&
		reason !== "head-missing"
	)
		throw new Error("Invalid plan gate reason.");
	if (typeof input.adopted !== "boolean" || typeof input.headValid !== "boolean")
		throw new Error("Invalid plan projection.");
	return {
		missionId: input.missionId === null ? null : missionText(input.missionId),
		adopted: input.adopted,
		head: input.head === null ? null : parseRevision(input.head),
		headValid: input.headValid,
		previous: input.previous === null ? null : parseRevision(input.previous),
		history: list(input.history, 32).map((item) => {
			const entry = missionObject(item);
			return { revision: count(entry.revision), digest: hex(entry.digest), agreedAt: count(entry.agreedAt) };
		}),
		draft: input.draft === null ? null : parseDraft(input.draft),
		gate: { state: gate.state, reason },
		runs: { used: count(runs.used), limit: count(runs.limit) },
		due: list(input.due, MAX_DUE_TRIGGERS).map(parseTrigger),
		preview: input.preview === null ? null : parseReviewNote(input.preview),
		reviews: list(input.reviews, 12).map(parseReviewNote),
	};
}

function parseRevision(value: unknown): PlanRevisionView {
	const input = missionObject(value);
	return {
		revision: count(input.revision),
		digest: hex(input.digest),
		previousDigest: input.previousDigest === null ? null : hex(input.previousDigest),
		terms: parsePlanTerms(input.terms),
		agreedAt: count(input.agreedAt),
		receiptId: missionText(input.receiptId),
	};
}

function parseDraft(value: unknown): NonNullable<PlanView["draft"]> {
	const input = missionObject(value);
	if (input.status !== "editing" && input.status !== "proposed") throw new Error("Invalid plan draft state.");
	if (input.savedBy !== "bob" && input.savedBy !== "owner") throw new Error("Invalid plan draft author.");
	return {
		revision: count(input.revision),
		baseRevision: count(input.baseRevision),
		status: input.status,
		terms: parsePlanTerms(input.terms),
		digest: input.digest === null ? null : hex(input.digest),
		savedBy: input.savedBy,
		fromReview: input.fromReview === null ? null : missionText(input.fromReview),
		missing: missionTextList(input.missing, 64, 200),
	};
}

const TRIGGER_KINDS: readonly unknown[] = ["cadence", "completed", "blocked", "runs-low", "deadline-near", "owner"];
const ITEM_LEVELS: readonly unknown[] = ["strategic", "tactical", "legacy"];
const ITEM_STATUSES: readonly unknown[] = ["on-track", "at-risk", "blocked", "done", "planned", "parked"];

function parseTrigger(value: unknown): ReviewTrigger {
	const input = closed(value, ["kind", "key", "subject"]);
	return {
		kind: member(input.kind, TRIGGER_KINDS) as ReviewTrigger["kind"],
		key: missionText(input.key, 400),
		subject: input.subject === null ? null : missionText(input.subject, 400),
	};
}

/** Rebuilds one review note from its closed, bounded shape; the stored plan check uses it for saved notes too. */
export function parseReviewNote(value: unknown): ReviewNote {
	const input = closed(value, [
		"reviewId",
		"key",
		"trigger",
		"planRevision",
		"planDigest",
		"window",
		"createdAt",
		"outcome",
		"items",
		"facts",
		"uncertainty",
		"disposition",
	]);
	const window = closed(input.window, ["from", "to"]);
	return {
		reviewId: missionText(input.reviewId),
		key: missionText(input.key, 400),
		trigger: parseTrigger(input.trigger),
		planRevision: count(input.planRevision),
		planDigest: hex(input.planDigest),
		window: { from: count(window.from), to: count(window.to) },
		createdAt: count(input.createdAt),
		outcome: member(input.outcome, ["no-change", "attention"]) as ReviewNote["outcome"],
		items: list(input.items, 16).map(parseItem),
		facts: parseFacts(input.facts),
		uncertainty: missionTextList(input.uncertainty, 64, 400),
		disposition: input.disposition === null ? null : parseDisposition(input.disposition),
	};
}

function parseItem(value: unknown): ReviewItem {
	const input = closed(value, [
		"id",
		"level",
		"status",
		"verifiedWorks",
		"listedWorks",
		"runIds",
		"blockReasons",
		"unsettled",
		"deadlineAt",
	]);
	return {
		id: missionText(input.id, 64),
		level: member(input.level, ITEM_LEVELS) as ReviewItem["level"],
		status: member(input.status, ITEM_STATUSES) as ReviewItem["status"],
		verifiedWorks: count(input.verifiedWorks),
		listedWorks: count(input.listedWorks),
		runIds: missionTextList(input.runIds, 32, 400),
		blockReasons: missionTextList(input.blockReasons, 32, 200),
		unsettled: count(input.unsettled),
		deadlineAt: input.deadlineAt === null ? null : count(input.deadlineAt),
	};
}

function parseFacts(value: unknown): ReviewFacts {
	const input = closed(value, [
		"runsUsed",
		"runsLimit",
		"cycles",
		"maxCycles",
		"requests",
		"maxRequests",
		"estimatedCost",
		"maxEstimatedCost",
	]);
	return {
		runsUsed: count(input.runsUsed),
		runsLimit: count(input.runsLimit),
		cycles: count(input.cycles),
		maxCycles: count(input.maxCycles),
		requests: count(input.requests),
		maxRequests: count(input.maxRequests),
		estimatedCost: amount(input.estimatedCost),
		maxEstimatedCost: input.maxEstimatedCost === null ? null : amount(input.maxEstimatedCost),
	};
}

function parseDisposition(value: unknown): NonNullable<ReviewNote["disposition"]> {
	const input = closed(value, ["kind", "at", "draftRevision"]);
	return {
		kind: member(input.kind, ["dismissed", "drafted"]) as "dismissed" | "drafted",
		at: count(input.at),
		draftRevision: input.draftRevision === null ? null : count(input.draftRevision),
	};
}

function closed(value: unknown, fields: string[]): Record<string, unknown> {
	const input = missionObject(value);
	const keys = Object.keys(input);
	if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
		throw new Error("Invalid plan projection fields.");
	return input;
}

function member(value: unknown, allowed: readonly unknown[]): unknown {
	if (!allowed.includes(value)) throw new Error("Invalid plan projection value.");
	return value;
}

function amount(value: unknown): number {
	const number = missionNumber(value);
	if (number < 0) throw new Error("Invalid plan projection amount.");
	return number;
}

function list(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`Plan projection lists fit ${maximum} items.`);
	return value;
}

function count(value: unknown): number {
	const number = missionNumber(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid plan projection number.");
	return number;
}

function hex(value: unknown): string {
	const digest = missionText(value, 64);
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Invalid plan digest.");
	return digest;
}
