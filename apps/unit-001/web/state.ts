// Holds the workspace state, the router and the actions views may call; views read state, never write it.
import type { Connection, MemoryGraphView, MissionRunView, SendOutcome, WorkspaceDetails, WorkspaceView } from "./contract.ts";
import type { ChatEntries, ChatHistory } from "./history.ts";
import type { IconName } from "./ui/icons.ts";

/** The pages of the workspace; Chat is home. */
export type Section = "chat" | "mission" | "status" | "memory" | "connections" | "about";

/** Sidebar order, labels and icons; the label is also the nav button's whole text. */
export const sections: readonly { id: Section; label: string; icon: IconName }[] = [
	{ id: "chat", label: "Chat", icon: "chat" },
	{ id: "mission", label: "Mission", icon: "target" },
	{ id: "status", label: "Status", icon: "status" },
	{ id: "memory", label: "Memory", icon: "memory" },
	{ id: "connections", label: "Connections", icon: "connections" },
	{ id: "about", label: "About", icon: "info" },
];

/** Theme choice: follow the system (default), or a fixed scheme the person picked. */
export type ThemeChoice = "system" | "light" | "dark";

export type Tool = WorkspaceView["tools"][number];

export interface Ui {
	section: Section;
	connection: Connection;
	view: WorkspaceView | null;
	/** Closed rows retained across watch windows and earlier pages for this mount only. */
	chatEntries: ChatEntries;
	chatHistory: ChatHistory;
	details: WorkspaceDetails | null;
	/** True when details were requested and could not be read; the last good details stay in `details`. */
	detailsFailed: boolean;
	missionDraft: {
		editRevision: number | null;
		unsaved: { revision: number; conflicted: boolean } | null;
		status: "ready" | "saving" | "refreshing" | "needs-refresh";
		notice: string;
		/** A completed developer-local approval from this browser, not a receipt still awaiting status. */
		localAgreementRevision: number | null;
	} | null;
	/** A status read from this connection, not a retained projection from before a refresh or disconnect. */
	planFresh: boolean;
	planDraft: {
		editRevision: number | null;
		unsaved: { revision: number; conflicted: boolean } | null;
	} | null;
	planChange:
		| { kind: "idle"; notice: string }
		| { kind: "writing" }
		| { kind: "unresolved"; revision: number; digest: string; requestId: string; receiptId: string | null };
	draft: string;
	sending: boolean;
	cancelling: boolean;
	/** One error sentence shown above the page until dismissed. */
	error: string;
	/** The last run ended because the person stopped it. */
	stopped: boolean;
	/** Every tool call seen during the current run, latest status per call. */
	runTools: readonly Tool[];
	/** The finished run's tools, shown collapsed under its reply. */
	finishedTools: readonly Tool[];
	runStartedAt: number | null;
	/** A message whose delivery the gateway could not confirm; it is never resent automatically. */
	unknown: { requestId: string; prompt: string } | null;
	purposeOpen: boolean;
	/** Which Status groups are expanded, by key; kept here so a redraw does not collapse them. */
	statusOpen: Readonly<Record<string, boolean>>;
	pendingForget: { id: string; requestId: string; content: string; opener: string } | null;
	forgetNotice: string;
	/** The request in flight, independently of which confirmation is shown. */
	forgetting: string | null;
	query: string;
	/** The last submitted query and its result, independent of the input draft and workspace details. */
	recall:
		| { kind: "idle" }
		| { kind: "searching" | "failed"; query: string }
		| { kind: "done"; query: string; records: WorkspaceDetails["memory"]["records"] };
	/** The memory graph snapshot; null until the first read, and the last good one stays when a refresh fails. */
	graph: MemoryGraphView | null;
	/** True when the last graph read failed. */
	graphFailed: boolean;
	/** The sidebar overlay below 768 px. */
	navOpen: boolean;
	theme: ThemeChoice;
	/** Sample data from the preview build; the sidebar says so. */
	preview: boolean;
}

/** What a view may ask for; every change of state goes through one of these. */
export interface Actions {
	go(section: Section): void;
	send(): void;
	cancel(): void;
	loadEarlier(): void;
	/** Updates the draft without redrawing anything (the composer already shows it). */
	setDraft(text: string): void;
	/** Puts text in the composer, opens Chat and focuses it; never sends. */
	useDraft(text: string): void;
	dismissUnknown(): void;
	dismissError(): void;
	togglePurpose(): void;
	toggleStatus(key: string): void;
	/** Updates the memory query without redrawing (the input already shows it). */
	setQuery(query: string): void;
	search(): void;
	askForget(id: string, content: string, opener: string): void;
	confirmForget(): void;
	closeForget(): void;
	/** Copies to the clipboard and confirms with a toast naming `label` ("Command copied."). */
	copy(text: string, label: string): Promise<boolean>;
	/** Shows a short toast; also announced to screen readers. */
	notify(text: string): void;
	setTheme(choice: ThemeChoice): void;
	setNav(open: boolean): void;
}

/** What every view receives: read-only state, the actions and the agent's display name. */
export interface Ctx {
	ui: Readonly<Ui>;
	act: Actions;
	/** The agent's name as the owner reports it ("Your agent" before the first view). */
	name: string;
}

/** How a state change should reach the screen: `stream` is a live-text or tool update only, `state` is anything else. */
export type Change = "stream" | "state";

/** A minimal store: one mutable state object, changed only through `update`, which notifies subscribers. */
export interface Store {
	readonly ui: Ui;
	update(change: Change, mutate: (ui: Ui) => void): void;
	subscribe(listener: (change: Change) => void): () => void;
}

/** Creates the store with its initial state. */
export function createStore(initial: { section?: Section; preview?: boolean; theme: ThemeChoice }): Store {
	const ui: Ui = {
		section: initial.section ?? "chat",
		connection: "connecting",
		view: null,
		chatEntries: [],
		chatHistory: { kind: "unstarted" },
		details: null,
		detailsFailed: false,
		missionDraft: null,
		planFresh: false,
		planDraft: null,
		planChange: { kind: "idle", notice: "" },
		draft: "",
		sending: false,
		cancelling: false,
		error: "",
		stopped: false,
		runTools: [],
		finishedTools: [],
		runStartedAt: null,
		unknown: null,
		purposeOpen: false,
		statusOpen: {},
		pendingForget: null,
		forgetNotice: "",
		forgetting: null,
		query: "",
		recall: { kind: "idle" },
		graph: null,
		graphFailed: false,
		navOpen: false,
		theme: initial.theme,
		preview: initial.preview ?? false,
	};
	const listeners = new Set<(change: Change) => void>();
	return {
		ui,
		update(change, mutate) {
			mutate(ui);
			for (const listener of listeners) listener(change);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** Restores the sent text only when the gateway proves it never reached the owner. */
export function settleSend(ui: Ui, outcome: SendOutcome, requestId: string, prompt: string): void {
	ui.sending = false;
	switch (outcome.state) {
		case "completed":
			break;
		case "unknown":
			ui.unknown = { requestId, prompt };
			break;
		case "failed":
		case "failed-after-admission":
			if (outcome.state === "failed" && !ui.draft.trim()) ui.draft = prompt;
			ui.error = outcome.message;
			break;
	}
}

/** A missing model counts only once the view or the owner says so; unknown is not unconfigured. */
export function isConfigured(ui: Readonly<Ui>): boolean {
	return ui.details?.owner?.configured !== false && ui.view?.model !== null;
}

/** Results of scheduled work nobody can confirm; any of them stops the run until the owner looks. */
export function unknownResults(run: MissionRunView): number {
	return run.unknownRequests + run.uncertainTools + run.unpricedResponses;
}

/** True when scheduled work is stopped and needs the owner (blocked, or results that are unknown). */
export function runBlocked(run: MissionRunView | null): boolean {
	return run !== null && (run.status === "blocked" || unknownResults(run) > 0);
}

/** How many things on a page need the person, for the count on its nav row; 0 means none. */
export function attentionCount(ui: Readonly<Ui>, section: Section): number {
	const details = ui.details;
	if (!details) return 0;
	if (section === "connections")
		return details.channels.filter((channel) => channel.status !== "ready").length;
	if (section === "status")
		return [details.owner?.held === true, !isConfigured(ui), runBlocked(details.mission.run)].filter(Boolean).length;
	if (section === "mission") return runBlocked(details.mission.run) ? 1 : 0;
	return 0;
}

/** The tone of a state word or dot. */
export type Tone = "idle" | "working" | "waiting" | "attention" | "blocked";

/**
 * The agent's state in one line, the same everywhere: connection first, then the chat reply, then what the owner
 * must do, then scheduled work. Only the highest-precedence state is shown, so two places never disagree.
 */
export function agentState(ui: Readonly<Ui>, now: number): { tone: Tone; text: string } {
	if (ui.connection === "workspace-changed") return { tone: "blocked", text: "Workspace changed" };
	if (ui.connection === "offline") return { tone: "blocked", text: "Offline" };
	if (ui.connection === "connecting") return { tone: "waiting", text: "Reconnecting" };
	if (ui.cancelling) return { tone: "working", text: "Stopping" };
	if (ui.view?.busy) {
		const running = ui.view.tools.find((tool) => tool.status === "running");
		const seconds = ui.runStartedAt === null ? 0 : Math.max(0, Math.floor((now - ui.runStartedAt) / 1000));
		return { tone: "working", text: `Replying${running ? ` · ${running.name.split(" ")[0]}` : ""} · ${seconds} s` };
	}
	const run = ui.details?.mission.run ?? null;
	if (runBlocked(run)) return { tone: "blocked", text: "Blocked · needs you" };
	if (ui.details?.owner?.held) return { tone: "attention", text: "On hold" };
	if (!isConfigured(ui)) return { tone: "attention", text: "Needs setup" };
	if (run?.status === "running") return { tone: "working", text: "Running scheduled work" };
	if (run?.status === "paused") return { tone: "waiting", text: "Paused" };
	if (run?.status === "waiting") return { tone: "waiting", text: "Waiting" };
	return { tone: "idle", text: "Ready" };
}

/** The agent's display name before the owner reports one. */
export const unnamed = "Your agent";

/** Recovery instructions do not derive a terminal command from the agent's display name. */
export const workspaceRecovery =
	"Check that your installation's web command is running. For managed Bob, open the SSH tunnel with ssh unit-001, then run bob web in that terminal.";

/** The terminal command of the installation: the lowercase name ("Bob" runs as `bob`), `agent` until it is named. */
export function commandName(name: string): string {
	return name === unnamed ? "agent" : name.toLowerCase();
}
