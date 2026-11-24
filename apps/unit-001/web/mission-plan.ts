// Validates the gateway's closed mission plan and review projections before the browser uses them.
import {
	MAX_DUE_TRIGGERS,
	MAX_REVIEW_TURNS,
	PLAN_PROJECTION_LIMITS as PROJECTION,
	PLAN_TERMS_LIMITS as TERMS,
} from "../src/missions/plan-limits.ts";
import type { MissionPlanBinding } from "./contract.ts";
import type {
	PlanRevisionView,
	PlanTerms,
	PlanView,
	ReviewAllowance,
	ReviewAllowanceView,
	ReviewNote,
	ReviewTrigger,
	ReviewTurnView,
} from "./mission-plan-contract.ts";

const RUN_LIMIT = PROJECTION.runs;
const REVIEW_PROJECTION_FIELDS = ["allowance", "turns", "blocker"] as const;
const ALLOWANCE_CAP_FIELDS = ["maxRequests", "maxRequestsPerReview", "maxEstimatedCost"] as const;

/** Parses the complete plan projection without inferring authority from its recorded history. */
export function parsePlanView(value: unknown): PlanView {
	const plan = closed(value, [
		"missionId", "adopted", "head", "headValid", "previous", "history", "draft", "gate", "runs", "due", "preview", "reviews",
	], REVIEW_PROJECTION_FIELDS);
	const missionId = nullable(plan.missionId, identity);
	const adopted = flag(plan.adopted);
	const head = nullable(plan.head, parseRevision);
	const headValid = flag(plan.headValid);
	const previous = nullable(plan.previous, parseRevision);
	const history = list(plan.history, PROJECTION.history,(value) => {
		const row = closed(value, ["revision", "digest", "agreedAt"]);
		return { revision: count(row.revision, 1), digest: digest(row.digest), agreedAt: count(row.agreedAt) };
	});
	checkHistory(head, previous, history);
	const draft = nullable(plan.draft, parseDraft);
	const gate = parseGate(plan.gate);
	if (adopted !== (head !== null) || (missionId === null && (head !== null || draft !== null))) return invalid();
	if ((headValid && head === null) || (gate.state === "open" && !headValid) || (adopted && gate.state === "not-adopted"))
		return invalid();
	const runs = closed(plan.runs, ["used", "limit"]);
	const used = count(runs.used);
	if (runs.limit !== RUN_LIMIT || used > RUN_LIMIT) return invalid();
	// Old gateway responses have no review turn projection and confer no model review capability.
	const hasReviewProjection = Object.hasOwn(plan, "turns");
	const allowance = hasReviewProjection ? nullable(plan.allowance, parseAllowanceView) : null;
	const turns = hasReviewProjection ? list(plan.turns, MAX_REVIEW_TURNS, parseReviewTurn) : [];
	const blocker = hasReviewProjection ? nullable(plan.blocker, parseReviewTurn) : null;
	const due = list(plan.due, MAX_DUE_TRIGGERS, parseTrigger);
	const preview = nullable(plan.preview, parseReviewNote);
	const reviews = list(plan.reviews, PROJECTION.reviews, parseReviewNote);
	if (preview) {
		const first = due[0];
		if (
			first === undefined || head === null || preview.planRevision !== head.revision || preview.planDigest !== head.digest ||
			preview.disposition !== null || preview.key !== first.key || preview.trigger.kind !== first.kind ||
			preview.trigger.subject !== first.subject
		) return invalid();
	} else if (due.length !== 0) return invalid();
	const reviewIds = new Set<string>();
	for (const note of reviews) {
		if (reviewIds.has(note.reviewId) || !history.some((row) => row.revision === note.planRevision && row.digest === note.planDigest))
			return invalid();
		reviewIds.add(note.reviewId);
	}
	return {
		missionId, adopted, head, headValid, previous, history, draft, gate, runs: { used, limit: RUN_LIMIT },
		allowance, turns, blocker, due, preview, reviews,
	};
}

/** Parses every field in a projected saved or preview review note. */
export function parseReviewNote(value: unknown): ReviewNote {
	const note = closed(value, [
		"reviewId", "key", "trigger", "planRevision", "planDigest", "window", "createdAt", "outcome", "items", "facts",
		"uncertainty", "disposition",
	]);
	const trigger = parseTrigger(note.trigger);
	if (note.key !== trigger.key) return invalid();
	const window = closed(note.window, ["from", "to"]);
	return {
		reviewId: identity(note.reviewId),
		key: trigger.key,
		trigger,
		planRevision: count(note.planRevision, 1),
		planDigest: digest(note.planDigest),
		window: { from: count(window.from), to: count(window.to) },
		createdAt: count(note.createdAt),
		outcome: oneOf(note.outcome, ["no-change", "attention"]),
		items: list(note.items, PROJECTION.noteItems, parseReviewItem),
		facts: parseReviewFacts(note.facts),
		uncertainty: list(note.uncertainty, PROJECTION.uncertainty, (value) => text(value, PROJECTION.uncertaintyText)),
		disposition: nullable(note.disposition, parseDisposition),
	};
}

/** Parses the exact verified purpose binding offered in the mission status projection. */
export function parseMissionPlanBinding(value: unknown): MissionPlanBinding {
	const binding = closed(value, ["missionId", "purposeRevision", "purposeDigest"]);
	return {
		missionId: identity(binding.missionId),
		purposeRevision: count(binding.purposeRevision, 1),
		purposeDigest: digest(binding.purposeDigest),
	};
}

function checkHistory(head: PlanRevisionView | null, previous: PlanRevisionView | null, history: PlanView["history"]): void {
	const first = history[0];
	const second = history[1];
	if (
		(head === null) !== (first === undefined) || (previous === null) !== (second === undefined) ||
		(head !== null && (head.revision !== first?.revision || head.digest !== first.digest || head.agreedAt !== first.agreedAt ||
			head.previousDigest !== (previous?.digest ?? null))) ||
		(previous !== null && (previous.revision !== second?.revision || previous.digest !== second.digest ||
			previous.agreedAt !== second.agreedAt || previous.previousDigest !== (history[2]?.digest ?? null)))
	) return invalid();
	for (let i = 1; i < history.length; i++) if (history[i].revision >= history[i - 1].revision) return invalid();
}

function parseRevision(value: unknown): PlanRevisionView {
	const row = closed(value, ["revision", "digest", "previousDigest", "terms", "agreedAt", "receiptId"]);
	return {
		revision: count(row.revision, 1),
		digest: digest(row.digest),
		previousDigest: nullable(row.previousDigest, digest),
		terms: parseTerms(row.terms, "projection"),
		agreedAt: count(row.agreedAt),
		receiptId: identity(row.receiptId),
	};
}

function parseDraft(value: unknown): NonNullable<PlanView["draft"]> {
	const row = closed(value, ["revision", "baseRevision", "status", "terms", "digest", "savedBy", "fromReview", "missing"]);
	const revision = count(row.revision, 1);
	const baseRevision = count(row.baseRevision);
	const status = oneOf(row.status, ["editing", "proposed"]);
	const proposalDigest = nullable(row.digest, digest);
	const missing = list(row.missing, PROJECTION.missing, (value) => text(value, PROJECTION.missingText));
	// The gateway withholds an unverifiable proposal digest without discarding the draft.
	if (revision <= baseRevision || (status === "editing" && proposalDigest !== null)) return invalid();
	return {
		revision, baseRevision, status,
		terms: parseTerms(row.terms, "projection"),
		digest: proposalDigest,
		savedBy: oneOf(row.savedBy, ["bob", "owner"]),
		fromReview: nullable(row.fromReview, identity),
		missing,
	};
}

function parseGate(value: unknown): PlanView["gate"] {
	const gate = closed(value, ["state", "reason"]);
	const state = oneOf(gate.state, ["not-adopted", "open", "closed"]);
	if (state === "closed") return { state, reason: oneOf(gate.reason, ["receipt", "binding", "reopen-needed", "head-missing"]) };
	if (gate.reason !== null) return invalid();
	return { state, reason: null };
}

const UTF8 = new TextEncoder();
const PRIORITIES = ["high", "normal", "low"] as const;

/** Validates authored plan terms without deciding whether they can be proposed. */
export function parsePlanTerms(value: unknown): PlanTerms {
	return parseTerms(value, "authored");
}

function parseTerms(value: unknown, source: "authored" | "projection"): PlanTerms {
	const input = closed(value, ["overall", "strategics", "tacticals"]);
	const overall = closed(
		input.overall,
		["purpose", "scope", "askFirst", "reviewEveryMs"],
		["reviewAllowance"],
	);
	const legacy = !Object.hasOwn(overall, "reviewAllowance");
	if (legacy && source === "authored") return invalid();
	const terms: PlanTerms = {
		overall: {
			purpose: text(overall.purpose, TERMS.purposeText),
			scope: text(overall.scope, TERMS.scopeText),
			askFirst: list(overall.askFirst, TERMS.askFirst, (value) => text(value, TERMS.askFirstText)),
			reviewEveryMs: count(overall.reviewEveryMs),
			reviewAllowance: legacy ? null : nullable(overall.reviewAllowance, (row) => parseAllowanceCaps(closed(row, ALLOWANCE_CAP_FIELDS))),
		},
		strategics: list(input.strategics, TERMS.strategics, (value) => {
			const row = closed(value, ["id", "title", "intent", "signals", "priority"]);
			return {
				id: itemId(row.id),
				title: text(row.title, TERMS.titleText),
				intent: text(row.intent, TERMS.intentText),
				signals: list(row.signals, TERMS.signals, (value) => text(value, TERMS.signalText)),
				priority: oneOf(row.priority, PRIORITIES),
			};
		}),
		tacticals: list(input.tacticals, TERMS.tacticals, parseTactical),
	};
	// Normalizing an omitted allowance must not make a legacy payload exceed its original byte limit.
	const legacyBytes = legacy ? ',"reviewAllowance":null'.length : 0;
	if (UTF8.encode(JSON.stringify(terms)).length > TERMS.termsBytes + legacyBytes) return invalid();
	return terms;
}

function parseAllowanceView(value: unknown): ReviewAllowanceView {
	const row = closed(value, [...ALLOWANCE_CAP_FIELDS, "requests", "estimatedCost", "reservedCost"]);
	return {
		...parseAllowanceCaps(row),
		requests: count(row.requests),
		estimatedCost: reviewCost(row.estimatedCost),
		reservedCost: reviewCost(row.reservedCost),
	};
}

function parseAllowanceCaps(row: Record<(typeof ALLOWANCE_CAP_FIELDS)[number], unknown>): ReviewAllowance {
	const maxRequests = count(row.maxRequests, 1);
	const maxRequestsPerReview = count(row.maxRequestsPerReview, 1);
	const maxEstimatedCost = nullable(row.maxEstimatedCost, reviewCost);
	if (maxRequestsPerReview > TERMS.requestsPerReview || maxRequestsPerReview > maxRequests || maxEstimatedCost === 0)
		return invalid();
	return { maxRequests, maxRequestsPerReview, maxEstimatedCost };
}

function reviewCost(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalid();
	return value;
}

function parseTactical(value: unknown): PlanTerms["tacticals"][number] {
	const row = closed(value, ["id", "strategic", "objective", "successCriteria", "priority", "deadlineAt", "mode", "binding"]);
	const base = {
		id: itemId(row.id),
		strategic: itemId(row.strategic),
		objective: text(row.objective, TERMS.objectiveText),
		successCriteria: list(row.successCriteria, TERMS.successCriteria, (value) => text(value, TERMS.criterionText)),
		priority: oneOf(row.priority, PRIORITIES),
		deadlineAt: nullable(row.deadlineAt, (value) => count(value, 1)),
	};
	const mode = oneOf(row.mode, ["runnable", "parked", "planned"]);
	if (mode === "runnable") return { ...base, mode, binding: parseMissionPlanBinding(row.binding) };
	if (row.binding !== null) return invalid();
	return { ...base, mode, binding: null };
}

function parseTrigger(value: unknown): ReviewTrigger {
	const trigger = closed(value, ["kind", "key", "subject"]);
	return {
		kind: oneOf(trigger.kind, ["cadence", "completed", "blocked", "runs-low", "deadline-near", "owner"]),
		key: identity(trigger.key, PROJECTION.keyText),
		subject: nullable(trigger.subject, (value) => identity(value, PROJECTION.keyText)),
	};
}

function parseReviewTurn(value: unknown): ReviewTurnView {
	const row = closed(value, [
		"key", "planRevision", "trigger", "state", "reason", "reviewId", "draftRevision", "requests", "at",
	]);
	const base = {
		key: identity(row.key, PROJECTION.keyText),
		planRevision: count(row.planRevision, 1),
		trigger: parseTrigger(row.trigger),
		reviewId: nullable(row.reviewId, identity),
		requests: count(row.requests),
		at: count(row.at),
	};
	const state = oneOf(row.state, ["running", "done", "skipped", "blocked"]);
	if (state !== "done" && row.draftRevision !== null) return invalid();
	if (state === "skipped")
		return { ...base, state, reason: oneOf(row.reason, ["budget", "hold", "unsettled"]), draftRevision: null };
	if (state === "blocked")
		return {
			...base, state, reason: oneOf(row.reason, ["unknown_request_outcome", "turn_failed", "authority"]), draftRevision: null,
		};
	if (row.reason !== null) return invalid();
	if (state === "done") return { ...base, state, reason: null, draftRevision: nullable(row.draftRevision, (value) => count(value, 1)) };
	return { ...base, state, reason: null, draftRevision: null };
}

function parseReviewItem(value: unknown): ReviewNote["items"][number] {
	const item = closed(value, ["id", "level", "status", "verifiedWorks", "listedWorks", "runIds", "blockReasons", "unsettled", "deadlineAt"]);
	const listedWorks = count(item.listedWorks);
	const verifiedWorks = count(item.verifiedWorks);
	const runIds = list(item.runIds, PROJECTION.itemRunIds, (value) => identity(value, PROJECTION.keyText));
	const unsettled = count(item.unsettled);
	if (verifiedWorks > listedWorks || unsettled > runIds.length) return invalid();
	return {
		id: identity(item.id, PROJECTION.itemIdText),
		level: oneOf(item.level, ["strategic", "tactical", "legacy"]),
		status: oneOf(item.status, ["on-track", "at-risk", "blocked", "done", "planned", "parked"]),
		verifiedWorks, listedWorks, runIds,
		blockReasons: list(item.blockReasons, PROJECTION.itemBlockReasons, (value) => text(value, PROJECTION.blockReasonText)),
		unsettled,
		deadlineAt: nullable(item.deadlineAt, (value) => count(value, 1)),
	};
}

function parseReviewFacts(value: unknown): ReviewNote["facts"] {
	const facts = closed(value, [
		"runsUsed", "runsLimit", "cycles", "maxCycles", "requests", "maxRequests", "estimatedCost", "maxEstimatedCost",
	]);
	const runsUsed = count(facts.runsUsed);
	if (runsUsed > RUN_LIMIT || facts.runsLimit !== RUN_LIMIT) return invalid();
	return {
		runsUsed,
		runsLimit: RUN_LIMIT,
		cycles: count(facts.cycles),
		maxCycles: count(facts.maxCycles),
		requests: count(facts.requests),
		maxRequests: count(facts.maxRequests),
		estimatedCost: amount(facts.estimatedCost),
		maxEstimatedCost: nullable(facts.maxEstimatedCost, amount),
	};
}

function parseDisposition(value: unknown): NonNullable<ReviewNote["disposition"]> {
	const row = closed(value, ["kind", "at", "draftRevision"]);
	const kind = oneOf(row.kind, ["dismissed", "drafted"]);
	const at = count(row.at);
	if (kind === "drafted") return { kind, at, draftRevision: count(row.draftRevision, 1) };
	if (row.draftRevision !== null) return invalid();
	return { kind, at, draftRevision: null };
}

function closed<const K extends string, const E extends string = never>(
	value: unknown,
	fields: readonly K[],
	extension?: readonly E[],
): Record<K, unknown> & Partial<Record<E, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	const length = Object.keys(value).length;
	if (fields.some((key) => !Object.hasOwn(value, key))) return invalid();
	if (length !== fields.length && (
		extension === undefined || length !== fields.length + extension.length || extension.some((key) => !Object.hasOwn(value, key))
	)) return invalid();
	// Required own fields are present; the legacy extension is either entirely absent or complete.
	return value as Record<K, unknown> & Partial<Record<E, unknown>>;
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
	return value === null ? null : parse(value);
}

function list<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > max) return invalid();
	return Array.from(value, parse);
}

function text(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length > max || UTF8.encode(value).length > max) return invalid();
	return value;
}

function identity(value: unknown, max = 200): string {
	const id = text(value, max);
	if (!id.trim()) return invalid();
	return id;
}

function itemId(value: unknown): string {
	const id = text(value, PROJECTION.itemIdText);
	if (id !== "" && !/^[a-z0-9][a-z0-9-]*$/.test(id)) return invalid();
	return id;
}

function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return invalid();
	return value;
}

function flag(value: unknown): boolean {
	if (typeof value !== "boolean") return invalid();
	return value;
}

function count(value: unknown, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return invalid();
	return value;
}

function amount(value: unknown): number {
	if (typeof value !== "number" || !(value >= 0 && value <= Number.MAX_SAFE_INTEGER)) return invalid();
	return value;
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T {
	for (const member of allowed) if (value === member) return member;
	return invalid();
}

function invalid(): never {
	throw new Error("Invalid mission plan projection.");
}
