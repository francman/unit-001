// About page: who the agent is, what it is for, how it is controlled and where its data goes; read-only, from what the workspace already holds.
import type { WorkspaceDetails } from "../contract.ts";
import { type Ctx, commandName, type Section } from "../state.ts";
import { command, tag } from "../ui/blocks.ts";
import { buttons, surfaces, text } from "../ui/classes.ts";
import { button } from "../ui/controls.ts";
import { attrs, type Child, el } from "../ui/dom.ts";
import { duration, plural } from "../ui/format.ts";
import { facts, listRow, pageFrame, panel, rowList, section } from "../ui/page.ts";
import { connectionSentence } from "./connections.ts";

/** The published releases page named in the README; the only external link, since the docs host is not decided. */
const releasesUrl = "https://github.com/francman/unit-001-releases/releases";

const notReported = "Not reported yet.";

/** What the browser can do: the gateway's closed operation set, as plain sentences (docs/web-ui.md). */
const browserCan = [
	"Read the agent's status, purpose, memory and connections.",
	"Chat, and stop the reply or work in progress.",
	"Forget a memory you pick, after you confirm. Conversation history is kept.",
];

/** What only a terminal can do: every step that changes the agent. */
const terminalOnly = [
	"Approve or change its purpose, connections, model or setup.",
	"Start or approve scheduled work.",
	"Update, stop or restart the agent.",
];

type Details = WorkspaceDetails;

/** Renders the About page; anything that changes the agent is a command to copy, never a button. */
export function renderAbout(ctx: Ctx): HTMLElement {
	const view = ctx.ui.view;
	const { root, body } = pageFrame({
		title: "About",
		key: "about",
		lead: `Who ${ctx.name} is, what it is for, and what this browser can and cannot do.`,
		actions: view ? [tag(`v${view.version}`)] : [],
	});
	const details = ctx.ui.details;
	body.append(
		identitySection(ctx),
		purposeSection(ctx, details),
		inUseSection(ctx, details),
		controlSection(ctx),
		privacySection(ctx),
		limitsSection(details),
		softwareSection(ctx),
	);
	return root;
}

function identitySection(ctx: Ctx): HTMLElement {
	const { view, details } = ctx.ui;
	const model = view?.model ?? null;
	const uptime = details?.owner?.uptimeMs;
	const rows: (readonly [string, Child])[] = [
		["Name", view ? view.name : notReported],
		["Terminal command", el("span", text.mono, commandName(ctx.name))],
		["Version", view ? view.version : notReported],
		["Installation ID", view ? (view.installationId ? el("span", text.mono, view.installationId) : "Not reported.") : notReported],
		["Model", view ? (model ? `${model.provider} / ${model.modelId}` : "No model configured") : notReported],
	];
	if (typeof uptime === "number") rows.push(["Running for", duration(uptime)]);
	return section({ title: "Identity", icon: "user", children: [panel(el("div", surfaces.panelBody, facts(rows)))] });
}

function purposeSection(ctx: Ctx, details: Details | null): HTMLElement {
	const objective = details?.mission.objective;
	const sentence = details === null ? notReported : (objective ?? "No purpose has been agreed yet. Agreeing one happens in a terminal.");
	return section({
		title: "Purpose",
		icon: "target",
		children: [
			panel(
				el(
					"div",
					`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ${surfaces.panelBody}`,
					el("p", `min-w-0 flex-1 ${objective ? text.strong : text.body}`, sentence),
					openLink(ctx, "mission", "Open Mission", "about-purpose"),
				),
			),
		],
	});
}

/** Memory and connections as two rows with a one-sentence summary each, and a link to the page that has the detail. */
function inUseSection(ctx: Ctx, details: Details | null): HTMLElement {
	const stats = details?.memory.stats ?? null;
	const memory = details === null ? notReported : stats ? memorySentence(stats.working, stats.episodic) : "Counts could not be read.";
	const connections = details === null ? notReported : connectionSentence(details.channels);
	return section({
		title: "Memory and connections",
		icon: "memory",
		children: [
			rowList(
				listRow({ icon: "memory", title: "Memory", description: memory, trailing: [openLink(ctx, "memory", "Open Memory", "about-memory")] }),
				listRow({
					icon: "connections",
					title: "Connections",
					description: connections,
					trailing: [openLink(ctx, "connections", "Open Connections", "about-connections")],
				}),
			),
		],
	});
}

function controlSection(ctx: Ctx): HTMLElement {
	const cmd = commandName(ctx.name);
	return section({
		title: "How you control it",
		icon: "terminal",
		children: [
			el("p", text.body, `Anything that changes ${ctx.name} needs a terminal on the computer it runs on. The browser only shows state and lets you talk to it.`),
			panel(el("div", `grid grid-cols-2 gap-x-6 gap-y-4 max-sm:grid-cols-1 ${surfaces.panelBody}`, group("This browser can", browserCan), group("Only a terminal can", terminalOnly))),
			el("p", text.description, "Run these in the agent's terminal:"),
			el(
				"div",
				"flex flex-col gap-2",
				command(`${cmd} status`, "copy-about-status", ctx.act.copy),
				command(`${cmd} mission status`, "copy-about-mission", ctx.act.copy),
				command(`${cmd} memory stats`, "copy-about-memory", ctx.act.copy),
			),
		],
	});
}

function privacySection(ctx: Ctx): HTMLElement {
	const provider = ctx.ui.view?.model?.provider;
	const items = [
		`The conversation, memory and credentials stay with ${ctx.name} on the computer it runs on, not in this browser.`,
		provider
			? `To reply, ${ctx.name} sends the conversation to its model provider, ${provider}.`
			: `To reply, ${ctx.name} sends the conversation to its model provider. No model is configured yet.`,
		"This browser keeps your theme choice and, until you leave the page, an unsent draft. Nothing else is stored here.",
		"The workspace trusts this computer as the operator. Use it only on a trusted computer, through loopback or your private SSH tunnel.",
	];
	return section({ title: "Data and privacy", icon: "lock", children: [panel(el("div", surfaces.panelBody, bullets(items)))] });
}

function limitsSection(details: Details | null): HTMLElement {
	const agreement = details?.mission.agreement ?? null;
	const rows: (readonly [string, Child])[] = [];
	if (details === null) rows.push(["Agreed limits", notReported]);
	else if (agreement === null) rows.push(["Agreed limits", "None yet. Limits are set when the purpose is approved in a terminal."]);
	else {
		rows.push(
			["Asks you first about", agreement.approvalBoundary.length ? bullets(agreement.approvalBoundary) : "Nothing listed."],
			["Scheduled work stops at", "The cycle, request, retry, no-progress, deadline and cost limits you agreed. Status shows how much is used."],
		);
	}
	const tools = details?.mission.tools ?? [];
	if (tools.length > 0) rows.push(["Tools it may use", chips(tools)]);
	rows.push(["Unknown results", "A result nobody can confirm stops scheduled work until you review it in a terminal."]);
	return section({ title: "Limits and safety", icon: "shield", children: [panel(el("div", surfaces.panelBody, facts(rows)))] });
}

function softwareSection(ctx: Ctx): HTMLElement {
	const link = el("a", `${buttons.link} w-fit`, "Release notes and downloads");
	link.href = releasesUrl;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	const rows: (readonly [string, Child])[] = [
		["Version", ctx.ui.view ? ctx.ui.view.version : notReported],
		["License", "MIT"],
		["Releases", link],
		["Help in a terminal", el("span", text.mono, `${commandName(ctx.name)} --help`)],
	];
	return section({ title: "Software", icon: "info", children: [panel(el("div", surfaces.panelBody, facts(rows)))] });
}

function group(title: string, items: readonly string[]): HTMLElement {
	return el("div", "flex min-w-0 flex-col gap-1.5", el("h3", text.label, title), bullets(items));
}

function bullets(items: readonly string[]): HTMLElement {
	return attrs(el("ul", "m-0 flex list-disc flex-col gap-1 pl-4", ...items.map((item) => el("li", text.strong, item))), { role: "list" });
}

function chips(items: readonly string[]): HTMLElement {
	return el("span", "flex flex-wrap gap-1.5", ...items.map((item) => el("code", "rounded-xs bg-fill px-1.5 py-0.5 font-mono text-xs text-fg [overflow-wrap:anywhere]", item)));
}

/** A link-style button to another page of the workspace. */
function openLink(ctx: Ctx, target: Section, label: string, key: string): HTMLButtonElement {
	return button({ label, key, variant: "link", onClick: () => ctx.act.go(target) });
}

function memorySentence(working: number, episodic: number): string {
	return `${plural(working, "memory", "memories")} in mind and ${plural(episodic, "older one", "older ones")}.`;
}

