// Defines the mission plan's terms (overall purpose, strategics, tacticals) and checks them; terms grant nothing.
import { missionNumber, missionObject, missionText, missionTextList } from "./contract.ts";
import { type LoopState, loopAgreement } from "./purpose-loop.ts";

export type PlanPriority = "high" | "normal" | "low";

/** The enduring purpose of the whole plan; `reviewEveryMs` is the assignment-review cadence, not the loop's. */
export type PlanOverall = { purpose: string; scope: string; askFirst: string[]; reviewEveryMs: number };

/** A medium-horizon outcome; its signals are judged by review, never verified by the host. */
export type PlanStrategic = { id: string; title: string; intent: string; signals: string[]; priority: PlanPriority };

/** Names the one agreed purpose revision a runnable tactical runs as; the purpose receipt stays its only authority. */
export type PlanBinding = { missionId: string; purposeRevision: number; purposeDigest: string };

/**
 * A bounded tactical under one strategic. `runnable` binds an agreed purpose revision; `parked` is set not runnable by
 * the owner; `planned` has no host verifier and is never admitted.
 */
export type PlanTactical = {
	id: string;
	strategic: string;
	objective: string;
	successCriteria: string[];
	priority: PlanPriority;
	deadlineAt: number | null;
	mode: "runnable" | "parked" | "planned";
	binding: PlanBinding | null;
};

/** The whole plan one receipt agrees: its digest covers every level at once. */
export type PlanTerms = { overall: PlanOverall; strategics: PlanStrategic[]; tacticals: PlanTactical[] };

/** Most strategics one plan revision lists. */
export const MAX_STRATEGICS = 3;

/** Most current tacticals one plan revision lists. */
export const MAX_TACTICALS = 6;

/** Parses plan terms crossing the wire or stored boundary: closed shapes, bounded text; semantic checks come later. */
export function parsePlanTerms(value: unknown): PlanTerms {
	const input = closed(value, ["overall", "strategics", "tacticals"], "plan");
	if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error("Plan terms exceed 64 KiB.");
	const overall = closed(input.overall, ["purpose", "scope", "askFirst", "reviewEveryMs"], "overall purpose");
	if (!Array.isArray(input.strategics) || input.strategics.length > MAX_STRATEGICS)
		throw new Error(`A plan lists at most ${MAX_STRATEGICS} strategics.`);
	if (!Array.isArray(input.tacticals) || input.tacticals.length > MAX_TACTICALS)
		throw new Error(`A plan lists at most ${MAX_TACTICALS} tacticals.`);
	return {
		overall: {
			purpose: missionText(overall.purpose, 4096),
			scope: missionText(overall.scope, 4096),
			askFirst: missionTextList(overall.askFirst, 32, 2000),
			reviewEveryMs: whole(overall.reviewEveryMs, 0),
		},
		strategics: input.strategics.map(parseStrategic),
		tacticals: input.tacticals.map(parseTactical),
	};
}

/** Lists what a draft still needs before it can be proposed; an empty list means complete. */
export function missingPlanTerms(terms: PlanTerms): string[] {
	const missing: string[] = [];
	if (!terms.overall.purpose.trim()) missing.push("purpose");
	if (!terms.overall.scope.trim()) missing.push("scope");
	if (terms.overall.reviewEveryMs < 1) missing.push("review cadence");
	for (const strategic of terms.strategics) {
		if (!strategic.id.trim() || !strategic.title.trim() || !strategic.intent.trim())
			missing.push(`strategic ${strategic.id || "(no id)"}`);
	}
	for (const tactical of terms.tacticals) {
		if (!tactical.id.trim() || !tactical.objective.trim() || tactical.successCriteria.length === 0)
			missing.push(`tactical ${tactical.id || "(no id)"}`);
	}
	return missing;
}

/**
 * Why complete terms cannot be proposed against the stored loop, if they cannot: duplicate or orphan IDs, more than one
 * runnable tactical, or a runnable binding that is not exactly an agreed purpose revision and digest.
 */
export function planTermsDenial(terms: PlanTerms, loop: LoopState | undefined): string | undefined {
	const strategicIds = terms.strategics.map((item) => item.id);
	const tacticalIds = terms.tacticals.map((item) => item.id);
	if (new Set([...strategicIds, ...tacticalIds]).size !== strategicIds.length + tacticalIds.length)
		return "Plan item IDs must be distinct.";
	const orphan = terms.tacticals.find((tactical) => !strategicIds.includes(tactical.strategic));
	if (orphan) return `Tactical ${orphan.id} names no strategic in this plan.`;
	const runnable = terms.tacticals.filter((tactical) => tactical.mode === "runnable");
	if (runnable.length > 1) return "At most one tactical can be runnable in this slice.";
	for (const tactical of terms.tacticals) {
		if ((tactical.mode === "runnable") !== (tactical.binding !== null))
			return `Tactical ${tactical.id}: only a runnable tactical binds a purpose, and it must.`;
	}
	const binding = runnable[0]?.binding;
	if (!binding) return undefined;
	const agreement = loop && loopAgreement(loop, binding.purposeRevision);
	if (!agreement || agreement.missionId !== binding.missionId || agreement.digest !== binding.purposeDigest)
		return "The runnable tactical must bind an exact agreed purpose revision and digest.";
	return undefined;
}

function parseStrategic(value: unknown): PlanStrategic {
	const input = closed(value, ["id", "title", "intent", "signals", "priority"], "strategic");
	return {
		id: itemId(input.id),
		title: missionText(input.title, 200),
		intent: missionText(input.intent, 2048),
		signals: missionTextList(input.signals, 16, 1000),
		priority: priority(input.priority),
	};
}

function parseTactical(value: unknown): PlanTactical {
	const input = closed(
		value,
		["id", "strategic", "objective", "successCriteria", "priority", "deadlineAt", "mode", "binding"],
		"tactical",
	);
	if (input.mode !== "runnable" && input.mode !== "parked" && input.mode !== "planned")
		throw new Error("Unknown tactical mode.");
	return {
		id: itemId(input.id),
		strategic: itemId(input.strategic),
		objective: missionText(input.objective, 2048),
		successCriteria: missionTextList(input.successCriteria, 16, 1000),
		priority: priority(input.priority),
		deadlineAt: input.deadlineAt === null ? null : whole(input.deadlineAt, 1),
		mode: input.mode,
		binding: input.binding === null ? null : parseBinding(input.binding),
	};
}

function parseBinding(value: unknown): PlanBinding {
	const input = closed(value, ["missionId", "purposeRevision", "purposeDigest"], "binding");
	const purposeDigest = missionText(input.purposeDigest, 64);
	if (!/^[0-9a-f]{64}$/.test(purposeDigest)) throw new Error("A binding needs an exact purpose digest.");
	return { missionId: missionText(input.missionId), purposeRevision: whole(input.purposeRevision, 1), purposeDigest };
}

// Every plan shape is closed and complete: a missing field is an error, never a default the creator did not see.
function closed(value: unknown, fields: string[], name: string): Record<string, unknown> {
	const input = missionObject(value);
	const keys = Object.keys(input);
	if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
		throw new Error(`The ${name} needs exactly: ${fields.join(", ")}.`);
	return input;
}

// Item IDs are short stable slugs, so history and review notes can cite them across revisions.
function itemId(value: unknown): string {
	const id = missionText(value, 64);
	if (id !== "" && !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Plan item IDs are lowercase slugs.");
	return id;
}

function priority(value: unknown): PlanPriority {
	if (value !== "high" && value !== "normal" && value !== "low") throw new Error("Unknown plan priority.");
	return value;
}

function whole(value: unknown, minimum: number): number {
	const number = missionNumber(value);
	if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`Plan numbers are integers from ${minimum}.`);
	return number;
}
