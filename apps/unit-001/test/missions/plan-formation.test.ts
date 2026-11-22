// #72: Mission plans form through the owner on real SQLite: draft, propose, exact agreement, plan-bound open and reviews.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionAdmission } from "../../src/missions/admission.ts";
import { readMissionAuthority, writeMissionAuthority } from "../../src/missions/authority.ts";
import type { MissionApproval, MissionRequest, PurposeTerms } from "../../src/missions/contract.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { missionController } from "../../src/missions/controller.ts";
import { MissionOwner } from "../../src/missions/owner.ts";
import { planDigest } from "../../src/missions/plan-authority.ts";
import { MissionPlanIssued, PlanFormation, withPlanReceipt } from "../../src/missions/plan-formation.ts";
import { MissionPlanDoc, readMissionPlan } from "../../src/missions/plan-state.ts";
import type { PlanTerms } from "../../src/missions/plan-terms.ts";
import { readMissionPurpose } from "../../src/missions/purpose.ts";
import { initialLoop, type LoopState } from "../../src/missions/purpose-loop.ts";
import { MissionRefusal } from "../../src/missions/refusal.ts";
import { MissionFoundation } from "../../src/missions/state.ts";
import { parseMissionView } from "../../src/missions/wire.ts";
import { planned, runnable } from "./fixtures/plan.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];
const model = { provider: "faux", modelId: "faux-1" };
type Response = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-plan-"));
	now = 1_000;
});
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const writes = (content: string): Response =>
	fauxAssistantMessage(fauxToolCall("unit_work_write", { content }), { stopReason: "toolUse" });
const purpose = (contents: string[]): PurposeTerms => ({
	purpose: "Keep the fixture reports current",
	scope: "The fixture workspace",
	reviewEveryMs: 1_000,
	works: contents.map((content, index) => ({
		kind: "artifact-digest",
		path: `reports/${index}.txt`,
		sha256: sha(content),
		instructions: "Write the agreed text.",
		maxCycles: 2,
		maxRequests: 2,
		maxRetries: 0,
		maxConsecutiveNoProgress: 2,
	})),
	lifetime: { maxWorkItems: 4, maxCycles: 6, maxRequests: 6, deadlineAt: 60_000 },
});

async function launch(responses: Response[] = []) {
	const location = { kind: "developer-local" as const, directory, session: "default" };
	const admission = new MissionAdmission(location, () => now);
	const engine = missionController(admission, directory);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(MissionFoundation);
	registry.install(engine.extension);
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
	const owner = new MissionOwner(harness, control, location, registry, admission, engine, model, directory, () => now);
	await owner.initialize(context, "permitted");
	const request = (input: MissionRequest) => owner.handle(input, context);
	return { harness, faux, request, location };
}
type Host = Awaited<ReturnType<typeof launch>>;

async function reopen(host: Host, responses: Response[] = []) {
	await host.harness.close(context);
	opened.splice(opened.indexOf(host.harness), 1);
	const next = await launch(responses);
	next.harness.resume();
	return next;
}

/** Configures the creator, agrees purpose revision 1 for the given contents and returns its binding. */
async function withPurpose(host: Host, contents: string[]) {
	await host.request({
		operation: "configure-local",
		creator: { kind: "human", id: "creator", uid: process.getuid?.() ?? null },
		ceiling: {
			allowedTools: ["write"],
			maxCycles: 10,
			maxRequests: 20,
			maxRetries: 2,
			maxConsecutiveNoProgress: 10,
			maxDurationMs: 100_000,
		},
		purposeCeiling: {
			capabilities: ["artifact-digest"],
			paths: ["reports/"],
			maxWorkItems: 8,
			maxCycles: 10,
			maxRequests: 10,
			maxRetries: 2,
			maxConsecutiveNoProgress: 4,
			maxDurationMs: 100_000,
		},
	});
	const proposed = await host.request({
		operation: "purpose-propose",
		expectedRevision: 0,
		requestId: "purpose-propose",
		terms: purpose(contents),
	});
	await host.request({
		operation: "purpose-approve-local",
		revision: proposed.purpose!.proposed!.revision,
		digest: proposed.purpose!.proposed!.digest,
		requestId: "purpose-approve",
	});
	const agreement = (await loopState(host)).agreements[0]!;
	return { missionId: agreement.missionId, purposeRevision: agreement.revision, purposeDigest: agreement.digest };
}

function plan(binding: { missionId: string; purposeRevision: number; purposeDigest: string }, scope = "The workspace"): PlanTerms {
	return {
		overall: { purpose: "Keep the reports current", scope, askFirst: [], reviewEveryMs: 10_000 },
		strategics: [{ id: "reports", title: "Reports", intent: "Fresh reports", signals: [], priority: "high" }],
		tacticals: [runnable({ binding }), planned()],
	};
}

async function draft(host: Host, terms: PlanTerms, id: string, savedBy: "bob" | "owner" = "owner") {
	const view = await host.request({ operation: "status" });
	const expectedRevision = view.plan?.draft?.revision ?? view.plan?.head?.revision ?? 0;
	return host.request({ operation: "plan-draft", expectedRevision, requestId: id, terms, savedBy, fromReview: null });
}

/** Drafts, proposes and agrees `terms`; returns the agreed head digest. */
async function agree(host: Host, terms: PlanTerms, id: string): Promise<string> {
	const drafted = await draft(host, terms, `draft-${id}`);
	const proposed = await host.request({
		operation: "plan-propose",
		expectedRevision: drafted.plan!.draft!.revision,
		requestId: `propose-${id}`,
	});
	const { revision, digest } = proposed.plan!.draft!;
	const agreed = await host.request({ operation: "plan-agree", revision, digest: digest!, requestId: `agree-${id}` });
	expect(agreed.plan!.head).toMatchObject({ revision, digest });
	return digest!;
}

async function operate(host: Host, action: "open" | "suspend" | "close", id: string) {
	const loop = await loopState(host);
	return host.request({ operation: "operate-local", action, expectedOperationRevision: loop.operation.revision, requestId: id });
}

async function loopState(host: Host): Promise<LoopState> {
	return (await readMissionPurpose(host.harness, context))?.loop ?? initialLoop();
}

async function until(host: Host, predicate: (loop: LoopState) => boolean): Promise<LoopState> {
	for (let i = 0; i < 400; i++) {
		const loop = await loopState(host);
		if (predicate(loop)) return loop;
		await setTimeout(5);
	}
	throw new Error(`Loop did not settle: ${JSON.stringify((await loopState(host)).operation)}`);
}

const blockedBy = (reason: string) => (loop: LoopState) =>
	loop.operation.activity?.kind === "blocked" && loop.operation.activity.reason === reason;
const settled = (loop: LoopState) => loop.operation.activity?.kind === "waiting" || loop.operation.activity?.kind === "idle";

describe("drafting and proposing a plan", () => {
	it("saves drafts that grant nothing and refuses stale revisions with a code", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const view = await draft(host, plan(binding), "d1");
		expect(view.plan!.draft).toMatchObject({ revision: 1, status: "editing", savedBy: "owner", missing: [] });
		expect(view.plan!.head).toBeNull();
		expect((await readMissionAuthority(host.location))!.planApprovals).toBeUndefined();
		await expect(
			host.request({ operation: "plan-draft", expectedRevision: 0, requestId: "d2", terms: plan(binding), savedBy: "owner", fromReview: null }),
		).rejects.toMatchObject({ code: "stale-revision" });
		// The same request ID is the same draft; with other terms it conflicts.
		await host.request({ operation: "plan-draft", expectedRevision: 0, requestId: "d1", terms: plan(binding), savedBy: "owner", fromReview: null });
		await expect(
			host.request({ operation: "plan-draft", expectedRevision: 1, requestId: "d1", terms: plan(binding, "Other"), savedBy: "owner", fromReview: null }),
		).rejects.toMatchObject({ code: "conflicting-request" });
	});

	it("never lets Bob replace a draft the owner saved", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		await draft(host, plan(binding), "owner-1");
		await expect(draft(host, plan(binding, "Bob's"), "bob-1", "bob")).rejects.toMatchObject({ code: "owner-draft" });
	});

	it("refuses to propose incomplete terms, orphans and a binding that is not an exact agreed purpose", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const incomplete = { ...plan(binding), overall: { ...plan(binding).overall, purpose: "" } };
		let view = await draft(host, incomplete, "d1");
		expect(view.plan!.draft!.missing).toEqual(["purpose"]);
		await expect(host.request({ operation: "plan-propose", expectedRevision: 1, requestId: "p1" })).rejects.toMatchObject({
			code: "incomplete",
		});
		view = await draft(host, plan({ ...binding, purposeDigest: "c".repeat(64) }), "d2");
		await expect(
			host.request({ operation: "plan-propose", expectedRevision: view.plan!.draft!.revision, requestId: "p2" }),
		).rejects.toMatchObject({ code: "outside-authority" });
		view = await draft(host, { ...plan(binding), tacticals: [planned({ strategic: "gone" })] }, "d3");
		await expect(
			host.request({ operation: "plan-propose", expectedRevision: view.plan!.draft!.revision, requestId: "p3" }),
		).rejects.toMatchObject({ code: "outside-authority" });
	});
});

describe("agreeing a plan", () => {
	it("records the exact revision once, replays by request ID and keeps the predecessor readable", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const first = await agree(host, plan(binding), "1");
		const authority = (await readMissionAuthority(host.location))!;
		expect(authority.planApprovals).toHaveLength(1);
		expect(authority.planRequests).toMatchObject([{ requestId: "agree-1", revision: 1, digest: first }]);
		// A replay with the same ID mints nothing; another digest under it conflicts.
		await host.request({ operation: "plan-agree", revision: 1, digest: first, requestId: "agree-1" });
		expect((await readMissionAuthority(host.location))!.planRequests).toHaveLength(1);
		await expect(
			host.request({ operation: "plan-agree", revision: 1, digest: "e".repeat(64), requestId: "agree-1" }),
		).rejects.toMatchObject({ code: "conflicting-request" });
		const second = await agree(host, plan(binding, "Wider"), "2");
		const view = parseMissionView(JSON.parse(JSON.stringify(await host.request({ operation: "status" }))));
		expect(view.plan).toMatchObject({
			adopted: true,
			head: { digest: second, previousDigest: first },
			previous: { digest: first, terms: { overall: { scope: "The workspace" } } },
			history: [{ digest: second }, { digest: first }],
			gate: { state: "closed", reason: "reopen-needed" },
		});
	});

	it("refuses a proposal written against a head that has since moved", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const drafted = await draft(host, plan(binding), "d1");
		const proposed = await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" });
		// Another receipt lands in protected authority after the proposal was frozen.
		const authority = (await readMissionAuthority(host.location))!;
		const other: MissionApproval = {
			receiptId: "other",
			requestId: "other",
			installationId: null,
			session: "default",
			missionId: binding.missionId,
			revision: 9,
			digest: "f".repeat(64),
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: now,
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: authority.creator.uid },
		};
		await writeMissionAuthority(host.location, withPlanReceipt(authority, undefined, other));
		const { revision, digest } = proposed.plan!.draft!;
		await expect(host.request({ operation: "plan-agree", revision, digest: digest!, requestId: "a1" })).rejects.toMatchObject({
			code: "stale-digest",
		});
	});

	it("refuses on a managed host with the terminal command, writing nothing", async () => {
		const host = await launch();
		const managed = new PlanFormation(host.harness, { kind: "managed", directory, session: "default" } as never, () => now);
		const refusal = await managed
			.agreeLocal({ operation: "plan-agree", revision: 1, digest: "a".repeat(64), requestId: "a1" }, context)
			.catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(MissionRefusal);
		expect(refusal).toMatchObject({ code: "managed-requires-gateway" });
		expect((refusal as Error).message).toContain("sudo unit-001 mission plan approve --revision 1");
	});
});

describe("the plan gate on a running purpose", () => {
	it("needs suspend, agreement and a fresh plan-bound open; an older open never arms the new head", async () => {
		let host = await launch([writes("alpha")]);
		const binding = await withPurpose(host, ["alpha", "beta"]);
		const first = await agree(host, plan(binding), "1");
		await operate(host, "open", "open-1");
		expect((await readMissionAuthority(host.location))!.operationIntent!.planDigest).toBe(first);
		await until(host, settled);
		expect(host.faux.state.callCount).toBe(1);
		// Agreement while open is refused before any receipt.
		const drafted = await draft(host, plan(binding, "Wider"), "d2");
		const proposed = await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p2" });
		const { revision, digest } = proposed.plan!.draft!;
		await expect(host.request({ operation: "plan-agree", revision, digest: digest!, requestId: "a2" })).rejects.toMatchObject({
			code: "execution-active",
		});
		await operate(host, "suspend", "suspend-1");
		await host.request({ operation: "plan-agree", revision, digest: digest!, requestId: "a2" });
		// Replaying the old open cannot arm the new head.
		await expect(host.request({ operation: "reconcile-operation", requestId: "open-1" })).rejects.toThrow();
		expect((await loopState(host)).operation.state.status).toBe("suspended");
		now = 3_000;
		host = await reopen(host, [writes("beta")]);
		await operate(host, "open", "open-2");
		expect((await readMissionAuthority(host.location))!.operationIntent!.planDigest).toBe(digest);
		const loop = await until(host, (state) => state.operation.activity?.kind === "idle");
		expect(loop.runs.map((run) => run.state.status)).toEqual(["verified", "verified"]);
	});

	it("closes admission at once when a receipt for a newer plan is published while open", async () => {
		const host = await launch([writes("alpha")]);
		const binding = await withPurpose(host, ["alpha", "beta"]);
		await agree(host, plan(binding), "1");
		await operate(host, "open", "open-1");
		await until(host, settled);
		// As a managed administrator command would: a newer receipt and binding, unrecorded by the owner.
		const authority = (await readMissionAuthority(host.location))!;
		const saved = (await readMissionPlan(host.harness, context))!;
		const terms = plan(binding, "Wider");
		const receipt: MissionApproval = {
			...authority.planApprovals!.at(-1)!,
			receiptId: "newer",
			requestId: "newer",
			revision: 9,
			digest: planDigest(terms, binding.missionId, 9, saved.agreed.at(-1)!.digest, authority),
		};
		await writeMissionAuthority(host.location, withPlanReceipt(authority, authority.planApprovals!.at(-1), receipt));
		now = 2_000;
		host.harness.resume();
		await until(host, blockedBy("plan"));
		expect(host.faux.state.callCount).toBe(1);
	});

	it("closes legacy admission in the crash window between the first receipt and its record", async () => {
		const host = await launch([writes("alpha")]);
		const binding = await withPurpose(host, ["alpha", "beta"]);
		await operate(host, "open", "open-1");
		await until(host, settled);
		const drafted = await draft(host, plan(binding), "d1");
		await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" });
		const saved = (await readMissionPlan(host.harness, context))!;
		const authority = (await readMissionAuthority(host.location))!;
		const receipt: MissionApproval = {
			receiptId: "first",
			requestId: "first",
			installationId: null,
			session: "default",
			missionId: saved.missionId!,
			revision: saved.draft!.revision,
			digest: saved.draft!.digest!,
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: now,
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: authority.creator.uid },
		};
		// Published, then the owner "crashes" before recording it.
		await writeMissionAuthority(host.location, withPlanReceipt(authority, undefined, receipt));
		now = 2_000;
		host.harness.resume();
		await until(host, blockedBy("plan"));
		expect(host.faux.state.callCount).toBe(1);
		expect((await host.request({ operation: "status" })).plan!.gate).toEqual({ state: "closed", reason: "head-missing" });
	});

	it("leaves an unadopted install exactly as before", async () => {
		const host = await launch([writes("alpha")]);
		await withPurpose(host, ["alpha"]);
		await operate(host, "open", "open-1");
		const loop = await until(host, (state) => state.operation.activity?.kind === "idle");
		expect(loop.runs[0]!.state.status).toBe("verified");
		expect((await readMissionAuthority(host.location))!.operationIntent!.planDigest).toBeUndefined();
		expect((await host.request({ operation: "status" })).plan!.gate).toEqual({ state: "not-adopted", reason: null });
	});
});

describe("codex gate review holds", () => {
	it("records the exact prepared revision R when the owner moved on to R+1 before the terminal published", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const drafted = await draft(host, plan(binding), "d1");
		const proposed = await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" });
		const r = proposed.plan!.draft!;
		// The terminal prepares R and receives exactly R as the draft.
		const prepared = await host.request({ operation: "prepare-plan", revision: r.revision, digest: r.digest!, requestId: "prep-1" });
		expect(prepared.plan!.draft).toMatchObject({ revision: r.revision, digest: r.digest, status: "proposed" });
		// Meanwhile the owner drafts and even proposes R+1; neither revokes R.
		const edited = await draft(host, plan(binding, "Other"), "d2");
		await host.request({ operation: "plan-propose", expectedRevision: edited.plan!.draft!.revision, requestId: "p2" });
		expect((await host.request({ operation: "prepare-plan", revision: r.revision, digest: r.digest!, requestId: "prep-1" })).plan!.draft)
			.toMatchObject({ revision: r.revision, terms: { overall: { scope: "The workspace" } } });
		// The terminal publishes R, as the managed command does, under the head compare-and-swap.
		const authority = (await readMissionAuthority(host.location))!;
		const receipt: MissionApproval = {
			receiptId: "issued",
			requestId: "issued",
			installationId: null,
			session: "default",
			missionId: binding.missionId,
			revision: r.revision,
			digest: r.digest!,
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: now,
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: authority.creator.uid },
		};
		await writeMissionAuthority(host.location, withPlanReceipt(authority, undefined, receipt));
		const recorded = await host.request({ operation: "reconcile-plan", receiptId: "issued" });
		expect(recorded.plan!.head).toMatchObject({ revision: r.revision, digest: r.digest, terms: { overall: { scope: "The workspace" } } });
		// R+1 stays an editing draft on the old base; nothing rebased it.
		expect(recorded.plan!.draft).toMatchObject({ revision: edited.plan!.draft!.revision, status: "editing", baseRevision: 0, digest: null });
	});

	it("reports a known-published receipt that is not recorded yet as issued, with its receipt ID", async () => {
		const host = await launch([writes("alpha")]);
		const binding = await withPurpose(host, ["alpha", "beta"]);
		await operate(host, "open", "open-1");
		await until(host, settled);
		const drafted = await draft(host, plan(binding), "d1");
		const r = (await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" })).plan!.draft!;
		const authority = (await readMissionAuthority(host.location))!;
		const receipt: MissionApproval = {
			receiptId: "issued",
			requestId: "agree-1",
			installationId: null,
			session: "default",
			missionId: binding.missionId,
			revision: r.revision,
			digest: r.digest!,
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: now,
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: authority.creator.uid },
		};
		await writeMissionAuthority(host.location, withPlanReceipt(authority, undefined, receipt));
		// A durable replay of the same request ID: recording waits while operation is open, so it is issued, not refused.
		const error = await host
			.request({ operation: "plan-agree", revision: r.revision, digest: r.digest!, requestId: "agree-1" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MissionPlanIssued);
		expect(error).not.toBeInstanceOf(MissionRefusal);
		expect(error).toMatchObject({ receiptId: "issued" });
	});

	it("bounds prepared request IDs before writing, so the stored plan stays valid", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const drafted = await draft(host, plan(binding), "d1");
		const r = (await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" })).plan!.draft!;
		for (let i = 1; i <= 8; i++)
			await host.request({ operation: "prepare-plan", revision: r.revision, digest: r.digest!, requestId: `prep-${i}` });
		await expect(
			host.request({ operation: "prepare-plan", revision: r.revision, digest: r.digest!, requestId: "prep-9" }),
		).rejects.toMatchObject({ code: "plan-limit" });
		const status = await host.request({ operation: "prepare-plan", revision: r.revision, digest: r.digest!, requestId: "prep-1" });
		expect(status.planError).toBeNull();
		expect((await readMissionPlan(host.harness, context))!.prepared).toHaveLength(8);
	});

	it("refuses to propose a draft written against an older head until it is saved again", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const drafted = await draft(host, plan(binding), "d1");
		const r = (await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" })).plan!.draft!;
		const next = await draft(host, plan(binding, "Next"), "d2");
		await host.request({ operation: "plan-agree", revision: r.revision, digest: r.digest!, requestId: "a1" });
		// The newer draft is still on base 0 while revision R is now the head.
		await expect(
			host.request({ operation: "plan-propose", expectedRevision: next.plan!.draft!.revision, requestId: "p2" }),
		).rejects.toMatchObject({ code: "stale-revision" });
		const saved = await draft(host, plan(binding, "Next"), "d3");
		expect(saved.plan!.draft!.baseRevision).toBe(r.revision);
		const proposed = await host.request({ operation: "plan-propose", expectedRevision: saved.plan!.draft!.revision, requestId: "p3" });
		expect(proposed.plan!.draft).toMatchObject({ status: "proposed", baseRevision: r.revision });
	});

	it("prepares idempotently by request ID and refuses a snapshot that is not eligible", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const drafted = await draft(host, plan(binding), "d1");
		const r = (await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" })).plan!.draft!;
		await host.request({ operation: "prepare-plan", revision: r.revision, digest: r.digest!, requestId: "prep-1" });
		await expect(
			host.request({ operation: "prepare-plan", revision: r.revision, digest: "e".repeat(64), requestId: "prep-1" }),
		).rejects.toMatchObject({ code: "conflicting-request" });
		await expect(
			host.request({ operation: "prepare-plan", revision: 99, digest: r.digest!, requestId: "prep-2" }),
		).rejects.toMatchObject({ code: "stale-revision" });
		expect((await readMissionPlan(host.harness, context))!.prepared).toHaveLength(1);
	});

	it("recovers proposal capacity after a creator authority rotation; older-epoch request records stay in the ledger", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		for (let i = 1; i <= 8; i++) {
			const drafted = await draft(host, plan(binding, `Scope ${i}`), `d${i}`);
			await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: `p${i}` });
		}
		const full = await draft(host, plan(binding, "Ninth"), "d9");
		await expect(
			host.request({ operation: "plan-propose", expectedRevision: full.plan!.draft!.revision, requestId: "p9" }),
		).rejects.toMatchObject({ code: "plan-limit" });
		const saved = (await readMissionPlan(host.harness, context))!;
		const authority = (await readMissionAuthority(host.location))!;
		const issued = saved.proposals[0]!;
		// A receipt for the oldest snapshot was published before the rotation: it can never be recorded under the new
		// authority, so its snapshot frees capacity, while its request record stays in the protected ledger.
		const rotated = {
			...authority,
			revision: authority.revision + 1,
			planRequests: [
				{ requestId: "old", receiptId: "old", missionId: binding.missionId, revision: issued.revision, digest: issued.digest, authorityRevision: authority.revision, issuedAt: now },
			],
		};
		await writeMissionAuthority(host.location, rotated);
		await host.request({ operation: "plan-propose", expectedRevision: full.plan!.draft!.revision, requestId: "p9" });
		const after = (await readMissionPlan(host.harness, context))!;
		expect(after.proposals.map((proposal) => proposal.revision)).toEqual([full.plan!.draft!.revision]);
		expect((await readMissionAuthority(host.location))!.planRequests).toMatchObject([{ requestId: "old" }]);
	});

	it("keeps the request ledger across a configure-local rotation, clears its receipts and closes the gate", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const first = await agree(host, plan(binding), "1");
		const before = (await readMissionAuthority(host.location))!;
		await host.request({ operation: "configure-local", creator: before.creator, ceiling: before.ceiling, purposeCeiling: before.purposeCeiling });
		const after = (await readMissionAuthority(host.location))!;
		expect(after.revision).toBe(before.revision + 1);
		expect(after.planRequests).toEqual(before.planRequests);
		expect(after.planApprovals).toBeUndefined();
		expect((await host.request({ operation: "status" })).plan!.gate.state).toBe("closed");
		// A replay of the old epoch's request ID is never reissued and never reported as issued-pending.
		const replay = await host
			.request({ operation: "plan-agree", revision: 1, digest: first, requestId: "agree-1" })
			.catch((caught: unknown) => caught);
		expect(replay).toBeInstanceOf(Error);
		expect(replay).not.toBeInstanceOf(MissionPlanIssued);
		expect(replay).not.toBeInstanceOf(MissionRefusal);
		expect((await readMissionAuthority(host.location))!.planRequests).toHaveLength(1);
	});

	it("refuses prepare and recording when any recorded revision lost its protected binding", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		await agree(host, plan(binding), "1");
		await agree(host, plan(binding, "Two"), "2");
		await agree(host, plan(binding, "Three"), "3");
		const drafted = await draft(host, plan(binding, "Four"), "d4");
		const r = (await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p4" })).plan!.draft!;
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, { ...authority, planRequests: authority.planRequests!.slice(1) });
		await expect(
			host.request({ operation: "prepare-plan", revision: r.revision, digest: r.digest!, requestId: "prep-1" }),
		).rejects.toMatchObject({ code: "unavailable" });
		// Even the idempotent answer for an already recorded receipt is withheld over a broken history.
		await expect(host.request({ operation: "reconcile-plan", receiptId: authority.planApprovals!.at(-1)!.receiptId })).rejects.toThrow(
			"history is unavailable",
		);
		expect((await host.request({ operation: "status" })).plan!.gate).toMatchObject({ state: "closed", reason: "receipt" });
		await expect(operate(host, "open", "open-1")).rejects.toThrow("history is unavailable");
		expect((await readMissionAuthority(host.location))!.operationIntent).toBeUndefined();
	});

	it("refuses a creator rotation while the latest protected plan receipt awaits recording", async () => {
		const host = await launch([writes("alpha")]);
		const binding = await withPurpose(host, ["alpha"]);
		await operate(host, "open", "open-1");
		await until(host, (state) => state.operation.activity?.kind === "idle");
		const drafted = await draft(host, plan(binding), "d1");
		const r = (await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p1" })).plan!.draft!;
		const authority = (await readMissionAuthority(host.location))!;
		const receipt: MissionApproval = {
			receiptId: "pending",
			requestId: "pending",
			installationId: null,
			session: "default",
			missionId: binding.missionId,
			revision: r.revision,
			digest: r.digest!,
			creator: authority.creator,
			authorityRevision: authority.revision,
			approvedAt: now,
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: authority.creator.uid },
		};
		await writeMissionAuthority(host.location, withPlanReceipt(authority, undefined, receipt));
		await expect(
			host.request({ operation: "configure-local", creator: authority.creator, ceiling: authority.ceiling, purposeCeiling: authority.purposeCeiling }),
		).rejects.toThrow("awaits recording");
		expect((await readMissionAuthority(host.location))!.revision).toBe(authority.revision);
	});

	it("keeps developer-local suspend and close available when the stored plan is malformed", async () => {
		const host = await launch([writes("alpha")]);
		await withPurpose(host, ["alpha", "beta"]);
		await operate(host, "open", "open-1");
		await until(host, settled);
		await host.harness.commit(async (tx) => {
			(await tx.doc(MissionPlanDoc)).agreed = [{ forged: true } as never];
		}, context);
		expect((await host.request({ operation: "status" })).planError).toBeTruthy();
		await operate(host, "suspend", "suspend-1");
		expect((await loopState(host)).operation.state.status).toBe("suspended");
		await expect(operate(host, "open", "open-2")).rejects.toThrow();
		await operate(host, "close", "close-1");
		expect((await loopState(host)).operation.state.status).toBe("closed");
	});

	it("refuses an open against a head the protected receipts no longer agree, before writing any intent", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		await agree(host, plan(binding), "1");
		const authority = (await readMissionAuthority(host.location))!;
		const saved = (await readMissionPlan(host.harness, context))!;
		const terms = plan(binding, "Wider");
		const newer: MissionApproval = {
			...authority.planApprovals!.at(-1)!,
			receiptId: "newer",
			requestId: "newer",
			revision: 9,
			digest: planDigest(terms, binding.missionId, 9, saved.agreed.at(-1)!.digest, authority),
		};
		await writeMissionAuthority(host.location, withPlanReceipt(authority, authority.planApprovals!.at(-1), newer));
		await expect(operate(host, "open", "open-1")).rejects.toThrow("does not agree the recorded plan");
		expect((await readMissionAuthority(host.location))!.operationIntent).toBeUndefined();
	});
});

describe("codex gate review holds, second round", () => {
	it("refuses mint and replay when an old revision's protected request binding was dropped", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		const first = await agree(host, plan(binding), "1");
		await agree(host, plan(binding, "Two"), "2");
		await agree(host, plan(binding, "Three"), "3");
		const authority = (await readMissionAuthority(host.location))!;
		// The retained tail still matches; only the oldest binding is gone.
		await writeMissionAuthority(host.location, { ...authority, planRequests: authority.planRequests!.slice(1) });
		await expect(
			host.request({ operation: "plan-agree", revision: 1, digest: first, requestId: "agree-1" }),
		).rejects.toMatchObject({ code: "unavailable" });
		const drafted = await draft(host, plan(binding, "Four"), "d4");
		const proposed = await host.request({ operation: "plan-propose", expectedRevision: drafted.plan!.draft!.revision, requestId: "p4" });
		const { revision, digest } = proposed.plan!.draft!;
		await expect(host.request({ operation: "plan-agree", revision, digest: digest!, requestId: "agree-4" })).rejects.toMatchObject({
			code: "unavailable",
		});
		expect((await readMissionAuthority(host.location))!.planRequests).toHaveLength(2);
	});

	it("refuses a draft from a review of an older plan revision", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		await agree(host, plan(binding), "1");
		const reviewed = await host.request({ operation: "review-now", requestId: "r1" });
		const reviewId = reviewed.plan!.reviews[0]!.reviewId;
		await agree(host, plan(binding, "Two"), "2");
		const view = await host.request({ operation: "status" });
		await expect(
			host.request({
				operation: "plan-draft",
				expectedRevision: view.plan!.head!.revision,
				requestId: "from-old",
				terms: plan(binding, "Three"),
				savedBy: "bob",
				fromReview: reviewId,
			}),
		).rejects.toMatchObject({ code: "stale-revision" });
	});
});

describe("reviews through the owner", () => {
	it("previews due reviews in status without storing, and stores one note per explicit request", async () => {
		const host = await launch();
		const binding = await withPurpose(host, ["alpha"]);
		await agree(host, plan(binding), "1");
		now = 20_000;
		const before = structuredClone(await host.harness.snapshot(MissionPlanDoc, context));
		const status = await host.request({ operation: "status" });
		expect(status.plan!.due.map((trigger) => trigger.key)).toEqual(["1:cadence:w1"]);
		expect(status.plan!.preview).toMatchObject({ key: "1:cadence:w1", outcome: "no-change" });
		expect(await host.harness.snapshot(MissionPlanDoc, context)).toEqual(before);
		const stored = await host.request({ operation: "review-now", requestId: "r1" });
		expect(stored.plan!.reviews).toHaveLength(1);
		expect(stored.plan!.due).toEqual([]);
		const again = await host.request({ operation: "review-now", requestId: "r1" });
		expect(again.plan!.reviews).toEqual(stored.plan!.reviews);
		const reviewId = stored.plan!.reviews[0]!.reviewId;
		// A draft from the review links it; dismissing afterwards keeps the drafted disposition.
		const drafted = await host.request({
			operation: "plan-draft",
			expectedRevision: 1,
			requestId: "from-review",
			terms: plan(binding, "Narrower"),
			savedBy: "bob",
			fromReview: reviewId,
		});
		expect(drafted.plan!.draft).toMatchObject({ savedBy: "bob", fromReview: reviewId });
		await host.request({ operation: "review-dismiss", reviewId, requestId: "dismiss-1" });
		const view = await host.request({ operation: "status" });
		expect(view.plan!.reviews[0]!.disposition).toMatchObject({ kind: "drafted", draftRevision: drafted.plan!.draft!.revision });
		expect(view.plan!.head!.terms.overall.scope).toBe("The workspace");
	});
});
