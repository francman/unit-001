// Mounts the workspace: owns state and actions, builds the shell once (sidebar, top bar, bands, page, status bar) and patches it.
import type { WorkspacePort } from "./contract.ts";
import {
	type Actions,
	agentState,
	attentionCount,
	type Change,
	type Ctx,
	commandName,
	createStore,
	isConfigured,
	runBlocked,
	type Section,
	sections,
	settleSend,
	type ThemeChoice,
	type Ui,
	unknownResults,
	unnamed,
} from "./state.ts";
import { command, dot, tag } from "./ui/blocks.ts";
import { button, iconButton } from "./ui/controls.ts";
import { dialogTitleId } from "./ui/dialog.ts";
import { attrs, coarsePointer, el, srOnly } from "./ui/dom.ts";
import { count, money } from "./ui/format.ts";
import { type IconName, icon } from "./ui/icons.ts";
import { createToaster } from "./ui/toast.ts";
import { renderAbout } from "./views/about.ts";
import { type ChatView, createChat } from "./views/chat.ts";
import { renderConnections } from "./views/connections.ts";
import { renderForgetDialog, renderMemory } from "./views/memory.ts";
import { renderMission } from "./views/mission.ts";
import { renderActivity, renderStatus } from "./views/status.ts";

const pages: Record<Exclude<Section, "chat">, (ctx: Ctx) => HTMLElement> = {
	mission: renderMission,
	status: renderStatus,
	memory: renderMemory,
	connections: renderConnections,
	about: renderAbout,
};

/** Mounts the workspace against a live or sample port; unmounting never cancels the agent's work. */
export function mountWorkspace(root: HTMLElement, port: WorkspacePort, options: { preview?: boolean; section?: Section } = {}): () => void {
	const store = createStore({ section: options.section, preview: options.preview, theme: storedTheme() });
	const ui = store.ui;
	applyTheme(ui.theme);
	let destroyed = false;
	const name = () => ui.view?.name ?? unnamed;
	const context = (): Ctx => ({ ui, act, name: name() });
	const set = (change: Change, mutate: (ui: Ui) => void) => {
		if (!destroyed) store.update(change, mutate);
	};

	// One polite live region for short state words; streamed tokens are never announced.
	const live = attrs(el("div", "sr-only"), { role: "status" });
	const announce = (text: string) => {
		live.textContent = "";
		setTimeout(() => {
			live.textContent = text;
		}, 50);
	};
	const toaster = createToaster();
	const notify = (text: string) => {
		toaster.show(text);
		announce(text);
	};
	const fail = (text: string) => {
		set("state", (ui) => {
			ui.error = text;
		});
		announce(text);
	};

	// The memory graph is read only while the Memory page is open; a failed read keeps the last good snapshot.
	const loadGraph = async () => {
		try {
			const next = await port.memoryGraph();
			if (destroyed || ui.signedOut) return;
			set("state", (ui) => {
				ui.graph = next;
				ui.graphFailed = false;
			});
		} catch {
			set("state", (ui) => {
				ui.graphFailed = true;
			});
		}
	};

	const refresh = async () => {
		if (ui.section === "memory") void loadGraph();
		try {
			const next = await port.details();
			if (destroyed || ui.signedOut) return;
			// Search results are the page's own; a details refresh keeps them.
			set("state", (ui) => {
				ui.details = { ...next, memory: { ...next.memory, records: ui.details ? ui.details.memory.records : next.memory.records } };
				ui.detailsFailed = false;
			});
		} catch {
			// Details are secondary: chat keeps working, the last good details stay, and the next navigation retries.
			set("state", (ui) => {
				ui.detailsFailed = true;
			});
		}
	};

	const act: Actions = {
		go(section) {
			set("state", (ui) => {
				ui.section = section;
				ui.navOpen = false;
			});
			if (section === "chat" && !coarsePointer()) chat.focus();
			else main.focus({ preventScroll: true });
			void refresh();
		},
		send() {
			const text = ui.draft.trim();
			if (!text || ui.sending || ui.view?.busy || ui.connection !== "connected") return;
			const requestId = crypto.randomUUID();
			// The draft leaves the composer at once, as in Hermes; it is restored if the gateway refuses the message.
			set("state", (ui) => {
				ui.sending = true;
				ui.stopped = false;
				ui.error = "";
				ui.draft = "";
			});
			void (async () => {
				let outcome: Awaited<ReturnType<WorkspacePort["send"]>>;
				try {
					outcome = await port.send(text, requestId);
				} catch {
					outcome = { state: "unknown", message: "" };
				}
				if (destroyed || ui.signedOut) return;
				set("state", (ui) => settleSend(ui, outcome, requestId, text));
				if (outcome.state === "failed" || outcome.state === "failed-after-admission") announce(outcome.message);
			})();
		},
		cancel() {
			if (ui.cancelling) return;
			set("state", (ui) => {
				ui.cancelling = true;
			});
			announce("Stopping");
			void port.cancel(crypto.randomUUID()).catch(() => {
				set("state", (ui) => {
					ui.cancelling = false;
				});
				fail("Stopping could not be confirmed. Check whether the agent is still working.");
			});
		},
		setDraft(text) {
			ui.draft = text;
		},
		useDraft(text) {
			set("state", (ui) => {
				ui.draft = text;
				ui.section = "chat";
			});
			chat.focus();
		},
		dismissUnknown() {
			set("state", (ui) => {
				ui.unknown = null;
			});
			chat.focus();
		},
		dismissError() {
			set("state", (ui) => {
				ui.error = "";
			});
			if (ui.section === "chat" && !coarsePointer()) chat.focus();
			else main.focus({ preventScroll: true });
		},
		togglePurpose() {
			set("state", (ui) => {
				ui.purposeOpen = !ui.purposeOpen;
			});
		},
		toggleStatus(key) {
			set("state", (ui) => {
				ui.statusOpen = { ...ui.statusOpen, [key]: !ui.statusOpen[key] };
			});
		},
		setQuery(query) {
			ui.query = query;
		},
		search() {
			set("state", (ui) => {
				ui.recall = "searching";
			});
			void (async () => {
				try {
					const memory = await port.recall(ui.query);
					if (destroyed || ui.signedOut) return;
					set("state", (ui) => {
						if (ui.details) ui.details = { ...ui.details, memory: { ...ui.details.memory, records: memory.records } };
						ui.recall = "done";
					});
					announce(memory.records.length ? `${memory.records.length} memories found` : "No matches");
				} catch {
					set("state", (ui) => {
						ui.recall = "failed";
					});
				}
			})();
		},
		askForget(id, content, opener) {
			set("state", (ui) => {
				// The request ID is fixed here, so trying again after an unknown outcome reuses it.
				ui.pendingForget = { id, content, opener, requestId: crypto.randomUUID() };
				ui.forgetNotice = "";
			});
		},
		confirmForget() {
			const pending = ui.pendingForget;
			if (!pending || ui.forgetting) return;
			set("state", (ui) => {
				ui.forgetting = true;
			});
			void (async () => {
				let notice: string;
				try {
					const result = await port.forget(pending.id, pending.requestId);
					if (result.state === "completed") {
						set("state", (ui) => {
							const memory = ui.details?.memory;
							if (ui.details && memory)
								ui.details = {
									...ui.details,
									memory: {
										...memory,
										count: memory.count === null ? null : memory.count - 1,
										records: memory.records.filter((record) => record.id !== pending.id),
									},
								};
							// The graph drops the forgotten node and its links at once; the refresh below re-reads the real snapshot.
							const graph = ui.graph;
							if (graph)
								ui.graph = {
									...graph,
									nodes: graph.nodes.filter((node) => node.id !== pending.id),
									edges: graph.edges.filter((edge) => edge.from !== pending.id && edge.to !== pending.id),
									total: Math.max(0, graph.total - 1),
								};
							ui.pendingForget = null;
							ui.forgetting = false;
							ui.recall = "idle";
						});
						focusKey("memory-query");
						notify("Memory forgotten. Conversation history was retained.");
						void refresh();
						return;
					}
					notice =
						result.state === "unknown"
							? `Forget outcome not confirmed. Close this dialog and search again to check. Request ID ${pending.requestId}. Trying again reuses this ID and may stay unknown.`
							: result.message;
				} catch {
					notice = `Forget outcome not confirmed. Close this dialog and search again to check. Request ID ${pending.requestId}.`;
				}
				set("state", (ui) => {
					ui.forgetting = false;
					ui.forgetNotice = notice;
				});
				announce(notice);
			})();
		},
		closeForget() {
			const opener = ui.pendingForget?.opener ?? "memory-query";
			set("state", (ui) => {
				ui.pendingForget = null;
				ui.forgetting = false;
				ui.forgetNotice = "";
			});
			focusKey(opener);
		},
		async copy(text, label) {
			try {
				await navigator.clipboard.writeText(text);
				notify(`${label} copied.`);
				return true;
			} catch {
				fail("Copy was blocked by the browser. Select the text and copy it by hand.");
				return false;
			}
		},
		notify,
		setTheme(choice) {
			applyTheme(choice);
			set("state", (ui) => {
				ui.theme = choice;
			});
		},
		setNav(open) {
			set("state", (ui) => {
				ui.navOpen = open;
			});
			focusKey(open ? `nav-${ui.section}` : "menu");
		},
		signOut() {
			void (async () => {
				try {
					await port.logout();
				} catch {
					fail("Sign out could not be confirmed. Close this tab, then stop the web command in its terminal.");
					return;
				}
				set("state", (ui) => {
					ui.signedOut = true;
					ui.view = null;
					ui.details = null;
					ui.draft = "";
					ui.unknown = null;
					ui.pendingForget = null;
					ui.connection = "offline";
				});
				announce("Signed out. Your agent keeps running.");
			})();
		},
	};

	// ── The shell, built once. ──
	const chat: ChatView = createChat(context);
	const main = attrs(el("main", "flex min-h-0 min-w-0 flex-1 flex-col outline-none"), { id: "main", tabindex: "-1" });
	const navButtons = new Map<Section, HTMLButtonElement>();
	const agentTab = el("span", "truncate");
	const version = el("span", "");
	const themeButton = iconButton({ icon: "monitor", label: "Theme", key: "theme", onClick: () => act.setTheme(nextTheme[ui.theme]) });
	const sidebar = buildSidebar();
	const menuButton = iconButton({ icon: "menu", label: "Menu", key: "menu", onClick: () => act.setNav(!ui.navOpen) });
	menuButton.className = `${menuButton.className} md:hidden`;
	menuButton.setAttribute("aria-controls", "sidebar");
	const crumbAgent = el("span", "truncate text-fg-3 max-md:hidden");
	const crumbPage = el("span", "truncate font-medium text-fg");
	const topbar = el(
		"header",
		"flex h-[34px] shrink-0 items-center gap-1.5 px-4 max-md:h-11 max-md:px-1.5",
		menuButton,
		el(
			"div",
			"flex min-w-0 items-center gap-1.5 text-sm",
			crumbAgent,
			el("span", "text-fg-4 max-md:hidden", icon("chevronRight", "size-3 shrink-0")),
			crumbPage,
		),
		options.preview ? el("span", "ml-auto", tag("Sample data", "accent")) : null,
	);
	const bands = el("div", "flex shrink-0 flex-col empty:hidden");
	const rail = attrs(el("aside", "hidden w-[18.75rem] shrink-0 flex-col overflow-y-auto border-l border-stroke-4 bg-sidebar xl:flex"), {
		"aria-label": "Activity",
		"data-scroll": "activity",
	});
	const workspace = el("div", "flex min-w-0 flex-1 flex-col bg-canvas", topbar, bands, el("div", "flex min-h-0 flex-1", main, rail));
	const statusbar = attrs(
		el("footer", "flex h-5 shrink-0 items-stretch overflow-hidden bg-sidebar px-1.5 text-xs text-fg-3 pb-[env(safe-area-inset-bottom)] box-content"),
		{ "aria-label": "Status bar" },
	);
	const scrim = el("div", "fixed inset-0 z-30 bg-scrim animate-fade md:hidden");
	scrim.hidden = true;
	scrim.addEventListener("click", () => act.setNav(false));
	const dialog = attrs(
		el("dialog", "m-auto w-[min(32rem,calc(100vw-2rem))] max-w-none rounded-md border border-line bg-bubble p-0 text-fg shadow-float animate-rise"),
		{ "aria-labelledby": dialogTitleId },
	);
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		act.closeForget();
	});
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) act.closeForget();
	});
	const skip = el(
		"a",
		"absolute -top-16 left-2 z-50 rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent focus:top-2",
		"Skip to content",
	);
	skip.href = "#main";
	skip.addEventListener("click", (event) => {
		event.preventDefault();
		main.focus();
	});
	const app = el(
		"div",
		"relative flex h-dvh flex-col overflow-hidden bg-canvas text-fg",
		skip,
		el("div", "flex min-h-0 flex-1", sidebar, workspace),
		statusbar,
		scrim,
	);
	root.replaceChildren(app, dialog, toaster.root, live);

	// ── Patching: every region compares what it shows with the state and changes only what differs. ──
	let pageShown: Section | null = null;
	let bandsSignature = "";
	const render = (change: Change) => {
		if (destroyed) return;
		if (ui.signedOut) return renderSignedOut();
		patchSidebar();
		patchTopbar();
		patchBands();
		patchPage(change);
		patchRail(change);
		patchStatusbar();
		patchDialog();
	};

	function patchSidebar(): void {
		const open = ui.navOpen;
		sidebar.className = open
			? "fixed inset-y-0 left-0 z-40 flex w-[16.25rem] max-w-[85vw] flex-col bg-sidebar shadow-float animate-fade md:static md:z-auto md:max-w-none md:shadow-none"
			: "flex w-[16.25rem] shrink-0 flex-col bg-sidebar max-md:hidden";
		scrim.hidden = !open;
		menuButton.setAttribute("aria-expanded", String(open));
		agentTab.textContent = name();
		for (const [section, item] of navButtons) {
			item.setAttribute("aria-current", ui.section === section ? "page" : "false");
			const waiting = String(attentionCount(ui, section));
			if (item.dataset.waiting === waiting) continue;
			item.dataset.waiting = waiting;
			for (const old of item.querySelectorAll("[data-attention]")) old.remove();
			if (waiting === "0") continue;
			item.append(
				attrs(el("span", "ml-auto inline-grid h-4 min-w-4 place-items-center rounded-xs bg-warn/10 px-1 text-2xs font-semibold text-warn tabular-nums", waiting), {
					"data-attention": "",
					"aria-hidden": "true",
				}),
				attrs(srOnly(`, ${waiting} need${waiting === "1" ? "s" : ""} you`), { "data-attention": "" }),
			);
		}
		themeButton.replaceChildren(icon(themeIcons[ui.theme], "size-3.5 shrink-0"), srOnly(`Theme: ${themeWords[ui.theme]}`));
		themeButton.title = `Theme: ${themeWords[ui.theme]} (click to change)`;
		version.textContent = ui.view ? `v${ui.view.version}` : "";
	}

	function patchTopbar(): void {
		crumbAgent.textContent = name();
		crumbPage.textContent = sections.find((entry) => entry.id === ui.section)?.label ?? "";
	}

	function patchBands(): void {
		const signature = bandSignature(ui, name());
		if (signature === bandsSignature) return;
		bandsSignature = signature;
		preserve(bands, () => buildBands(context()));
	}

	function patchPage(change: Change): void {
		if (ui.section === "chat") {
			if (pageShown !== "chat") main.replaceChildren(chat.root);
			pageShown = "chat";
			chat.update(change);
			return;
		}
		if (change === "stream" && pageShown === ui.section) return;
		pageShown = ui.section;
		preserve(main, () => pages[ui.section as Exclude<Section, "chat">](context()));
	}

	function patchRail(change: Change): void {
		rail.hidden = ui.section !== "chat";
		if (rail.hidden || (change === "stream" && rail.firstChild)) return;
		preserve(rail, () => attrs(el("div", "flex min-h-full flex-col", renderActivity(context())), { "data-activity-body": "" }));
	}

	function patchStatusbar(): void {
		const state = agentState(ui, Date.now());
		const item = "flex min-w-0 items-center gap-1.5 px-1.5 whitespace-nowrap";
		const connection = connectionWords[ui.connection];
		const parts: Node[] = [
			el("span", `${item} shrink-0`, dot(connection.tone), el("span", connection.tone === "idle" ? "" : connection.color, connection.word)),
		];
		if (ui.connection === "connected") parts.push(el("span", `${item} min-w-0 truncate`, dot(state.tone), el("span", "truncate", state.text)));
		const right = el("div", "ml-auto flex min-w-0 items-stretch max-md:hidden");
		const view = ui.view;
		if (view?.model) right.append(el("span", `${item} min-w-0`, icon("cpu", "size-3 shrink-0"), el("span", "truncate", view.model.modelId)));
		if (view?.usage) {
			right.append(el("span", `${item} tabular-nums`, `${count(view.usage.totalTokens)} tokens`));
			right.append(
				el("span", `${item} tabular-nums`, view.usage.cost.kind === "estimate" ? `~${money(view.usage.cost.usd)} est.` : "cost unknown"),
			);
		}
		statusbar.replaceChildren(...parts, right);
	}

	function patchDialog(): void {
		if (!ui.pendingForget) {
			if (dialog.open) dialog.close();
			dialog.replaceChildren();
			return;
		}
		preserve(dialog, () => renderForgetDialog(context()));
		if (!dialog.open) {
			dialog.showModal();
			dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
		}
	}

	function renderSignedOut(): void {
		toaster.clear();
		if (dialog.open) dialog.close();
		const cmd = `${commandName(name())} web`;
		// The same brand line and card as the pairing screen, which is where the owner goes next.
		root.replaceChildren(
			el(
				"main",
				"flex min-h-dvh flex-col items-center justify-center gap-5 bg-canvas px-4 py-8 text-fg",
				el("div", "flex items-center gap-2 text-fg", icon("terminal", "size-4 shrink-0"), el("span", "text-sm font-semibold tracking-[0.12em]", "UNIT-001")),
				el(
					"div",
					"flex w-full max-w-[28rem] flex-col gap-3 rounded-md border border-line bg-bubble p-5 shadow-float max-sm:p-4",
					el("h1", "text-md font-semibold text-fg", "Signed out. Your agent keeps running."),
					el("p", "text-base text-fg-2", "To come back, run its web command in the terminal where it runs, reload this page and enter the new code:"),
					command(cmd, "copy-web", act.copy),
				),
			),
			toaster.root,
			live,
		);
	}

	// Focuses an element by id or data-key once the current patch has run.
	function focusKey(key: string): void {
		const target = root.querySelector<HTMLElement>(`[id="${CSS.escape(key)}"]`) ?? root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
		target?.focus({ preventScroll: true });
	}

	function buildSidebar(): HTMLElement {
		const nav = attrs(el("nav", "flex flex-col gap-px px-2.5 pt-1.5"), { "aria-label": "Workspace" });
		for (const section of sections) {
			const item = el(
				"button",
				"group flex h-7 w-full min-w-0 items-center gap-2 rounded-xs px-2 text-left text-base font-medium text-fg-2 transition-colors duration-100 hover:bg-hover hover:text-fg aria-[current=page]:bg-fill aria-[current=page]:text-fg pointer-coarse:h-11",
				icon(section.icon, "size-4 shrink-0 text-fg-3 group-hover:text-fg-2 group-aria-[current=page]:text-fg"),
				el("span", "truncate", section.label),
			);
			item.type = "button";
			item.id = `nav-${section.id}`;
			item.dataset.key = `nav-${section.id}`;
			item.addEventListener("click", () => act.go(section.id));
			navButtons.set(section.id, item);
			nav.append(item);
		}
		const close = iconButton({ icon: "close", label: "Close menu", key: "nav-close", onClick: () => act.setNav(false) });
		close.className = `${close.className} md:hidden`;
		const head = el(
			"div",
			"flex h-[34px] shrink-0 items-center justify-between pr-1.5 pl-4 max-md:h-11",
			el("span", "text-xs font-bold tracking-[0.14em] text-fg", "UNIT-001"),
			close,
		);
		const tabs = el(
			"div",
			"flex h-7 shrink-0 items-stretch px-0 shadow-[inset_0_-1px_0_var(--stroke-4)]",
			el("span", "flex min-w-0 items-center px-2.5 text-xs font-medium tracking-[0.04em] text-fg uppercase shadow-[inset_0_-2px_0_var(--accent)]", agentTab),
		);
		const signOut = iconButton({ icon: "logout", label: "Sign out", key: "signout", onClick: () => act.signOut() });
		const foot = el(
			"div",
			"flex h-[34px] shrink-0 items-center gap-0.5 px-2.5 max-md:h-12",
			themeButton,
			signOut,
			el("span", "ml-auto truncate pr-1 font-mono text-2xs text-fg-3", version),
		);
		return attrs(el("aside", "", head, tabs, nav, el("div", "min-h-4 flex-1"), foot), { id: "sidebar", "aria-label": "Sidebar" });
	}

	// ── Events. ──
	const onKey = (event: KeyboardEvent) => {
		if (destroyed || ui.signedOut || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || ui.pendingForget) return;
		const target = event.target;
		const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
		if (typing && event.key !== "Escape") return;
		if (shortcuts.some((entry) => entry.key === event.key && entry.run(act, ui))) event.preventDefault();
	};
	document.addEventListener("keydown", onKey);
	const baseTitle = document.title;
	const onVisible = () => {
		if (!document.hidden) document.title = baseTitle;
	};
	document.addEventListener("visibilitychange", onVisible);
	// Elapsed time while replying ages every second; relative times on pages ("next wake in 5 min") every 30 s.
	const secondTimer = setInterval(() => {
		if (ui.view?.busy && !ui.signedOut) patchStatusbar();
	}, 1000);
	const minuteTimer = setInterval(() => set("state", () => {}), 30_000);

	const unsubscribe = store.subscribe(render);
	const unwatch = port.watch((event) => {
		if (destroyed || ui.signedOut) return;
		if (event.type === "connection") {
			set("state", (ui) => {
				ui.connection = event.state;
			});
			announce(event.state === "connecting" ? "Reconnecting" : event.state === "expired" ? "Session ended" : "Offline");
			return;
		}
		const next = event.view;
		const previous = ui.view;
		const wasBusy = previous?.busy === true;
		const change: Change = ui.connection === "connected" && previous !== null && sameFrame(previous, next) ? "stream" : "state";
		set(change, (ui) => {
			if (!wasBusy && next.busy) {
				ui.stopped = false;
				ui.runTools = [];
				ui.finishedTools = [];
				ui.runStartedAt = Date.now();
			}
			if (next.busy) {
				// Keeps the latest status of every tool call seen, so the finished run can be summarized.
				const seen = new Map(ui.runTools.map((tool) => [tool.callId, tool]));
				for (const tool of next.tools) seen.set(tool.callId, tool);
				ui.runTools = [...seen.values()];
			}
			if (wasBusy && !next.busy) {
				ui.finishedTools = ui.runTools;
				ui.runStartedAt = null;
				ui.stopped = ui.cancelling;
			}
			if (!next.busy) ui.cancelling = false;
			ui.view = next;
			ui.connection = "connected";
		});
		if (wasBusy !== next.busy) announce(next.busy ? "Working" : ui.stopped ? "Stopped" : "Reply finished");
		if (wasBusy && !next.busy) {
			if (document.hidden) document.title = `● ${name()} replied`;
			void refresh();
		}
	});
	render("state");
	void refresh();
	return () => {
		destroyed = true;
		unwatch();
		unsubscribe();
		chat.destroy();
		document.removeEventListener("keydown", onKey);
		document.removeEventListener("visibilitychange", onVisible);
		clearInterval(secondTimer);
		clearInterval(minuteTimer);
		root.replaceChildren();
	};
}

/** Keys the workspace reacts to outside text fields (Escape also inside them); one table, no key checks in handlers. */
const shortcuts: readonly { key: string; run: (act: Actions, ui: Readonly<Ui>) => boolean }[] = [
	{ key: "Escape", run: (act, ui) => ui.navOpen && (act.setNav(false), true) },
	{ key: "Escape", run: (act, ui) => ui.view?.busy === true && (act.cancel(), true) },
	{ key: "/", run: (act, ui) => ui.section !== "chat" && (act.go("chat"), true) },
];

/** True when only the live text or tool rows changed, so the frame (bands, pages, rail) stays as it is. */
function sameFrame(a: NonNullable<Ui["view"]>, b: NonNullable<Ui["view"]>): boolean {
	return (
		a.busy === b.busy &&
		a.entries.length === b.entries.length &&
		a.entries.at(-1)?.id === b.entries.at(-1)?.id &&
		a.model?.provider === b.model?.provider &&
		a.model?.modelId === b.model?.modelId &&
		a.name === b.name &&
		a.historyTruncated === b.historyTruncated
	);
}

const connectionWords = {
	connected: { word: "Connected", tone: "idle", color: "" },
	connecting: { word: "Reconnecting", tone: "waiting", color: "text-fg-2" },
	offline: { word: "Offline", tone: "blocked", color: "text-danger" },
	expired: { word: "Session ended", tone: "blocked", color: "text-danger" },
} as const;

const themeIcons: Record<ThemeChoice, IconName> = { system: "monitor", light: "sun", dark: "moon" };
const themeWords: Record<ThemeChoice, string> = { system: "follows the system", light: "light", dark: "dark" };
const nextTheme: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const themeKey = "unit-001-theme";

// The theme choice for this browser: the system setting unless the person picked one. A preview URL may preset it.
function storedTheme(): ThemeChoice {
	const preset = document.documentElement.dataset.theme;
	if (preset === "light" || preset === "dark") return preset;
	try {
		const stored = localStorage.getItem(themeKey);
		return stored === "light" || stored === "dark" ? stored : "system";
	} catch {
		return "system";
	}
}

function applyTheme(choice: ThemeChoice): void {
	if (choice === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = choice;
	try {
		if (choice === "system") localStorage.removeItem(themeKey);
		else localStorage.setItem(themeKey, choice);
	} catch {
		// Storage can be blocked (private mode); the choice then lasts for this page only.
	}
}

/**
 * Replaces a region's content and puts back what the person was doing in it: the focused control (by id or
 * data-key), its text selection, and the scroll offset of every `[data-scroll]` element.
 */
function preserve(region: HTMLElement, build: () => Node): void {
	const active = document.activeElement;
	const inside = active instanceof HTMLElement && region.contains(active);
	const key = inside ? active.id || active.dataset.key || null : null;
	const selection =
		inside && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ? [active.selectionStart, active.selectionEnd] : null;
	const scrolls = new Map<string, number>();
	for (const node of region.querySelectorAll<HTMLElement>("[data-scroll]")) scrolls.set(node.dataset.scroll ?? "", node.scrollTop);
	const regionScroll = region.scrollTop;
	region.replaceChildren(build());
	region.scrollTop = regionScroll;
	for (const node of region.querySelectorAll<HTMLElement>("[data-scroll]")) {
		const top = scrolls.get(node.dataset.scroll ?? "");
		if (top !== undefined) node.scrollTop = top;
	}
	if (!key) return;
	const target =
		region.querySelector<HTMLElement>(`[id="${CSS.escape(key)}"]`) ?? region.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
	target?.focus({ preventScroll: true });
	if (selection && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement))
		target.setSelectionRange(selection[0], selection[1]);
}

/** The inputs the bands are built from; equal signatures mean the bands are already right. */
function bandSignature(ui: Readonly<Ui>, name: string): string {
	const run = ui.details?.mission.run ?? null;
	const blocked = runBlocked(run) && run ? `${run.status}:${run.unknownRequests}:${run.uncertainTools}:${run.unpricedResponses}:${run.blocker}` : "";
	return [ui.connection, ui.details?.owner?.held === true, isConfigured(ui), blocked, ui.section === "status" || ui.section === "mission", ui.error, name, ui.view === null].join("|");
}

/** The strips above the page: connection, what the owner must do, and the last error. Each says what to do next. */
function buildBands(ctx: Ctx): HTMLElement {
	const { ui, act, name } = ctx;
	const cmd = commandName(name);
	const strips = el("div", "flex flex-col");
	if (ui.connection === "connecting")
		strips.append(band("warn", "Reconnecting.", "Your draft is kept. Nothing you sent is replayed.", [], "status"));
	else if (ui.connection === "expired")
		strips.append(
			band("danger", "Your session ended.", "Run this in the agent's terminal, reload, then enter the new code:", [command(`${cmd} web`, "copy-web", act.copy)], "status"),
		);
	else if (ui.connection === "offline")
		strips.append(
			band(
				"danger",
				"Cannot reach the agent.",
				"Your draft is kept and the agent keeps working. Check that the web command is running and only one tab is open, then reload.",
				[],
				"status",
			),
		);
	const owner = attrs(el("div", "flex flex-col"), { "data-owner-banners": "" });
	if (ui.view) {
		const run = ui.details?.mission.run ?? null;
		// The Status and Mission pages explain a blocked run in full; the strip would only repeat it there.
		if (run && runBlocked(run) && ui.section !== "status" && ui.section !== "mission")
			owner.append(band("danger", "Blocked.", blockedSentence(run, name), [command(`${cmd} mission status`, "copy-mission", act.copy)]));
		if (ui.details?.owner?.held)
			owner.append(
				band("warn", "On hold.", `A maintenance hold is active, so ${name} is not taking new work. Messages you send will wait.`, []),
			);
		if (!isConfigured(ui))
			owner.append(
				band("warn", "No model is configured.", `${name} cannot answer until you run setup in a terminal:`, [
					command(`sudo ${cmd} setup`, "copy-setup", act.copy),
				]),
			);
	}
	strips.append(owner);
	if (ui.error)
		strips.append(
			band("danger", "", ui.error, [button({ label: "Dismiss", key: "dismiss-error", variant: "ghost", onClick: () => act.dismissError() })], "alert"),
		);
	return strips;
}

const bandTones = {
	warn: { box: "border-warn/25 bg-warn/8", glyph: "warning", color: "text-warn" },
	danger: { box: "border-danger/25 bg-danger/8", glyph: "alert", color: "text-danger" },
} as const;

/** One full-width strip: icon, bold lead-in, sentence, then its command or action at the right (wrapping below on phones). */
function band(tone: keyof typeof bandTones, title: string, body: string, trailing: HTMLElement[], role?: "status" | "alert"): HTMLElement {
	const style = bandTones[tone];
	const sentence = el("p", "min-w-[16rem] flex-1 text-sm text-fg [overflow-wrap:anywhere] max-sm:min-w-0", title ? el("strong", `font-semibold ${style.color}`, `${title} `) : null, body);
	const strip = el(
		"div",
		`flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 max-md:px-3 ${style.box}`,
		el("span", `self-start pt-px ${style.color}`, icon(style.glyph, "size-4 shrink-0")),
		sentence,
		trailing.length ? el("div", "flex max-w-full min-w-0 items-center justify-end gap-2 max-sm:w-full [&>div]:min-w-0 [&>div]:flex-1", ...trailing) : null,
	);
	if (role) strip.setAttribute("role", role);
	return strip;
}

// Says what happened, what the agent does about it, and where to look; the command shows details, it does not resolve them.
function blockedSentence(run: NonNullable<NonNullable<Ui["details"]>["mission"]["run"]>, name: string): string {
	const parts = [
		run.unknownRequests > 0 ? `${run.unknownRequests} model request${run.unknownRequests === 1 ? "" : "s"}` : "",
		run.uncertainTools > 0 ? `${run.uncertainTools} tool call${run.uncertainTools === 1 ? "" : "s"}` : "",
		run.unpricedResponses > 0 ? `${run.unpricedResponses} response${run.unpricedResponses === 1 ? "" : "s"} with no price` : "",
	].filter(Boolean);
	if (parts.length === 0) return `${run.blocker ?? `${name} cannot continue scheduled work.`} See the details in a terminal:`;
	const one = unknownResults(run) === 1;
	const listed = parts.length < 2 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
	return `${listed} ${one ? "has an unknown result" : "have unknown results"}, so ${name} will not continue scheduled work until you review ${one ? "it" : "them"}. See ${one ? "it" : "them"} in a terminal:`;
}
