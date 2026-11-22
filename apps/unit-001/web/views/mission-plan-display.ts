// Shares exact plan terms and diffs between the timeline and the approval card.
import type { PlanTerms } from "../mission-plan-contract.ts";
import { text } from "../ui/classes.ts";
import { attrs, type Child, el } from "../ui/dom.ts";
import { facts } from "../ui/page.ts";

type TermRow = readonly [string, string | number | readonly string[] | null | undefined];

/** A copy-only terminal instruction prepared by the caller for the current installation. */
export type PlanTerminalCommand = { line: string; copy: (line: string, label: string) => Promise<boolean> };

const stack = "flex min-w-0 flex-col gap-3";
const heading = `${text.heading} [overflow-wrap:anywhere]`;
const escaped = /[\\\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/gu;

/** Encodes text without normalizing it, including isolated surrogate code units. */
export function encodePlanText(value: string): string {
	return value.replace(escaped, (character) => {
		if (character === "\\") return "\\\\";
		const point = character.codePointAt(0) ?? 0;
		const hex = point.toString(16).toUpperCase();
		return point <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
	});
}

/** Quotes and isolates text so invisible differences remain visible without changing the terms. */
export function visiblePlanText(value: string): HTMLElement {
	return attrs(el("bdi", `whitespace-pre-wrap ${text.mono}`, `"${encodePlanText(value).replaceAll('"', '\\"')}"`), { dir: "auto" });
}

/** Renders the reported value, distinguishing empty, absent and unreported terms. */
export function planTermRows(rows: readonly TermRow[]): HTMLDListElement {
	return facts(rows.map(([label, value]) => [label,
		value === undefined ? "Not reported" : value === null ? "None" : typeof value === "number" ? String(value) :
			typeof value === "string" ? visiblePlanText(value) : value.length
				? el("ol", "m-0 list-decimal pl-5", ...value.map((item) => el("li", "", visiblePlanText(item)))) : "None (empty list)",
	]));
}

/** Shows the exact terms using the same fields as the diff. */
export function exactPlanTerms(terms: PlanTerms): HTMLElement {
	return el("div", stack,
		el("h3", heading, "Overall"), planTermRows(overallRows(terms.overall)),
		...terms.strategics.map((strategic) => el("div", "min-w-0", el("h3", heading, "Strategy ", visiblePlanText(strategic.id)), planTermRows(strategicRows(strategic)))),
		terms.strategics.length ? null : el("p", text.description, "No strategies (empty list)."),
		...terms.tacticals.map((tactical) => el("div", "min-w-0", el("h3", heading, "Tactic ", visiblePlanText(tactical.id)), planTermRows(tacticalRows(tactical)))),
		terms.tacticals.length ? null : el("p", text.description, "No tactics (empty list)."),
	);
}

/** Shows every changed field, including ordering, and the tactics affected by a parent change. */
export function planTermsDiff(before: PlanTerms, after: PlanTerms, label: string, next: "Current" | "Draft"): HTMLElement {
	const changes = el("div", stack);
	const add = (name: Child, oldRows: TermRow[] | undefined, newRows: TermRow[] | undefined, affected: readonly string[] = []) => {
		if (!oldRows && !newRows) return;
		if (!oldRows || !newRows) {
			changes.append(el("h3", heading, name), el("p", text.body, oldRows ? "Removed" : "Added"), planTermRows(oldRows ?? newRows ?? []));
		} else {
			const updated = oldRows.flatMap(([field, oldValue], index) => {
				const newValue = newRows[index][1];
				return JSON.stringify(oldValue) === JSON.stringify(newValue) ? [] : [el("div", "min-w-0", el("h4", heading, field), planTermRows([["Previous", oldValue], [next, newValue]]))];
			});
			if (!updated.length) return;
			changes.append(el("h3", heading, name), ...updated);
		}
		if (affected.length) changes.append(planTermRows([["Affected tactics", affected]]));
	};
	const descendants = (strategic?: string) => [...new Set([...before.tacticals, ...after.tacticals]
		.filter((tactical) => strategic === undefined || tactical.strategic === strategic).map(({ id }) => id))];
	add("Overall", overallRows(before.overall), overallRows(after.overall), descendants());
	for (const id of new Set([...before.strategics, ...after.strategics].map(({ id }) => id))) {
		const old = before.strategics.find((item) => item.id === id);
		const current = after.strategics.find((item) => item.id === id);
		add(el("span", "", "Strategy ", visiblePlanText(id)), old && strategicRows(old), current && strategicRows(current), descendants(id));
	}
	for (const id of new Set([...before.tacticals, ...after.tacticals].map(({ id }) => id))) {
		const old = before.tacticals.find((item) => item.id === id);
		const current = after.tacticals.find((item) => item.id === id);
		add(el("span", "", "Tactic ", visiblePlanText(id)), old && tacticalRows(old), current && tacticalRows(current));
	}
	for (const [label, old, current] of [["Strategy order", before.strategics, after.strategics], ["Tactic order", before.tacticals, after.tacticals]] as const) {
		add(label, [["Ordered IDs", old.map(({ id }) => id)]], [["Ordered IDs", current.map(({ id }) => id)]]);
	}
	return el("details", "min-w-0", planDisclosure(label), changes.childElementCount ? changes : el("p", text.body, "No plan terms changed."));
}

/** Gives native disclosures a consistent focusable summary. */
export function planDisclosure(label: string): HTMLElement {
	return el("summary", `cursor-pointer py-1 ${text.strong}`, label);
}

/** Maps exact Overall terms to labelled rows. */
export function overallRows(overall: PlanTerms["overall"]): TermRow[] {
	return [["Purpose", overall.purpose], ["Scope", overall.scope], ["Ask first", overall.askFirst], ["Review interval (milliseconds)", overall.reviewEveryMs]];
}

/** Maps exact strategic terms to labelled rows. */
export function strategicRows(strategic: PlanTerms["strategics"][number]): TermRow[] {
	return [["Strategy ID", strategic.id], ["Title", strategic.title], ["Intent", strategic.intent], ["Success signals (reviewed, not host-verified)", strategic.signals], ["Priority", strategic.priority]];
}

/** Maps exact tactical terms and the full binding tuple to labelled rows. */
export function tacticalRows(tactical: PlanTerms["tacticals"][number]): TermRow[] {
	return [["Tactic ID", tactical.id], ["Parent strategy ID", tactical.strategic], ["Objective", tactical.objective],
		["Success criteria", tactical.successCriteria], ["Priority", tactical.priority],
		["Deadline (UTC, milliseconds since Unix epoch)", tactical.deadlineAt], ["Mode", tactical.mode],
		["Bound mission ID", tactical.binding?.missionId ?? null], ["Bound purpose revision", tactical.binding?.purposeRevision ?? null],
		["Bound purpose digest (SHA-256)", tactical.binding?.purposeDigest ?? null]];
}
