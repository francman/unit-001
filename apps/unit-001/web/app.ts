// Renders a browser interface to one existing agent owner without executing model output as HTML.
import type { Connection, WorkspaceDetails, WorkspacePort, WorkspaceView } from "./contract.ts";

type Section = "workspace" | "mission" | "memory" | "channels";
const sectionNames: Record<Section, string> = {
	workspace: "Workspace",
	mission: "Mission",
	memory: "Memory",
	channels: "Channels",
};

/** Mounts the workspace against a live or isolated fixture port; disconnecting never cancels owner work. */
export function mountWorkspace(
	root: HTMLElement,
	port: WorkspacePort,
	options: { preview?: boolean } = {},
): () => void {
	let section: Section = "workspace";
	let connection: Connection = "connecting";
	let view: WorkspaceView | null = null;
	let details: WorkspaceDetails | null = null;
	let draft = "";
	let sending = false;
	let notice = "";
	let unknown: { requestId: string; prompt: string } | null = null;
	let mobileMenu = false;
	let destroyed = false;
	let signedOut = false;
	let pendingForget: string | null = null;
	let query = "";

	const run = async (operation: () => Promise<void>) => {
		try {
			await operation();
		} catch {
			notice = "That request could not be completed. Check the connection and try again.";
		}
		if (!destroyed) render();
	};
	const refresh = async () => {
		const next = await port.details();
		if (!signedOut) details = next;
	};
	const render = () => {
		const focused = document.activeElement;
		const wasComposer = focused instanceof HTMLTextAreaElement && focused.id === "composer";
		const selection = wasComposer ? focused.selectionStart : null;
		root.replaceChildren();
		const shell = element("div", `shell${mobileMenu ? " menu-open" : ""}`);
		const aside = element("aside", "sidebar");
		aside.setAttribute("aria-label", "Agent navigation");
		const brand = element("div", "brand");
		brand.append(element("span", "brand-mark", "u"), element("span", "", "unit-001"));
		aside.append(brand, element("p", "nav-label", "YOUR AGENT"));
		const identity = element("div", "agent-identity");
		identity.append(
			element("span", "agent-avatar", (view?.name ?? "A").slice(0, 1).toUpperCase()),
			element("div", "identity-copy", view?.name ?? "Connecting…"),
		);
		identity.append(element("span", `connection-dot ${connection}`));
		aside.append(identity);
		const nav = element("nav", "navigation");
		for (const key of Object.keys(sectionNames) as Section[]) {
			const item = button(sectionNames[key], `nav-item${section === key ? " selected" : ""}`, () => {
				section = key;
				mobileMenu = false;
				render();
			});
			item.setAttribute("aria-current", section === key ? "page" : "false");
			item.prepend(element("span", `nav-icon icon-${key}`));
			nav.append(item);
		}
		aside.append(nav);
		const service = element("div", "sidebar-bottom");
		service.append(
			element("span", "small-dot"),
			element(
				"span",
				"",
				connection === "connected"
					? "Owner connected"
					: connection === "connecting"
						? "Reconnecting to owner"
						: "Owner unavailable",
			),
		);
		aside.append(
			service,
			element(
				"p",
				"sidebar-caption",
				options.preview ? "Isolated interface preview" : "Work continues when you leave.",
			),
		);
		const main = element("main", "main");
		const header = element("header", "topbar");
		const heading = element("div", "topbar-title");
		const menu = button("Menu", "mobile-menu", () => {
			mobileMenu = !mobileMenu;
			render();
		});
		menu.setAttribute("aria-expanded", String(mobileMenu));
		heading.append(
			menu,
			element("span", "breadcrumb", view?.name ?? "Agent"),
			element("span", "breadcrumb-separator", "/"),
			element("strong", "", sectionNames[section]),
		);
		header.append(heading);
		const headerActions = element("div", "header-actions");
		if (options.preview) headerActions.append(element("span", "preview-label", "PREVIEW DATA"));
		headerActions.append(
			element(
				"span",
				`status-pill ${view?.busy ? "working" : ""}`,
				connection === "connected" ? (view?.busy ? "Working" : "Ready") : "Offline",
			),
		);
		headerActions.append(
			button(
				"Sign out",
				"quiet-button",
				() =>
					void run(async () => {
						await port.logout();
						signedOut = true;
						view = null;
						details = null;
						draft = "";
						unknown = null;
						notice = "Signed out. Your agent keeps running.";
						connection = "offline";
					}),
			),
		);
		header.append(headerActions);
		main.append(header);
		if (connection !== "connected")
			main.append(
				element(
					"div",
					"connection-banner",
					connection === "connecting"
						? "Reconnecting. Your draft is saved here; requests will not be replayed."
						: "Connection lost. Your draft is preserved. Reconnect before sending.",
				),
			);
		if (notice) {
			const alert = element("div", "notice", notice);
			alert.setAttribute("role", "status");
			main.append(alert);
		}
		if (unknown) {
			const alert = element("div", "unknown-notice");
			alert.setAttribute("role", "alert");
			alert.append(
				element("strong", "", "Delivery not confirmed"),
				element("p", "", "The owner may have received this message. It has not been sent again."),
				element("code", "", unknown.requestId),
			);
			alert.append(
				button(
					"Copy request ID",
					"text-button",
					() =>
						void run(async () => {
							await navigator.clipboard.writeText(unknown?.requestId ?? "");
							notice = "Request ID copied.";
						}),
				),
			);
			main.append(alert);
		}
		const body = element("div", `body section-${section}`);
		if (section === "workspace") {
			const thread = element("section", "thread");
			thread.setAttribute("aria-label", "Conversation");
			const introduction = element("div", "page-intro");
			introduction.append(
				element("p", "eyebrow", "A CONTINUOUS WORKSPACE"),
				element("h1", "", "Your agent, in view."),
				element("p", "muted", "See what is happening, give direction, and stay in control."),
			);
			thread.append(introduction);
			if (view?.historyTruncated)
				thread.append(
					element("p", "history-note", "Showing recent conversation. Earlier history is retained by the owner."),
				);
			const history = element("div", "messages");
			history.setAttribute("aria-live", "polite");
			history.setAttribute("aria-relevant", "additions text");
			if (!view?.entries.length)
				history.append(
					emptyState(
						"A fresh conversation",
						"Ask a question or give your agent direction. Its saved mission and memory stay separate from this conversation.",
					),
				);
			for (const entry of view?.entries ?? []) {
				const message = element("article", `message ${entry.role}`);
				message.append(element("div", "message-label", entry.role === "user" ? "YOU" : (view?.name ?? "AGENT")));
				const content = element("div", "message-content");
				renderText(content, entry.text);
				message.append(content);
				if (entry.source === "host") message.append(element("span", "host-label", "Observed host facts"));
				if (entry.truncated)
					message.append(element("p", "history-note", "This entry is shortened in the current view."));
				history.append(message);
			}
			if (view?.text) {
				const live = element("article", "message assistant streaming");
				live.append(element("div", "message-label", view.name));
				const content = element("div", "message-content");
				renderText(content, view.text);
				live.append(content);
				history.append(live);
			}
			thread.append(history);
			const composer = element("form", "composer");
			const input = element("textarea", "composer-input");
			input.id = "composer";
			input.rows = 3;
			input.value = draft;
			input.maxLength = 16000;
			input.placeholder = "Ask a question or give direction…";
			input.setAttribute("aria-label", "Message your agent");
			input.addEventListener("input", () => {
				draft = input.value;
			});
			const controls = element("div", "composer-controls");
			controls.append(element("span", "composer-hint", "Closing this window does not stop the owner."));
			if (view?.busy)
				controls.append(
					button(
						"Cancel current work",
						"quiet-button cancel-button",
						() =>
							void run(async () => {
								await port.cancel(crypto.randomUUID());
								notice = "Cancellation requested. Waiting for the owner to settle.";
							}),
					),
				);
			const send = element("button", "primary-button", sending ? "Sending…" : "Send message");
			send.type = "submit";
			send.disabled = sending || connection !== "connected";
			controls.append(send);
			composer.append(input, controls);
			composer.addEventListener("submit", (event) => {
				event.preventDefault();
				const text = draft.trim();
				if (!text || sending || connection !== "connected") return;
				const requestId = crypto.randomUUID();
				sending = true;
				render();
				void run(async () => {
					try {
						const result = await port.send(text, requestId);
						if (signedOut) return;
						if (result.state === "unknown") unknown = { requestId, prompt: text };
						else if (draft.trim() === text) draft = "";
					} catch {
						unknown = { requestId, prompt: text };
					} finally {
						sending = false;
					}
				});
			});
			thread.append(composer);
			body.append(thread);
			const context = element("aside", "context-panel");
			context.setAttribute("aria-label", "Agent overview");
			context.append(
				missionCard(details),
				activityCard(view),
				element(
					"div",
					"context-note",
					"Permissions stay with the creator. This browser does not grant administrative access.",
				),
			);
			body.append(context);
		} else if (section === "mission") {
			const page = pageHeading("Mission", "A durable agreement, with clear boundaries.");
			page.append(missionCard(details));
			page.append(
				emptyState(
					"Creator-controlled agreement",
					"Mission approval and security changes use the protected administrative path. A conversation cannot grant new authority.",
				),
			);
			body.append(page);
		} else if (section === "memory") {
			const page = pageHeading("Memory", "Inspect the facts and preferences your agent retains.");
			const search = element("form", "memory-search");
			const input = element("input", "search-input");
			input.type = "search";
			input.placeholder = "Search memories…";
			input.value = query;
			input.setAttribute("aria-label", "Search memories");
			input.addEventListener("input", () => {
				query = input.value;
			});
			const submit = element("button", "secondary-button", "Search");
			submit.type = "submit";
			search.append(input, submit);
			search.addEventListener("submit", (event) => {
				event.preventDefault();
				void run(async () => {
					if (details) details.memory = await port.recall(query);
				});
			});
			page.append(search);
			for (const record of details?.memory.records ?? []) {
				const card = element("article", "memory-card");
				card.append(
					element("p", "", record.content),
					element("span", "small-meta", record.source),
					button("Forget", "text-button danger", () => {
						pendingForget = record.id;
						render();
					}),
				);
				page.append(card);
			}
			if (!details?.memory.records.length)
				page.append(
					emptyState(
						"Find a memory",
						"Search by a topic or phrase. An empty search result does not mean the agent has no memories.",
					),
				);
			body.append(page);
		} else {
			const page = pageHeading("Channels", "The ways your agent can connect, and what is actually ready.");
			for (const channel of details?.channels ?? []) {
				const card = element("article", "channel-card");
				const title = element("div", "channel-heading");
				title.append(
					element("strong", "", channel.id),
					element("span", "subtle-pill", channel.status.replaceAll("_", " ")),
				);
				card.append(title, element("p", "small-meta", channel.adapter), element("p", "muted", channel.detail));
				page.append(card);
			}
			if (!details?.channels.length)
				page.append(
					emptyState(
						"No channels configured",
						"Your agent can propose a channel. Its creator must authorize setup before it becomes available.",
					),
				);
			body.append(page);
		}
		main.append(body);
		shell.append(aside, main);
		root.append(shell);
		if (pendingForget) {
			const dialog = element("dialog", "confirm-dialog");
			const id = pendingForget;
			dialog.setAttribute("aria-labelledby", "forget-title");
			dialog.append(element("h2", "", "Forget this memory?"));
			dialog.querySelector("h2")?.setAttribute("id", "forget-title");
			dialog.append(
				element("p", "muted", "It will no longer be recalled. Original conversation history is retained."),
			);
			const actions = element("div", "dialog-actions");
			actions.append(
				button("Keep memory", "secondary-button", () => {
					pendingForget = null;
					render();
				}),
				button(
					"Forget memory",
					"primary-button danger-fill",
					() =>
						void run(async () => {
							await port.forget(id, crypto.randomUUID());
							pendingForget = null;
							await refresh();
							notice = "Memory forgotten. Conversation history was retained.";
						}),
				),
			);
			dialog.addEventListener("cancel", () => {
				pendingForget = null;
			});
			dialog.append(actions);
			root.append(dialog);
			dialog.showModal();
			dialog.querySelector<HTMLButtonElement>("button")?.focus();
		}
		if (wasComposer && selection !== null) {
			const input = root.querySelector<HTMLTextAreaElement>("#composer");
			input?.focus();
			input?.setSelectionRange(selection, selection);
		}
	};
	const unwatch = port.watch((event) => {
		if (destroyed || signedOut) return;
		if (event.type === "view") {
			view = event.view;
			connection = "connected";
		} else connection = event.state;
		render();
	});
	render();
	void run(refresh);
	return () => {
		destroyed = true;
		unwatch();
		root.replaceChildren();
	};
}

function missionCard(details: WorkspaceDetails | null): HTMLElement {
	const card = element("section", "overview-card");
	card.append(element("p", "eyebrow", "CURRENT MISSION"));
	card.append(element("h2", "", details?.mission.objective ?? "Define what matters."));
	card.append(
		element("p", "muted", details?.mission.scope ?? "An agreed mission gives the agent direction and limits."),
	);
	card.append(element("span", "subtle-pill", details?.mission.stage.replaceAll("_", " ") ?? "Loading agreement"));
	card.append(element("p", "execution-note", "Autonomous execution is not implemented in this release."));
	return card;
}

function activityCard(view: WorkspaceView | null): HTMLElement {
	const card = element("section", "overview-card activity");
	card.append(element("p", "eyebrow", "OWNER ACTIVITY"));
	if (!view?.tools.length)
		card.append(
			element(
				"p",
				"muted",
				view?.busy ? "Working on the current request." : "No active tools. The owner is available.",
			),
		);
	for (const tool of view?.tools ?? []) {
		const row = element("div", "activity-row");
		row.append(
			element("span", `activity-marker ${tool.status}`),
			element("span", "", tool.name),
			element("span", "small-meta", tool.status),
		);
		card.append(row);
	}
	return card;
}

function pageHeading(title: string, description: string): HTMLElement {
	const page = element("section", "detail-page");
	page.append(
		element("p", "eyebrow", "AGENT WORKSPACE"),
		element("h1", "", title),
		element("p", "page-description", description),
	);
	return page;
}

function emptyState(title: string, text: string): HTMLElement {
	const empty = element("div", "empty-state");
	empty.append(element("h3", "", title), element("p", "muted", text));
	return empty;
}

function renderText(root: HTMLElement, text: string): void {
	const blocks = text.split(/```/);
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block) continue;
		if (index % 2) root.append(element("pre", "code-block", block.replace(/^\w*\n/, "")));
		else for (const paragraph of block.split(/\n\s*\n/)) root.append(element("p", "", paragraph));
	}
}

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(text: string, className: string, action: () => void): HTMLButtonElement {
	const node = element("button", className, text);
	node.type = "button";
	node.addEventListener("click", action);
	return node;
}
