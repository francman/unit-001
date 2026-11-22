// Mounts the workspace: owns state and actions, builds the shell once (sidebar, top bar, bands, page, status bar) and patches it.
import { describeMissionRefusal } from "../src/missions/refusal.ts";
import type { ChatHistoryPage, MissionDraftTerms, MissionMutation, MissionMutationOutcome, WorkspaceDetails, WorkspacePort } from "./contract.ts";
import { mergeChatEntries } from "./history.ts";
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
import { callout, command, dot, tag } from "./ui/blocks.ts";
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
import { missionApprovalCommand, missionProposalDigest, renderMission } from "./views/mission.ts";
import { createMissionDraftEditor, type MissionDraftEditor, renderMissionDraftCard } from "./views/mission-draft.ts";
import { renderActivity, renderStatus } from "./views/status.ts";

const pages: Record<Exclude<Section, "chat" | "mission">, (ctx: Ctx) => HTMLElement> = {
	status: renderStatus,
	memory: renderMemory,
	connections: renderConnections,
	about: renderAbout,
};

type MissionSnapshot = WorkspaceDetails["mission"];

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
	const announce = (text: string, current?: () => boolean) => {
		live.textContent = "";
		setTimeout(() => {
			if (!current || current()) live.textContent = text;
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

	let graphRead = 0;
	let detailsRead = 0;
	let recallRead = 0;

	// The memory graph is read only while the Memory page is open; a failed read keeps the last good snapshot.
	const loadGraph = async () => {
		const read = ++graphRead;
		try {
			const next = await port.memoryGraph();
			if (destroyed || ui.signedOut || read !== graphRead) return;
			set("state", (ui) => {
				ui.graph = next;
				ui.graphFailed = false;
			});
		} catch {
			if (destroyed || ui.signedOut || read !== graphRead) return;
			set("state", (ui) => {
				ui.graphFailed = true;
			});
		}
	};

	let missionVersion = 0;
	let missionEditor: { base: MissionSnapshot; view: MissionDraftEditor } | null = null;

	function noteDraftConflict(mission: MissionSnapshot): void {
		const unsaved = ui.missionDraft?.unsaved;
		if (unsaved && missionEditor && mission.formationAvailable && !sameMissionDraft(missionEditor.base, mission))
			unsaved.conflicted = true;
	}

	const refresh = async () => {
		const read = ++detailsRead;
		if (ui.section === "memory") void loadGraph();
		const version = missionVersion;
		try {
			const next = await port.details();
			if (destroyed || ui.signedOut || read !== detailsRead) return;
			set("state", (ui) => {
				ui.details = {
					...next,
					mission: version === missionVersion ? next.mission : (ui.details?.mission ?? next.mission),
				};
				noteDraftConflict(ui.details.mission);
				ui.detailsFailed = false;
			});
		} catch {
			if (destroyed || ui.signedOut || read !== detailsRead) return;
			// Details are secondary: chat keeps working, the last good details stay, and the next navigation retries.
			set("state", (ui) => {
				ui.detailsFailed = true;
			});
		}
	};

	async function searchMemory(query: string): Promise<void> {
		const read = ++recallRead;
		const current = () => !destroyed && !ui.signedOut && read === recallRead;
		set("state", (ui) => {
			ui.recall = { kind: "searching", query };
		});
		try {
			const { records } = await port.recall(query);
			if (!current()) return;
			set("state", (ui) => {
				ui.recall = { kind: "done", query, records };
			});
			announce(records.length ? `${records.length} ${records.length === 1 ? "memory" : "memories"} found` : "No matches", current);
		} catch {
			if (!current()) return;
			set("state", (ui) => {
				ui.recall = { kind: "failed", query };
			});
		}
	}

	function openMissionDraft(): void {
		if (!missionEntryAvailable(ui)) return;
		const alreadyOpen = ui.missionDraft !== null;
		set("state", (ui) => {
			ui.missionDraft ??= { editRevision: null, unsaved: null, status: "ready", notice: "", localAgreementRevision: null };
			ui.section = "chat";
			ui.navOpen = false;
			if (!alreadyOpen && ui.draft === "") ui.draft = "Let's define your mission.";
		});
		focusKey("mission-draft-heading");
		if (!alreadyOpen) void refreshMissionDraft();
	}

	async function refreshMissionDraft(notice = ui.missionDraft?.notice ?? "", intent: "keep-edits" | "discard-edits" = "keep-edits"): Promise<void> {
		const current = ui.missionDraft;
		if (!current || current.status === "saving" || ui.connection !== "connected") return;
		const panel = intent === "discard-edits" ? { ...current, unsaved: null } : current;
		const version = ++missionVersion;
		set("state", (ui) => {
			ui.missionDraft = { ...panel, editRevision: null, status: "refreshing", notice };
		});
		try {
			const mission = await port.mission();
			if (destroyed || ui.signedOut || version !== missionVersion) return;
			++missionVersion;
			set("state", (ui) => {
				if (ui.details) ui.details = { ...ui.details, mission };
				ui.detailsFailed = false;
				ui.missionDraft = { ...panel, editRevision: null, status: "ready", notice };
				noteDraftConflict(mission);
			});
		} catch {
			if (destroyed || ui.signedOut || version !== missionVersion) return;
			set("state", (ui) => {
				ui.missionDraft = { ...panel, editRevision: null, status: "needs-refresh", notice };
			});
		}
	}

	async function mutateMission(change: MissionMutation, shown: MissionSnapshot): Promise<void> {
		const panel = ui.missionDraft;
		const mission = ui.details?.mission;
		if (!panel || panel.status !== "ready" || !mission || ui.connection !== "connected" || ui.detailsFailed || ui.details?.owner?.held) return;
		const expected = missionRevision(mission);
		const matches = change.operation === "agree"
			? mission.canAgree && mission.formationAvailable && mission.draft?.status === "proposed" &&
				mission.draft.missionId === shown.draft?.missionId && expected === change.revision &&
				missionProposalDigest(mission) === change.digest && mission.review?.authorityRevision === shown.review?.authorityRevision &&
				(mission.authority === "developer-local"
					? change.previousReceipt === undefined
					: mission.authority === "managed-administrator" && mission.review !== null &&
						change.previousReceipt !== undefined && mission.previousReceipt === change.previousReceipt) &&
				(mission === shown || JSON.stringify(mission.draft.terms) === JSON.stringify(shown.draft?.terms)) &&
				ui.missionReceipt?.revision !== change.revision
			: mission.formationAvailable && !panel.unsaved?.conflicted && expected === change.expectedRevision && sameMissionDraft(shown, mission);
		if (!matches) {
			await refreshMissionDraft("The draft or approval changed. Review the fresh terms before acting.");
			return;
		}
		++missionVersion;
		set("state", (ui) => {
			ui.missionDraft = { ...panel, status: "saving", notice: "" };
		});
		let result: MissionMutationOutcome;
		try {
			result = await port.mutateMission(change, crypto.randomUUID());
		} catch {
			result = { state: "unknown" };
		}
		if (destroyed || ui.signedOut) return;
		++missionVersion;
		if (result.state === "completed") {
			missionEditor = null;
			const updated = result.mission;
			set("state", (ui) => {
				if (ui.details) ui.details = { ...ui.details, mission: updated };
				ui.missionDraft = { editRevision: null, unsaved: null, status: "ready", notice: "", localAgreementRevision: change.operation === "agree" ? change.revision : null };
			});
			return;
		}
		if (result.state === "issued" && change.operation === "agree") {
			const { receiptId, reconciled } = result;
			set("state", (ui) => {
				ui.missionReceipt = { revision: change.revision, receiptId, reconciled };
				ui.missionDraft = { ...panel, editRevision: null, status: "ready", notice: "" };
			});
			if (reconciled) await refreshMissionDraft();
			return;
		}
		const notice = result.state === "refused" ? describeMissionRefusal(result.code)
			: result.state === "rejected" ? "The gateway rejected this mission change before dispatch."
				: "The outcome is unknown. Check the current mission before acting again. Nothing was retried.";
		set("state", (ui) => {
			if (panel.unsaved && result.state === "refused" && result.code === "stale-revision") panel.unsaved.conflicted = true;
			ui.missionDraft = { ...panel, status: "needs-refresh", notice };
		});
		await refreshMissionDraft(notice);
	}

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
		async loadEarlier() {
			const history = ui.chatHistory;
			if (destroyed || ui.signedOut || ui.connection !== "connected" || history.kind === "loading" || history.kind === "exhausted") return;
			if (history.kind === "unstarted" && !ui.view?.historyTruncated) return;
			const before = history.kind === "unstarted" ? (ui.chatEntries[0]?.id ?? null) : history.before;
			set("state", (ui) => {
				ui.chatHistory = { kind: "loading", before };
			});
			announce("Loading earlier messages.");
			let page: ChatHistoryPage;
			try {
				page = await port.history(before);
			} catch {
				if (destroyed || ui.signedOut) return;
				set("state", (ui) => {
					ui.chatHistory = { kind: "failed", before };
				});
				announce("Could not load earlier messages. Try again.");
				return;
			}
			if (destroyed || ui.signedOut) return;
			const reachedStart = page.nextBefore === null;
			const entries = mergeChatEntries(ui.chatEntries, page.entries, "page");
			const added = entries.length - ui.chatEntries.length;
			set("state", (ui) => {
				ui.chatEntries = entries;
				ui.chatHistory = page.nextBefore === null ? { kind: "exhausted" } : { kind: "ready", before: page.nextBefore };
			});
			announce(
				added
					? `${added} earlier ${added === 1 ? "message" : "messages"} loaded.${reachedStart ? " Start of conversation." : ""}`
					: reachedStart
						? "No more earlier messages."
						: "No messages in this page. You can keep loading earlier messages.",
			);
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
			if (destroyed || ui.signedOut) return;
			const query = ui.query.trim();
			if (ui.recall.kind === "searching" && ui.recall.query === query) return;
			void searchMemory(query);
		},
		askForget(id, content, opener) {
			if (destroyed || ui.signedOut || ui.pendingForget || ui.forgetting) return;
			set("state", (ui) => {
				// The request ID is fixed here, so trying again after an unknown outcome reuses it.
				ui.pendingForget = { id, content, opener, requestId: crypto.randomUUID() };
				ui.forgetNotice = "";
			});
		},
		confirmForget() {
			const pending = ui.pendingForget;
			if (destroyed || ui.signedOut || !pending || ui.forgetting) return;
			set("state", (ui) => {
				ui.forgetting = pending.requestId;
				ui.forgetNotice = "";
			});
			focusKey(dialogTitleId);
			void (async () => {
				let result: Awaited<ReturnType<WorkspacePort["forget"]>>;
				try {
					result = await port.forget(pending.id, pending.requestId);
				} catch {
					result = { state: "unknown", message: "" };
				}
				if (destroyed || ui.signedOut || ui.forgetting !== pending.requestId) return;
				const sameDialog = ui.pendingForget?.requestId === pending.requestId;
				if (result.state !== "completed") {
					const notice = result.state === "unknown"
						? `Forget outcome not confirmed. Close this dialog and search again to check. Request ID ${pending.requestId}. Trying again reuses this ID and may stay unknown.`
						: result.message;
					set("state", (ui) => {
						ui.forgetting = null;
						if (sameDialog) ui.forgetNotice = notice;
					});
					if (sameDialog) announce(notice);
					return;
				}

				// A read started before the confirmed removal cannot reintroduce the forgotten memory.
				++detailsRead;
				++graphRead;
				++recallRead;
				const recall = ui.recall;
				set("state", (ui) => {
					if (ui.details) {
						const memory = ui.details.memory;
						ui.details = {
							...ui.details,
							memory: {
								...memory,
								count: memory.count === null ? null : Math.max(0, memory.count - 1),
								records: memory.records.filter((record) => record.id !== pending.id),
							},
						};
					}
					const graph = ui.graph;
					if (graph) {
						const nodes = graph.nodes.filter((node) => node.id !== pending.id);
						const total = Math.max(0, graph.total - 1);
						ui.graph = {
							nodes,
							edges: graph.edges.filter((edge) => edge.from !== pending.id && edge.to !== pending.id),
							total,
							limited: nodes.length < total,
						};
					}
					if (recall.kind === "done") {
						ui.recall = { ...recall, records: recall.records.filter((record) => record.id !== pending.id) };
					}
					ui.forgetting = null;
					if (sameDialog) ui.pendingForget = null;
				});
				if (sameDialog) focusKey("memory-query");
				notify("Memory forgotten. Conversation history was retained.");
				void refresh();
				if (recall.kind === "searching") void searchMemory(recall.query);
			})();
		},
		closeForget() {
			if (ui.forgetting || !ui.pendingForget) return;
			const { opener } = ui.pendingForget;
			set("state", (ui) => {
				ui.pendingForget = null;
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
			if (open && !mobile.matches) return;
			set("state", (ui) => {
				ui.navOpen = open;
			});
			if (open) navButtons.get(ui.section)?.focus();
			else menuButton.focus({ preventScroll: true });
		},
		signOut() {
			if (ui.signedOut) return;
			const revocation = port.logout().catch(() => "unconfirmed" as const);
			set("state", (ui) => {
				ui.signedOut = true;
				ui.logoutNotice = "Signed out locally. Confirming remote session revocation…";
				ui.missionDraft = null;
				ui.missionReceipt = null;
				ui.view = null;
				ui.chatEntries = [];
				ui.chatHistory = { kind: "unstarted" };
				ui.details = null;
				ui.draft = "";
				ui.unknown = null;
				ui.pendingForget = null;
				ui.forgetting = null;
				ui.query = "";
				ui.recall = { kind: "idle" };
				ui.graph = null;
				ui.runTools = [];
				ui.finishedTools = [];
				ui.connection = "offline";
			});
			chat.destroy();
			chat.root.replaceChildren();
			missionEditor = null;
			missionDraftBody.replaceChildren();
			missionPanel.replaceChildren();
			void revocation.then((outcome) => {
				const notice = outcome === "revoked" ? "" : "Remote revocation could not be confirmed. Stop the web command in its terminal.";
				set("state", (ui) => { ui.logoutNotice = notice; });
				announce(notice || "Signed out. Your agent keeps running.");
			});
		},
	};

	// ── The shell, built once. ──
	const chat: ChatView = createChat(context);
	const missionPanel = attrs(
		el("div", "order-first max-h-[48dvh] min-h-0 overflow-y-auto border-b border-stroke-3 px-3 py-3 lg:order-last lg:max-h-none lg:w-[25rem] lg:shrink-0 lg:border-b-0 lg:border-l"),
		{ "data-scroll": "mission-draft" },
	);
	missionPanel.hidden = true;
	const missionDraftBody = el("div", "min-w-0");
	const missionDraftNotices = el("div", "flex flex-col gap-2 empty:hidden");
	const dismissMissionDraft = button({
		label: "Close mission draft", key: "mission-draft-close", variant: "ghost",
		onClick: () => {
			set("state", (ui) => { ui.missionDraft = null; });
			if (!coarsePointer()) chat.focus();
			else main.focus({ preventScroll: true });
		},
	});
	const checkMissionDraft = button({
		label: "Refresh draft", key: "mission-draft-refresh", onClick: () => void refreshMissionDraft(),
	});
	const discardMissionEdits = button({
		label: "Discard edits and review latest", key: "mission-draft-discard", variant: "ghost",
		onClick: () => {
			void refreshMissionDraft("", "discard-edits");
			focusKey("mission-draft-heading");
		},
	});
	missionPanel.append(el("div", "flex min-w-0 flex-col gap-2",
		missionDraftNotices, missionDraftBody,
		el("div", "flex flex-wrap gap-2", checkMissionDraft, discardMissionEdits, dismissMissionDraft),
	));
	const chatPage = el("div", "flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row", chat.root, missionPanel);
	const mobile = matchMedia("(width < 48rem)");
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
	const statusText = document.createTextNode("");
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

	let missionPanelKey = "";
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
			? "fixed inset-y-0 left-0 z-40 flex w-[16.25rem] max-w-[85vw] flex-col bg-sidebar shadow-float animate-fade"
			: "flex w-[16.25rem] shrink-0 flex-col bg-sidebar max-md:hidden";
		scrim.hidden = !open;
		menuButton.setAttribute("aria-expanded", String(open));
		workspace.inert = open;
		statusbar.inert = open;
		skip.inert = open;
		if (open) {
			sidebar.setAttribute("role", "dialog");
			sidebar.setAttribute("aria-modal", "true");
		} else {
			sidebar.removeAttribute("role");
			sidebar.removeAttribute("aria-modal");
		}
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
			if (pageShown !== "chat") main.replaceChildren(chatPage);
			pageShown = "chat";
			chat.update(change);
			if (change === "state") patchMissionDraft();
			return;
		}
		if (change === "stream" && pageShown === ui.section) return;
		pageShown = ui.section;
		preserve(main, () => ui.section === "mission"
			? renderMission(context(), missionEntryAvailable(ui) ? openMissionDraft : undefined)
			: pages[ui.section as Exclude<Section, "chat" | "mission">](context()));
	}

	function patchMissionDraft(): void {
		const panel = ui.missionDraft;
		const mission = ui.details?.mission;
		missionPanel.hidden = panel === null || !mission;
		if (!panel || !mission) {
			if (missionPanelKey === "") return;
			missionPanelKey = "";
			missionEditor = null;
			missionDraftBody.replaceChildren();
			missionDraftNotices.replaceChildren();
			return;
		}
		const { draft, review, agreement, missing } = mission;
		const { unsaved } = panel;
		const receipt = ui.missionReceipt;
		const recorded = agreement && mission.agreementValid && draft === null;
		const expectedRevision = missionRevision(mission);
		const issued = receipt && expectedRevision <= receipt.revision && !(recorded && agreement.revision === receipt.revision)
			? receipt : null;
		const blocked = ui.details?.owner?.held === true || !["not-implemented", "not-started", "stopped", "completed"].includes(mission.execution);
		const offline = ui.connection !== "connected";
		const key = JSON.stringify([panel, ui.connection, ui.detailsFailed, blocked, mission.formationAvailable, mission.canAgree,
			mission.authority, draft, review, agreement, recorded, issued, missing]);
		if (key === missionPanelKey) return;
		missionPanelKey = key;

		const busy = panel.status === "saving" || panel.status === "refreshing";
		const unavailable = panel.status === "needs-refresh" || !mission.formationAvailable;
		const disabled = offline || blocked || ui.detailsFailed;
		checkMissionDraft.disabled = offline || busy;
		dismissMissionDraft.disabled = busy;
		dismissMissionDraft.textContent = unsaved ? "Discard edits and close" : "Close mission draft";
		discardMissionEdits.hidden = unsaved === null;
		discardMissionEdits.disabled = offline || busy;

		const progress = issued
			? `Approval receipt ${issued.receiptId} was issued for revision ${issued.revision}. ${panel.status === "refreshing"
				? "Checking the recorded agreement."
				: issued.reconciled
					? "The agreement is not recorded in the current status. Refresh to check again."
					: "Reconciliation is pending."} Do not submit approval again.`
			: panel.status === "saving" ? "Applying the mission change…"
				: panel.status === "refreshing" ? "Reading the latest mission draft…"
					: unavailable ? "A fresh mission draft is not available. Refresh to check current status." : "";
		const conflict = unsaved?.conflicted
			? `${expectedRevision > unsaved.revision ? `Revision ${expectedRevision} is now current.` : "The saved mission draft changed."} Your edits based on revision ${unsaved.revision} are kept here but cannot be saved. Copy any text you want to keep, then discard your edits to review the latest terms.`
			: "";
		missionDraftNotices.replaceChildren(...[
			panel.notice ? callout({ tone: "warn", role: "alert", body: panel.notice }) : null,
			conflict ? callout({ tone: "warn", role: "alert", body: conflict }) : null,
			progress ? callout({ tone: "info", role: "status", body: progress }) : null,
			blocked && !busy ? callout({ tone: "warn", body: ui.details?.owner?.held
				? "The service is held for maintenance." : "Stop the current work before changing the mission." }) : null,
		].filter((notice) => notice !== null));

		if (unsaved && missionEditor) {
			// Recreating a native number or date input loses invalid partial text, even if `.value` is saved.
			missionEditor.view.update(panel.status === "saving" ? "locked"
				: disabled || busy || unavailable || issued || unsaved.conflicted ? "local-only" : "ready");
			return;
		}

		const restoreFocus = missionDraftBody.contains(document.activeElement);
		const previous = agreement ? { revision: agreement.revision, terms: agreedTerms(mission, agreement) } : undefined;
		let body: HTMLElement;
		missionEditor = null;
		if (busy || unavailable || issued) {
			body = attrs(el("h2", "font-semibold", "Mission draft"), { id: "mission-draft-heading" });
		} else if (recorded && (agreement.revision === panel.localAgreementRevision || agreement.revision === receipt?.revision)) {
			const byYou = agreement.approvedBy === "developer-local" && agreement.revision === panel.localAgreementRevision ||
				agreement.approvedBy === "local-creator" && agreement.revision === receipt?.revision;
			body = renderMissionDraftCard({ kind: "agreed", agreement, byYou, disabled });
		} else if (draft?.status === "proposed" && draft.terms && panel.editRevision !== draft.revision) {
			const digest = missionProposalDigest(mission);
			const web = mission.canAgree && (mission.authority === "developer-local" ||
				(mission.authority === "managed-administrator" && review !== null && mission.previousReceipt !== undefined));
			const previousReceipt = mission.authority === "managed-administrator" ? review?.previousReceipt : undefined;
			body = renderMissionDraftCard({
				kind: "review",
				missionId: draft.missionId,
				revision: draft.revision,
				digest,
				terms: draft.terms,
				previous,
				disabled,
				binding: mission.authority === "developer-local" ? { kind: "developer-local" } : review ? { kind: "managed", review } : null,
				approval: digest === null ? { kind: "unavailable" }
					: web ? { kind: "web", onAgree: (snapshot) => void mutateMission({
						operation: "agree", ...snapshot, ...(previousReceipt === undefined ? {} : { previousReceipt }),
					}, mission) }
						: { kind: "terminal", line: missionApprovalCommand(context(), draft.revision, digest), copy: act.copy },
				onEdit: () => set("state", (ui) => { ui.missionDraft = { ...panel, editRevision: draft.revision }; }),
			});
		} else {
			const view = createMissionDraftEditor({
				expectedRevision,
				terms: draft?.terms ?? previous?.terms ?? {},
				saved: draft?.status === "editing",
				missing: draft === null || draft.status === "proposed" ? [] : missing,
				onDirty: () => set("state", (ui) => {
					if (ui.missionDraft) ui.missionDraft.unsaved = { revision: expectedRevision, conflicted: false };
				}),
				onSave: (expectedRevision, terms) => void mutateMission({ operation: "draft", expectedRevision, terms }, mission),
				onReview: (expectedRevision) => void mutateMission({ operation: "propose", expectedRevision }, mission),
			});
			view.update(disabled ? "locked" : "ready");
			missionEditor = { base: mission, view };
			body = view.root;
		}
		const top = missionPanel.scrollTop;
		missionDraftBody.replaceChildren(body);
		missionPanel.scrollTop = top;
		const heading = missionDraftBody.querySelector<HTMLElement>("#mission-draft-heading");
		if (heading) heading.tabIndex = -1;
		if (restoreFocus) heading?.focus({ preventScroll: true });
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
		statusText.data = state.text;
		if (ui.connection === "connected") parts.push(el("span", `${item} min-w-0 truncate`, dot(state.tone), el("span", "truncate", statusText)));
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
		// A native close request can be non-cancelable without user activation.
		dialog.setAttribute("closedby", ui.forgetting ? "none" : "closerequest");
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
					ui.logoutNotice ? attrs(el("p", "text-base text-fg-2", ui.logoutNotice), { role: "status" }) : null,
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
		const nav = attrs(el("nav", "flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overscroll-y-contain px-2.5 py-1.5"), { "aria-label": "Workspace" });
		for (const section of sections) {
			const item = el(
				"button",
				"group flex h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-xs px-2 text-left text-base font-medium text-fg-2 transition-colors duration-100 hover:bg-hover hover:text-fg aria-[current=page]:bg-fill aria-[current=page]:text-fg pointer-coarse:h-11",
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
		return attrs(el("aside", "", head, tabs, nav, foot), { id: "sidebar", "aria-label": "Workspace menu" });
	}

	// ── Events. ──
	const onWidth = () => {
		if (!mobile.matches && ui.navOpen) {
			set("state", (ui) => {
				ui.navOpen = false;
			});
			if (!sidebar.contains(document.activeElement)) navButtons.get(ui.section)?.focus();
		} else if (mobile.matches && sidebar.contains(document.activeElement)) {
			menuButton.focus({ preventScroll: true });
		}
	};
	mobile.addEventListener("change", onWidth);
	const onKey = (event: KeyboardEvent) => {
		if (destroyed || ui.signedOut || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || ui.pendingForget) return;
		if (ui.navOpen && event.key === "Tab") {
			const controls = sidebar.querySelectorAll("button");
			const first = controls[0];
			const last = controls[controls.length - 1];
			const active = document.activeElement;
			if (!sidebar.contains(active) || active === (event.shiftKey ? first : last)) {
				event.preventDefault();
				(event.shiftKey ? last : first)?.focus();
			}
			return;
		}
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
	// Age the elapsed reply label without replacing its node or repainting any other region.
	const secondTimer = setInterval(() => {
		if (!ui.view?.busy || ui.signedOut || ui.connection !== "connected") return;
		const next = agentState(ui, Date.now()).text;
		if (statusText.data !== next) statusText.data = next;
	}, 1000);

	const unsubscribe = store.subscribe(render);
	const unwatch = port.watch((event) => {
		if (destroyed || ui.signedOut) return;
		if (event.type === "connection") {
			if (ui.missionDraft?.status === "refreshing") ++missionVersion;
			set("state", (ui) => {
				ui.connection = event.state;
				if (ui.missionDraft?.status === "ready" || ui.missionDraft?.status === "refreshing")
					ui.missionDraft = { ...ui.missionDraft, status: "needs-refresh" };
			});
			announce(event.state === "connecting" ? "Reconnecting" : event.state === "expired" ? "Session ended" : "Offline");
			return;
		}
		const next = event.view;
		const previous = ui.view;
		const wasBusy = previous?.busy === true;
		const reconnect = ui.connection !== "connected" && previous !== null;
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
			ui.chatEntries = mergeChatEntries(ui.chatEntries, next.entries, "live");
			ui.connection = "connected";
		});
		if (wasBusy !== next.busy) announce(next.busy ? "Working" : ui.stopped ? "Stopped" : "Reply finished");
		if (wasBusy && !next.busy) {
			if (document.hidden) document.title = `● ${name()} replied`;
			void refresh();
		}
		if (ui.missionDraft && ui.missionDraft.status !== "saving" && (reconnect || next.tools.some((tool) =>
			tool.name === "unit_mission_draft" && tool.status === "succeeded" &&
			!previous?.tools.some((seen) => seen.callId === tool.callId && seen.status === "succeeded")
		))) void refreshMissionDraft();
	});
	render("state");
	void refresh();
	return () => {
		destroyed = true;
		unwatch();
		unsubscribe();
		if (!ui.signedOut) chat.destroy();
		document.removeEventListener("keydown", onKey);
		mobile.removeEventListener("change", onWidth);
		document.removeEventListener("visibilitychange", onVisible);
		clearInterval(secondTimer);
		root.replaceChildren();
	};
}

function missionRevision(mission: MissionSnapshot): number {
	return mission.draft?.revision ?? mission.agreement?.revision ?? 0;
}

function sameMissionDraft(a: MissionSnapshot, b: MissionSnapshot): boolean {
	return missionRevision(a) === missionRevision(b) && a.draft?.missionId === b.draft?.missionId &&
		a.draft?.status === b.draft?.status && a.draft?.digest === b.draft?.digest;
}

function missionEntryAvailable(ui: Readonly<Ui>): boolean {
	return ui.connection === "connected" && !ui.detailsFailed && ui.details?.mission.formationAvailable === true;
}

function agreedTerms(mission: MissionSnapshot, agreement: NonNullable<MissionSnapshot["agreement"]>): MissionDraftTerms {
	const { limits } = agreement;
	return {
		objective: mission.objective ?? undefined,
		scope: mission.scope ?? undefined,
		successCriteria: agreement.successCriteria,
		approvalBoundary: agreement.approvalBoundary,
		reviewEveryMs: agreement.reviewEveryMs,
		policy: {
			allowedTools: agreement.allowedTools,
			maxCycles: limits.maxCycles,
			maxRequests: limits.maxRequests,
			maxRetries: limits.maxRetries,
			maxConsecutiveNoProgress: limits.maxNoProgress,
			deadlineAt: limits.deadlineAt,
			maxEstimatedCost: limits.maxEstimatedCost ?? undefined,
		},
	};
}

/** Keys the workspace reacts to outside text fields (Escape also inside them); one table, no key checks in handlers. */
const shortcuts: readonly { key: string; run: (act: Actions, ui: Readonly<Ui>) => boolean }[] = [
	{ key: "Escape", run: (act, ui) => ui.navOpen && (act.setNav(false), true) },
	{ key: "/", run: (act, ui) => !ui.navOpen && ui.section !== "chat" && (act.go("chat"), true) },
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
