// #72: Bob's bounded model review of the agreed plan, on real SQLite with the faux provider: one turn per due window.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, ProviderDoc, type Tx } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceDoc } from "../../src/maintenance.ts";
import { MissionAdmission } from "../../src/missions/admission.ts";
import { readMissionAuthority, writeMissionAuthority } from "../../src/missions/authority.ts";
import type { MissionRequest, PurposeTerms } from "../../src/missions/contract.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { missionController } from "../../src/missions/controller.ts";
import { MissionOwner } from "../../src/missions/owner.ts";
import { planDraftTool } from "../../src/missions/plan-draft-tool.ts";
import { type PlanState, readMissionPlan, storedPlan } from "../../src/missions/plan-state.ts";
import type { PlanTerms, ReviewAllowance } from "../../src/missions/plan-terms.ts";
import { readMissionPurpose } from "../../src/missions/purpose.ts";
import { MissionReviewDoc, REVIEW_PROVIDER_PREFIX, readReviewState } from "../../src/missions/review-turn-state.ts";
import { MissionFoundation } from "../../src/missions/state.ts";
import { planned, runnable } from "./fixtures/plan.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];
const model = { provider: "faux", modelId: "faux-1" };
type Response = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-review-"));
	now = 1_000;
});
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const purpose: PurposeTerms = {
	purpose: "Keep the fixture reports current",
	scope: "The fixture workspace",
	reviewEveryMs: 1_000,
	works: [
		{
			kind: "artifact-digest",
			path: "reports/0.txt",
			sha256: sha("alpha"),
			instructions: "Write the agreed text.",
			maxCycles: 2,
			maxRequests: 2,
			maxRetries: 0,
			maxConsecutiveNoProgress: 2,
		},
	],
	lifetime: { maxWorkItems: 4, maxCycles: 6, maxRequests: 6, deadlineAt: 600_000 },
};

async function launch(responses: Response[] = []) {
	const location = { kind: "developer-local" as const, directory, session: "default" };
	const admission = new MissionAdmission(location, () => now);
	const engine = missionController(admission, directory);
	let owner: MissionOwner | undefined;
	const handle = (request: MissionRequest, ctx = context) => owner!.handle(request, ctx);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(MissionFoundation);
	registry.install(engine.extension);
	registry.install(
		defineExtension({
			name: "test.review.tools",
			tools: [
				defineTool({
					name: "unit_mission_status",
					description: "Mission status.",
					parameters: Type.Object({}),
					replay: "safe",
					execute: async (_args, _api, ctx) => ({
						output: [{ type: "text", text: JSON.stringify((await owner!.inspect(ctx)).plan?.head?.revision ?? null) }],
					}),
				}),
				planDraftTool(handle),
			],
		}),
	);
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{
			models: admission.models(models),
			registry,
			now: () => now,
			setTimer: () => () => {},
			settings: { retry: { enabled: false }, stream: { maxRetries: 0 } },
			env: () => new NodeExecutionEnv({ cwd: directory }),
		},
		context,
	);
	await admission.bind(harness, context);
	opened.push(harness);
	const control = new MissionControl(harness, location, ["write", "read"], () => now);
	owner = new MissionOwner(harness, control, location, registry, admission, engine, model, directory, () => now);
	await owner.initialize(context, "permitted");
	return { harness, faux, owner: owner!, request: (input: MissionRequest) => handle(input), location };
}
type Host = Awaited<ReturnType<typeof launch>>;

async function reopen(host: Host, responses: Response[] = []) {
	await host.harness.close(context);
	opened.splice(opened.indexOf(host.harness), 1);
	const next = await launch(responses);
	next.harness.resume();
	return next;
}

const allowance = (overrides: Partial<ReviewAllowance> = {}): ReviewAllowance => ({
	maxRequests: 6,
	maxRequestsPerReview: 2,
	maxEstimatedCost: null,
	...overrides,
});

function plan(binding: PlanTerms["tacticals"][number]["binding"], review: ReviewAllowance | null, scope = "The workspace"): PlanTerms {
	return {
		overall: { purpose: "Keep the reports current", scope, askFirst: [], reviewEveryMs: 10_000, reviewAllowance: review },
		strategics: [{ id: "reports", title: "Reports", intent: "Fresh reports", signals: [], priority: "high" }],
		tacticals: [runnable({ binding }), planned()],
	};
}

/** Configures the creator, agrees purpose 1, then drafts, proposes and agrees the plan; returns the purpose binding. */
async function adopt(host: Host, review: ReviewAllowance | null) {
	await host.request({
		operation: "configure-local",
		creator: { kind: "human", id: "creator", uid: process.getuid?.() ?? null },
		ceiling: {
			allowedTools: ["write"],
			maxCycles: 10,
			maxRequests: 20,
			maxRetries: 2,
			maxConsecutiveNoProgress: 10,
			maxDurationMs: 1_000_000,
		},
		purposeCeiling: {
			capabilities: ["artifact-digest"],
			paths: ["reports/"],
			maxWorkItems: 8,
			maxCycles: 10,
			maxRequests: 10,
			maxRetries: 2,
			maxConsecutiveNoProgress: 4,
			maxDurationMs: 1_000_000,
		},
	});
	const proposed = await host.request({ operation: "purpose-propose", expectedRevision: 0, requestId: "pp", terms: purpose });
	await host.request({
		operation: "purpose-approve-local",
		revision: proposed.purpose!.proposed!.revision,
		digest: proposed.purpose!.proposed!.digest,
		requestId: "pa",
	});
	const agreement = (await readMissionPurpose(host.harness, context))!.loop.agreements[0]!;
	const binding = { missionId: agreement.missionId, purposeRevision: agreement.revision, purposeDigest: agreement.digest };
	const drafted = await host.request({
		operation: "plan-draft",
		expectedRevision: 0,
		requestId: "d1",
		terms: plan(binding, review),
		savedBy: "owner",
		fromReview: null,
		reviewConversation: null,
	});
	const frozen = await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" });
	const { revision, digest } = frozen.plan!.draft!;
	await host.request({ operation: "plan-agree", revision, digest: digest!, requestId: "a1" });
	return binding;
}

/** Bob's reply that saves a draft answering the running review; it reads the stored note when the request arrives. */
function drafts(binding: Awaited<ReturnType<typeof adopt>>, host: () => Host, scope: string): Response {
	return async () => {
		const reviews = await readReviewState(host().harness, context);
		const saved = await readMissionPlan(host().harness, context);
		const turn = reviews!.turns.find((item) => item.state.status === "running")!;
		return fauxAssistantMessage(
			fauxToolCall("unit_plan_draft", {
				expectedRevision: saved!.draft?.revision ?? saved!.agreed.at(-1)!.revision,
				fromReview: turn.reviewId,
				terms: plan(binding, allowance(), scope),
			}),
			{ stopReason: "toolUse" },
		);
	};
}

const summary = (): Response => fauxAssistantMessage("Reviewed; one draft saved.");

async function until(host: Host, predicate: () => Promise<boolean>) {
	for (let i = 0; i < 400; i++) {
		if (await predicate()) return;
		await setTimeout(5);
	}
	throw new Error(`Review did not settle: ${JSON.stringify(await readReviewState(host.harness, context))}`);
}

const readMissionPlanInTx = async (tx: Tx): Promise<PlanState> => (await storedPlan(tx))!;
const turnsOf = async (host: Host) => (await readReviewState(host.harness, context))?.turns ?? [];

describe("arming", () => {
	it("arms no review task when the agreed plan grants no review allowance", async () => {
		const host = await launch();
		await adopt(host, null);
		expect((await readReviewState(host.harness, context))?.task ?? null).toBeNull();
		const view = await host.request({ operation: "status" });
		expect(view.plan).toMatchObject({ allowance: null, turns: [], blocker: null });
	});

	it("arms one task when the plan grants an allowance, and sleeps until the first cadence window", async () => {
		const host = await launch();
		await adopt(host, allowance());
		const reviews = await readReviewState(host.harness, context);
		expect(reviews?.task).not.toBeNull();
		await setTimeout(30);
		expect(host.faux.state.callCount).toBe(0);
		expect(reviews?.turns).toEqual([]);
	});
});

describe("one bounded turn per due window", () => {
	it("stores the note and turn before any request, drafts as Bob, charges the ledger, and never repeats the window", async () => {
		let host = await launch();
		const binding = await adopt(host, allowance());
		now = 11_000;
		host = await reopen(host, [drafts(binding, () => host, "Reviewed scope"), summary()]);
		await until(host, async () => (await turnsOf(host))[0]?.state.status === "done");
		const reviews = (await readReviewState(host.harness, context))!;
		const saved = (await readMissionPlan(host.harness, context))!;
		expect(reviews.turns).toHaveLength(1);
		expect(reviews.turns[0]).toMatchObject({
			key: "1:cadence:w1",
			planRevision: 1,
			state: { status: "done", draftRevision: saved.draft!.revision },
		});
		expect(saved.draft).toMatchObject({ savedBy: "bob", fromReview: reviews.turns[0]!.reviewId, status: "editing" });
		expect(saved.reviews.map((note) => note.key)).toEqual(["1:cadence:w1"]);
		expect(reviews.ledger).toMatchObject({ requests: 2, unknownRequests: 0 });
		expect(host.faux.state.callCount).toBe(2);
		const view = await host.request({ operation: "status" });
		expect(view.plan!.allowance).toMatchObject({ maxRequests: 6, maxRequestsPerReview: 2, requests: 2 });
		expect(view.plan!.turns[0]).toMatchObject({ state: "done", reason: null, requests: 2 });
		// The finished turn's conversation can no longer save a draft.
		await expect(
			host.request({
				operation: "plan-draft",
				expectedRevision: saved.draft!.revision,
				requestId: "late",
				terms: plan(binding, allowance(), "Late"),
				savedBy: "bob",
				fromReview: reviews.turns[0]!.reviewId,
				reviewConversation: reviews.turns[0]!.conversation,
			}),
		).rejects.toMatchObject({ code: "stale-revision" });
		// Same window after a restart: the key is consumed, nothing runs again.
		host = await reopen(host, [summary()]);
		await setTimeout(40);
		expect(host.faux.state.callCount).toBe(0);
		expect(await turnsOf(host)).toHaveLength(1);
	});

	it("never replaces an owner's pending draft; the turn finishes without a draft", async () => {
		let host = await launch();
		const binding = await adopt(host, allowance());
		await host.request({
			operation: "plan-draft",
			expectedRevision: 1,
			requestId: "owner-edit",
			terms: plan(binding, allowance(), "Owner's scope"),
			savedBy: "owner",
			fromReview: null,
			reviewConversation: null,
		});
		now = 11_000;
		host = await reopen(host, [drafts(binding, () => host, "Bob's scope"), summary()]);
		await until(host, async () => (await turnsOf(host))[0]?.state.status === "done");
		expect((await turnsOf(host))[0]!.state).toEqual({ status: "done", draftRevision: null });
		expect((await readMissionPlan(host.harness, context))!.draft).toMatchObject({
			savedBy: "owner",
			terms: { overall: { scope: "Owner's scope" } },
		});
	});
});

describe("skips", () => {
	it("skips with budget when the lifetime allowance is spent, making no request", async () => {
		let host = await launch();
		const binding = await adopt(host, allowance({ maxRequests: 2 }));
		now = 11_000;
		host = await reopen(host, [drafts(binding, () => host, "First"), summary()]);
		await until(host, async () => (await turnsOf(host))[0]?.state.status === "done");
		now = 21_000;
		host = await reopen(host, [summary()]);
		await until(host, async () => (await turnsOf(host)).some((turn) => turn.state.status === "skipped"));
		expect(host.faux.state.callCount).toBe(0);
		const view = await host.request({ operation: "status" });
		expect(view.plan!.turns[0]).toMatchObject({ key: "1:cadence:w2", state: "skipped", reason: "budget", requests: 0 });
	});

	it("skips with hold under maintenance and ends the task, then runs after the hold is released", async () => {
		let host = await launch();
		const binding = await adopt(host, allowance());
		await host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "op-1" };
		}, context);
		now = 11_000;
		host = await reopen(host, []);
		await until(host, async () => (await turnsOf(host))[0]?.state.status === "skipped");
		expect((await turnsOf(host))[0]!.state).toEqual({ status: "skipped", reason: "hold" });
		await until(host, async () => (await readReviewState(host.harness, context))!.task === null);
		expect(host.faux.state.callCount).toBe(0);
		await host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "open", operationId: null };
		}, context);
		host = await reopen(host, [drafts(binding, () => host, "After hold"), summary()]);
		await until(host, async () => (await turnsOf(host))[0]?.state.status === "done");
		// One record per key: the skipped turn became the one that ran.
		expect(await turnsOf(host)).toHaveLength(1);
	});

	it("skips with unsettled while an earlier review request has an unknown outcome, and shows it as the blocker", async () => {
		let host = await launch();
		await adopt(host, allowance());
		await host.harness.commit(async (tx) => {
			const reviews = await tx.doc(MissionReviewDoc);
			reviews.turns.push({
				key: "0:cadence:w9",
				planRevision: 1,
				trigger: { kind: "cadence", key: "0:cadence:w9", subject: "w9" },
				reviewId: null,
				conversation: null,
				providerSession: null,
				attempts: [{ attemptId: "0:cadence:w9:a1", ceiling: null, status: "reserved" }],
				state: { status: "blocked", reason: "unknown_request_outcome" },
				at: 1,
			});
			reviews.ledger.requests = 1;
			reviews.ledger.unknownRequests = 1;
			reviews.ledger.unboundedAttempts = 1;
		}, context);
		now = 11_000;
		host = await reopen(host, [summary()]);
		await until(host, async () => (await turnsOf(host)).some((turn) => turn.key === "1:cadence:w1"));
		expect(host.faux.state.callCount).toBe(0);
		const view = await host.request({ operation: "status" });
		expect(view.plan!.turns.find((turn) => turn.key === "1:cadence:w1")).toMatchObject({ state: "skipped", reason: "unsettled" });
		expect(view.plan!.blocker).toMatchObject({ key: "0:cadence:w9", state: "blocked", reason: "unknown_request_outcome" });
	});
});

describe("draft guard for review conversations", () => {
	type TurnSetup = {
		attempts?: number;
		estimatedCost?: number;
		blockedElsewhere?: boolean;
		recordTurn?: boolean;
	};

	/** A running turn bound to a real conversation whose provider session is a review session. */
	async function runningTurn(host: Host, setup: TurnSetup = {}) {
		// The turn answers a real stored note, as an admitted turn does.
		const noted = await host.request({ operation: "review-now", requestId: "fixture-note" });
		const reviewId = noted.plan!.reviews[0]!.reviewId;
		const conversation = await host.harness.commit(async (tx) => {
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			(await tx.doc(ProviderDoc, created.id)).sessionId = `${REVIEW_PROVIDER_PREFIX}fixture`;
			const saved = await readMissionPlanInTx(tx);
			const reviews = await tx.doc(MissionReviewDoc);
			const attempts = Array.from({ length: setup.attempts ?? 1 }, (_value, index) => ({
				attemptId: `1:cadence:w1:a${index + 1}`,
				ceiling: 0.1,
				status: "priced" as const,
				cost: 0,
			}));
			if (setup.recordTurn !== false)
				reviews.turns.push({
					key: "1:cadence:w1",
					planRevision: saved.agreed.at(-1)!.revision,
					trigger: { kind: "cadence", key: "1:cadence:w1", subject: "w1" },
					reviewId,
					conversation: created.id,
					providerSession: `${REVIEW_PROVIDER_PREFIX}fixture`,
					attempts,
					state: { status: "running" },
					at: 1,
				});
			if (setup.blockedElsewhere)
				reviews.turns.push({
					key: "0:cadence:w9",
					planRevision: 1,
					trigger: { kind: "cadence", key: "0:cadence:w9", subject: "w9" },
					reviewId: null,
					conversation: null,
					providerSession: null,
					attempts: [{ attemptId: "0:cadence:w9:a1", ceiling: null, status: "reserved" }],
					state: { status: "blocked", reason: "unknown_request_outcome" },
					at: 1,
				});
			reviews.ledger.requests = (setup.recordTurn === false ? 0 : attempts.length) + (setup.blockedElsewhere ? 1 : 0);
			reviews.ledger.unknownRequests = setup.blockedElsewhere ? 1 : 0;
			reviews.ledger.unboundedAttempts = setup.blockedElsewhere ? 1 : 0;
			reviews.ledger.estimatedCost = setup.estimatedCost ?? 0;
			return created.id;
		}, context);
		return { conversation, reviewId };
	}

	const draftFrom = (
		host: Host,
		binding: Awaited<ReturnType<typeof adopt>>,
		{ conversation, reviewId }: Awaited<ReturnType<typeof runningTurn>>,
	) =>
		host.request({
			operation: "plan-draft",
			expectedRevision: 1,
			requestId: `d-${String(conversation)}`,
			terms: plan(binding, allowance({ maxEstimatedCost: 1 }), "From review"),
			savedBy: "bob",
			fromReview: reviewId,
			reviewConversation: conversation,
		});

	it("allows the draft from the last charged request, at exactly the per-review and spend caps", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance({ maxEstimatedCost: 1 }));
		const turn = await runningTurn(host, { attempts: 2, estimatedCost: 1 });
		await expect(draftFrom(host, binding, turn)).resolves.toBeDefined();
	});

	it("refuses above the per-review cap", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance({ maxEstimatedCost: 1 }));
		const turn = await runningTurn(host, { attempts: 3 });
		await expect(draftFrom(host, binding, turn)).rejects.toMatchObject({ code: "stale-revision" });
	});

	it("refuses when estimated plus reserved spend settled above the cap", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance({ maxEstimatedCost: 1 }));
		const turn = await runningTurn(host, { estimatedCost: 1.5 });
		await expect(draftFrom(host, binding, turn)).rejects.toMatchObject({ code: "stale-revision" });
	});

	it("refuses while any review request has an unknown outcome", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance({ maxEstimatedCost: 1 }));
		const turn = await runningTurn(host, { blockedElsewhere: true });
		await expect(draftFrom(host, binding, turn)).rejects.toMatchObject({ code: "stale-revision" });
	});

	it("fails closed for a review session whose turn record is missing or evicted", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance({ maxEstimatedCost: 1 }));
		const turn = await runningTurn(host, { recordTurn: false });
		await expect(draftFrom(host, binding, turn)).rejects.toMatchObject({ code: "stale-revision" });
	});

	it("treats a conversation without a review session as an ordinary Bob draft", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance({ maxEstimatedCost: 1 }));
		const conversation = await host.harness.commit(
			async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
			context,
		);
		const saved = await host.request({
			operation: "plan-draft",
			expectedRevision: 1,
			requestId: "chat-draft",
			terms: plan(binding, allowance(), "From chat"),
			savedBy: "bob",
			fromReview: null,
			reviewConversation: conversation,
		});
		expect(saved.plan!.draft).toMatchObject({ savedBy: "bob", fromReview: null });
	});
});

describe("review drafts and turns after authority changes, restart and inhibition", () => {
	it("a draft from a review turn is refused once protected authority no longer agrees the head", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance({ maxEstimatedCost: 1 }));
		const noted = await host.request({ operation: "review-now", requestId: "note" });
		const reviewId = noted.plan!.reviews[0]!.reviewId;
		const conversation = await host.harness.commit(async (tx) => {
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			(await tx.doc(ProviderDoc, created.id)).sessionId = `${REVIEW_PROVIDER_PREFIX}one`;
			(await tx.doc(MissionReviewDoc)).turns.push({
				key: "1:cadence:w1",
				planRevision: 1,
				trigger: { kind: "cadence", key: "1:cadence:w1", subject: "w1" },
				reviewId,
				conversation: created.id,
				providerSession: `${REVIEW_PROVIDER_PREFIX}one`,
				attempts: [],
				state: { status: "running" },
				at: 1,
			});
			return created.id;
		}, context);
		// Protected authority changes after the turn started: the plan receipt no longer agrees the head.
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, { ...authority, planApprovals: [] });
		await expect(
			host.request({
				operation: "plan-draft",
				expectedRevision: 1,
				requestId: "after-revoke",
				terms: plan(binding, allowance({ maxEstimatedCost: 1 }), "After"),
				savedBy: "bob",
				fromReview: reviewId,
				reviewConversation: conversation,
			}),
		).rejects.toMatchObject({ code: "stale-revision" });
	});

	it("a running turn whose task ended is reconciled on start, so its unknown request shows as the blocker", async () => {
		let host = await launch();
		await adopt(host, allowance());
		await host.owner.endParkedReview(context);
		await host.harness.commit(async (tx) => {
			const reviews = await tx.doc(MissionReviewDoc);
			reviews.turns.push({
				key: "1:cadence:w1",
				planRevision: 1,
				trigger: { kind: "cadence", key: "1:cadence:w1", subject: "w1" },
				reviewId: null,
				conversation: null,
				providerSession: null,
				attempts: [{ attemptId: "1:cadence:w1:a1", ceiling: null, status: "reserved" }],
				state: { status: "running" },
				at: 1,
			});
			reviews.ledger.requests = 1;
			reviews.ledger.unknownRequests = 1;
			reviews.ledger.unboundedAttempts = 1;
			reviews.task = null;
		}, context);
		host = await reopen(host, []);
		const view = await host.request({ operation: "status" });
		expect(view.plan!.blocker).toMatchObject({ key: "1:cadence:w1", state: "blocked", reason: "unknown_request_outcome" });
	});

	it("ending a parked review task while inhibited never runs the scheduler", async () => {
		const host = await launch();
		await adopt(host, allowance());
		await host.owner.initialize(context, "inhibited");
		const wait = vi.spyOn(host.harness, "waitForTask");
		const abort = vi.spyOn(host.harness, "abortTask");
		await host.owner.endParkedReview(context);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(wait).not.toHaveBeenCalled();
	});

	it("a plan without a review allowance never creates a review document", async () => {
		const host = await launch();
		await adopt(host, null);
		await host.request({ operation: "status" });
		expect(await host.harness.snapshot(MissionReviewDoc, context)).toBeUndefined();
	});
});

describe("review drafts and turns under a hold, a missing task and unbounded spend", () => {
	it("a review draft whose write is queued after a hold commits is refused as held", async () => {
		const host = await launch();
		const binding = await adopt(host, allowance());
		const noted = await host.request({ operation: "review-now", requestId: "note" });
		const reviewId = noted.plan!.reviews[0]!.reviewId;
		const conversation = await host.harness.commit(async (tx) => {
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			(await tx.doc(ProviderDoc, created.id)).sessionId = `${REVIEW_PROVIDER_PREFIX}held`;
			(await tx.doc(MissionReviewDoc)).turns.push({
				key: "1:cadence:w1",
				planRevision: 1,
				trigger: { kind: "cadence", key: "1:cadence:w1", subject: "w1" },
				reviewId,
				conversation: created.id,
				providerSession: `${REVIEW_PROVIDER_PREFIX}held`,
				attempts: [],
				state: { status: "running" },
				at: 1,
			});
			return created.id;
		}, context);
		// The tool was admitted before the hold; its write commit is queued behind the hold's commit.
		const hold = host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "op-1" };
		}, context);
		const write = host.request({
			operation: "plan-draft",
			expectedRevision: 1,
			requestId: "queued",
			terms: plan(binding, allowance(), "Queued"),
			savedBy: "bob",
			fromReview: reviewId,
			reviewConversation: conversation,
		});
		await hold;
		await expect(write).rejects.toMatchObject({ code: "held" });
		expect((await readMissionPlan(host.harness, context))!.draft).toBeNull();
	});

	it("a pointer to a task that no longer exists neither hides a running turn nor blocks rearming", async () => {
		let host = await launch();
		await adopt(host, allowance());
		await host.owner.endParkedReview(context);
		await host.harness.commit(async (tx) => {
			const reviews = await tx.doc(MissionReviewDoc);
			reviews.turns.push({
				key: "1:cadence:w1",
				planRevision: 1,
				trigger: { kind: "cadence", key: "1:cadence:w1", subject: "w1" },
				reviewId: null,
				conversation: null,
				providerSession: null,
				attempts: [{ attemptId: "1:cadence:w1:a1", ceiling: 0.1, status: "reserved" }],
				state: { status: "running" },
				at: 1,
			});
			reviews.ledger.requests = 1;
			reviews.ledger.unknownRequests = 1;
			reviews.ledger.reservedCost = 0.1;
			reviews.task = 987_654 as never;
		}, context);
		host = await reopen(host, []);
		const reviews = (await readReviewState(host.harness, context))!;
		expect(reviews.turns[0]!.state).toEqual({ status: "blocked", reason: "unknown_request_outcome" });
		expect(reviews.task).not.toBe(987_654);
		expect(reviews.task).not.toBeNull();
		expect((await host.request({ operation: "status" })).plan!.blocker).toMatchObject({ key: "1:cadence:w1" });
	});

	it("an earlier unbounded request skips a capped review as budget before its key is consumed", async () => {
		let host = await launch();
		await adopt(host, allowance({ maxEstimatedCost: 1 }));
		await host.harness.commit(async (tx) => {
			const reviews = await tx.doc(MissionReviewDoc);
			reviews.turns.push({
				key: "0:cadence:w9",
				planRevision: 1,
				trigger: { kind: "cadence", key: "0:cadence:w9", subject: "w9" },
				reviewId: null,
				conversation: null,
				providerSession: null,
				attempts: [{ attemptId: "0:cadence:w9:a1", ceiling: null, status: "unpriced" }],
				state: { status: "done", draftRevision: null },
				at: 1,
			});
			reviews.ledger.requests = 1;
			reviews.ledger.unpricedResponses = 1;
			reviews.ledger.unboundedAttempts = 1;
		}, context);
		now = 11_000;
		host = await reopen(host, [summary()]);
		await until(host, async () => (await turnsOf(host)).some((turn) => turn.key === "1:cadence:w1"));
		expect((await turnsOf(host)).find((turn) => turn.key === "1:cadence:w1")!.state).toEqual({
			status: "skipped",
			reason: "budget",
		});
		expect((await readMissionPlan(host.harness, context))!.reviewKeys).not.toContain("1:cadence:w1");
		expect(host.faux.state.callCount).toBe(0);
	});
});

describe("rollback answer", () => {
	it("reports a live review task as blocking a switch to a release without it", async () => {
		const host = await launch();
		await adopt(host, allowance());
		expect((await host.request({ operation: "status" })).loopRollback).toBe("live-loop");
		await host.owner.endParkedReview(context);
		expect((await host.request({ operation: "status" })).loopRollback).toBe("no-live-loop");
	});
});
