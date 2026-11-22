// Renders local charter authoring and exact proposal review; the caller owns freshness and writes.
import type { WorkspaceDetails } from "../contract.ts";
import type { PlanTerms, PlanView, ReviewAllowance } from "../mission-plan-contract.ts";
import { callout, command } from "../ui/blocks.ts";
import { fields, surfaces, text } from "../ui/classes.ts";
import { button } from "../ui/controls.ts";
import { attrs, type Child, el } from "../ui/dom.ts";
import { duration } from "../ui/format.ts";
import { panel, section } from "../ui/page.ts";
import {
	encodePlanText, exactPlanTerms, type PlanTerminalCommand, planTermRows, planTermsDiff, visiblePlanText,
} from "./mission-plan-display.ts";

type Strategic = PlanTerms["strategics"][number];
type Tactical = PlanTerms["tacticals"][number];
type Binding = NonNullable<Tactical["binding"]>;
type Draft = NonNullable<PlanView["draft"]>;
type ExactProposal = { revision: number; digest: string };
type Mission = WorkspaceDetails["mission"];

type EditorAccess = { canSave: boolean; canReview: boolean; locked?: boolean };

/** Authoring inputs and the only callbacks that may write the draft or request exact review. */
export interface MissionPlanEditorOptions {
	terms: PlanTerms;
	expectedRevision: number;
	draft: Pick<Draft, "baseRevision" | "status" | "savedBy" | "fromReview" | "missing"> | null;
	bindings: readonly Binding[];
	access: EditorAccess;
	onDirty: () => void;
	onSave: (expectedRevision: number, terms: PlanTerms) => void;
	onReview: (expectedRevision: number) => void;
}

/** Keep this form mounted; change access without rebasing terms or replacing native inputs. */
export interface MissionPlanEditor {
	root: HTMLElement;
	update(access: EditorAccess): void;
}

/** The caller supplies the projected proposal, current context, and an affirmative action for that exact pair. */
export interface MissionPlanDraftCardOptions {
	missionId: PlanView["missionId"];
	draft: Draft;
	head: Pick<NonNullable<PlanView["head"]>, "revision" | "digest" | "receiptId" | "terms"> | null;
	authority: Mission["authority"];
	currentEffect: Mission["execution"] | null;
	gate?: PlanView["gate"];
	creator?: Mission["creator"];
	installationId?: string | null;
	session?: string;
	authorityRevision?: number;
	approval:
		| ({ kind: "web"; onAgree: (proposal: ExactProposal) => void } & ExactProposal)
		| ({ kind: "terminal" } & ExactProposal & PlanTerminalCommand)
		| { kind: "unavailable" };
	onEdit?: () => void;
}

const stack = "flex min-w-0 flex-col gap-3";
const fieldLayout = "flex min-w-0 flex-col gap-1.5";
const actions = "flex flex-wrap gap-2";
const priorities = ["high", "normal", "low"] as const satisfies readonly Strategic["priority"][];
const modes = ["planned", "parked", "runnable"] as const satisfies readonly Tactical["mode"][];
const sha256 = /^[a-f0-9]{64}$/;
const textHint = "mission-plan-draft-text-hint";

/** Builds a stable native editor. It never proposes local edits or chooses a purpose binding. */
export function createMissionPlanDraftEditor(options: MissionPlanEditorOptions): MissionPlanEditor {
	const { terms, expectedRevision, draft } = options;
	let access = options.access;
	let dirty = false;
	const overall = overallFields(terms.overall);
	const strategics = rows("strategy", "Strategies", "strategy", 3, terms.strategics, strategicFields);
	const tacticals = rows("tactic", "Tactics", "tactic", 6, terms.tacticals, (id, original) => tacticalFields(id, original, options.bindings));
	const status = attrs(el("p", text.description), { role: "status" });
	const save = button({ label: "Save draft", key: "mission-plan-draft-save", onClick: saveDraft });
	const review = button({ label: "Review for agreement", key: "mission-plan-draft-review", variant: "primary", onClick: () => {
		if (!review.disabled) options.onReview(expectedRevision);
	} });
	const controls = fieldset("Plan terms", overall.root, strategics.root, tacticals.root, el("div", actions, save, review));
	const savedBy = draft?.savedBy === "bob" ? "Bob" : "the owner";
	const savedStatus = !draft ? "No plan draft saved yet."
		: draft.status === "proposed"
			? `Editing proposed revision ${expectedRevision}. Saving creates a new editing revision; it must be proposed again before agreement. Saved by ${savedBy} (base ${draft.baseRevision}).`
			: `Revision ${expectedRevision} saved by ${savedBy} (base ${draft.baseRevision}).`;
	const form = el("form", stack,
		el("p", text.body, savedStatus),
		draft?.fromReview != null ? el("p", text.body, "Drafted from review ", visiblePlanText(draft.fromReview), ".") : null,
		draft?.missing.length ? el("p", text.body, `Still needed: ${draft.missing.map(encodePlanText).join(", ")}.`) : null,
		status,
		attrs(el("p", text.description, "Text escapes: \\u000A is a line break, \\u0009 is a tab, and \\\\ is a literal backslash."), { id: textHint }),
		controls);
	function update(next: EditorAccess): void {
		access = next;
		controls.disabled = access.locked === true;
		save.disabled = controls.disabled || !access.canSave || (!dirty && draft !== null);
		review.disabled = controls.disabled || !access.canReview || dirty || draft?.status !== "editing" || draft.missing.length > 0;
	}
	form.addEventListener("input", markDirty);
	form.addEventListener("change", markDirty);
	form.addEventListener("submit", (event) => event.preventDefault());
	function markDirty(): void {
		if (dirty || controls.disabled) return;
		dirty = true;
		status.textContent = `Unsaved edits based on revision ${expectedRevision}.`;
		update(access);
		options.onDirty();
	}
	function saveDraft(): void {
		if (save.disabled || !form.reportValidity()) return;
		const tactics = tacticals.read();
		if (tactics.length > 1 && tactics.filter(({ mode }) => mode === "runnable").length > 1) {
			status.textContent = "Only one tactic can be runnable. Park or plan the others before saving.";
			return;
		}
		status.textContent = dirty ? `Unsaved edits based on revision ${expectedRevision}.` : "";
		options.onSave(expectedRevision, { overall: overall.read(), strategics: strategics.read(), tacticals: tactics });
	}
	update(access);
	return { root: card(form), update };
}

/** Shows every term covered by the digest; agreeing never opens or starts work. */
export function renderMissionPlanDraftCard(options: MissionPlanDraftCardOptions): HTMLElement {
	const { missionId, draft, head, currentEffect, authority, creator, approval } = options;
	const base = head?.revision === draft.baseRevision ? head : null;
	const { revision, digest } = draft;
	const body = el("div", stack,
		el("p", text.body, draft.status === "proposed" ? `Review proposed plan revision ${revision}.` : `Plan draft revision ${revision} is not proposed.`),
		el("p", text.body, "Agreement records these terms. It does not open or start work. After a new agreement, admitting work requires a separate Open."),
		el("p", text.description, "Exact text is quoted. Line breaks, invisible controls, non-ASCII spaces and literal backslashes are escaped."),
		planTermRows([
			["Mission ID", missionId], ["Plan revision", revision], ["Base revision", draft.baseRevision],
			["Previous plan digest (SHA-256)", base?.digest ?? (draft.baseRevision === 0 ? null : undefined)],
			["Base approval receipt", base?.receiptId ?? (draft.baseRevision === 0 ? null : undefined)],
			["Proposed digest (SHA-256)", digest], ["Saved by", draft.savedBy === "bob" ? "Bob" : "the owner"],
			["Drafted from review", draft.fromReview],
			["Current privileged effect", currentEffect ?? undefined], ["Authority", authority],
			...(options.gate ? [["Current plan admission", options.gate.state], ["Admission reason", options.gate.reason]] as const : []),
			...(creator ? [["Creator kind", creator.kind], ["Creator ID", creator.id]] as const : []),
			...(options.installationId !== undefined ? [["Installation ID", options.installationId]] as const : []),
			...(options.session !== undefined ? [["Session", options.session]] as const : []),
			...(options.authorityRevision !== undefined ? [["Authority revision", options.authorityRevision]] as const : []),
		]),
		el("p", text.description, "The digest also binds the installation, session and creator authority. Only projected values are shown here."),
		base ? planTermsDiff(base.terms, draft.terms, `Diff from base revision ${base.revision}`, "Draft") : null,
		exactPlanTerms(draft.terms),
	);
	const edit = options.onEdit && button({ label: "Edit draft", key: "mission-plan-draft-edit", onClick: options.onEdit });
	const buttons = el("div", actions, edit);
	const exact = draft.status === "proposed" && digest !== null && sha256.test(digest) && !!missionId &&
		Number.isSafeInteger(revision) && revision > draft.baseRevision && draft.missing.length === 0 &&
		(draft.baseRevision === 0 ? head === null : base !== null && sha256.test(base.digest));
	const currentApproval = exact && approval.kind !== "unavailable" && approval.revision === revision && approval.digest === digest;
	const canAgree = currentApproval && approval.kind === "web" && authority === "developer-local";
	const canUseTerminal = currentApproval && approval.kind === "terminal" &&
		(authority === "managed-administrator" || authority === "developer-local");
	if (canAgree) {
		buttons.append(button({ label: `Agree to plan revision ${revision}`, key: `mission-plan-draft-agree-${revision}-${digest}`,
			variant: "primary", onClick: () => approval.onAgree({ revision, digest }) }));
	}
	if (buttons.childElementCount) body.append(buttons);
	if (canUseTerminal) {
		body.append(callout({ tone: "info", body: "To agree to this exact revision, use the terminal command.", children: [
			command(approval.line, "mission-plan-draft-copy-approval", approval.copy),
		] }));
	} else if (!canAgree && draft.status === "proposed") {
		body.append(callout({ tone: "info", body: "No exact agreement action is available from the current status." }));
	}
	return card(body);
}

function card(body: HTMLElement): HTMLElement {
	return section({ title: "Plan draft", id: "mission-plan-draft-heading", icon: "target", children: [panel(el("div", surfaces.panelBody, body))] });
}

type Field<T> = { root: HTMLElement; read: () => T };

function overallFields(original: PlanTerms["overall"]): Field<PlanTerms["overall"]> {
	const purpose = textField("purpose", "Purpose", original.purpose);
	const scope = textField("scope", "Scope", original.scope);
	const askFirst = listField("ask-first", "Ask first", "ask-first item", 32, original.askFirst);
	const reviewEveryMs = numberField("review-every", "Review interval (milliseconds)", original.reviewEveryMs, 0,
		(ms) => ms === 0 ? "0 ms" : `About ${duration(ms)}`);
	reviewEveryMs.input.required = true;
	const reviewAllowance = reviewAllowanceFields(original.reviewAllowance ?? null);
	return {
		root: fieldset("Overall", purpose.root, scope.root, askFirst.root, reviewEveryMs.root, reviewAllowance.root),
		read: () => ({ purpose: purpose.read(), scope: scope.read(), askFirst: askFirst.read(),
			reviewEveryMs: reviewEveryMs.input.valueAsNumber, reviewAllowance: reviewAllowance.read() }),
	};
}

function reviewAllowanceFields(original: ReviewAllowance | null): Field<ReviewAllowance | null> {
	const optIn = attrs(el("input", ""), { type: "checkbox", id: "mission-plan-draft-review-opt-in" });
	optIn.checked = original !== null;
	const maxRequests = attrs(el("input", fields.input), { type: "number", min: "1", max: String(Number.MAX_SAFE_INTEGER), step: "1", required: "" });
	const maxPerReview = attrs(el("input", fields.input), {
		type: "number", min: "1", step: "1", required: "", "aria-describedby": "mission-plan-draft-review-per-review-hint",
	});
	const maxCost = attrs(el("input", fields.input), {
		type: "number", step: "any", "aria-describedby": "mission-plan-draft-review-cost-hint",
	});
	if (original) {
		maxRequests.value = String(original.maxRequests);
		maxPerReview.value = String(original.maxRequestsPerReview);
		maxCost.value = original.maxEstimatedCost === null ? "" : String(original.maxEstimatedCost);
	}
	const limits = fieldset("Model review allowance",
		labelled("review-max-requests", "Lifetime review request limit", maxRequests),
		labelled("review-max-per-review", "Requests per review limit", maxPerReview),
		attrs(el("p", text.description, "Enter 1 to 4 requests, no more than the lifetime review request limit."), {
			id: "mission-plan-draft-review-per-review-hint",
		}),
		labelled("review-max-cost", "Review estimated cost cap (USD)", maxCost),
		attrs(el("p", text.description,
			"Leave blank for no separate review cost cap; purpose limits still apply. If the creator set a purpose cost cap, you must enter a cap at or below it to propose the plan."), {
			id: "mission-plan-draft-review-cost-hint",
		}),
	);
	const sync = () => {
		limits.hidden = limits.disabled = !optIn.checked;
		maxPerReview.max = String(Math.min(4, maxRequests.valueAsNumber || 4));
		maxCost.setCustomValidity(maxCost.value && !(maxCost.valueAsNumber > 0) ? "Enter a positive cost cap or leave it blank." : "");
	};
	const root = el("div", fieldLayout,
		attrs(el("label", `flex items-center gap-2 ${fields.label}`, optIn, "Opt in to model reviews"), { for: optIn.id }),
		el("p", text.description, "This sets the terms for model reviews. Saving or agreeing does not start one."),
		limits,
	);
	root.addEventListener("input", sync);
	root.addEventListener("change", sync);
	sync();
	return {
		root,
		read: () => optIn.checked ? {
			maxRequests: maxRequests.valueAsNumber,
			maxRequestsPerReview: maxPerReview.valueAsNumber,
			maxEstimatedCost: maxCost.value === "" ? null : maxCost.valueAsNumber,
		} : null,
	};
}

function strategicFields(id: string, original?: Strategic): Field<Strategic> {
	const itemId = slugField(`${id}-id`, "Strategy ID", original?.id ?? "");
	const title = textField(`${id}-title`, "Title", original?.title ?? "");
	const intent = textField(`${id}-intent`, "Intent", original?.intent ?? "");
	const signals = listField(`${id}-signals`, "Success signals (reviewed, not host-verified)", "signal", 16, original?.signals ?? []);
	const priority = choiceField(`${id}-priority`, "Priority", priorities, original?.priority ?? "normal");
	return { root: el("div", fieldLayout, itemId.root, title.root, intent.root, signals.root, priority.root),
		read: () => ({ id: itemId.input.value, title: title.read(), intent: intent.read(), signals: signals.read(), priority: priority.read() }) };
}

function tacticalFields(id: string, original: Tactical | undefined, bindings: readonly Binding[]): Field<Tactical> {
	const itemId = slugField(`${id}-id`, "Tactic ID", original?.id ?? "");
	const strategic = slugField(`${id}-strategic`, "Parent strategy ID", original?.strategic ?? "");
	const objective = textField(`${id}-objective`, "Objective", original?.objective ?? "");
	const criteria = listField(`${id}-criteria`, "Success criteria", "criterion", 16, original?.successCriteria ?? []);
	const priority = choiceField(`${id}-priority`, "Priority", priorities, original?.priority ?? "normal");
	const deadline = numberField(`${id}-deadline`, "Deadline (UTC, milliseconds since Unix epoch)", original?.deadlineAt ?? null, 1, (ms) => {
		const time = new Date(ms);
		return Number.isFinite(time.getTime()) ? time.toISOString() : "Outside the ISO date range";
	});
	const mode = choiceField(`${id}-mode`, "Mode", modes, original?.mode ?? "planned");
	const binding = bindingField(`${id}-binding`, bindings, original?.binding ?? null);
	const syncBinding = () => {
		binding.input.required = mode.read() === "runnable";
		binding.input.disabled = !binding.input.required;
		binding.root.hidden = binding.input.disabled;
	};
	mode.input.addEventListener("input", syncBinding);
	mode.input.addEventListener("change", syncBinding);
	syncBinding();
	return {
		root: el("div", fieldLayout, itemId.root, strategic.root, objective.root, criteria.root, priority.root, deadline.root, mode.root, binding.root),
		read: () => {
			const selected = mode.read();
			const terms = { id: itemId.input.value, strategic: strategic.input.value, objective: objective.read(), successCriteria: criteria.read(),
				priority: priority.read(), deadlineAt: deadline.input.value === "" ? null : deadline.input.valueAsNumber };
			return selected === "runnable" ? { ...terms, mode: selected, binding: binding.read() } : { ...terms, mode: selected, binding: null };
		},
	};
}

function fieldset(label: string, ...children: Child[]): HTMLFieldSetElement {
	return el("fieldset", `m-0 p-0 ${stack}`, el("legend", fields.label, label), ...children);
}

function rows<T>(key: string, label: string, item: string, maximum: number, initial: readonly T[], create: (id: string, original?: T) => Field<T>): Field<T[]> {
	const items = el("div", stack);
	const entries: Field<T>[] = [];
	let serial = 0;
	const add = button({ label: `Add ${item}`, key: `mission-plan-draft-${key}-add`, variant: "ghost", onClick: () => {
		if (add.disabled) return;
		const row = append();
		changed();
		row.querySelector<HTMLElement>("input, textarea, select")?.focus();
	} });
	function sync(): void { add.disabled = entries.length >= maximum; }
	function changed(): void {
		sync();
		items.dispatchEvent(new Event("input", { bubbles: true }));
	}
	function append(original?: T): HTMLElement {
		// This counter identifies controls, not plan items. New plan IDs are always authored explicitly.
		const n = ++serial;
		const id = `${key}-${n}`;
		const field = create(id, original);
		const remove = button({ label: `Remove ${item} ${n}`, key: `mission-plan-draft-${id}-remove`, variant: "ghost", onClick: () => {
			entries.splice(entries.indexOf(entry), 1);
			entry.root.remove();
			changed();
			add.focus();
		} });
		const entry = { root: fieldset(`${item[0].toUpperCase()}${item.slice(1)} ${n}`, field.root, el("div", actions, remove)), read: field.read };
		entries.push(entry);
		items.append(entry.root);
		return entry.root;
	}
	for (const value of initial) append(value);
	sync();
	return { root: fieldset(label, items, el("div", actions, add)), read: () => entries.map((entry) => entry.read()) };
}

function listField(key: string, label: string, item: string, maximum: number, initial: readonly string[]): Field<string[]> {
	return rows(key, label, item, maximum, initial, (id, original) => textField(id, item, original ?? ""));
}

function labelled(id: string, label: string, input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): HTMLElement {
	input.id = `mission-plan-draft-${id}`;
	return el("div", fieldLayout, attrs(el("label", fields.label, label), { for: input.id }), input);
}

function textField(id: string, label: string, original: string): Field<string> {
	const input = attrs(el("textarea", `${fields.input} min-h-16 resize-y py-1.5`), { rows: "2", "aria-describedby": textHint });
	// Encode before assigning to the textarea, whose value normalizes raw line endings.
	const encoded = encodePlanText(original);
	input.value = encoded;
	return { root: labelled(id, label, input), read: () => input.value === encoded ? original :
		input.value.replace(/\\\\|\\u(?:([\dA-Fa-f]{4})|\{([\dA-Fa-f]{1,6})\})/g,
			(match, bmp: string | undefined, extended: string | undefined) => {
				if (match === "\\\\") return "\\";
				const point = Number.parseInt((bmp ?? extended) || "", 16);
				// Do not turn newly typed escapes into isolated UTF-16 surrogate code units.
				return point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? match : String.fromCodePoint(point);
			}) };
}

function slugField(id: string, label: string, value: string): { root: HTMLElement; input: HTMLInputElement } {
	const input = attrs(el("input", fields.input), { pattern: "[a-z0-9][a-z0-9\\-]*", maxlength: "64", title: "Lowercase letters, digits and hyphens; start with a letter or digit." });
	input.value = value;
	input.spellcheck = false;
	return { root: labelled(id, label, input), input };
}

function numberField(id: string, label: string, value: number | null, minimum: number, format: (value: number) => string): { root: HTMLElement; input: HTMLInputElement } {
	const hintId = `mission-plan-draft-${id}-hint`;
	const input = attrs(el("input", fields.input), {
		type: "number", min: String(minimum), max: String(Number.MAX_SAFE_INTEGER), step: "1", "aria-describedby": hintId,
	});
	input.value = value === null ? "" : String(value);
	const hint = attrs(el("p", text.description), { id: hintId });
	const update = () => {
		hint.textContent = input.value && input.validity.valid ? format(input.valueAsNumber) : "";
		hint.hidden = hint.textContent === "";
	};
	input.addEventListener("input", update);
	update();
	const root = labelled(id, label, input);
	root.append(hint);
	return { root, input };
}

function choiceField<T extends string>(id: string, label: string, choices: readonly T[], current: T): Field<T> & { input: HTMLSelectElement } {
	const input = el("select", fields.input, ...choices.map((choice) => attrs(el("option", "", choice), { value: choice })));
	input.value = current;
	return { root: labelled(id, label, input), input, read: () => choices[input.selectedIndex] };
}

function bindingField(id: string, bindings: readonly Binding[], original: Binding | null): Field<Binding> & { input: HTMLSelectElement } {
	const label = (binding: Binding) => `${binding.missionId} · revision ${binding.purposeRevision} · ${binding.purposeDigest}`;
	const initial = original && bindings.findIndex((binding) => binding.missionId === original.missionId &&
		binding.purposeRevision === original.purposeRevision && binding.purposeDigest === original.purposeDigest);
	const input = el("select", fields.input,
		attrs(el("option", "", bindings.length ? "Choose an agreed purpose" : "No agreed purpose available"), { value: "" }),
		...bindings.map((binding, i) => attrs(el("option", "", encodePlanText(label(binding))), { value: String(i) })));
	const root = labelled(id, "Exact agreed purpose binding", input);
	if (initial !== null && initial >= 0) input.selectedIndex = initial + 1;
	const detail = el("p", text.description);
	const describe = () => {
		const selected = bindings[input.selectedIndex - 1];
		detail.replaceChildren();
		if (selected) detail.append(visiblePlanText(label(selected)));
		else if (original && initial === -1)
			detail.append("Current binding is not one of the allowed choices: ", visiblePlanText(label(original)));
		detail.hidden = detail.childNodes.length === 0;
	};
	input.addEventListener("input", describe);
	input.addEventListener("change", describe);
	describe();
	root.append(detail);
	// The native required select is validated before any runnable row is read.
	return { root, input, read: () => bindings[input.selectedIndex - 1] };
}
