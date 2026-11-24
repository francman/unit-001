// Renders the Mission plan, recorded reviews, and exact revision history without performing operations.
import type { PlanTerms, PlanView, ReviewNote, ReviewTrigger, ReviewTurnView } from "../mission-plan-contract.ts";
import { callout, command, tag } from "../ui/blocks.ts";
import { surfaces, text } from "../ui/classes.ts";
import { button } from "../ui/controls.ts";
import { attrs, type Child, el } from "../ui/dom.ts";
import { duration } from "../ui/format.ts";
import { facts, panel, section } from "../ui/page.ts";
import { encodeExactText, visibleExactText as visibleText } from "./exact-text.ts";
import {
	exactPlanTerms as exactTerms, noSeparateReviewCap, overallRows, planDisclosure as disclosure, type PlanTerminalCommand,
	planTermRows as termRows, planTermsDiff as termsDiff, strategicRows, tacticalRows,
} from "./mission-plan-display.ts";

/** The caller supplies closed projection data and chooses which actions are available. */
export interface MissionPlanOptions {
	plan: PlanView | null;
	/** Stored data failed validation. The underlying diagnostic is not shown. */
	planError?: boolean;
	/** Existing purpose, not a tactical or a new source of authority. */
	legacy?: { purpose: string; scope: string | null };
	onReviewNow?: () => void;
	onDismissReview?: (reviewId: string) => void;
	/** Prefills Chat only; sending that request remains a separate owner action. */
	onDraftFromReview?: (reviewId: string) => void;
	/** Copy-only instruction for the exact current proposed revision. */
	terminalApproval?: PlanTerminalCommand & { revision: number; digest: string };
	/** Copy-only instruction when fresh status reports that a separate Open is needed. */
	terminalOpen?: PlanTerminalCommand;
}

const stack = "flex min-w-0 flex-col gap-3";
const heading = `${text.heading} [overflow-wrap:anywhere]`;

/** Builds sections for the Mission page; never opens, agrees, saves, or sends a message. */
export function renderMissionPlan(options: MissionPlanOptions): HTMLElement {
	const { plan, planError, legacy } = options;
	const root = el("div", "flex min-w-0 flex-col gap-5");
	if (planError) {
		root.append(section({ title: "Needs you", icon: "warning", children: [
			callout({ tone: "danger", role: "alert", body: "The stored mission plan could not be verified. Plan admission is blocked. Inspect mission status in a terminal." }),
		] }));
		return root;
	}
	if (!plan) {
		root.append(section({ title: "Overall", icon: "target", children: [
			legacy ? legacyPurpose(legacy) : el("p", text.body, "No agreed plan or legacy purpose is reported."),
		] }));
		return root;
	}
	const needs = needsYou(plan, options);
	if (needs) root.append(needs);
	root.append(overall(plan, legacy));
	if (plan.head) root.append(portfolio(plan.head.terms, plan));
	if (plan.draft) root.append(draftSection(plan.draft, plan.head, plan.previous));
	root.append(reviewsSection(plan, options), historySection(plan));
	return root;
}

const gateReasons: Record<NonNullable<PlanView["gate"]["reason"]>, string> = {
	receipt: "The protected approval receipt does not match the agreed plan.",
	binding: "No runnable tactical matches the open purpose revision and digest.",
	"reopen-needed": "The current agreed plan needs a separate Open in the terminal before it can admit new work.",
	"head-missing": "The agreed plan head is missing. Legacy admission must not resume.",
};

function needsYou(plan: PlanView, { terminalApproval, terminalOpen }: MissionPlanOptions): HTMLElement | null {
	const items: Child[] = [];
	const { blocker, draft, gate, runs } = plan;
	if (blocker && blocker.state !== "running") items.push(el("li", "min-w-0",
		el("h3", heading, "Unresolved model review blocker"),
		blocker.state === "done" ? el("p", text.body, "A model request receipt is still unresolved. Later reviews wait for it.") : null,
		reviewTurn(blocker)));
	if (gate.state === "closed") items.push(el("li", "", gate.reason ? gateReasons[gate.reason] : "Plan admission is closed.",
		gate.reason === "reopen-needed" && terminalOpen
			? el("div", "mt-1 min-w-0", command(terminalOpen.line, "mission-plan-copy-open", terminalOpen.copy)) : null));
	if (runs.used >= runs.limit) items.push(el("li", "", "The lifetime run limit is exhausted. No new run can be admitted."));
	if (plan.history.length >= 32) items.push(el("li", "", "The plan has reached its 32-revision limit. A new revision cannot be proposed."));
	if (draft?.status === "proposed") {
		const exactCommand = terminalApproval && draft.digest !== null &&
			terminalApproval.revision === draft.revision && terminalApproval.digest === draft.digest;
		items.push(el("li", "", `Plan revision ${draft.revision} is awaiting approval. Agreeing does not start work.`,
			exactCommand ? el("div", "mt-1 min-w-0", el("p", text.description, "Approve this exact revision in a terminal:"),
				command(terminalApproval.line, "mission-plan-copy-approval", terminalApproval.copy)) : null));
	}
	if (plan.due.length) items.push(el("li", "", plan.preview ? "A plan review is due. The preview has not been saved." : "A plan review is due."));
	return items.length ? section({ title: "Needs you", icon: "warning", children: [el("ul", `m-0 list-disc space-y-2 pl-5 ${text.body}`, ...items)] }) : null;
}

function overall(plan: PlanView, legacy: MissionPlanOptions["legacy"]): HTMLElement {
	const { head, headValid, adopted, gate, runs } = plan;
	const operation = gate.state === "not-adopted" ? "Plan not adopted" : gate.state === "closed" ? "Admission closed" : "Admission open";
	return section({ title: "Overall", icon: "target", children: [
		panel(el("div", surfaces.panelBody, facts([
			["Approval", head ? (headValid ? `Agreed revision ${head.revision}` : `Approval not current for recorded revision ${head.revision}`) : "No agreed plan"],
			["Plan admission", operation],
			["Lifetime runs", `${runs.used} of ${runs.limit} used; ${Math.max(0, runs.limit - runs.used)} left`],
		]))),
		head ? termRows(overallRows(head.terms.overall)) : null,
		!head && !adopted && legacy ? legacyPurpose(legacy, gate.state === "closed" ? "Plan admission is closed; do not rely on legacy authority." : undefined) : null,
		el("p", text.description, "Plan terms do not grant execution authority. Agreeing does not open or start work."),
	] });
}

function legacyPurpose(legacy: NonNullable<MissionPlanOptions["legacy"]>, warning?: string): HTMLElement {
	return panel(el("div", `${stack} ${surfaces.panelBody}`,
		el("h3", heading, "Legacy purpose"),
		el("p", text.body, warning ?? "Existing purpose agreement, separate from the plan. It has no strategic or tactical parent."),
		termRows([["Purpose", legacy.purpose], ["Scope", legacy.scope]]),
	));
}

function portfolio(terms: PlanTerms, plan: PlanView): HTMLElement {
	const blocked = plan.gate.state === "closed" || !plan.headValid || plan.runs.used >= plan.runs.limit;
	return section({ title: "Strategies and tactics", icon: "target", children: terms.strategics.length ? terms.strategics.map((strategic) => {
		const children = terms.tacticals.filter((tactical) => tactical.strategic === strategic.id);
		return panel(el("div", `${stack} ${surfaces.panelBody}`,
			el("h3", heading, visibleText(strategic.title)),
			termRows(strategicRows(strategic).slice(2)),
			children.length ? el("ul", "m-0 flex min-w-0 list-none flex-col gap-3 p-0", ...children.map((tactical) => {
				const status = tactical.mode === "runnable" ? (blocked ? tag("Blocked", "warn") : tag("Runnable", "ok")) :
					tactical.mode === "parked" ? tag("Parked") : tag("Planned");
				return el("li", "min-w-0 border-t border-stroke-3 pt-3",
					el("h4", heading, visibleText(tactical.objective)),
					el("div", "my-1 flex flex-wrap gap-2", status),
					termRows(tacticalRows(tactical).slice(3)),
				);
			})) : el("p", text.description, "No current tactics in this strategy."),
		));
	}) : [el("p", text.body, "No strategies in the agreed plan.")] });
}

function draftSection(draft: NonNullable<PlanView["draft"]>, head: PlanView["head"], previous: PlanView["previous"]): HTMLElement {
	const base = [head, previous].find((revision) => revision?.revision === draft.baseRevision);
	return section({ title: "Plan draft", icon: "target", children: [
		el("p", text.body, `Revision ${draft.revision}, saved by ${draft.savedBy === "bob" ? "Bob" : "the owner"}. ${draft.status === "proposed" ? "Awaiting approval." : "Still being edited; not proposed."}`),
		draft.fromReview !== null ? el("p", text.body, "Drafted from review ", visibleText(draft.fromReview), ".") : null,
		draft.missing.length ? termRows([["Still needed", draft.missing]]) : null,
		el("details", "min-w-0", disclosure("Read draft terms"),
			termRows([["Base revision", draft.baseRevision], ["Draft digest (SHA-256)", draft.digest]]), exactTerms(draft.terms)),
		base ? termsDiff(base.terms, draft.terms, `Diff from base revision ${base.revision}`, "Draft") : null,
	] });
}

const triggerWords: Record<ReviewTrigger["kind"], string> = {
	cadence: "Scheduled review",
	completed: "Tactical completion",
	blocked: "Blocked run",
	"runs-low": "Low lifetime run allowance",
	"deadline-near": "Deadline approaching",
	owner: "Requested by the owner",
};

const reviewStatus: Record<ReviewNote["items"][number]["status"], string> = {
	"on-track": "On track",
	"at-risk": "At risk",
	blocked: "Blocked",
	done: "Done",
	planned: "Planned",
	parked: "Parked",
};

function reviewsSection(plan: PlanView, options: MissionPlanOptions): HTMLElement {
	const { due, preview, reviews, head, headValid } = plan;
	return section({ title: "Reviews", icon: "checks", children: [
		el("p", text.body, due.length ? "Review due. Due triggers are computed, not saved." : "No review is reported due."),
		due.length ? el("ul", `m-0 list-disc pl-5 ${text.body}`, ...due.map((trigger) =>
			el("li", "", triggerWords[trigger.kind], trigger.subject === null ? null : el("span", "", ": ", visibleText(trigger.subject))))) : null,
		options.onReviewNow ? el("div", "flex flex-wrap gap-2", button({ label: "Review now", key: "mission-plan-review-now", onClick: options.onReviewNow })) : null,
		preview ? reviewNote(preview, "Unsaved review preview") : null,
		modelReviews(plan),
		el("h3", heading, "Saved reviews"),
		reviews.length ? el("ul", "m-0 flex min-w-0 list-none flex-col gap-3 p-0", ...reviews.map((review) => {
			const group = reviewNote(review, "Saved review");
			const actions: Child[] = [];
			if (!review.disposition) {
				const { onDismissReview, onDraftFromReview } = options;
				const reviewName = `${triggerWords[review.trigger.kind]}, ${date(review.createdAt)}, review ${encodeExactText(review.reviewId)}`;
				if (onDismissReview) actions.push(attrs(
					button({ label: "Dismiss", key: `mission-plan-dismiss-${review.reviewId}`, onClick: () => onDismissReview(review.reviewId) }),
					{ "aria-label": `Dismiss ${reviewName}` },
				));
				if (onDraftFromReview && headValid && head?.revision === review.planRevision && head.digest === review.planDigest)
					actions.push(attrs(
						button({ label: "Draft a revision in Chat", key: `mission-plan-draft-${review.reviewId}`, onClick: () => onDraftFromReview(review.reviewId) }),
						{ "aria-label": `Draft a revision in Chat from ${reviewName}` },
					));
			}
			if (actions.length) group.append(el("div", "flex flex-wrap gap-2", ...actions));
			return el("li", "min-w-0", group);
		})) : el("p", text.description, "No reviews have been saved."),
	] });
}

const turnStatus: Record<ReviewTurnView["state"], string> = {
	skipped: "Skipped",
	running: "Running",
	done: "Done",
	blocked: "Blocked",
};

const turnReasons: Record<NonNullable<ReviewTurnView["reason"]>, string> = {
	budget: "The review budget did not allow another request.",
	hold: "The purpose is on hold.",
	unsettled: "Earlier effects have not settled.",
	unknown_request_outcome: "A model request’s outcome is unknown. Later reviews wait for it.",
	turn_failed: "The model review could not finish.",
	authority: "The current authority did not allow the model review to continue.",
};

function modelReviews({ allowance, turns, blocker }: PlanView): HTMLElement | null {
	if (!allowance && !turns.length && !blocker) return null;
	const history = blocker ? turns.filter(({ key }) => key !== blocker.key) : turns;
	const inFlight = blocker?.state === "running" ? blocker : null;
	const pinned = blocker !== null && inFlight === null;
	return el("div", stack,
		el("h3", heading, "Model review usage and history"),
		allowance ? el("div", stack,
			el("p", text.description, "Lifetime usage carries across plan revisions."),
			termRows([
				["Lifetime review requests used", allowance.requests],
				["Lifetime review request limit", allowance.maxRequests],
				...(allowance.requests >= allowance.maxRequests ? [["Review requests remaining", { note: "No review requests left" }]] as const : []),
				["Requests per review limit", allowance.maxRequestsPerReview],
				["Review estimated cost (USD)", allowance.estimatedCost],
				["Review reserved cost (USD)", allowance.reservedCost],
				["Review estimated cost cap (USD)", allowance.maxEstimatedCost ?? noSeparateReviewCap],
			]),
		) : el("p", text.description, "Model reviews are disabled in the agreed plan."),
		pinned ? el("p", text.description, "The unresolved turn is pinned under Needs you.") : null,
		inFlight || history.length ? el("ol", "m-0 flex min-w-0 list-none flex-col gap-3 p-0",
			inFlight ? el("li", "min-w-0",
				el("p", text.body, "Request in flight; outcome not yet known. Later reviews wait for it."), reviewTurn(inFlight)) : null,
			...history.map((turn) => el("li", "min-w-0", reviewTurn(turn))))
			: el("p", text.description, pinned ? "No other model review turns are recorded." : "No model review turns are recorded."),
	);
}

function reviewTurn(turn: ReviewTurnView): HTMLElement {
	return el("div", `border-t border-stroke-3 pt-2 ${stack}`,
		el("p", text.strong, `${turnStatus[turn.state]} · ${triggerWords[turn.trigger.kind]} · Plan revision ${turn.planRevision}`),
		el("p", text.body, `${date(turn.at)} · Requests: ${turn.requests}`),
		turn.reason === null ? null : el("p", text.body, turnReasons[turn.reason]),
		el("details", "min-w-0", disclosure("Read model review turn details"),
			termRows([
				["Turn key", turn.key], ["Trigger subject", turn.trigger.subject], ["Review ID", turn.reviewId], ["Draft revision", turn.draftRevision],
				...(turn.reason === null ? [] : [["Reason code", turn.reason]] as const),
			])),
	);
}

function reviewNote(note: ReviewNote, label: string): HTMLElement {
	const { facts: usage } = note;
	const outcome = note.outcome === "no-change" ? "No change" : "Needs attention";
	const disposition = note.disposition;
	return el("div", `border-t border-stroke-3 pt-2 ${stack}`,
		el(label === "Saved review" ? "h4" : "h3", heading, `${label} · ${outcome}`),
		el("p", text.body, `${triggerWords[note.trigger.kind]} · Plan revision ${note.planRevision} · `, date(note.createdAt)),
		disposition ? el("p", text.body, disposition.kind === "dismissed" ? "Dismissed" :
			disposition.draftRevision === null ? "Drafted" : `Drafted as revision ${disposition.draftRevision}`, " · ", date(disposition.at)) : null,
		el("details", "min-w-0", disclosure(label === "Saved review" ? "Read saved review evidence" : "Read preview evidence"),
			termRows([
				["Review ID", note.reviewId], ["Plan digest (SHA-256)", note.planDigest], ["Trigger subject", note.trigger.subject],
				["Window starts (UTC)", date(note.window.from)], ["Window ends (UTC)", date(note.window.to)],
				["Lifetime runs used", `${usage.runsUsed} of ${usage.runsLimit}`],
				["Lifetime cycles used", `${usage.cycles} of ${usage.maxCycles}`],
				["Lifetime model requests used", `${usage.requests} of ${usage.maxRequests}`],
				["Lifetime estimated cost (USD)", usage.estimatedCost], ["Estimated cost cap (USD)", usage.maxEstimatedCost],
				["Uncertainty", note.uncertainty],
			]),
			note.items.length ? el("ul", "m-0 flex min-w-0 list-none flex-col gap-3 p-0", ...note.items.map((item) => {
				const remaining = item.deadlineAt === null ? null : item.deadlineAt - note.createdAt;
				const distance = remaining === null ? null : remaining === 0 ? "Due at review time" :
					`${duration(Math.abs(remaining))} ${remaining > 0 ? "left at review time" : "overdue at review time"}`;
				return el("li", "min-w-0 border-t border-stroke-3 pt-2",
					el("p", text.strong, `${item.level === "legacy" ? "Legacy" : item.level === "strategic" ? "Strategy" : "Tactic"} `,
						visibleText(item.id), ` · ${reviewStatus[item.status]}`),
					termRows([
						["Verified works", `${item.verifiedWorks} of ${item.listedWorks}`], ["Cited runs", item.runIds],
						["Reasons work was blocked", item.blockReasons], ["Unsettled effects", item.unsettled],
						["Deadline (UTC)", item.deadlineAt === null ? null : date(item.deadlineAt)], ["Deadline distance", distance],
					]),
				);
			})) : el("p", text.description, "No items evaluated in this review."),
		),
	);
}

function historySection({ head, previous, history }: PlanView): HTMLElement {
	const children: Child[] = [];
	for (const [revision, label] of [[head, "Current recorded revision"], [previous, "Previous exact revision"]] as const) {
		if (!revision) continue;
		children.push(el("details", "min-w-0", disclosure(`${label} ${revision.revision}`), termRows([
			["Digest (SHA-256)", revision.digest], ["Previous digest (SHA-256)", revision.previousDigest],
			["Approval receipt", revision.receiptId], ["Agreed at (UTC)", date(revision.agreedAt)],
		]), exactTerms(revision.terms)));
	}
	if (previous && head) children.push(termsDiff(previous.terms, head.terms, `Diff from revision ${previous.revision} to ${head.revision}`, "Current"));
	if (history.length) children.push(el("ol", `m-0 list-decimal space-y-2 pl-5 ${text.body}`, ...history.map((item) =>
		el("li", "", `Revision ${item.revision} · ${date(item.agreedAt)} · SHA-256 `, visibleText(item.digest)))));
	return section({ title: "History", icon: "history", children: children.length ? [
		el("p", text.description, "Exact text is quoted. Line breaks, invisible controls, non-ASCII spaces and literal backslashes are escaped."),
		...children,
	] : [el("p", text.body, "No plan revision has been agreed.")] });
}

function date(ms: number): string {
	const time = new Date(ms);
	return Number.isFinite(time.getTime()) ? time.toISOString() : `${ms} ms since Unix epoch`;
}
