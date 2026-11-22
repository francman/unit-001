// Renders Mission authoring and an exact, read-only agreement review; the shell owns freshness and requests.
import type { MissionAgreementView, MissionDraftTerms, MissionReviewView } from "../contract.ts";
import { callout, command } from "../ui/blocks.ts";
import { fields, surfaces, text } from "../ui/classes.ts";
import { button } from "../ui/controls.ts";
import { attrs, el } from "../ui/dom.ts";
import { dateTime, humanize } from "../ui/format.ts";
import { panel, section } from "../ui/page.ts";

type Editing = {
	expectedRevision: number;
	terms: MissionDraftTerms;
	saved: boolean;
	missing: readonly string[];
	onDirty: () => void;
	onSave: (expectedRevision: number, terms: MissionDraftTerms) => void;
	onReview: (expectedRevision: number) => void;
};

/** The native form stays mounted while its write permissions change. */
export interface MissionDraftEditor {
	root: HTMLElement;
	update(mode: "ready" | "local-only" | "locked"): void;
}

/** Options for the pinned Chat review; stale terms remain readable without an approval action. */
export type MissionDraftCardOptions = (
	| {
			kind: "review";
			missionId: string;
			revision: number;
			digest: string | null;
			terms: MissionDraftTerms;
			binding: { kind: "developer-local" } | { kind: "managed"; review: Pick<MissionReviewView, "authorityRevision" | "previousReceipt"> } | null;
			previous?: { revision: number; terms: MissionDraftTerms };
			/** Choose `web` only for affirmative developer-local capability in a verified session. */
			approval:
				| { kind: "web"; onAgree: (request: { revision: number; digest: string; confirmed: true }) => void }
				| { kind: "terminal"; line: string; copy: (value: string, label: string) => Promise<boolean> }
				| { kind: "stale" }
				| { kind: "unavailable" };
			onEdit: () => void;
	  }
	| { kind: "agreed"; agreement: Pick<MissionAgreementView, "revision" | "approvedAt" | "approvedBy">; byYou: boolean }
) & { disabled: boolean };

/** Builds a Mission draft card with no network, navigation, composer, or execution side effects. */
export function renderMissionDraftCard(options: MissionDraftCardOptions): HTMLElement {
	if (options.kind === "review") return draftCard(review(options));
	const { revision, approvedAt, approvedBy } = options.agreement;
	const by = { "local-creator": "the local creator", "host-administrator": "the host administrator", "developer-local": "the local developer" };
	return draftCard(attrs(el("p", text.body, `Agreed, revision ${revision}, ${dateTime(approvedAt)}, by ${options.byYou ? "you" : by[approvedBy]}. This did not start work.`), { role: "status" }));
}

function draftCard(body: HTMLElement): HTMLElement {
	const content = el("div", `flex min-w-0 flex-col gap-3 ${surfaces.panelBody}`, body);
	return section({ title: "Mission draft", id: "mission-draft-heading", icon: "target", children: [panel(content)] });
}

type Review = Extract<MissionDraftCardOptions, { kind: "review" }>;
type TermField<T> = { root: HTMLElement; read: () => T | undefined };

const limits = [
	["maxCycles", "Maximum cycles"],
	["maxRequests", "Maximum model requests"],
	["maxRetries", "Maximum retries"],
	["maxConsecutiveNoProgress", "Maximum consecutive cycles without progress"],
	["maxEstimatedCost", "Maximum estimated cost (USD)"],
] as const;
const fieldLayout = "flex min-w-0 flex-col gap-1.5";
// Unicode separators other than ASCII space, plus controls and literal backslashes.
const escapedTermCharacters = /[\\\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/gu;

/** Keeps the native form and its raw input alive while the shell checks the saved revision. */
export function createMissionDraftEditor(options: Editing): MissionDraftEditor {
	const { terms, expectedRevision, missing, saved } = options;
	const objective = textArea("mission-draft-objective", "Objective", terms.objective);
	const scope = textArea("mission-draft-scope", "Scope", terms.scope);
	const criteria = listField("success", "Success criteria", "success criterion", terms.successCriteria);
	const boundary = listField("boundary", "Approval boundary", "ask-first item", terms.approvalBoundary, "No ask-first items");
	const tools = listField("tools", "Allowed tools", "tool", terms.policy?.allowedTools, "No tools");
	const cadence = numericField("review", "Review interval (milliseconds)", terms.reviewEveryMs, "60,000 ms is one minute.");
	const deadline = deadlineField(terms.policy?.deadlineAt);
	const limitFields = limits.map(([key, label]) => ({ key, ...numericField(key, label, terms.policy?.[key]) }));
	const save = button({ label: "Save draft", key: "mission-draft-save", onClick: saveDraft });
	const propose = button({
		label: "Review for agreement",
		key: "mission-draft-propose",
		variant: "primary",
		onClick: () => options.onReview(expectedRevision),
	});
	const controls = el(
		"fieldset",
		"m-0 flex min-w-0 flex-col gap-3 p-0",
		el("legend", "sr-only", "Mission terms"),
		objective.root,
		scope.root,
		criteria.root,
		boundary.root,
		tools.root,
		cadence.root,
		deadline.root,
		...limitFields.map(({ root }) => root),
		el("div", "flex flex-wrap gap-2", save, propose),
	);
	const status = attrs(el(
		"p",
		text.description,
		`${saved ? `Revision ${expectedRevision} saved.` : "No draft saved yet."} ${missing.length > 0 ? `Still needed: ${missing.map(humanize).join(", ")}.` : saved ? "Ready to review." : "Save to check which terms are still needed."}`,
	), { role: "status" });
	const form = el(
		"form",
		"flex min-w-0 flex-col gap-3",
		status,
		attrs(el("p", text.description, "Text escapes: \\u000A is a line break, \\u0009 is a tab, \\u00A0 is a non-breaking space, and \\\\ is a literal backslash."), { id: "mission-draft-text-hint" }),
		controls,
	);
	let dirty = false;
	let mode: "ready" | "local-only" | "locked" = "ready";
	function update(next: typeof mode): void {
		mode = next;
		controls.disabled = mode === "locked";
		save.disabled = mode !== "ready" || (!dirty && saved);
		propose.disabled = mode !== "ready" || dirty || !saved || missing.length > 0;
	}
	form.addEventListener("input", () => {
		if (dirty || mode === "locked") return;
		dirty = true;
		status.textContent = `Unsaved edits based on revision ${expectedRevision}.`;
		update(mode);
		options.onDirty();
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
	});
	function saveDraft(): void {
		if (save.disabled || !form.reportValidity()) return;
		const terms: MissionDraftTerms = {};
		const policy: NonNullable<MissionDraftTerms["policy"]> = {};
		setTerm(terms, "objective", objective.read());
		setTerm(terms, "scope", scope.read());
		setTerm(terms, "successCriteria", criteria.read());
		setTerm(terms, "approvalBoundary", boundary.read());
		setTerm(terms, "reviewEveryMs", cadence.read());
		setTerm(policy, "allowedTools", tools.read());
		setTerm(policy, "deadlineAt", deadline.read());
		for (const field of limitFields) setTerm(policy, field.key, field.read());
		if (options.terms.policy !== undefined || Object.keys(policy).length > 0) terms.policy = policy;
		options.onSave(expectedRevision, terms);
	}
	update(mode);
	return { root: draftCard(form), update };
}

function setTerm<T, K extends keyof T>(terms: T, key: K, value: T[K]): void {
	if (value !== undefined) terms[key] = value;
}

function textArea(id: string, label: string, original: string | undefined): TermField<string> & { input: HTMLTextAreaElement } {
	const input = attrs(el("textarea", `${fields.input} min-h-16 resize-y py-1.5`), { id, rows: "2", "aria-describedby": "mission-draft-text-hint" });
	// Keep the editor's value reversible even when the browser normalizes textarea line endings.
	input.value = original?.replace(escapedTermCharacters, escapeCharacter) ?? "";
	const initial = input.value;
	return {
		root: el("div", fieldLayout, attrs(el("label", fields.label, label), { for: id }), input),
		input,
		read: () => {
			if (input.value === initial) return original;
			return input.value.replace(/\\\\|\\u(?:([\dA-Fa-f]{4})|\{([\dA-Fa-f]{1,6})\})/g, (match, bmp: string | undefined, extended: string | undefined) => {
				if (match === "\\\\") return "\\";
				const point = Number.parseInt((bmp ?? extended) || "", 16);
				return point <= 0x10ffff ? String.fromCodePoint(point) : match;
			}) || undefined;
		},
	};
}

function listField(id: string, label: string, itemName: string, original: readonly string[] | undefined, emptyLabel?: string): TermField<string[]> {
	const items = el("div", "flex flex-col gap-2");
	const entries: { row: HTMLElement; read: TermField<string>["read"] }[] = [];
	const status = el("p", text.description, original ? "No entries." : "Not set.");
	let defined = original !== undefined;
	let nextId = 0;
	const change = () => {
		defined = true;
		status.textContent = "No entries.";
		status.hidden = entries.length > 0;
		if (none) none.hidden = true;
		items.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const add = button({
		label: `Add ${itemName}`,
		key: `mission-draft-${id}-add`,
		variant: "ghost",
		onClick: () => {
			const input = addItem(undefined);
			change();
			input.focus();
		},
	});
	const none = emptyLabel ? button({ label: emptyLabel, key: `mission-draft-${id}-none`, variant: "ghost", onClick: () => { change(); add.focus(); } }) : null;
	function addItem(value: string | undefined): HTMLTextAreaElement {
		const key = `mission-draft-${id}-${++nextId}`;
		const field = textArea(key, `${itemName[0].toUpperCase()}${itemName.slice(1)} ${nextId}`, value);
		const remove = button({
			label: `Remove ${itemName} ${nextId}`,
			key: `${key}-remove`,
			variant: "ghost",
			onClick: () => {
				entries.splice(entries.indexOf(entry), 1);
				entry.row.remove();
				change();
				add.focus();
			},
		});
		const entry = { row: el("div", fieldLayout, field.root, el("div", "self-end", remove)), read: field.read };
		entries.push(entry);
		items.append(entry.row);
		return field.input;
	}
	for (const value of original ?? []) addItem(value);
	status.hidden = entries.length > 0;
	if (none) none.hidden = defined;
	return {
		root: el("fieldset", `m-0 p-0 ${fieldLayout}`, el("legend", fields.label, label), status, items, el("div", "flex flex-wrap gap-2", add, none)),
		read: () => (defined ? entries.map((entry) => entry.read() ?? "") : undefined),
	};
}

function numericField(key: string, label: string, value: number | undefined, hint?: string): TermField<number> {
	const id = `mission-draft-${key}`;
	const input = attrs(el("input", fields.input), { id });
	const root = el("div", fieldLayout, attrs(el("label", fields.label, label), { for: id }), input);
	input.type = "number";
	input.step = "any";
	input.value = value === undefined ? "" : String(value);
	if (hint) {
		const hintId = `${id}-hint`;
		input.setAttribute("aria-describedby", hintId);
		root.append(attrs(el("p", text.description, hint), { id: hintId }));
	}
	return { root, read: () => (input.value === "" ? undefined : input.valueAsNumber) };
}

function deadlineField(value: number | undefined): TermField<number> {
	const date = value === undefined ? null : new Date(value);
	const id = "mission-draft-deadline";
	const input = attrs(el("input", fields.input), { id });
	const root = el("div", fieldLayout, attrs(el("label", fields.label, "Deadline (UTC)"), { for: id }), input);
	input.type = "datetime-local";
	input.step = "0.001";
	if (date && Number.isFinite(date.getTime())) input.value = date.toISOString().slice(0, -1).replace(/^\+/, "");
	const initial = input.value;
	return { root, read: () => (input.value === initial ? value : input.value ? input.valueAsNumber : undefined) };
}

function review(options: Review): HTMLElement {
	const { missionId, revision, digest, terms, previous, binding, disabled, approval } = options;
	const rows = termRows(terms);
	const content = el(
		"div",
		"flex min-w-0 flex-col gap-3",
		el("p", text.body, `Review proposed revision ${revision}. Agreeing does not start work.`),
		el("p", text.description, "Text is quoted. Line breaks, invisible controls, non-ASCII spaces and literal backslashes are shown as escapes."),
		binding?.kind === "developer-local"
			? el("p", text.description, "The digest binds the developer-local authority revision, which is not shown here.")
			: null,
		reviewRows([
			["Mission ID", missionId],
			["Digest (SHA-256)", digest ?? undefined],
			...(binding?.kind === "managed" ? [
				["Authority revision", binding.review.authorityRevision],
				["Previous receipt", binding.review.previousReceipt ?? undefined],
			] satisfies TermRow[] : []),
			...rows,
		]),
	);
	if (previous) {
		const changes = termRows(previous.terms).filter(([label, value], index) =>
			(label !== "Allowed tools" || value !== undefined) && JSON.stringify(value) !== JSON.stringify(rows[index][1]));
		content.append(
			el("h3", text.heading, `What changed from agreed revision ${previous.revision}`),
			changes.length ? el("details", "min-w-0", el("summary", `cursor-pointer ${text.body}`, "Show previous values for changed terms"), reviewRows(changes)) : el("p", text.description, "No shown terms changed."),
		);
		if (previous.terms.policy?.allowedTools === undefined)
			content.append(el("p", text.description, "The previous allowed tool list was not reported."));
	}
	const actions = el(
		"div",
		"flex flex-wrap gap-2",
		button({ label: "Edit draft", key: "mission-draft-edit", disabled, onClick: options.onEdit }),
	);
	content.append(actions);
	if (approval.kind === "stale") {
		content.append(callout({ tone: "info", body: "Check fresh mission status before acting on these terms." }));
		return content;
	}
	if (digest === null || approval.kind === "unavailable") {
		content.append(callout({ tone: "info", body: "No reviewed digest is available in this session. Inspect mission status in a terminal." }));
		return content;
	}
	// A wire projection without the full proposal cannot support exact review.
	const exact = Number.isSafeInteger(revision) && revision > 0 && typeof missionId === "string" && missionId.length > 0 &&
		/^[a-f0-9]{64}$/.test(digest) && rows.every(([, value, optional]) => value !== undefined || optional);
	if (!exact) {
		content.append(callout({ tone: "warn", role: "status", body: "The complete proposal is not available to review. Refresh the draft or inspect it in a terminal." }));
		return content;
	}
	if (approval.kind === "web" && binding?.kind === "developer-local") {
		actions.append(button({
			label: `Agree to revision ${revision}`,
			key: `mission-draft-agree-${revision}-${digest}`,
			variant: "primary",
			disabled,
			onClick: () => approval.onAgree({ revision, digest, confirmed: true }),
		}));
	} else if (approval.kind === "terminal") {
		content.append(callout({
			tone: "info",
			body: "Browser agreement is unavailable. Approval requires the appropriate terminal authority.",
			children: [command(approval.line, "copy-mission-draft-approve", approval.copy)],
		}));
	}
	return content;
}

type TermValue = string | readonly string[] | number | undefined;
type TermRow = readonly [label: string, value: TermValue, optional?: true];

function termRows(terms: MissionDraftTerms): TermRow[] {
	return [
		["Objective", terms.objective],
		["Scope", terms.scope],
		["Success criteria", terms.successCriteria],
		["Approval boundary", terms.approvalBoundary],
		["Allowed tools", terms.policy?.allowedTools],
		["Review interval (milliseconds)", terms.reviewEveryMs],
		["Deadline (UTC, milliseconds since Unix epoch)", terms.policy?.deadlineAt],
		...limits.map(([key, label]): TermRow => [label, terms.policy?.[key], key === "maxEstimatedCost" ? true : undefined]),
	];
}

function reviewRows(rows: readonly TermRow[]): HTMLElement {
	const list = el("dl", "m-0 flex flex-col gap-2");
	for (const [label, value] of rows) {
		let shown;
		if (value === undefined) shown = "None";
		else if (typeof value === "number") {
			const date = label.startsWith("Deadline") ? new Date(value) : null;
			shown = date && Number.isFinite(date.getTime()) ? `${date.toISOString()} (${value} ms)` : String(value);
		} else if (typeof value === "string") shown = visibleText(value);
		else shown = value.length ? el("ol", "m-0 list-decimal pl-5", ...value.map((item) => el("li", "", visibleText(item)))) : "None (empty list)";
		list.append(el("div", "min-w-0", el("dt", fields.label, label), el("dd", `m-0 ${text.strong}`, shown)));
	}
	return list;
}

function visibleText(value: string): HTMLElement {
	const escaped = `"${value.replace(escapedTermCharacters, escapeCharacter).replaceAll('"', '\\"')}"`;
	return attrs(el("bdi", `whitespace-pre-wrap ${text.mono}`, escaped), { dir: "auto" });
}

function escapeCharacter(character: string): string {
	if (character === "\\") return "\\\\";
	const point = character.codePointAt(0) ?? 0;
	const hex = point.toString(16).toUpperCase();
	return point <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
}
