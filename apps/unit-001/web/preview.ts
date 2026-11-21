// Sample data for design review and screenshots; built into web-preview only, never into a release.
import type { Connection, MemoryGraphView, MissionRunView, WorkspaceDetails, WorkspacePort, WorkspaceView } from "./contract.ts";
import { sampleMemoryGraph } from "./preview-memory-graph.ts";
import { mountWorkspace } from "./shell.ts";
import { sections } from "./state.ts";
import { renderPairing } from "./views/pairing.ts";

/*
 * URL switches (combine freely):
 *   ?section=mission|status|memory|connections|about   open that page first (About uses the sample view and details; ?details=none, ?unconfigured=1 change it)
 *   ?busy=1        a reply is streaming, with one finished and one running tool
 *   ?blocked=1     scheduled work is blocked on unknown results
 *   ?long=1        many messages, a long model id and long connection text
 *   ?draft=long    a 30-line draft in the composer
 *   ?details=none  details never load
 *   ?empty=1       no messages yet
 *   ?held=1        a maintenance hold is active
 *   ?unconfigured=1  no model is configured
 *   ?norun=1       no work run exists
 *   ?connection=connecting|offline|expired   the connection state after load
 *   ?unknown=1     sending returns an unknown outcome
 *   ?send=1        sends a sample message after load (with ?unknown=1: the uncertain-delivery notice)
 *   ?signedout=1   signs out after load
 *   ?nav=1         opens the phone menu after load (below 768 px)
 *   ?memory=1      the memory page shows search results
 *   ?forget=1      the forget dialog is open (with ?section=memory&memory=1)
 *   ?graph=empty|limited|large|failed   the memory map with no memories, the newest 40 of 1,204, or a failed read
 *   ?pairing=1     the pairing screen
 *   ?theme=light|dark   a fixed theme instead of the system setting
 */
const params = new URL(location.href).searchParams;
const flag = (name: string) => params.get(name) === "1";
const now = Date.now();
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

const reply =
	"I checked the two remaining advisories against the lockfile. Neither affects Harbor: one is in a dev-only dependency, the other was fixed in the version we already pin.\n\nNothing changes until you approve it.";
const sampleModel = { provider: "sample-provider", modelId: "sample-model" };

let view: WorkspaceView = {
	name: "Bob",
	version: "0.0.9-preview",
	installationId: "sample-unit",
	busy: false,
	model: sampleModel,
	usage: { input: 12_400, output: 3_100, cacheRead: 8_000, cacheWrite: 1_200, totalTokens: 24_700, cost: { kind: "estimate", usd: 0.1832 } },
	entries: [
		{ id: 1, role: "user", text: "Where are we on the advisories?", truncated: false },
		{
			id: 2,
			role: "assistant",
			text: "Three advisories this week touch Harbor. One needs your decision: patching undici changes proxy behavior. I prepared the patch, but its tests have not run yet and I will not apply it without you.\n\nI also commented on pull request 212 and have not seen confirmation that it posted. I am not retrying until that is resolved.",
			truncated: false,
		},
		{ id: 3, role: "user", text: "Run the tests for the undici patch and tell me what breaks.", truncated: false },
		{
			id: 4,
			role: "assistant",
			text: "The suite passed except two proxy tests. Both expect the old CONNECT header order, which undici 7 changed on purpose.\n\nI would update the two assertions rather than pin the old version. Say the word and I will prepare that change for review.",
			truncated: false,
		},
	],
	text: "",
	textTruncated: false,
	historyTruncated: false,
	tools: [],
};

const sampleRun: MissionRunView = {
	status: "waiting",
	blocker: null,
	nextWakeAt: now + hour,
	cycles: 6,
	requests: 41,
	retries: 2,
	noProgress: 1,
	estimatedCost: 0.42,
	reservedCost: 0.05,
	unknownRequests: 0,
	unpricedResponses: 0,
	uncertainTools: 0,
	evidence: [
		{ criterion: "Advisories are triaged each week", accepted: true, detail: "Three advisories triaged on Monday.", observedAt: now - 2 * hour },
		{ criterion: "Patches have passing tests", accepted: false, detail: "The undici patch fails two proxy tests.", observedAt: now - hour },
	],
	observedAt: now - minute,
};

const blockedRun: MissionRunView = {
	...sampleRun,
	status: "blocked",
	blocker: "Outcomes of earlier requests are unknown and must be reconciled before work continues.",
	nextWakeAt: null,
	unknownRequests: 2,
	uncertainTools: 1,
};

const details: WorkspaceDetails = {
	owner: { uptimeMs: 3 * day + 90 * minute, held: false, inhibited: false, configured: true },
	mission: {
		stage: "agreed",
		objective: "Keep the Harbor repository's dependencies secure.",
		scope: "Watch advisories and prepare verified patches for review.",
		missing: [],
		execution: "not-implemented",
		creator: { kind: "human", id: "owner" },
		authority: "developer-local",
		agreementValid: true,
		authorityError: null,
		draft: null,
		tools: ["read_file", "run_tests"],
		agreement: {
			revision: 2,
			successCriteria: ["Advisories are triaged each week", "Patches have passing tests"],
			approvalBoundary: ["Merging", "Security changes"],
			reviewEveryMs: 7 * day,
			approvedAt: now - 2 * day,
			approvedBy: "local-creator",
			limits: { maxCycles: 20, maxRequests: 200, maxRetries: 5, maxNoProgress: 3, deadlineAt: now + 30 * day, maxEstimatedCost: 5 },
		},
		run: sampleRun,
	},
	memory: {
		count: 3,
		stats: { working: 3, episodic: 1_000, tombstones: 2, pendingCaptures: 1, failedCaptures: 1, consolidation: "scheduled" },
		records: [],
	},
	channels: [
		{
			id: "Project updates",
			adapter: "telegram",
			status: "ready",
			detail: "Setup identity verified. Message delivery has not been verified.",
			lastHealth: { observedAt: now - 15 * minute, healthy: true },
			failure: null,
			awaiting: null,
		},
		{
			id: "Security desk",
			adapter: "email",
			status: "awaiting_authorization",
			detail: "Setup is proposed. Creator authorization is required before this connection can be used.",
			lastHealth: null,
			failure: null,
			awaiting: "grant",
		},
	],
};

const memories = [
	{ id: "m1", content: "The creator prefers a short weekly digest with links to sources.", source: "creator/semantic" },
	{ id: "m2", content: "Harbor's API runs behind a corporate proxy; proxy changes need explicit review.", source: "creator/semantic" },
	{ id: "m3", content: "Security changes and merges always require explicit creator authorization.", source: "operating boundary" },
];

let graph: MemoryGraphView = sampleMemoryGraph(now, params.get("graph"));

let listener: Parameters<WorkspacePort["watch"]>[0] | null = null;
let unknown = flag("unknown");
let detailsAvailable = params.get("details") !== "none";
let timer: ReturnType<typeof setInterval> | undefined;
const emit = () => listener?.({ type: "view", view });
// The workspace re-reads details when a run ends, so a short busy cycle shows a changed fixture.
const refresh = () => {
	view = { ...view, busy: true };
	emit();
	view = { ...view, busy: false };
	emit();
};

const port: WorkspacePort = {
	watch(callback) {
		listener = callback;
		queueMicrotask(() => {
			emit();
			const state = params.get("connection");
			if (state === "connecting" || state === "offline" || state === "expired") callback({ type: "connection", state });
		});
		return () => {
			listener = null;
		};
	},
	async details() {
		if (!detailsAvailable) throw new Error("Details are not available in this fixture.");
		return details;
	},
	async send(prompt, requestId) {
		if (unknown) return { state: "unknown", message: requestId };
		view = {
			...view,
			entries: [...view.entries, { id: view.entries.length + 1, role: "user", text: prompt, truncated: false }],
			busy: true,
			text: "",
			tools: [{ callId: "t1", name: "read_file package-lock.json", status: "running" }],
		};
		emit();
		let shown = 0;
		timer = setInterval(() => {
			shown = Math.min(reply.length, shown + 6);
			const tools = shown > 40 ? [{ callId: "t1", name: "read_file package-lock.json", status: "done" }] : view.tools;
			view = { ...view, text: reply.slice(0, shown), tools };
			if (shown >= reply.length) {
				clearInterval(timer);
				view = {
					...view,
					busy: false,
					text: "",
					tools: [],
					entries: [...view.entries, { id: view.entries.length + 1, role: "assistant", text: reply, truncated: false }],
				};
			}
			emit();
		}, 50);
		return { state: "completed" };
	},
	async cancel() {
		clearInterval(timer);
		await new Promise((resolve) => setTimeout(resolve, 900));
		view = { ...view, busy: false, text: "", tools: [] };
		emit();
	},
	async recall(query) {
		const needle = query.trim().toLowerCase();
		return { ...details.memory, records: memories.filter((record) => record.content.toLowerCase().includes(needle)) };
	},
	async forget(id) {
		if (unknown) return { state: "unknown", message: "Forget outcome not confirmed." };
		memories.splice(
			memories.findIndex((record) => record.id === id),
			1,
		);
		// The map drops the memory and its links, as the real snapshot would on the next read.
		graph = {
			...graph,
			nodes: graph.nodes.filter((node) => node.id !== id),
			edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
			total: Math.max(0, graph.total - 1),
		};
		return { state: "completed" };
	},
	async memoryGraph() {
		if (params.get("graph") === "failed") throw new Error("The memory map is not available in this fixture.");
		return graph;
	},
	async logout() {},
};

declare global {
	interface Window {
		/** Switches the fixture from the console or a screenshot script. */
		unitPreview: {
			connection(state: Connection): void;
			unknown(value: boolean): void;
			empty(): void;
			held(value: boolean): void;
			unconfigured(value: boolean): void;
			noRun(value: boolean): void;
			blocked(value: boolean): void;
			draft(text: string): void;
		};
	}
}

if (params.get("theme") === "light" || params.get("theme") === "dark") document.documentElement.dataset.theme = params.get("theme") ?? "";
if (flag("empty")) view = { ...view, entries: [] };
if (flag("long")) {
	const turns = Array.from({ length: 8 }, (_, index) => [
		{ id: 10 + index * 2, role: "user" as const, text: `Question ${index + 1}: what changed in the lockfile since yesterday?`, truncated: false },
		{ id: 11 + index * 2, role: "assistant" as const, text: reply, truncated: false },
	]).flat();
	view = {
		...view,
		model: { provider: "sample-provider-with-a-long-name", modelId: "sample-model-2026-11-21-with-a-very-long-identifier-for-layout-checks" },
		entries: [...view.entries, ...turns],
		historyTruncated: true,
	};
	const second = details.channels[1];
	if (second) second.detail = `${second.detail} ${second.detail}`;
}
if (flag("busy"))
	view = {
		...view,
		busy: true,
		text: reply.slice(0, 96),
		tools: [
			{ callId: "t0", name: "run_tests undici", status: "done" },
			{ callId: "t1", name: "read_file package-lock.json", status: "running" },
		],
	};
if (flag("blocked")) details.mission.run = blockedRun;
if (flag("norun")) details.mission.run = null;
if (flag("held") && details.owner) details.owner.held = true;
if (flag("unconfigured")) {
	if (details.owner) details.owner.configured = false;
	view = { ...view, model: null };
}
if (flag("memory")) details.memory.records = memories;

window.unitPreview = {
	connection(state) {
		listener?.({ type: "connection", state });
	},
	unknown(value) {
		unknown = value;
	},
	empty() {
		view = { ...view, entries: [] };
		emit();
	},
	held(value) {
		if (details.owner) details.owner.held = value;
		refresh();
	},
	unconfigured(value) {
		if (details.owner) details.owner.configured = !value;
		view = { ...view, model: value ? null : sampleModel };
		refresh();
	},
	noRun(value) {
		details.mission.run = value ? null : sampleRun;
		refresh();
	},
	blocked(value) {
		details.mission.run = value ? blockedRun : sampleRun;
		refresh();
	},
	draft(text) {
		const input = document.querySelector<HTMLTextAreaElement>("#composer");
		if (!input) return;
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	},
};

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Workspace mount element is missing.");
if (flag("pairing"))
	renderPairing(root, {
		async submit(code) {
			return code === "000000" ? "paired" : "wrong";
		},
		onPaired: () => location.assign(location.pathname),
	});
else {
	// "channels" is the old name of the Connections page; keep old preview links working.
	const requested = params.get("section") === "channels" ? "connections" : params.get("section");
	const section = sections.find((entry) => entry.id === requested)?.id;
	mountWorkspace(root, port, { preview: true, section });
	if (params.get("draft") === "long")
		window.unitPreview.draft(
			Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long draft that keeps going to check how tall the composer may grow.`).join("\n"),
		);
	// Clicks what a person would click once the first view has rendered.
	const click = (key: string) => setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-key="${key}"]`)?.click(), 100);
	if (flag("send")) {
		window.unitPreview.draft("Did the undici patch land?");
		click("send");
	}
	if (flag("signedout")) click("signout");
	if (flag("nav")) click("menu");
	if (flag("forget")) {
		const first = memories[0];
		// Waits for the memory page to render its rows, then opens the dialog for the first one.
		if (first) setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-key="forget-${first.id}"]`)?.click(), 100);
	}
}
