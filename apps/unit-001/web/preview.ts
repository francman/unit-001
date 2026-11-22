// Sample data for design review and screenshots; built into web-preview only, never into a release.
import type { Connection, MemoryGraphView, MissionDraftTerms, MissionRunView, WorkspaceDetails, WorkspacePort, WorkspaceView } from "./contract.ts";
import type { PlanRevisionView, PlanTerms, PlanView, ReviewNote } from "./mission-plan-contract.ts";
import { sampleMemoryGraph } from "./preview-memory-graph.ts";
import { mountWorkspace } from "./shell.ts";
import { sections } from "./state.ts";

/*
 * URL switches (combine freely):
 *   ?section=mission|status|memory|connections|about   open that page first (About uses the sample view and details; ?details=none, ?unconfigured=1 change it)
 *   ?busy=1        a reply is streaming, with one finished and one running tool
 *   ?blocked=1     scheduled work is blocked on unknown results
 *   ?long=1        paged chat history, a long model id and long connection text
 *   ?draft=long    a 30-line draft in the composer
 *   ?details=none  details never load
 *   ?empty=1       no messages yet
 *   ?held=1        a maintenance hold is active
 *   ?unconfigured=1  no model is configured
 *   ?norun=1       no work run exists
 *   ?mission=new|unarmed   start without a mission, or with managed web approval unavailable
 *   ?plan=history|new|managed|invalid   sample charter and due review, no charter, managed proposal, or blocked plan validation
 *   ?connection=connecting|offline   the connection state after load
 *   ?unknown=1     sending returns an unknown outcome
 *   ?send=1        sends a sample message after load (with ?unknown=1: the uncertain-delivery notice)
 *   ?nav=1         opens the phone menu after load (below 768 px)
 *   ?memory=1      the memory page shows search results
 *   ?forget=1      the forget dialog is open (with ?section=memory&memory=1)
 *   ?graph=empty|small|mid|limited|large|failed   the memory map with no memories, 8 (no brain), 30, the newest 40 of 1,204, 300, or a failed read (the default is 60); the map forms again on every reload
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

const retainedEntries = [...view.entries];
const watchRows = 20;

function chatWindow(): Pick<WorkspaceView, "entries" | "historyTruncated"> {
	return { entries: retainedEntries.slice(-watchRows), historyTruncated: retainedEntries.length > watchRows };
}

function appendChat(role: WorkspaceView["entries"][number]["role"], text: string): Pick<WorkspaceView, "entries" | "historyTruncated"> {
	retainedEntries.push({ id: (retainedEntries.at(-1)?.id ?? 0) + 1, role, text, truncated: false });
	return chatWindow();
}

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
		formationAvailable: true,
		canAgree: true,
		review: null,
		draft: null,
		tools: ["read_file", "run_tests"],
		agreement: {
			revision: 2,
			successCriteria: ["Advisories are triaged each week", "Patches have passing tests"],
			approvalBoundary: ["Merging", "Security changes"],
			reviewEveryMs: 7 * day,
			approvedAt: now - 2 * day,
			approvedBy: "local-creator",
			allowedTools: ["read_file", "run_tests"],
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

const previewBinding = { missionId: "sample-purpose", purposeRevision: 2, purposeDigest: "a".repeat(64) };
const planTerms: PlanTerms = {
	overall: { purpose: "Keep Harbor secure without disrupting production.", scope: "Harbor only", askFirst: ["Merging"], reviewEveryMs: 7 * day, reviewAllowance: null },
	strategics: [{ id: "supply-chain", title: "Reduce dependency risk", intent: "Keep known issues triaged.", signals: ["Advisories have owners"], priority: "high" }],
	tacticals: [
		{ id: "triage", strategic: "supply-chain", objective: "Triage Harbor advisories", successCriteria: ["Record affected versions"],
			priority: "high", deadlineAt: now + day, mode: "runnable", binding: previewBinding },
		{ id: "proxy-tests", strategic: "supply-chain", objective: "Revisit proxy test coverage", successCriteria: ["Document test gaps"],
			priority: "normal", deadlineAt: null, mode: "parked", binding: null },
	],
};
const previousPlan: PlanRevisionView = {
	revision: 1, digest: "1".repeat(64), previousDigest: null, agreedAt: now - 21 * day, receiptId: "sample-plan-receipt-1",
	terms: { ...planTerms, overall: { ...planTerms.overall, scope: "Harbor and shared proxy infrastructure" } },
};
const planHead: PlanRevisionView = {
	revision: 2, digest: "2".repeat(64), previousDigest: previousPlan.digest, terms: planTerms, agreedAt: now - 8 * day, receiptId: "sample-plan-receipt-2",
};
const cadence = { kind: "cadence", key: "2:cadence:1", subject: null } as const;

function previewReview(head: PlanRevisionView, trigger: ReviewNote["trigger"], reviewId: string): ReviewNote {
	return {
		reviewId, key: trigger.key, trigger, planRevision: head.revision, planDigest: head.digest,
		window: { from: head.agreedAt, to: now }, createdAt: now, outcome: "attention", disposition: null,
		items: [
			{ id: "triage", level: "tactical", status: "at-risk", verifiedWorks: 1, listedWorks: 3,
				runIds: ["sample-run-4"], blockReasons: [], unsettled: 0, deadlineAt: now + day },
		],
		facts: { runsUsed: 4, runsLimit: 32, cycles: 6, maxCycles: 20, requests: 41, maxRequests: 200, estimatedCost: 0.42, maxEstimatedCost: 5 },
		uncertainty: ["The proxy tests are still failing."],
	};
}

function previewPlan(variant: string): PlanView {
	return {
		missionId: "sample-charter", adopted: true, head: planHead, headValid: true, previous: previousPlan,
		history: [planHead, previousPlan].map(({ revision, digest, agreedAt }) => ({ revision, digest, agreedAt })),
		draft: variant === "managed" ? {
			revision: 3, baseRevision: 2, status: "proposed", digest: "3".repeat(64), terms: planTerms,
			savedBy: "owner", fromReview: null, missing: [],
		} : null,
		gate: { state: "closed", reason: "reopen-needed" }, runs: { used: 4, limit: 32 },
		due: [cadence], preview: previewReview(planHead, cadence, "sample-due-review"), reviews: [],
		allowance: null, turns: [], blocker: null,
	};
}

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
			if (state === "connecting" || state === "offline") callback({ type: "connection", state });
		});
		return () => {
			listener = null;
		};
	},
	async history(before) {
		const boundary = before === null ? -1 : retainedEntries.findIndex((entry) => entry.id >= before);
		const end = boundary < 0 ? retainedEntries.length : boundary;
		const start = Math.max(0, end - 5);
		return { entries: retainedEntries.slice(start, end), nextBefore: start === 0 ? null : retainedEntries[start].id };
	},
	async details() {
		if (!detailsAvailable) throw new Error("Details are not available in this fixture.");
		return { ...details };
	},
	async mission() {
		if (!detailsAvailable) throw new Error("Details are not available in this fixture.");
		return details.mission;
	},
	async mutateMission(change) {
		const current = details.mission;
		const { draft, agreement } = current;
		if (details.owner?.held) return { state: "refused", code: "held" };
		const expected = draft?.revision ?? agreement?.revision ?? 0;
		if ((change.operation === "agree" ? change.revision : change.expectedRevision) !== expected)
			return { state: "refused", code: "stale-revision" };
		if (change.operation === "draft") {
			const terms = change.terms;
			details.mission = {
				...current,
				stage: "drafting",
				missing: previewMissingTerms(terms),
				draft: { missionId: "preview-mission", revision: expected + 1, status: "editing", digest: null, terms },
			};
		} else if (change.operation === "propose") {
			if (!draft?.terms || current.missing.length) return { state: "refused", code: "incomplete" };
			const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(draft)));
			const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
			details.mission = { ...current, stage: "awaiting_approval", draft: { ...draft, status: "proposed", digest: current.canAgree ? digest : null } };
		} else {
			if (!current.canAgree) return { state: "refused", code: "managed-requires-gateway" };
			if (draft?.status !== "proposed" || draft.digest !== change.digest) return { state: "refused", code: "stale-digest" };
			const terms = draft.terms;
			const policy = terms?.policy;
			if (!terms || !policy || terms.objective === undefined || terms.scope === undefined || !terms.successCriteria ||
				!terms.approvalBoundary || terms.reviewEveryMs === undefined || !policy.allowedTools ||
				policy.maxCycles === undefined || policy.maxRequests === undefined || policy.maxRetries === undefined ||
				policy.maxConsecutiveNoProgress === undefined || policy.deadlineAt === undefined)
				return { state: "refused", code: "incomplete" };
			details.mission = {
				...current, stage: "agreed", draft: null, objective: terms.objective, scope: terms.scope, agreementValid: true,
				agreement: {
					revision: change.revision, approvedAt: Date.now(), approvedBy: "developer-local",
					successCriteria: terms.successCriteria, approvalBoundary: terms.approvalBoundary, reviewEveryMs: terms.reviewEveryMs,
					allowedTools: policy.allowedTools,
					limits: {
						maxCycles: policy.maxCycles, maxRequests: policy.maxRequests, maxRetries: policy.maxRetries,
						maxNoProgress: policy.maxConsecutiveNoProgress, deadlineAt: policy.deadlineAt, maxEstimatedCost: policy.maxEstimatedCost ?? null,
					},
				},
			};
		}
		return { state: "completed", mission: details.mission };
	},
	async mutateMissionPlan(change, requestId) {
		const mission = details.mission;
		if (mission.plan === undefined || mission.planError !== null) return { state: "rejected" };
		if (details.owner?.held) return { state: "refused", code: "held" };
		const plan: PlanView = mission.plan ?? {
			missionId: "sample-charter", adopted: false, head: null, headValid: false, previous: null, history: [], draft: null,
			gate: { state: "not-adopted", reason: null }, runs: { used: 0, limit: 32 }, due: [], preview: null, reviews: [],
			allowance: null, turns: [], blocker: null,
		};
		const { draft, head } = plan;
		const revision = draft?.revision ?? head?.revision ?? 0;
		if ("expectedRevision" in change && change.expectedRevision !== revision) return { state: "refused", code: "stale-revision" };
		let next: PlanView;
		switch (change.operation) {
			case "plan-draft": {
				const { terms } = change;
				const missing = [
					!terms.overall.purpose.trim() ? "purpose" : "",
					!terms.overall.scope.trim() ? "scope" : "",
					terms.overall.reviewEveryMs < 1 ? "review cadence" : "",
					...terms.strategics.filter((item) => !item.id || !item.title.trim() || !item.intent.trim()).map((item) => `strategy ${item.id}`),
					...terms.tacticals.filter((item) => !item.id || !item.objective.trim() || !item.successCriteria.length).map((item) => `tactic ${item.id}`),
				].filter(Boolean);
				next = { ...plan, draft: { revision: revision + 1, baseRevision: head?.revision ?? 0, status: "editing",
					terms, digest: null, savedBy: "owner", fromReview: null, missing } };
				break;
			}
			case "plan-propose": {
				if (draft?.status !== "editing" || draft.missing.length) return { state: "refused", code: "incomplete" };
				const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([draft.revision, draft.terms])));
				const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
				next = { ...plan, draft: { ...draft, status: "proposed", digest } };
				break;
			}
			case "plan-agree": {
				if (!mission.canAgreePlan || mission.authority !== "developer-local") return { state: "refused", code: "managed-requires-gateway" };
				if (draft?.status !== "proposed" || revision !== change.revision || draft.digest !== change.digest)
					return { state: "refused", code: "stale-digest" };
				const { digest } = change;
				next = { ...plan, adopted: true, headValid: true, previous: head, draft: null, due: [], preview: null,
					head: { revision, digest, previousDigest: head?.digest ?? null, terms: draft.terms, agreedAt: now, receiptId: `sample-plan-receipt-${revision}` },
					history: [{ revision, digest, agreedAt: now }, ...plan.history], gate: { state: "closed", reason: "reopen-needed" } };
				break;
			}
			case "review-now": {
				if (!head) return { state: "refused", code: "incomplete" };
				const trigger = plan.due[0] ?? { kind: "owner", key: `${head.revision}:owner:${requestId}`, subject: null };
				if (plan.reviews.some((review) => review.key === trigger.key)) return { state: "completed", mission };
				next = { ...plan, due: [], preview: null, reviews: [previewReview(head, trigger, `sample-${requestId}`), ...plan.reviews].slice(0, 12) };
				break;
			}
			case "review-dismiss":
				if (!plan.reviews.some((review) => review.reviewId === change.reviewId))
					return { state: "refused", code: "stale-revision" };
				next = { ...plan, reviews: plan.reviews.map((review) => review.reviewId !== change.reviewId || review.disposition ? review :
					{ ...review, disposition: { kind: "dismissed", at: now, draftRevision: null } }) };
				break;
		}
		details.mission = { ...mission, plan: next };
		return { state: "completed", mission: details.mission };
	},
	async send(prompt, requestId) {
		if (unknown) return { state: "unknown", message: requestId };
		view = {
			...view,
			...appendChat("user", prompt),
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
					...appendChat("assistant", reply),
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
};

function previewMissingTerms(terms: MissionDraftTerms): string[] {
	const { policy } = terms;
	return [
		[terms.objective?.trim(), "objective"],
		[terms.scope?.trim(), "scope"],
		[terms.successCriteria?.length, "success criteria"],
		[terms.approvalBoundary !== undefined, "approval boundary"],
		[terms.reviewEveryMs, "review cadence"],
		[policy?.allowedTools !== undefined, "allowed tool actions"],
		[policy?.maxCycles, "max cycles"],
		[policy?.maxRequests, "max requests"],
		[policy?.maxRetries !== undefined, "max retries"],
		[policy?.maxConsecutiveNoProgress, "max consecutive cycles without progress"],
		[policy?.deadlineAt, "deadline"],
	].flatMap(([present, label]) => present ? [] : [String(label)]);
}

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
if (flag("empty")) {
	retainedEntries.length = 0;
	view = { ...view, ...chatWindow() };
}
if (flag("long")) {
	const turns = Array.from({ length: 12 }, (_, index) => [
		{ id: 10 + index * 2, role: "user" as const, text: `Question ${index + 1}: what changed in the lockfile since yesterday?`, truncated: false },
		{ id: 11 + index * 2, role: "assistant" as const, text: reply, truncated: false },
	]).flat();
	retainedEntries.push(...turns);
	view = {
		...view,
		model: { provider: "sample-provider-with-a-long-name", modelId: "sample-model-2026-11-21-with-a-very-long-identifier-for-layout-checks" },
		...chatWindow(),
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
if (params.get("mission") === "new")
	details.mission = { ...details.mission, stage: "drafting", objective: null, scope: null, agreement: null, agreementValid: false, run: null };
else if (params.get("mission") === "unarmed")
	details.mission = { ...details.mission, authority: "managed-administrator", canAgree: false };
const planVariant = params.get("plan");
if (planVariant === "history" || planVariant === "managed" || planVariant === "new" || planVariant === "invalid") {
	const authority = planVariant === "managed" ? "managed-administrator" : details.mission.authority;
	details.mission = {
		...details.mission, authority, canAgree: authority === "developer-local",
		plan: planVariant === "new" || planVariant === "invalid" ? null : previewPlan(planVariant),
		planError: planVariant === "invalid" ? "invalid-plan" : null,
		canAgreePlan: authority === "developer-local" && planVariant !== "invalid",
		runnablePurposeBinding: details.mission.agreement && planVariant !== "invalid" ? previewBinding : null,
	};
}
if (flag("held") && details.owner) details.owner.held = true;
if (flag("unconfigured")) {
	if (details.owner) details.owner.configured = false;
	view = { ...view, model: null };
}
if (flag("memory")) details.memory.records = memories;

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Workspace mount element is missing.");
// "channels" is the old name of the Connections page; keep old preview links working.
const requested = params.get("section") === "channels" ? "connections" : params.get("section");
const section = sections.find((entry) => entry.id === requested)?.id;
let unmount = mountWorkspace(root, port, { preview: true, section });

window.unitPreview = {
	connection(state) {
		listener?.({ type: "connection", state });
	},
	unknown(value) {
		unknown = value;
	},
	empty() {
		retainedEntries.length = 0;
		view = { ...view, ...chatWindow() };
		// The workspace keeps seen rows across frames, so a new sample conversation needs a new mount.
		unmount();
		unmount = mountWorkspace(root, port, { preview: true, section });
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
if (flag("nav")) click("menu");
if (flag("forget")) {
	const first = memories[0];
	// Waits for the memory page to render its rows, then opens the dialog for the first one.
	if (first) setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-key="forget-${first.id}"]`)?.click(), 100);
}
