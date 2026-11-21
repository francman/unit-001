// Connections page (the wire field and CLI still say "channels"): the messaging connections the owner reports, their health and what each one needs from the person.
import type { WorkspaceDetails } from "../contract.ts";
import { commandName, type Ctx } from "../state.ts";
import { callout, command, emptyState, tag } from "../ui/blocks.ts";
import { el } from "../ui/dom.ts";
import { ago, dateTime, humanize } from "../ui/format.ts";
import type { IconName } from "../ui/icons.ts";
import { listRow, pageFrame, rowList, section } from "../ui/page.ts";

type Channel = WorkspaceDetails["channels"][number];

const failures = {
	authorization: "The provider refused the authorization. Authorize it again in a terminal.",
	credentials: "The credentials were missing or rejected. Supply them in a terminal.",
	transport: "The provider could not be reached. This is usually a network problem.",
	provider: "The provider reported an error.",
	identity: "The account that answered is not the one that was set up.",
} as const satisfies Record<NonNullable<Channel["failure"]>, string>;

/** Renders the Connections page; setup and approval are terminal commands to copy, never buttons that act. */
export function renderConnections(ctx: Ctx): HTMLElement {
	const channels = ctx.ui.details?.channels;
	const { root, body } = pageFrame({
		title: "Connections",
		count: channels?.length ?? null,
		lead: channels?.length ? `Where ${ctx.name} can talk to you. ${ready(channels)} Setup and approval happen in a terminal.` : undefined,
		key: "connections",
	});
	if (!channels) {
		// No report is not proof of no connections: say the list is unknown, never that it is empty.
		body.append(
			ctx.ui.detailsFailed || ctx.ui.connection !== "connecting"
				? callout({
						tone: "warn",
						title: "Connections could not be read.",
						body: "They are read again when you open this page.",
						role: "status",
					})
				: emptyState("connections", "Reading connections."),
		);
		return root;
	}
	if (channels.length === 0) {
		body.append(
			emptyState("connections", `No connections are set up. ${ctx.name} can propose one, such as Telegram. You approve it in a terminal before it can be used.`),
		);
		return root;
	}
	const statusCommand = `${commandName(ctx.name)} channels status`;
	body.append(
		section({
			title: "Your connections",
			icon: "connections",
			children: [rowList(...channels.map((channel) => channelRow(ctx, channel)))],
		}),
		section({
			title: "Check from a terminal",
			icon: "terminal",
			children: [
				el("p", "m-0 text-base text-fg-2", "Shows the status of each connection in your terminal."),
				command(statusCommand, "copy-channels-status", ctx.act.copy),
			],
		}),
	);
	return root;
}

function channelRow(ctx: Ctx, channel: Channel): HTMLLIElement {
	const problem = problemText(ctx, channel);
	const description = problem ?? (channel.status === "ready" ? "Identity was checked. Delivery has not been tested." : channel.detail);
	const meta = el("span", "", `${humanize(channel.adapter)} · ${checkedText(channel)}`);
	if (channel.lastHealth) meta.title = dateTime(channel.lastHealth.observedAt);
	return listRow({
		icon: iconFor(channel.adapter),
		title: channel.id,
		description: channel.failure ? el("span", "text-danger", description) : description,
		meta,
		trailing: [stateTag(channel)],
	});
}

// One state word per connection. Amber means the person has a step to take; red means it is failing.
function stateTag(channel: Channel): HTMLElement {
	if (channel.failure) return tag("Not working", "danger", "error");
	if (needsApproval(channel)) return tag("Needs approval", "warn", "alert");
	if (channel.lastHealth && !channel.lastHealth.healthy) return tag("Check failed", "warn", "warning");
	if (channel.status === "ready") return tag("Ready", "ok", "success");
	return tag(sentence(humanize(channel.status)), "neutral");
}

function needsApproval(channel: Channel): boolean {
	return channel.awaiting !== null || channel.status.startsWith("awaiting");
}

// What the person must do or know beyond the state word; null when nothing needs saying.
function problemText(ctx: Ctx, channel: Channel): string | null {
	if (channel.failure) return failures[channel.failure];
	const terminal = `${ctx.name}'s terminal`;
	if (channel.awaiting === "manager-bootstrap") return `Set up the Telegram manager bot in ${terminal}.`;
	if (channel.awaiting === "telegram-confirmation") return `Confirm the Telegram link in ${terminal}.`;
	if (needsApproval(channel)) return `Approve it in ${terminal}.`;
	return null;
}

function checkedText(channel: Channel): string {
	const health = channel.lastHealth;
	if (!health) return "never checked";
	return `${health.healthy ? "checked" : "last check found a problem,"} ${ago(health.observedAt)}`;
}

function ready(channels: readonly Channel[]): string {
	const count = channels.filter((channel) => channel.status === "ready" && !channel.failure && !needsApproval(channel)).length;
	return `${count} of ${channels.length} ${channels.length === 1 ? "is" : "are"} ready.`;
}

function iconFor(adapter: string): IconName {
	const name = adapter.toLowerCase();
	if (name.includes("telegram")) return "telegram";
	if (/mail|imap|smtp/.test(name)) return "mail";
	return "plug";
}

function sentence(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
