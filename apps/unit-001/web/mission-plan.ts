// Validates the gateway's closed mission plan and review projections before the browser uses them.
import type { MissionPlanBinding } from "./contract.ts";
import type { PlanRevisionView, PlanTerms, PlanView, ReviewNote, ReviewTrigger } from "./mission-plan-contract.ts";

const RUN_LIMIT = 32;

/** Parses the complete plan projection without inferring authority from its recorded history. */
export function parsePlanView(value: unknown): PlanView {
	const plan = closed(value, [
		"missionId", "adopted", "head", "headValid", "previous", "history", "draft", "gate", "runs", "due", "preview", "reviews",
	]);
	const missionId = nullable(plan.missionId, identity);
	const adopted = flag(plan.adopted);
	const head = nullable(plan.head, parseRevision);
	const headValid = flag(plan.headValid);
	const previous = nullable(plan.previous, parseRevision);
	const history = list(plan.history, 32, (value) => {
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
	const due = list(plan.due, 16, parseTrigger);
	const preview = nullable(plan.preview, parseReviewNote);
	const reviews = list(plan.reviews, 12, parseReviewNote);
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
	return { missionId, adopted, head, headValid, previous, history, draft, gate, runs: { used, limit: RUN_LIMIT }, due, preview, reviews };
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
		items: list(note.items, 16, parseReviewItem),
		facts: parseReviewFacts(note.facts),
		uncertainty: list(note.uncertainty, 64, (value) => text(value, 400)),
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
		terms: parsePlanTerms(row.terms),
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
	const missing = list(row.missing, 64, (value) => text(value, 200));
	// The gateway withholds an unverifiable proposal digest without discarding the draft.
	if (revision <= baseRevision || (status === "editing" && proposalDigest !== null)) return invalid();
	return {
		revision, baseRevision, status,
		terms: parsePlanTerms(row.terms),
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

/** Validates and canonicalizes the closed terms shape without deciding whether it can be proposed. */
export function parsePlanTerms(value: unknown): PlanTerms {
	const input = closed(value, ["overall", "strategics", "tacticals"]);
	const overall = closed(input.overall, ["purpose", "scope", "askFirst", "reviewEveryMs"]);
	const terms: PlanTerms = {
		overall: {
			purpose: text(overall.purpose, 4096),
			scope: text(overall.scope, 4096),
			askFirst: list(overall.askFirst, 32, (value) => text(value, 2000)),
			reviewEveryMs: count(overall.reviewEveryMs),
		},
		strategics: list(input.strategics, 3, (value) => {
			const row = closed(value, ["id", "title", "intent", "signals", "priority"]);
			return {
				id: itemId(row.id),
				title: text(row.title, 200),
				intent: text(row.intent, 2048),
				signals: list(row.signals, 16, (value) => text(value, 1000)),
				priority: oneOf(row.priority, PRIORITIES),
			};
		}),
		tacticals: list(input.tacticals, 6, parseTactical),
	};
	if (UTF8.encode(JSON.stringify(terms)).length > 65536) return invalid();
	return terms;
}

function parseTactical(value: unknown): PlanTerms["tacticals"][number] {
	const row = closed(value, ["id", "strategic", "objective", "successCriteria", "priority", "deadlineAt", "mode", "binding"]);
	const base = {
		id: itemId(row.id),
		strategic: itemId(row.strategic),
		objective: text(row.objective, 2048),
		successCriteria: list(row.successCriteria, 16, (value) => text(value, 1000)),
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
		key: identity(trigger.key, 400),
		subject: nullable(trigger.subject, (value) => identity(value, 400)),
	};
}

function parseReviewItem(value: unknown): ReviewNote["items"][number] {
	const item = closed(value, ["id", "level", "status", "verifiedWorks", "listedWorks", "runIds", "blockReasons", "unsettled", "deadlineAt"]);
	const listedWorks = count(item.listedWorks);
	const verifiedWorks = count(item.verifiedWorks);
	const runIds = list(item.runIds, RUN_LIMIT, (value) => identity(value, 400));
	const unsettled = count(item.unsettled);
	if (verifiedWorks > listedWorks || unsettled > runIds.length) return invalid();
	return {
		id: identity(item.id, 64),
		level: oneOf(item.level, ["strategic", "tactical", "legacy"]),
		status: oneOf(item.status, ["on-track", "at-risk", "blocked", "done", "planned", "parked"]),
		verifiedWorks, listedWorks, runIds,
		blockReasons: list(item.blockReasons, RUN_LIMIT, (value) => text(value, 200)),
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

function closed<const K extends string>(value: unknown, fields: readonly K[]): Record<K, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	if (Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) return invalid();
	// Every required own JSON field is present; its value is still unknown.
	return value as Record<K, unknown>;
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
	const id = text(value, 64);
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
