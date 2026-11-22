// Mission page: the agreed purpose, the current work run, recorded checks, history and the entry to authoring.
import type { MissionAgreementView, MissionRunView, WorkspaceDetails } from "../contract.ts";
import { type Ctx, commandName, runBlocked } from "../state.ts";
import { callout, command, emptyState, tag } from "../ui/blocks.ts";
import { surfaces, text } from "../ui/classes.ts";
import { button } from "../ui/controls.ts";
import { type Child, el } from "../ui/dom.ts";
import { ago, count, dateTime, duration, humanize, money, until } from "../ui/format.ts";
import { facts, listRow, pageFrame, panel, rowList, section } from "../ui/page.ts";
import { bullets, chips, limitRow, runStates, unknownSentence } from "../ui/run.ts";

const approvers: Record<MissionAgreementView["approvedBy"], string> = {
	"local-creator": "the local creator",
	"host-administrator": "the host administrator",
	"developer-local": "a developer in a local source checkout",
};

const creators = { human: "you", elder: "an elder", organization: "an organization" } as const;

/** Opens Mission authoring only when the shell supplies a working entry point. */
export function renderMission(ctx: Ctx, openDraft?: () => void): HTMLElement {
	const details = ctx.ui.details;
	const run = details?.mission.run ?? null;
	const state = run ? runStates[run.status] : null;
	const entry = details && openDraft
		? button({ label: details.mission.agreement ? "Amend mission" : "Define mission", key: "open-mission-draft", onClick: openDraft })
		: null;
	const { root, body } = pageFrame({
		title: "Mission",
		key: "mission",
		lead: details?.mission.objective ?? "No purpose agreed yet.",
		actions: [state ? tag(state.word, state.tone) : null, entry],
	});
	if (!details) {
		body.append(missingDetails(ctx));
		return root;
	}
	const sections = [
		...needsYou(ctx, details),
		purposeSection(ctx, details, openDraft !== undefined),
		currentWork(details, run),
		evidenceSection(run),
		historySection(),
		terminalSection(ctx),
	];
	for (const item of sections) if (item) body.append(item);
	return root;
}

/** Formats the existing terminal approval command for this exact proposal. */
export function missionApprovalCommand(ctx: Ctx, revision: number, digest: string): string {
	const sudo = ctx.ui.details?.mission.authority === "managed-administrator" ? "sudo " : "";
	return `${sudo}${terminal(ctx, `mission approve --revision ${revision} --digest ${digest}`)}`;
}

/** Uses only the digest the gateway bound to the managed proposal; a pre-upgrade owner digest is not enough. */
export function missionProposalDigest({ draft, review, authority, previousReceipt }: WorkspaceDetails["mission"]): string | null {
	if (draft?.status !== "proposed") return null;
	if (authority !== "managed-administrator") return draft.digest;
	return review && review.missionId === draft.missionId && review.revision === draft.revision &&
		review.digest === draft.digest && review.previousReceipt === previousReceipt ? review.digest : null;
}

/** The terminal command uses the installation's reported name. */
function terminal(ctx: Ctx, rest: string): string {
	return `${commandName(ctx.name)} ${rest}`;
}

/** What the owner has to do, one callout per case, each with one sentence and one command. */
function needsYou(ctx: Ctx, details: WorkspaceDetails): HTMLElement[] {
	const items: HTMLElement[] = [];
	const run = details.mission.run;
	if (run && runBlocked(run)) {
		const unknown = unknownSentence(run);
		const blocked = run.status === "blocked";
		items.push(
			callout({
				tone: blocked ? "danger" : "warn",
				title: blocked ? "Blocked." : "Needs your review.",
				body: [blocked ? (run.blocker ?? `${ctx.name} reports it cannot continue.`) : null, unknown, `${ctx.name} will not continue until you look at it in a terminal.`]
					.filter((part) => part !== null)
					.join(" "),
				role: "status",
				children: [command(terminal(ctx, "mission status"), "copy-needs-mission", ctx.act.copy)],
			}),
		);
	}
	return items;
}

function purposeSection(ctx: Ctx, details: WorkspaceDetails, canOpenDraft: boolean): HTMLElement {
	const { mission } = details;
	const agreement = mission.agreement;
	const proposed = mission.draft?.status === "proposed" ? mission.draft : null;
	const digest = missionProposalDigest(mission);
	const children: Child[] = [];
	if (mission.objective === null) children.push(emptyState("target", canOpenDraft ? "No purpose has been agreed yet." : "No purpose has been agreed yet. Agreeing one happens in a terminal."));
	else {
		const rows: (readonly [string, Child])[] = [["Purpose", el("span", text.strong, mission.objective)]];
		if (mission.scope) rows.push(["Scope", mission.scope]);
		if (mission.missing.length > 0) rows.push(["Still missing", mission.missing.map(humanize).join(", ")]);
		if (mission.creator) rows.push(["Set by", creators[mission.creator.kind]]);
		if (mission.tools.length > 0) rows.push(["Tools it may use", chips(mission.tools)]);
		if (agreement)
			rows.push(
				["Success criteria", bullets(agreement.successCriteria, "None listed.")],
				["Asks you first about", bullets(agreement.approvalBoundary, "None listed.")],
				["Agreed", `${dateTime(agreement.approvedAt)} by ${approvers[agreement.approvedBy]}, revision ${agreement.revision}`],
				["Reviewed", `Every ${duration(agreement.reviewEveryMs)}`],
				["Approval receipt", receipt(mission)],
			);
		children.push(panel(el("div", surfaces.panelBody, facts(rows))));
		if (!agreement && !proposed) children.push(el("p", text.description, canOpenDraft ? "Not approved yet." : "Not approved yet. Approval happens in a terminal."));
	}
	if (proposed && ctx.ui.missionReceipt?.revision === proposed.revision)
		children.push(el("p", text.description, "Approval receipt issued. Check the recorded agreement before acting again."));
	else if (proposed && digest !== null)
		children.push(
			callout({
				tone: "info",
				title: "Waiting for your approval.",
				body: canOpenDraft
					? `Draft revision ${proposed.revision} is proposed. Open the draft to review it, or approve it in a terminal.`
					: `Draft revision ${proposed.revision} is proposed. Approving it is a step you take in a terminal.`,
				children: [command(missionApprovalCommand(ctx, proposed.revision, digest), "copy-mission-approve", ctx.act.copy)],
			}),
		);
	else if (proposed) children.push(el("p", text.description, `Draft revision ${proposed.revision} is proposed, but this session has no reviewed digest.`));
	else if (mission.draft?.status === "editing") children.push(el("p", text.description, `A draft (revision ${mission.draft.revision}) is still being written and has not been proposed.`));
	if (!canOpenDraft && mission.formationAvailable === false)
		children.push(el("p", text.description, "Web drafting is not available in this session."));
	return section({ title: "Purpose", icon: "target", children });
}

/** Whether the stored approval still holds, without displaying owner diagnostics. */
function receipt(mission: WorkspaceDetails["mission"]): HTMLElement {
	if (mission.agreementValid) return tag("Valid", "ok", "check");
	return el(
		"span",
		"inline-flex flex-wrap items-center gap-2",
		tag("Not valid", "warn", "warning"),
		mission.authorityError === "invalid-authority" ? "Mission authority could not be verified." : null,
	);
}

function currentWork(details: WorkspaceDetails, run: MissionRunView | null): HTMLElement | null {
	if (!run) return null;
	const limits = details.mission.agreement?.limits ?? null;
	const state = runStates[run.status];
	const rows: (readonly [string, Child])[] = [["State", el("span", "inline-flex items-center gap-2", tag(state.word, state.tone), state.sentence)]];
	if (run.blocker) rows.push(["Reason", run.blocker]);
	if (run.nextWakeAt !== null) rows.push(["Next wake", `${until(run.nextWakeAt)} (${dateTime(run.nextWakeAt)})`]);
	const children: Child[] = [panel(el("div", surfaces.panelBody, facts(rows)))];
	const meters = limits ? limitRows(run, limits) : [];
	if (meters.length > 0) children.push(panel(el("div", `flex flex-col gap-4 ${surfaces.panelBody}`, ...meters)));
	children.push(el("p", text.description, `Updated ${ago(run.observedAt)}. The run stops at a limit${limits ? `; deadline ${dateTime(limits.deadlineAt)}` : ""}. Costs are estimates.`));
	return section({ title: "Current work", icon: "clock", children });
}

function limitRows(run: MissionRunView, limits: MissionAgreementView["limits"]): HTMLElement[] {
	const entries: { name: string; value: number; max: number; words: string }[] = [
		{ name: "Cycles", value: run.cycles, max: limits.maxCycles, words: `${count(run.cycles)} of ${count(limits.maxCycles)}` },
		{ name: "Model requests", value: run.requests, max: limits.maxRequests, words: `${count(run.requests)} of ${count(limits.maxRequests)}` },
		{ name: "Retries", value: run.retries, max: limits.maxRetries, words: `${count(run.retries)} of ${count(limits.maxRetries)}` },
		{ name: "Runs without progress", value: run.noProgress, max: limits.maxNoProgress, words: `${count(run.noProgress)} of ${count(limits.maxNoProgress)}` },
	];
	if (limits.maxEstimatedCost !== null && limits.maxEstimatedCost > 0)
		entries.push({
			name: "Estimated cost",
			value: run.estimatedCost,
			max: limits.maxEstimatedCost,
			words: `about ${money(run.estimatedCost)} of ${money(limits.maxEstimatedCost)}`,
		});
	return entries.filter((entry) => entry.max > 0).map((entry) => limitRow(entry));
}

function evidenceSection(run: MissionRunView | null): HTMLElement | null {
	if (!run) return null;
	if (run.evidence.length === 0)
		return section({ title: "Evidence", icon: "checks", count: 0, children: [emptyState("checks", "No checks have been recorded yet.")] });
	const accepted = run.evidence.filter((item) => item.accepted).length;
	const list = rowList(
		...run.evidence.map((item) =>
			listRow({
				title: item.criterion,
				description: item.detail,
				meta: `Recorded ${ago(item.observedAt)}`,
				trailing: [item.accepted ? tag("Met", "ok", "check") : tag("Not met", "warn")],
			}),
		),
	);
	return section({
		title: "Evidence",
		icon: "checks",
		count: run.evidence.length,
		children: [list, el("p", text.description, `${accepted} of ${run.evidence.length} met. Checks do not show that the purpose is fulfilled.`)],
	});
}

function historySection(): HTMLElement {
	return section({ title: "History", icon: "history", children: [emptyState("history", "Past work runs are not recorded yet.")] });
}

function terminalSection(ctx: Ctx): HTMLElement {
	return section({
		title: "From a terminal",
		icon: "terminal",
		children: [
			el("p", text.body, "These show the same facts in your terminal."),
			command(terminal(ctx, "mission status"), "copy-mission-status", ctx.act.copy),
		],
	});
}

function missingDetails(ctx: Ctx): HTMLElement {
	if (ctx.ui.detailsFailed) return emptyState("alert", "The mission could not be loaded. It is read again when you open this page.");
	return emptyState("clock", `Loading what ${ctx.name} reports.`);
}
