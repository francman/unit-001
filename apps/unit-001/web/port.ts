// Connects the workspace to the local operator gateway without replaying mutations.
import { parseMissionRefusalCode } from "../src/missions/refusal.ts";
import {
	APPROVER_KINDS,
	CHANNEL_FAILURES,
	CHANNEL_STEPS,
	CREATOR_KINDS,
	DRAFT_STATUSES,
	MEMORY_DERIVATIONS,
	MEMORY_GRAPH_LIMITS,
	MEMORY_KINDS,
	MEMORY_ORIGINS,
	MEMORY_RELATIONS,
	MEMORY_TIERS,
	MISSION_AUTHORITIES,
	memoryGraphProblem,
	RUN_STATES,
} from "../src/web/payload.ts";
import { browserApiFetch, type GatewaySession, readGatewaySession, requireWorkspaceIdentity, WorkspaceChanged } from "./client-auth.ts";
import { readEventStream } from "./client-stream.ts";
import type {
	ChatHistoryPage,
	MemoryGraphEdgeView,
	MemoryGraphView,
	MemoryStatsView,
	MissionAgreementView,
	MissionDraftTerms,
	MissionMutationOutcome,
	MissionPlanMutation,
	MissionPlanMutationOutcome,
	MissionPlanStatusRequest,
	MissionReviewView,
	MissionRunView,
	WorkspaceDetails,
	WorkspacePort,
	WorkspaceUsage,
	WorkspaceView,
} from "./contract.ts";
import { parseMissionPlanBinding, parsePlanTerms, parsePlanView } from "./mission-plan.ts";

type JsonObject = Record<string, unknown>;
type VerifiedConnection = { csrfToken: string; invalidate: () => void };

class GatewayRejection extends Error {}

/** Pins this page to one workspace and only authorizes requests after a matching live view. */
export function browserWorkspacePort(initialSession: GatewaySession): WorkspacePort {
	const { workspaceId } = initialSession;
	let candidate: GatewaySession | null = initialSession;
	let active: VerifiedConnection | null = null;
	let workspaceChanged = false;
	let watcher: AbortController | null = null;
	let planProposal: { connection: VerifiedConnection; revision: number; digest: string } | null = null;
	let missionVersion = 0;

	const requestEnvelope = async (operation: JsonObject, requestId: string): Promise<JsonObject> => {
		const connection = active;
		if (!connection) throw new GatewayRejection("The workspace connection is not verified. No request was sent.");
		const csrfToken = connection.csrfToken;
		const response = await browserApiFetch("/api/v1/requests", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Unit-CSRF": csrfToken },
			body: JSON.stringify({ requestId, operation }),
			signal: AbortSignal.timeout(125_000),
		});
		if (!response.ok) {
			// Only statuses the gateway uses before dispatch can establish that the owner was not called.
			if (![400, 403, 409, 429].includes(response.status)) throw new Error("Owner outcome is unknown.");
			void response.body?.cancel().catch(() => {});
			switch (response.status) {
				case 403:
					if (active === connection && connection.csrfToken === csrfToken) connection.invalidate();
					throw new GatewayRejection(workspaceChanged
						? "Request not sent. Return to the original workspace before trying again."
						: active
							? "Request not sent. Try the action again on the current workspace connection."
							: "Request not sent. Wait for this workspace to reconnect, then try the action again.");
				case 429:
					throw new GatewayRejection("Request not sent: the gateway is at capacity. Wait for active requests to finish, then try again.");
				default:
					throw new GatewayRejection("The gateway rejected this request before dispatch. Check the connection, request size and arguments.");
			}
		}
		if (active !== connection) {
			void response.body?.cancel().catch(() => {});
			throw new Error("The workspace connection changed before the reply arrived.");
		}
		const result = object(await response.json());
		if (active !== connection) throw new Error("The workspace connection changed before the reply arrived.");
		if (result.requestId !== requestId) throw new Error("Owner outcome is unknown.");
		// A delayed response must not overwrite a credential adopted while this POST was in flight.
		const nextCsrf = response.headers.get("X-Unit-Next-CSRF");
		if (nextCsrf !== null && connection.csrfToken === csrfToken) {
			if (response.headers.get("X-Unit-Workspace") === workspaceId && /^[!-~]+$/.test(nextCsrf)) {
				connection.csrfToken = nextCsrf;
			} else {
				// Refresh the credential without discarding the matching request outcome.
				connection.invalidate();
			}
		}
		return result;
	};
	const request = async (operation: JsonObject, requestId: string = crypto.randomUUID()): Promise<JsonObject> => {
		const result = await requestEnvelope(operation, requestId);
		if (result.state !== "completed") throw new Error("Owner outcome is unknown.");
		const reply = object(result.response);
		if (reply.type === "error" && typeof reply.message === "string")
			throw new Error("The owner could not complete this request.");
		if (operation.type === "send") {
			if (reply.type !== "sent" && reply.type !== "send-failed") throw new Error("Unexpected operation response.");
		} else if (reply.type !== (operation.type === "cancel" ? "cancelled" : operation.type)) {
			throw new Error("Unexpected operation response.");
		}
		if (operation.type === "memory" || operation.type === "channels") {
			const body = object(reply.result);
			if (body.operation !== object(operation.request).operation) throw new Error("Unexpected operation response.");
			if (body.operation === "forget") boolean(body.removed);
		}
		return reply;
	};
	async function loadMission(): Promise<WorkspaceDetails["mission"]> {
		const version = ++missionVersion;
		const connection = active;
		planProposal = null;
		const status: MissionPlanStatusRequest = { operation: "status" };
		const mission = parseMission((await request({ type: "mission", request: status })).result);
		rememberPlanProposal(mission, version, connection);
		return mission;
	}
	function rememberPlanProposal(mission: WorkspaceDetails["mission"], version: number, connection: VerifiedConnection | null): void {
		const plan = mission.plan;
		const draft = plan?.draft;
		if (
			version === missionVersion && connection !== null && connection === active && mission.canAgreePlan === true &&
			draft?.status === "proposed" && draft.digest !== null && draft.missing.length === 0 &&
			draft.baseRevision === (plan?.head?.revision ?? 0)
		) planProposal = { connection, revision: draft.revision, digest: draft.digest };
	}
	return {
		watch(listener) {
			watcher?.abort();
			const controller = new AbortController();
			const { signal } = controller;
			watcher = controller;
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			signal.addEventListener("abort", () => {
				clearTimeout(retryTimer);
				active = null;
			}, { once: true });
			if (workspaceChanged) listener({ type: "connection", state: "workspace-changed" });
			else void connect();
			return () => {
				if (watcher === controller) watcher = null;
				controller.abort();
			};

			async function connect(): Promise<void> {
				const stream = new AbortController();
				const streamSignal = AbortSignal.any([signal, stream.signal]);
				function invalidate(): void {
					active = null;
					stream.abort();
					listener({ type: "connection", state: "offline" });
				}
				try {
					const session = candidate ?? await readGatewaySession(streamSignal, workspaceId);
					streamSignal.throwIfAborted();
					candidate = null;
					const response = await browserApiFetch("/api/v1/events", {
						headers: { Accept: "text/event-stream" },
						signal: streamSignal,
					});
					try {
						streamSignal.throwIfAborted();
						if (!response.ok) throw new Error("Invalid event stream.");
						requireWorkspaceIdentity(response, workspaceId);
						const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
						if (type !== "text/event-stream" || !response.body) throw new Error("Invalid event stream.");
					} catch (error) {
						void response.body?.cancel().catch(() => {});
						throw error;
					}
					await readEventStream(response.body, streamSignal, (event, data) => {
						if (event === "connecting") {
							active = null;
							listener({ type: "connection", state: "connecting" });
						} else if (event === "view") {
							let view: WorkspaceView;
							try {
								view = parseWorkspaceView(JSON.parse(data));
							} catch {
								invalidate();
								return;
							}
							active ??= { csrfToken: session.csrfToken, invalidate };
							listener({ type: "view", view });
						}
					});
				} catch (error) {
					if (!signal.aborted && error instanceof WorkspaceChanged) {
						workspaceChanged = true;
						listener({ type: "connection", state: "workspace-changed" });
						return;
					}
				}
				if (signal.aborted) return;
				if (!stream.signal.aborted) invalidate();
				if (!signal.aborted) retryTimer = setTimeout(() => void connect(), 3000);
			}
		},
		async history(before) {
			const reply = await request({ type: "chat-history", before });
			return parseHistoryPage(reply.page, before);
		},
		mission: loadMission,
		async mutateMission(change, requestId): Promise<MissionMutationOutcome> {
			try {
				if (change.operation === "agree") {
					const connection = active;
					if (!connection) return { state: "rejected" };
					// Recheck authority at the click, not from prior UI state, and never carry the click across a reconnect.
					const mission = await loadMission().catch(() => null);
					if (active !== connection || !mission?.canAgree) return { state: "rejected" };
					if (mission.draft?.status !== "proposed" || mission.draft.revision !== change.revision)
						return { state: "refused", code: "stale-revision" };
					if (mission.draft.digest !== change.digest) return { state: "refused", code: "stale-digest" };
				}
				const result = await requestEnvelope({ type: "mission", request: change }, requestId);
				if (result.state === "refused") return { state: "refused", code: parseMissionRefusalCode(result.code) };
				if (result.state === "completed") {
					const reply = object(result.response);
					if (reply.type === "mission") {
						const mission = parseMission(reply.result);
						const draft = mission.draft;
						if (
							(change.operation === "draft" && draft?.status === "editing" && draft.revision > change.expectedRevision) ||
							(change.operation === "propose" && draft?.status === "proposed" && draft.revision === change.expectedRevision) ||
							// The gateway checks the owner's revision and digest but not the approver kind or the cleared draft, so the page does.
							(change.operation === "agree" && mission.authority === "developer-local" && mission.agreementValid &&
								mission.agreement?.approvedBy === "developer-local" && mission.agreement.revision === change.revision && draft === null)
						) return { state: "completed", mission };
					}
				}
			} catch (error) {
				if (error instanceof GatewayRejection) return { state: "rejected" };
			}
			return { state: "unknown" };
		},
		async mutateMissionPlan(change, requestId): Promise<MissionPlanMutationOutcome> {
			const connection = active;
			if (!connection) return { state: "rejected" };
			if (
				change.operation === "plan-agree" &&
				(change.confirmed !== true || planProposal === null || planProposal.connection !== connection ||
					planProposal.revision !== change.revision || planProposal.digest !== change.digest)
			) return { state: "rejected" };

			let mutation: MissionPlanMutation;
			try {
				mutation = planMutationRequest(change);
			} catch {
				return { state: "rejected" };
			}
			// A write consumes the exact proposal snapshot even when the result is uncertain.
			const version = ++missionVersion;
			planProposal = null;
			try {
				const result = await requestEnvelope({ type: "mission", request: mutation }, requestId);
				if (result.state === "refused") return { state: "refused", code: parseMissionRefusalCode(result.code) };
				if (result.state === "issued" && mutation.operation === "plan-agree")
					return { state: "issued", receiptId: missionIdentity(result.receiptId), reconciled: boolean(result.reconciled) };
				if (result.state === "completed") {
					const reply = object(result.response);
					if (reply.type === "mission") {
						const mission = parseMission(reply.result);
						if (confirmsPlanMutation(mutation, mission)) {
							rememberPlanProposal(mission, version, connection);
							return { state: "completed", mission };
						}
					}
				}
			} catch (error) {
				if (error instanceof GatewayRejection) return { state: "rejected" };
			}
			return { state: "unknown" };
		},
		async details() {
			const [mission, memoryReply, channelsReply, owner] = await Promise.all([
				loadMission(),
				request({ type: "memory", request: { operation: "stats" } }),
				request({ type: "channels", request: { operation: "status" } }),
				// A failed status read must not hide mission, memory or channel details.
				request({ type: "status" }).then(parseOwner, () => null),
			]);
			const stats = object(memoryReply.result);
			const channels = object(object(channelsReply.result).view).channels;
			if (!Array.isArray(channels)) throw new Error("Invalid channel response.");
			return {
				owner,
				mission,
				memory: {
					count:
						typeof stats.working === "number" && typeof stats.episodic === "number"
							? stats.working + stats.episodic
							: null,
					stats: parseMemoryStats(stats),
					records: [],
				},
				channels: channels.slice(0, 64).map((value: unknown) => {
					const channel = object(value);
					const input = object(channel.request);
					const outcome = object(channel.outcome);
					// The confirmation url on awaiting_creator outcomes is a credential-bearing link; it is never read.
					return {
						id: text(input.channelId),
						adapter: text(input.adapter),
						status: text(outcome.kind),
						detail:
							outcome.kind === "ready"
								? "Setup identity verified. Message delivery has not been verified."
								: "Setup is pending or unavailable. Creator authority is required.",
						lastHealth: channel.lastHealth === null || channel.lastHealth === undefined ? null : parseHealth(channel.lastHealth),
						failure: outcome.kind === "failed" ? oneOf(outcome.reason, CHANNEL_FAILURES) : null,
						awaiting: outcome.kind === "awaiting_creator" ? oneOf(outcome.step, CHANNEL_STEPS) : null,
					};
				}),
			} satisfies WorkspaceDetails;
		},
		async send(prompt, requestId) {
			try {
				const reply = await request({ type: "send", prompt }, requestId);
				if (reply.type === "send-failed")
					return {
						state: "failed-after-admission",
						message: "The owner could not complete this request. Your message was sent.",
					};
				return { state: "completed" };
			} catch (error) {
				if (error instanceof GatewayRejection) return { state: "failed", message: error.message };
				return { state: "unknown", message: "Inspect the current conversation before sending again." };
			}
		},
		async cancel(requestId) {
			await request({ type: "cancel" }, requestId);
		},
		async recall(query) {
			const reply = await request({ type: "memory", request: { operation: "recall", query } });
			const result = object(reply.result);
			if (reply.type !== "memory" || result.operation !== "recall" || !Array.isArray(result.records))
				throw new Error("Invalid memory response.");
			return {
				count: null,
				stats: null,
				records: result.records.slice(0, 5).map((value: unknown) => {
					const record = object(value);
					return {
						id: text(record.id),
						content: text(record.content),
						source: `${text(record.origin)}/${text(record.tier)}`,
					};
				}),
			};
		},
		async memoryGraph() {
			const reply = await request({ type: "memory", request: { operation: "graph" } });
			if (reply.type !== "memory") throw new Error("Invalid memory response.");
			return parseMemoryGraph(reply.result);
		},
		async forget(id, requestId) {
			try {
				await request({ type: "memory", request: { operation: "forget", id, confirmed: true } }, requestId);
				return { state: "completed" };
			} catch (error) {
				if (error instanceof GatewayRejection) return { state: "failed", message: error.message };
				return { state: "unknown", message: "Forget outcome not confirmed. Inspect memory before acting again." };
			}
		},
	};
}

function planMutationRequest(change: MissionPlanMutation): MissionPlanMutation {
	switch (change.operation) {
		case "plan-draft":
			return { operation: change.operation, expectedRevision: change.expectedRevision, terms: parsePlanTerms(change.terms) };
		case "plan-propose":
			return { operation: change.operation, expectedRevision: change.expectedRevision };
		case "plan-agree":
			return { operation: change.operation, revision: change.revision, digest: change.digest, confirmed: change.confirmed };
		case "review-now":
			return { operation: change.operation };
		case "review-dismiss":
			return { operation: change.operation, reviewId: change.reviewId };
	}
	throw new Error("Invalid mission plan operation.");
}

function confirmsPlanMutation(change: MissionPlanMutation, mission: WorkspaceDetails["mission"]): boolean {
	const plan = mission.plan;
	if (!plan) return false;
	switch (change.operation) {
		case "plan-draft":
			return plan.draft?.status === "editing" && plan.draft.savedBy === "owner" &&
				plan.draft.revision > change.expectedRevision && JSON.stringify(plan.draft.terms) === JSON.stringify(change.terms);
		case "plan-propose":
			return plan.draft?.status === "proposed" && plan.draft.revision === change.expectedRevision;
		case "plan-agree":
			// The gateway emits completed for plan Agree only after checking the authority, the head and its revision and digest.
			return true;
		case "review-now":
			// The request ID binds the gateway acknowledgement, including replay of an earlier stored note.
			return plan.reviews.length !== 0;
		case "review-dismiss":
			return plan.reviews.some((note) => note.reviewId === change.reviewId && note.disposition !== null);
	}
}

// Failure reasons and retry state are owner-terminal fields; the gateway's projection never forwards them.
const OWNER_ONLY = ["failure", "retry"];

/** Validates snapshots before displaying owner-provided text. */
export function parseWorkspaceView(value: unknown): WorkspaceView {
	const view = object(value);
	if (
		!Array.isArray(view.entries) ||
		view.entries.length > 20 ||
		!Array.isArray(view.tools) ||
		view.tools.length > 32 ||
		OWNER_ONLY.some((key) => key in view)
	)
		throw new Error("Invalid view.");
	const model = view.model === null ? null : object(view.model);
	let previous = 0;
	return {
		name: text(view.name),
		version: text(view.version),
		installationId: view.installationId === null ? null : text(view.installationId),
		busy: boolean(view.busy),
		model: model === null ? null : { provider: text(model.provider), modelId: text(model.modelId) },
		usage: view.usage === null ? null : parseUsage(view.usage),
		text: text(view.text),
		textTruncated: boolean(view.textTruncated),
		historyTruncated: boolean(view.historyTruncated),
		entries: view.entries.map((value: unknown) => {
			const entry = object(value);
			const id = historyId(entry.id);
			if (id <= previous || (entry.role !== "user" && entry.role !== "assistant"))
				throw new Error("Invalid entry.");
			previous = id;
			return {
				id,
				role: entry.role,
				text: text(entry.text),
				truncated: boolean(entry.truncated),
				...(entry.source === "host" ? { source: "host" as const } : {}),
			};
		}),
		tools: view.tools.map((value: unknown) => {
			const tool = object(value);
			if (Object.keys(tool).some((key) => key !== "callId" && key !== "name" && key !== "status"))
				throw new Error("Invalid tool.");
			return { callId: text(tool.callId), name: text(tool.name), status: text(tool.status) };
		}),
	};
}

function object(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid owner object.");
	return value as JsonObject;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length > 32768) throw new Error("Invalid owner text.");
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("Invalid owner flag.");
	return value;
}

function parseUsage(value: unknown): WorkspaceUsage {
	const usage = object(value);
	const cost = object(usage.cost);
	return {
		input: number(usage.input),
		output: number(usage.output),
		cacheRead: number(usage.cacheRead),
		cacheWrite: number(usage.cacheWrite),
		totalTokens: number(usage.totalTokens),
		cost:
			cost.kind === "estimate"
				? { kind: "estimate", usd: number(cost.usd) }
				: cost.kind === "unknown"
					? { kind: "unknown" }
					: fail("Invalid owner cost."),
	};
}

function parseOwner(reply: JsonObject): NonNullable<WorkspaceDetails["owner"]> {
	if (reply.type !== "status") throw new Error("Invalid status response.");
	const runtime = object(reply.runtime);
	const maintenance = object(reply.maintenance);
	return {
		uptimeMs: number(runtime.uptimeMs),
		held: maintenance.state === "held",
		inhibited: boolean(reply.inhibited),
		configured: runtime.configuration === "configured",
	};
}

function parseHistoryPage(value: unknown, before: number | null): ChatHistoryPage {
	const page = object(value);
	let previous = 0;
	const entries = list(page.entries, 5, (item): ChatHistoryPage["entries"][number] => {
		const row = object(item);
		const id = historyId(row.id);
		if (id <= previous || (before !== null && id >= before)) throw new Error("Invalid chat history order.");
		previous = id;
		const role = oneOf(row.role, ["user", "assistant"] as const);
		const content = text(row.text);
		if (content.length > 4096) throw new Error("Invalid chat history text.");
		const truncated = boolean(row.truncated);
		if (row.source === undefined) return { id, role, text: content, truncated };
		if (row.source !== "host") throw new Error("Invalid chat history source.");
		return { id, role, text: content, truncated, source: "host" };
	});
	const nextBefore = page.nextBefore === null ? null : historyId(page.nextBefore);
	const first = entries[0]?.id;
	if (nextBefore !== null && ((before !== null && nextBefore >= before) || (first !== undefined && nextBefore > first)))
		throw new Error("Invalid chat history continuation.");
	return { entries, nextBefore };
}

function historyId(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid chat history ID.");
	return value;
}

function parseMission(value: unknown): WorkspaceDetails["mission"] {
	const mission = object(value);
	const formation = object(mission.formation);
	const authority = oneOf(mission.authority, MISSION_AUTHORITIES);
	const current = formation.agreement ?? formation.draft;
	const terms = current === null ? {} : object(object(current).terms);
	const draft = formation.draft === null ? null : parseDraft(formation.draft);
	if (draft?.status === "proposed" && draft.digest === null &&
		!(authority === "managed-administrator" && mission.canAgree === false))
		throw new Error("Invalid mission proposal.");
	const previousReceipt = mission.previousReceipt == null ? mission.previousReceipt : missionIdentity(mission.previousReceipt);
	const review = mission.review == null ? null : parseMissionReview(mission.review);
	const matchingReview = review === null ||
		(draft?.status === "proposed" && review.missionId === draft.missionId && review.revision === draft.revision &&
			review.digest === draft.digest && review.previousReceipt === (previousReceipt ?? null));
	const plan = mission.plan === null ? null : parsePlanView(mission.plan);
	const planError = mission.planError === null ? null : oneOf(mission.planError, ["invalid-plan"]);
	if (planError === "invalid-plan" && plan !== null) throw new Error("Invalid mission plan projection.");
	const binding = mission.runnablePurposeBinding;
	return {
		stage: text(mission.stage),
		objective: typeof terms.objective === "string" ? terms.objective : null,
		scope: typeof terms.scope === "string" ? terms.scope : null,
		missing: list(mission.missing, 32, text),
		execution: text(mission.execution),
		tools: list(mission.tools, 128, text),
		agreement: formation.agreement === null ? null : parseAgreement(formation.agreement),
		run: mission.runtime == null ? null : parseRun(mission.runtime),
		creator: mission.creator === null ? null : parseCreator(mission.creator),
		authority,
		agreementValid: boolean(mission.agreementValid),
		authorityError: mission.authorityError === null ? null : oneOf(mission.authorityError, ["invalid-authority"]),
		formationAvailable: matchingReview,
		canAgree: authority === "developer-local" && mission.authorityError === null && mission.canAgree === true &&
			previousReceipt === undefined && matchingReview,
		previousReceipt,
		draft,
		review: matchingReview ? review : null,
		plan,
		planError,
		canAgreePlan: mission.canAgreePlan === true && authority === "developer-local" && planError !== "invalid-plan",
		runnablePurposeBinding: binding === null ? null : parseMissionPlanBinding(binding),
	};
}

function parseAgreement(value: unknown): MissionAgreementView {
	const agreement = object(value);
	const terms = object(agreement.terms);
	const policy = object(terms.policy);
	const approval = object(agreement.approval);
	return {
		revision: number(agreement.revision),
		successCriteria: list(terms.successCriteria, 32, text),
		approvalBoundary: list(terms.approvalBoundary, 32, text),
		reviewEveryMs: number(terms.reviewEveryMs),
		approvedAt: number(approval.approvedAt),
		approvedBy: oneOf(object(approval.approvedBy).kind, APPROVER_KINDS),
		...(policy.allowedTools === undefined ? {} : { allowedTools: list(policy.allowedTools, 128, text) }),
		limits: {
			maxCycles: number(policy.maxCycles),
			maxRequests: number(policy.maxRequests),
			maxRetries: number(policy.maxRetries),
			maxNoProgress: number(policy.maxConsecutiveNoProgress),
			deadlineAt: number(policy.deadlineAt),
			maxEstimatedCost: policy.maxEstimatedCost === undefined ? null : number(policy.maxEstimatedCost),
		},
	};
}

function parseRun(value: unknown): MissionRunView {
	const run = object(value);
	return {
		status: oneOf(run.status, RUN_STATES),
		blocker: run.blocker === null ? null : text(run.blocker),
		nextWakeAt: run.nextWakeAt === null ? null : number(run.nextWakeAt),
		cycles: number(run.cycles),
		requests: number(run.requests),
		retries: number(run.retries),
		noProgress: number(run.noProgress),
		estimatedCost: number(run.estimatedCost),
		reservedCost: number(run.reservedCost),
		unknownRequests: number(run.unknownRequests),
		unpricedResponses: number(run.unpricedResponses),
		uncertainTools: number(run.uncertainTools),
		evidence: list(run.evidence, 32, (item) => {
			const evidence = object(item);
			return {
				criterion: text(evidence.criterion),
				accepted: boolean(evidence.accepted),
				detail: text(evidence.detail),
				observedAt: number(evidence.observedAt),
			};
		}),
		observedAt: number(run.observedAt),
	};
}

function parseMemoryStats(stats: JsonObject): MemoryStatsView {
	return {
		working: number(stats.working),
		episodic: number(stats.episodic),
		tombstones: number(stats.tombstones),
		pendingCaptures: number(stats.pendingCaptures),
		failedCaptures: number(stats.failedCaptures),
		consolidation: oneOf(stats.consolidation, ["idle", "scheduled"] as const),
	};
}

/** Validates a memory graph reply; rejects oversize lists, unknown values, self relations and edges to absent nodes. */
export function parseMemoryGraph(value: unknown): MemoryGraphView {
	const graph = object(value);
	if (graph.operation !== "graph") throw new Error("Invalid memory response.");
	const nodes = list(graph.nodes, MEMORY_GRAPH_LIMITS.nodes, (item): MemoryGraphView["nodes"][number] => {
		const node = object(item);
		const id = text(node.id);
		if (id.length > MEMORY_GRAPH_LIMITS.idText) throw new Error("Invalid memory id.");
		return {
			id,
			content: text(node.content),
			truncated: boolean(node.truncated),
			kind: oneOf(node.kind, MEMORY_KINDS),
			tier: oneOf(node.tier, MEMORY_TIERS),
			origin: oneOf(node.origin, MEMORY_ORIGINS),
			importance: number(node.importance),
			createdAt: number(node.createdAt),
			conversation: text(node.conversation),
		};
	});
	const edges = list(graph.edges, MEMORY_GRAPH_LIMITS.edges, (item): MemoryGraphEdgeView => {
		const edge = object(item);
		const from = text(edge.from);
		const to = text(edge.to);
		if (edge.kind === "summary") return { from, to, kind: "summary" };
		return {
			from,
			to,
			kind: oneOf(edge.kind, MEMORY_RELATIONS),
			derivation: oneOf(edge.derivation, MEMORY_DERIVATIONS),
		};
	});
	const total = number(graph.total);
	const limited = boolean(graph.limited);
	const problem = Number.isSafeInteger(total) ? memoryGraphProblem({ nodes, edges, total, limited }) : "Invalid memory total.";
	if (problem !== null) throw new Error(problem);
	return { nodes, edges, total, limited };
}

function parseHealth(value: unknown): { observedAt: number; healthy: boolean } {
	const health = object(value);
	return { observedAt: number(health.observedAt), healthy: boolean(health.healthy) };
}

function parseCreator(value: unknown): NonNullable<WorkspaceDetails["mission"]["creator"]> {
	const creator = object(value);
	// The creator's local uid stays in the owner; the page shows who, not which account.
	return { kind: oneOf(creator.kind, CREATOR_KINDS), id: text(creator.id) };
}

function parseDraft(value: unknown): NonNullable<WorkspaceDetails["mission"]["draft"]> {
	const draft = object(value);
	const revision = historyId(draft.revision);
	const status = oneOf(draft.status, DRAFT_STATUSES);
	const digest = draft.digest === null ? null : missionDigest(draft.digest);
	if (status === "editing" && digest !== null) throw new Error("Invalid mission proposal.");
	return { revision, status, digest, missionId: missionIdentity(draft.missionId), terms: parseDraftTerms(draft.terms) };
}

function parseMissionReview(value: unknown): MissionReviewView {
	const review = object(value);
	return {
		missionId: missionIdentity(review.missionId),
		revision: historyId(review.revision),
		digest: missionDigest(review.digest),
		authorityRevision: historyId(review.authorityRevision),
		previousReceipt: review.previousReceipt === null ? null : missionIdentity(review.previousReceipt),
	};
}

function missionIdentity(value: unknown): string {
	const id = text(value);
	if (id.length === 0 || id.length > 200) throw new Error("Invalid mission identity.");
	return id;
}

function missionDigest(value: unknown): string {
	const digest = text(value);
	if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid mission digest.");
	return digest;
}

function parseDraftTerms(value: unknown): MissionDraftTerms {
	const input = object(value);
	const terms: MissionDraftTerms = {};
	for (const key of ["objective", "scope"] as const) if (input[key] !== undefined) terms[key] = text(input[key]);
	for (const key of ["successCriteria", "approvalBoundary"] as const) if (input[key] !== undefined) terms[key] = list(input[key], 32, text);
	if (input.reviewEveryMs !== undefined) terms.reviewEveryMs = draftNumber(input.reviewEveryMs);
	if (input.policy !== undefined) {
		const inputPolicy = object(input.policy);
		const policy: NonNullable<MissionDraftTerms["policy"]> = {};
		if (inputPolicy.allowedTools !== undefined) policy.allowedTools = list(inputPolicy.allowedTools, 128, text);
		for (const key of ["maxCycles", "maxRequests", "maxRetries", "maxConsecutiveNoProgress", "deadlineAt", "maxEstimatedCost"] as const)
			if (inputPolicy[key] !== undefined) policy[key] = draftNumber(inputPolicy[key]);
		terms.policy = policy;
	}
	return terms;
}

function draftNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid mission term.");
	return value;
}

function list<T>(value: unknown, max: number, item: (value: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > max) throw new Error("Invalid owner list.");
	return value.map(item);
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("Invalid owner value.");
	return value as T;
}

function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error("Invalid owner number.");
	return value;
}

function fail(message: string): never {
	throw new Error(message);
}
