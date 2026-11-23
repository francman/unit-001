// #72: Continuous operation of one purpose across work items, waits and restarts on real SQLite with a faux provider.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceDoc } from "../../src/maintenance.ts";
import { MissionAdmission } from "../../src/missions/admission.ts";
import { releaseAttempt, reserveAttempt, settleAttempt } from "../../src/missions/allowance.ts";
import { readMissionAuthority, writeMissionAuthority } from "../../src/missions/authority.ts";
import type { ArtifactWorkTerms, MissionRequest, PurposeTerms } from "../../src/missions/contract.ts";
import { describeMission } from "../../src/missions/command.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { missionController, startMissionExecution } from "../../src/missions/controller.ts";
import { loopParkedForMaintenance, loopRollbackBlocker } from "../../src/missions/loop-drain.ts";
import { nextOperationAuthority } from "../../src/missions/operation.ts";
import { MissionOwner } from "../../src/missions/owner.ts";
import { MissionPurposeDoc, readMissionPurpose } from "../../src/missions/purpose.ts";
import { matchingPurposeApproval, purposeDigest } from "../../src/missions/purpose-authority.ts";
import { checkLoopState, initialLoop, type LoopRun, type LoopState } from "../../src/missions/purpose-loop.ts";
import { MissionFoundation } from "../../src/missions/state.ts";
import { parseMissionView } from "../../src/missions/wire.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];
const model = { provider: "faux", modelId: "faux-1" };
type Response = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-loop-"));
	now = 1_000;
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const work = (path: string, content: string, limits: Partial<ArtifactWorkTerms> = {}): ArtifactWorkTerms => ({
	kind: "artifact-digest",
	path,
	sha256: sha(content),
	instructions: `Write the agreed text for ${path}.`,
	maxCycles: 2,
	maxRequests: 2,
	maxRetries: 0,
	maxConsecutiveNoProgress: 2,
	...limits,
});
const purpose = (works: PurposeTerms["works"], lifetime: Partial<PurposeTerms["lifetime"]> = {}): PurposeTerms => ({
	purpose: "Keep the fixture reports current",
	scope: "The fixture workspace",
	reviewEveryMs: 1_000,
	works,
	lifetime: { maxWorkItems: 4, maxCycles: 6, maxRequests: 6, deadlineAt: 60_000, ...lifetime },
});
const writes = (content: string): Response =>
	fauxAssistantMessage(fauxToolCall("unit_work_write", { content }), { stopReason: "toolUse" });

type LaunchOptions = {
	model?: typeof model | null;
	models?: (models: ReturnType<typeof createModels>) => void;
	faux?: Parameters<typeof fauxProvider>[0];
};

async function launch(responses: Response[] = [], options: LaunchOptions = {}) {
	const location = { kind: "developer-local" as const, directory, session: "default" };
	const admission = new MissionAdmission(location, () => now);
	const engine = missionController(admission, directory);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(MissionFoundation);
	registry.install(engine.extension);
	const faux = fauxProvider(options.faux);
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	options.models?.(models);
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
	const chosen = options.model === undefined ? model : options.model;
	const owner = new MissionOwner(harness, control, location, registry, admission, engine, chosen, directory, () => now);
	await owner.initialize(context, "permitted");
	const request = (input: MissionRequest) => owner.handle(input, context);
	return { harness, admission, engine, registry, faux, owner, request, location };
}
type Host = Awaited<ReturnType<typeof launch>>;

/** Closes and reopens the owner on the same file, then permits scheduling as the agent does after startup. */
async function reopen(host: Host, responses: Response[] = [], options: LaunchOptions = {}) {
	await host.harness.close(context);
	opened.splice(opened.indexOf(host.harness), 1);
	const next = await launch(responses, options);
	next.harness.resume();
	return next;
}

async function configure(host: Host, ceiling: { maxEstimatedCost?: number } = {}) {
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
			...ceiling,
		},
	});
}

async function approve(host: Host, terms: PurposeTerms, id = "1") {
	const loop = await state(host);
	const proposed = await host.request({
		operation: "purpose-propose",
		expectedRevision: loop.draft?.revision ?? loop.agreements.at(-1)?.revision ?? 0,
		requestId: `propose-${id}`,
		terms,
	});
	await host.request({
		operation: "purpose-approve-local",
		revision: proposed.purpose!.proposed!.revision,
		digest: proposed.purpose!.proposed!.digest,
		requestId: `approve-${id}`,
	});
}

async function operate(host: Host, action: "open" | "suspend" | "close", id: string) {
	const loop = await state(host);
	return host.request({
		operation: "operate-local",
		action,
		expectedOperationRevision: loop.operation.revision,
		requestId: id,
	});
}

async function state(host: Host): Promise<LoopState> {
	return (await readMissionPurpose(host.harness, context))?.loop ?? initialLoop();
}

/** Lets scheduled work run until the predicate holds on the stored loop. */
async function until(host: Host, predicate: (loop: LoopState) => boolean): Promise<LoopState> {
	for (let i = 0; i < 400; i++) {
		const loop = await state(host);
		if (predicate(loop)) return loop;
		await setTimeout(5);
	}
	throw new Error(`Loop did not settle: ${JSON.stringify((await state(host)).operation)}`);
}

const waiting = (loop: LoopState) => loop.operation.activity?.kind === "waiting";
const idle = (loop: LoopState) => loop.operation.activity?.kind === "idle";
const blockedBy = (reason: string) => (loop: LoopState) =>
	loop.operation.activity?.kind === "blocked" && loop.operation.activity.reason === reason;
const content = (path: string) => readFile(join(directory, path), "utf8");

/** A faux reply that never answers on its own: it records that it started and fails only when aborted. */
function hanging(started: () => void, effect?: () => Promise<void>): Response {
	return async (_input, options) => {
		await effect?.();
		started();
		return new Promise((_resolve, reject) =>
			options?.signal?.addEventListener("abort", () => reject(new Error("socket hang up")), { once: true }),
		);
	};
}

function latch() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, opened };
}

describe("one purpose across two work items", () => {
	it("runs A, persists the wait across restart, then runs B under the same purpose and lifetime ledger", async () => {
		const A = work("reports/a.txt", "alpha");
		const B = work("reports/b.txt", "beta");
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([A, B]));
		expect((await state(host)).operation.state.status).toBe("closed");
		await operate(host, "open", "open-1");
		let loop = await until(host, waiting);
		expect(await content("reports/a.txt")).toBe("alpha");
		expect(loop.runs).toHaveLength(1);
		expect(loop.runs[0]).toMatchObject({ workId: "p1-w1", state: { status: "verified" }, settlement: "settled" });
		expect(loop.operation.activity).toEqual({ kind: "waiting", reason: "next_observation", until: 2_000 });
		expect(host.faux.state.callCount).toBe(1);

		now = 1_500;
		host = await reopen(host, [writes("beta")]);
		await setTimeout(30);
		expect(host.faux.state.callCount).toBe(0);
		expect(await state(host)).toEqual(loop);
		await expect(content("reports/b.txt")).rejects.toThrow("ENOENT");

		now = 2_000;
		host = await reopen(host, [writes("beta")]);
		loop = await until(host, idle);
		expect(host.faux.state.callCount).toBe(1);
		expect(await content("reports/b.txt")).toBe("beta");
		expect(loop.runs.map((run) => [run.workId, run.state.status, run.settlement])).toEqual([
			["p1-w1", "verified", "settled"],
			["p1-w2", "verified", "settled"],
		]);
		expect(new Set(loop.runs.map((run) => run.runId)).size).toBe(2);
		expect(loop.agreements).toHaveLength(1);
		expect(loop.ledger).toMatchObject({ workItems: 2, cycles: 2, requests: 2, unknownRequests: 0 });
		expect(loop.operation).toMatchObject({ state: { status: "open" }, loop: null });
		expect((await host.harness.inspect(context)).tasks.filter((t) => t.record.kind === "unit.mission.loop")).toEqual([]);
		const view = await host.request({ operation: "status" });
		expect(view.purpose).toMatchObject({
			revision: 1,
			operation: "open",
			activity: "idle",
			works: [
				{ workId: "p1-w1", result: "verified" },
				{ workId: "p1-w2", result: "verified" },
			],
			used: { workItems: 2, requests: 2 },
			limits: { maxWorkItems: 4, maxRequests: 6 },
			rollback: "no-live-loop",
		});
	});

	it("approving a purpose opens nothing and an old one-shot receipt grants no loop", async () => {
		const host = await launch();
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await setTimeout(20);
		expect(host.faux.state.callCount).toBe(0);
		expect((await state(host)).operation).toMatchObject({ state: { status: "closed" }, loop: null });
		// An open intent that names a purpose revision without its receipt is refused at reconcile.
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, { ...authority, purposeApprovals: [] });
		await expect(operate(host, "open", "open-x")).rejects.toThrow("does not match");
		expect((await state(host)).operation.state.status).toBe("closed");
	});
});

describe("ambiguous provider failures and gated starts", () => {
	it("keeps a dispatched attempt that fails without a completed response reserved, across restart", async () => {
		let host = await launch([fauxAssistantMessage([], { stopReason: "error", errorMessage: "socket hang up" })]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		let loop = await until(host, blockedBy("unsettled_effects"));
		expect(loop.runs[0].attempts).toMatchObject([{ status: "reserved" }]);
		expect(loop.ledger).toMatchObject({ requests: 1, unknownRequests: 1 });
		host = await reopen(host, [writes("alpha")]);
		await setTimeout(30);
		loop = await state(host);
		expect(loop.ledger.unknownRequests).toBe(1);
		expect(host.faux.state.callCount).toBe(0);
	});

	it("refuses new starts until the drain ends, and rearms an acknowledgment only with permission and consent", async () => {
		const started = latch();
		let host = await launch([hanging(started.open)]);
		await configure(host);
		await agreeOneShot(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await started.opened;
		host = await reopen(host);
		const blocked = await until(host, blockedBy("unsettled_effects"));
		// A suspend applied while inhibited leaves the drain target set: nothing may start beside it.
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, {
			...authority,
			operationIntent: {
				...authority.operationIntent!,
				requestId: "suspend-1",
				sequence: 2,
				expectedOperationRevision: blocked.operation.revision,
				action: "suspend",
			},
		});
		await host.owner.initialize(context, "inhibited");
		expect((await state(host)).operation.drain).not.toBeNull();
		await expect(operate(host, "open", "open-2")).rejects.toThrow("has not drained");
		await expect(
			startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		).rejects.toThrow("let it drain");
		await host.owner.initialize(context, "permitted");
		await operate(host, "open", "open-3");
		// Acknowledged under a hold: recorded, not rearmed; the next permitted start rearms it.
		await host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "op" };
		}, context);
		const loop = await state(host);
		await host.request({
			operation: "operate-local",
			action: "acknowledge",
			expectedOperationRevision: loop.operation.revision,
			requestId: "ack-1",
			runId: loop.runs[0].runId,
		});
		const held = await state(host);
		expect(held.runs[0].settlement).toEqual({ acknowledged: "ack-1" });
		expect(held.operation.activity).toEqual({ kind: "blocked", reason: "unsettled_effects" });
		await host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "open", operationId: null };
		}, context);
		now = 10_000;
		// Without the current grant a permitted start still does not rearm.
		const granted = (await readMissionAuthority(host.location))!;
		await revoke(host);
		host = await reopen(host, [writes("alpha")]);
		await setTimeout(30);
		expect((await state(host)).operation.activity).toEqual({ kind: "blocked", reason: "unsettled_effects" });
		expect(host.faux.state.callCount).toBe(0);
		await writeMissionAuthority(host.location, granted);
		host = await reopen(host, [writes("alpha"), writes("beta")]);
		const rearmed = await until(host, waiting);
		expect(rearmed.runs.map((run) => [run.workId, run.state.status])).toEqual([
			["p1-w1", "blocked"],
			["p1-w1", "verified"],
		]);
		expect(host.faux.state.callCount).toBe(1);
	});
});

describe("verified versus settled", () => {
	it("blocks B after a verified A whose attempt is uncertain, until a protected acknowledgment rearms the loop", async () => {
		const A = work("reports/a.txt", "alpha");
		const B = work("reports/b.txt", "beta");
		const started = latch();
		// The provider writes A's exact bytes and then never answers: the effect is real, its request outcome unknown.
		let host = await launch([hanging(started.open, () => writeFile(join(directory, "reports/a.txt"), "alpha"))]);
		await mkdir(join(directory, "reports"));
		await configure(host);
		await approve(host, purpose([A, B]));
		await operate(host, "open", "open-1");
		await started.opened;
		host = await reopen(host, [writes("beta")]);
		let loop = await until(host, blockedBy("unsettled_effects"));
		const runA = loop.runs[0];
		expect(runA).toMatchObject({ state: { status: "verified" }, settlement: "unsettled" });
		expect(loop.ledger).toMatchObject({ requests: 1, unknownRequests: 1 });
		expect(host.faux.state.callCount).toBe(0);

		now = 5_000;
		host = await reopen(host, [writes("beta")]);
		await setTimeout(30);
		expect(host.faux.state.callCount).toBe(0);

		const ack = { operation: "operate-local", action: "acknowledge", expectedOperationRevision: 0 } as const;
		await host.request({ ...ack, requestId: "ack-1", runId: runA.runId });
		// The same request ID is idempotent; a new ID for an already acknowledged run is refused.
		await host.request({ ...ack, requestId: "ack-1", runId: runA.runId });
		await expect(host.request({ ...ack, requestId: "ack-2", runId: runA.runId })).rejects.toThrow("unsettled");
		loop = await until(host, idle);
		expect(host.faux.state.callCount).toBe(1);
		expect(loop.runs.map((run) => run.workId)).toEqual(["p1-w1", "p1-w2"]);
		expect(loop.runs[0].settlement).toEqual({ acknowledged: "ack-1" });
		// Nothing refunds: A's unknown attempt stays charged.
		expect(loop.ledger).toMatchObject({ requests: 2, unknownRequests: 1 });
	});

	it("refuses an acknowledgment ID the protected file evicted but the owner remembers, reissued for another run", async () => {
		const startedA = latch();
		const startedB = latch();
		let host = await launch([hanging(startedA.open)]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await startedA.opened;
		host = await reopen(host, [hanging(startedB.open)]);
		const blockedA = await until(host, blockedBy("unsettled_effects"));
		now = 5_000;
		const ack = { operation: "operate-local", action: "acknowledge", expectedOperationRevision: 0 } as const;
		await host.request({ ...ack, requestId: "ack-1", runId: blockedA.runs[0].runId });
		await startedB.opened;
		host = await reopen(host);
		const blockedB = await until(host, blockedBy("unsettled_effects"));
		const runB = blockedB.runs[1];
		expect(runB.settlement).toBe("unsettled");
		expect(blockedB.operation.acknowledged).toEqual(["ack-1"]);

		// Eight newer acknowledgments evict ack-1 from the protected file; the owner still remembers the ID.
		const authority = (await readMissionAuthority(host.location))!;
		const evicted = { ...authority, operationAcknowledgments: [] };
		await writeMissionAuthority(host.location, evicted);
		// The local writer refuses before saving the reused ID.
		await expect(host.request({ ...ack, requestId: "ack-1", runId: runB.runId })).rejects.toThrow(
			"Conflicting acknowledgment request ID",
		);
		expect((await readMissionAuthority(host.location))!.operationAcknowledgments).toEqual([]);

		// The administrator command cannot see the owner's memory and saves it; the owner must not report it applied.
		const reused = {
			requestId: "ack-1",
			missionId: blockedB.missionId!,
			runId: runB.runId,
			authorityRevision: authority.revision,
			issuedAt: now,
		};
		await writeMissionAuthority(host.location, { ...evicted, operationAcknowledgments: [reused] });
		await expect(host.request({ operation: "reconcile-operation", requestId: "ack-1" })).rejects.toThrow(
			"Conflicting acknowledgment request ID",
		);
		const after = await state(host);
		expect(after.runs[1].settlement).toBe("unsettled");
		expect(after.operation.activity).toEqual({ kind: "blocked", reason: "unsettled_effects" });
	});

	it("keeps an acknowledged run without verified evidence unfinished and proposes its work again", async () => {
		const A = work("reports/a.txt", "alpha");
		const started = latch();
		let host = await launch([hanging(started.open)]);
		await configure(host);
		await approve(host, purpose([A]));
		await operate(host, "open", "open-1");
		await started.opened;
		host = await reopen(host, [writes("alpha")]);
		const loop = await until(host, blockedBy("unsettled_effects"));
		expect(loop.runs[0]).toMatchObject({ state: { status: "blocked", reason: "unknown_request_outcome" } });
		now = 3_000;
		await host.request({
			operation: "operate-local",
			action: "acknowledge",
			expectedOperationRevision: 0,
			requestId: "ack-1",
			runId: loop.runs[0].runId,
		});
		const done = await until(host, idle);
		expect(done.runs.map((run) => [run.workId, run.state.status])).toEqual([
			["p1-w1", "blocked"],
			["p1-w1", "verified"],
		]);
		expect(done.ledger).toMatchObject({ workItems: 2, requests: 2, unknownRequests: 1 });
	});
});

describe("authority read inside each admission", () => {
	it("stales a recorded proposal when the receipt is revoked before its admission commit", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		const real = host.admission.readAuthority.bind(host.admission);
		let reads = 0;
		vi.spyOn(host.admission, "readAuthority").mockImplementation(async () => {
			// The second loop read is the admit commit's: revoke just before it, after the proposal was recorded.
			if (++reads === 2) await revoke(host);
			return real();
		});
		await operate(host, "open", "open-1");
		const loop = await until(host, blockedBy("authority"));
		expect(loop.proposals.map((proposal) => proposal.status)).toEqual(["stale"]);
		expect(loop.runs).toEqual([]);
		expect(loop.ledger.workItems).toBe(0);
		expect(host.faux.state.callCount).toBe(0);
	});

	it("writes no file when authority is revoked between the tool intent and its effect", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		const real = host.admission.readAuthority.bind(host.admission);
		let reads = 0;
		vi.spyOn(host.admission, "readAuthority").mockImplementation(async () => {
			// Reads: observe, admit, cycle, reservation, tool intent, then the tool's effect fence.
			if (++reads === 6) await revoke(host);
			return real();
		});
		await operate(host, "open", "open-1");
		const loop = await until(host, blockedBy("unsettled_effects"));
		await expect(content("reports/a.txt")).rejects.toThrow("ENOENT");
		expect(loop.runs[0]).toMatchObject({ settlement: "unsettled" });
		expect(loop.runs[0].pendingTools).toHaveLength(1);
	});

	it("does not admit B after a verified A once the grant is revoked during the wait", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		await configure(host);
		now = 5_000;
		host = await reopen(host, [writes("beta")]);
		const loop = await until(host, blockedBy("authority"));
		expect(host.faux.state.callCount).toBe(0);
		expect(loop.runs).toHaveLength(1);
		// The observation itself is refused: no proposal for B is recorded under the revoked grant.
		expect(loop.proposals.map((proposal) => proposal.status)).toEqual(["admitted"]);
	});
});

/** Agrees a one-shot mission, so a one-shot start reaches the exclusion checks. */
async function agreeOneShot(host: Host) {
	const draft = await host.request({
		operation: "draft",
		expectedRevision: 0,
		requestId: "draft",
		terms: {
			objective: "One-shot fixture",
			scope: "The fixture workspace",
			successCriteria: [`sha256:${sha("x")}:x.txt`],
			approvalBoundary: [],
			reviewEveryMs: 100,
			policy: {
				allowedTools: ["write"],
				maxCycles: 1,
				maxRequests: 1,
				maxRetries: 0,
				maxConsecutiveNoProgress: 1,
				deadlineAt: 50_000,
			},
		},
	});
	const proposed = await host.request({
		operation: "propose",
		expectedRevision: draft.formation.draft!.revision,
		requestId: "propose",
	});
	await host.request({
		operation: "approve-local",
		expectedRevision: proposed.formation.draft!.revision,
		digest: proposed.formation.draft!.digest!,
		requestId: "approve",
	});
}

async function revoke(host: Host) {
	const authority = (await readMissionAuthority(host.location))!;
	await writeMissionAuthority(host.location, { ...authority, purposeApprovals: [] });
}

describe("lifetime allowance", () => {
	it("refuses a request beyond the lifetime allowance before dispatch, and reopening operation resets nothing", async () => {
		let host = await launch([writes("wrong")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha", { maxCycles: 3, maxRequests: 3 })], { maxRequests: 1 }));
		await operate(host, "open", "open-1");
		let loop = await until(host, (saved) => saved.operation.activity?.kind === "blocked");
		expect(host.faux.state.callCount).toBe(1);
		expect(loop.ledger).toMatchObject({ requests: 1, workItems: 1 });
		await operate(host, "suspend", "suspend-1");
		await operate(host, "open", "open-2");
		host = await reopen(host, [writes("alpha")]);
		now = 10_000;
		host = await reopen(host, [writes("alpha")]);
		await setTimeout(50);
		loop = await state(host);
		expect(host.faux.state.callCount).toBe(0);
		expect(loop.ledger.requests).toBe(1);
	});

	it("settles attempts by exact ID: a delayed receipt touches only its own run, a duplicate nothing", () => {
		const terms = purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")], { maxEstimatedCost: 10 });
		const loop = initialLoop();
		const run = (runId: string): LoopRun => ({
			runId,
			workId: "p1-w1",
			workDigest: "d",
			purposeRevision: 1,
			sequence: 1,
			conversation: 1 as LoopRun["conversation"],
			providerSession: runId,
			cycles: 0,
			retries: 0,
			noProgress: 0,
			attempts: [],
			pendingTools: [],
			evidence: [],
			lastAnswer: null,
			state: { status: "running", phase: "execution" },
			settlement: null,
		});
		const [a, b] = [run("A"), run("B")];
		loop.runs.push(a, b);
		const first = reserveAttempt(loop, a, terms.works[0], terms.lifetime, 2);
		const second = reserveAttempt(loop, b, terms.works[1], terms.lifetime, 3);
		if (!("attempt" in first) || !("attempt" in second)) throw new Error("reservation refused");
		settleAttempt(loop, first.attempt.attemptId, 0.5);
		settleAttempt(loop, first.attempt.attemptId, 0.5);
		expect(a.attempts[0]).toMatchObject({ status: "priced", cost: 0.5 });
		expect(b.attempts[0]).toMatchObject({ status: "reserved" });
		expect(loop.ledger).toMatchObject({ estimatedCost: 0.5, reservedCost: 3, unknownRequests: 1, requests: 2 });
		releaseAttempt(loop, second.attempt.attemptId);
		// Never sent: zero cost replaces the reservation, but the request stays charged.
		expect(loop.ledger).toMatchObject({ reservedCost: 0, unknownRequests: 0, requests: 2 });
	});

	it("keeps the reserved total at zero, never a few ulps below, when reservations end in another order", () => {
		const terms = purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")], { maxEstimatedCost: 10 });
		const loop = initialLoop();
		const [a, b] = ["A", "B"].map((runId) => ({ attempts: [], pendingTools: [], runId }) as unknown as LoopRun);
		loop.runs.push(a, b);
		const first = reserveAttempt(loop, a, terms.works[0], terms.lifetime, 0.7);
		const second = reserveAttempt(loop, b, terms.works[1], terms.lifetime, 0.1);
		if (!("attempt" in first) || !("attempt" in second)) throw new Error("reservation refused");
		// 0.7 + 0.1 - 0.7 - 0.1 is -2.8e-17 in floating point, which stored validation refuses as a negative total.
		releaseAttempt(loop, first.attempt.attemptId);
		settleAttempt(loop, second.attempt.attemptId, 0);
		expect(Object.is(loop.ledger.reservedCost, 0)).toBe(true);
	});

	it("fails closed when a spend cap meets an earlier attempt without a computable ceiling", () => {
		const uncapped = purpose([work("reports/a.txt", "alpha")]);
		const capped = purpose([work("reports/a.txt", "alpha")], { maxEstimatedCost: 100 });
		const loop = initialLoop();
		const run = { attempts: [], pendingTools: [], runId: "A" } as unknown as LoopRun;
		loop.runs.push(run);
		const reserved = reserveAttempt(loop, run, uncapped.works[0], uncapped.lifetime, null);
		if (!("attempt" in reserved)) throw new Error("reservation refused");
		settleAttempt(loop, reserved.attempt.attemptId, null);
		expect(reserveAttempt(loop, run, capped.works[0], capped.lifetime, 1)).toEqual({ denial: "unknown_historical_cost" });
	});
});

describe("restrictive transitions and drain", () => {
	it("suspends during an active request: admission closes first, drain ends the loop, the purpose stays", async () => {
		const started = latch();
		let host = await launch([hanging(started.open)]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		await started.opened;
		await operate(host, "suspend", "suspend-1");
		let loop = await state(host);
		expect(loop.operation).toMatchObject({ state: { status: "suspended" }, drain: null, loop: null });
		expect(loop.runs[0]).toMatchObject({ state: { status: "aborted" } });
		expect(loop.agreements).toHaveLength(1);
		host = await reopen(host, [writes("alpha")]);
		now = 10_000;
		host = await reopen(host, [writes("alpha")]);
		await setTimeout(30);
		loop = await state(host);
		expect(host.faux.state.callCount).toBe(0);
		expect(loop.operation.state.status).toBe("suspended");
	});

	it("applies a restrictive intent written before a crash at the next start, before any wake", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		const before = await until(host, waiting);
		// The administrator's file write lands; the owner crashes before applying it.
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, {
			...authority,
			operationIntent: {
				...authority.operationIntent!,
				requestId: "close-1",
				sequence: authority.operationIntent!.sequence + 1,
				expectedOperationRevision: before.operation.revision,
				action: "close",
			},
		});
		now = 10_000;
		host = await reopen(host, [writes("beta")]);
		const loop = await until(host, (saved) => saved.operation.drain === null && saved.operation.state.status === "closed");
		await setTimeout(30);
		expect(host.faux.state.callCount).toBe(0);
		expect(loop.operation.loop).toBeNull();
		expect(loop.runs).toHaveLength(1);
	});

	it("on inhibited startup only abort-marks the persisted drain target, then finishes once permitted", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		const before = await until(host, waiting);
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, {
			...authority,
			operationIntent: {
				...authority.operationIntent!,
				requestId: "suspend-1",
				sequence: authority.operationIntent!.sequence + 1,
				expectedOperationRevision: before.operation.revision,
				action: "suspend",
			},
		});
		await host.harness.close(context);
		opened.splice(opened.indexOf(host.harness), 1);
		now = 10_000;
		const location = { kind: "developer-local" as const, directory, session: "default" };
		const admission = new MissionAdmission(location, () => now);
		const engine = missionController(admission, directory);
		const registry = createRegistry();
		registry.install(MissionFoundation);
		registry.install(engine.extension);
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "session.sqlite")),
			{ models: admission.models(models), registry, now: () => now, setTimer: () => () => {} },
			context,
		);
		opened.push(harness);
		await admission.bind(harness, context);
		const control = new MissionControl(harness, location, ["write"], () => now);
		const owner = new MissionOwner(harness, control, location, registry, admission, engine, model, directory, () => now);
		await owner.initialize(context, "inhibited");
		const marked = (await readMissionPurpose(harness, context))!.loop;
		expect(marked.operation).toMatchObject({ state: { status: "suspended" }, drain: { loop: before.operation.loop } });
		const task = await harness.getTask(before.operation.loop!, context);
		expect(task?.abortRequested).toBe(true);
		expect((await harness.inspect(context)).scheduling).toBe("paused");
		await owner.initialize(context, "permitted");
		expect((await readMissionPurpose(harness, context))!.loop.operation).toMatchObject({ drain: null, loop: null });
	});
});

describe("revision changes and legacy exclusion", () => {
	it("refuses a purpose amendment while open; a replayed old open cannot reopen; identical work stays done", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		const A = work("reports/a.txt", "alpha");
		await approve(host, purpose([A]));
		await operate(host, "open", "open-1");
		await until(host, idle);
		await expect(approve(host, purpose([A, work("reports/b.txt", "beta")]), "2")).rejects.toThrow(
			"Suspend or close",
		);
		await operate(host, "close", "close-1");
		await approve(host, purpose([A, work("reports/b.txt", "beta")]), "2");
		// Replaying the old open intent at restart reopens nothing: it names revision 1 and an applied sequence.
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, {
			...authority,
			operationIntent: { ...authority.operationIntent!, requestId: "open-1", action: "open", sequence: 1 },
		});
		host = await reopen(host, [writes("beta")]);
		await setTimeout(30);
		expect((await state(host)).operation.state.status).toBe("closed");
		await writeMissionAuthority(host.location, authority);
		now = 5_000;
		await operate(host, "open", "open-2");
		const loop = await until(host, idle);
		expect(loop.runs.map((run) => run.workId)).toEqual(["p1-w1", "p2-w2"]);
		expect(host.faux.state.callCount).toBe(1);
	});

	it("never runs one-shot work and the loop together", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await agreeOneShot(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await expect(
			startMissionExecution(host.harness, host.engine, host.admission, host.registry, model, context),
		).rejects.toThrow("Suspend or close continuous operation");
	});

	it("keeps the persisted next observation through suspend and reopen of operation", async () => {
		const host = await launch([writes("alpha"), writes("beta")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		now = 1_200;
		await operate(host, "suspend", "suspend-1");
		await operate(host, "open", "open-2");
		const loop = await until(host, waiting);
		expect(loop.operation.activity).toEqual({ kind: "waiting", reason: "next_observation", until: 2_000 });
		await setTimeout(30);
		expect(host.faux.state.callCount).toBe(1);
		await expect(content("reports/b.txt")).rejects.toThrow("ENOENT");
	});
});

describe("managed purpose grant", () => {
	it("accepts a managed purpose receipt only with the creator's own assent", () => {
		const terms = purpose([work("reports/a.txt", "alpha")]);
		const creator = { kind: "human" as const, id: "creator", uid: 1001 };
		const authority = {
			schemaVersion: 1 as const,
			installationId: "00000000-0000-4000-8000-000000000000",
			session: "default" as const,
			revision: 3,
			creator,
			ceiling: {
				allowedTools: [],
				maxCycles: 1,
				maxRequests: 1,
				maxRetries: 0,
				maxConsecutiveNoProgress: 1,
				maxDurationMs: 1,
			},
		};
		const receipt = (kind: "local-creator" | "host-administrator", uid: number) => ({
			receiptId: "r",
			requestId: "q",
			installationId: authority.installationId,
			session: "default",
			missionId: "m",
			revision: 1,
			digest: purposeDigest(terms, "m", 1, authority),
			creator,
			authorityRevision: 3,
			approvedAt: 1,
			provenance: "managed-administrator" as const,
			approvedBy: { kind, uid },
		});
		const check = (approval: ReturnType<typeof receipt>) =>
			matchingPurposeApproval({ ...authority, approvals: [], purposeApprovals: [approval] }, "r", "m", 1, terms);
		expect(check(receipt("local-creator", 1001))).toBeDefined();
		expect(check(receipt("host-administrator", 0))).toBeUndefined();
		expect(check(receipt("local-creator", 0))).toBeUndefined();
	});
});

describe("maintenance drain", () => {
	it("treats a loop sleeping for its next observation as drained and an active attempt as busy", async () => {
		const started = latch();
		let host = await launch([writes("alpha"), hanging(started.open)]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		const parked = await until(host, waiting);
		expect(loopParkedForMaintenance(await host.harness.inspect(context), parked)).toBe(true);
		expect(loopRollbackBlocker(await host.harness.inspect(context))).toBe("live-loop");
		now = 2_000;
		host = await reopen(host, [hanging(started.open)]);
		await started.opened;
		const active = await state(host);
		expect(loopParkedForMaintenance(await host.harness.inspect(context), active)).toBe(false);
	});

	it("re-sleeps a wake that falls due under a maintenance hold, with zero requests", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		await host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "op" };
		}, context);
		now = 2_000;
		host = await reopen(host, [writes("beta")]);
		const loop = await until(
			host,
			(saved) => saved.operation.activity?.kind === "waiting" && saved.operation.activity.reason === "maintenance",
		);
		expect(host.faux.state.callCount).toBe(0);
		expect(loopParkedForMaintenance(await host.harness.inspect(context), loop)).toBe(true);
	});
});

describe("work tool", () => {
	it("refuses outside an admitted run and refuses a symlinked declared path", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await mkdir(join(directory, "reports"));
		await mkdir(join(directory, "outside"));
		await symlink(join(directory, "outside"), join(directory, "reports", "nested"));
		await approve(host, purpose([work("reports/nested/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		const loop = await until(host, (saved) => saved.operation.activity?.kind === "blocked");
		await expect(readFile(join(directory, "outside", "a.txt"))).rejects.toThrow("ENOENT");
		expect(loop.runs[0].state.status).not.toBe("verified");
		const tool = host.registry.snapshot().tools().find((item) => item.tool.name === "unit_work_write")!.tool;
		expect(tool.deferred).toBe(true);
	});
});

describe("projection", () => {
	it("shows purpose revision, operation, activity, next observation, per-work result and lifetime use apart", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		const view = parseMissionView(JSON.parse(JSON.stringify(await host.request({ operation: "status" }))));
		expect(view.purpose).toMatchObject({
			revision: 1,
			operation: "open",
			activity: "waiting",
			reason: "next_observation",
			nextWakeAt: 2_000,
			works: [
				{ workId: "p1-w1", result: "verified" },
				{ workId: "p1-w2", result: "pending", runId: null },
			],
			used: { workItems: 1, cycles: 1, requests: 1 },
			rollback: "live-loop",
		});
		const text = describeMission(view);
		for (const line of [
			"Purpose revision 1: Keep the fixture reports current",
			"Operation: open (revision 1).",
			"Activity: waiting (next_observation).",
			`Next observation: ${new Date(2_000).toISOString()}.`,
			"p1-w2 reports/b.txt: pending.",
			"Lifetime: 1/4 work, 1/6 cycles, 1/6 requests.",
			"Rollback: close operation first (a loop is live).",
		])
			expect(text).toContain(line);
	});
});

describe("stored loop is a trust boundary", () => {
	it("rejects a ledger that no longer matches its runs and a changed agreement", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		const loop = await until(host, idle);
		expect(() => checkLoopState(structuredClone(loop))).not.toThrow();
		const lowered = structuredClone(loop);
		lowered.ledger.requests = 0;
		expect(() => checkLoopState(lowered)).toThrow("ledger");
		const changed = structuredClone(loop);
		(changed.agreements[0].terms.works[0] as ArtifactWorkTerms).sha256 = "0".repeat(64);
		expect(() => checkLoopState(changed)).toThrow();
		await host.harness.commit(async (tx) => {
			(await tx.doc(MissionPurposeDoc)).loop.ledger.cycles = 0;
		}, context);
		await expect(readMissionPurpose(host.harness, context)).rejects.toThrow("ledger");
	});

	it("runs and admits nothing from a tampered stored ledger after reopen", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")], { maxRequests: 1 }));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		// Lowered so the lifetime request allowance would admit B; the loop task is parked and wakes on the raw document.
		await host.harness.commit(async (tx) => {
			(await tx.doc(MissionPurposeDoc)).loop.ledger.requests = 0;
		}, context);
		now = 2_000;
		host = await reopen(host, [writes("beta")]);
		const loopLive = async () =>
			(await host.harness.inspect(context)).tasks.some((task) => task.record.kind === "unit.mission.loop");
		for (let i = 0; i < 100 && (await loopLive()); i++) await setTimeout(5);
		// The woken loop ended on the failed validation instead of observing.
		expect(await loopLive()).toBe(false);
		expect(host.faux.state.callCount).toBe(0);
		await expect(content("reports/b.txt")).rejects.toThrow("ENOENT");
		expect((await host.request({ operation: "status" })).purpose).toBeNull();
	});
});

describe("code check fixes", () => {
	/** Publishes `change` inside the next commit, just before its callback runs: the commit was queued before it. */
	function duringNextCommit(host: Host, change: () => Promise<void>) {
		const real = host.harness.commit.bind(host.harness);
		let armed = true;
		vi.spyOn(host.harness, "commit").mockImplementation((callback, inner, options) =>
			real(
				async (tx) => {
					if (armed) {
						armed = false;
						await change();
					}
					return callback(tx);
				},
				inner,
				options,
			),
		);
	}

	it("refuses an open whose grant is revoked while its commit is queued", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		duringNextCommit(host, () => revoke(host));
		await expect(operate(host, "open", "open-1")).rejects.toThrow("does not match");
		const loop = await state(host);
		expect(loop.operation).toMatchObject({ state: { status: "closed" }, loop: null, revision: 0 });
		await setTimeout(20);
		expect(host.faux.state.callCount).toBe(0);
	});

	it("records an acknowledgment but does not rearm when the grant is revoked while its commit is queued", async () => {
		const started = latch();
		let host = await launch([hanging(started.open)]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		await started.opened;
		host = await reopen(host, [writes("alpha")]);
		const blocked = await until(host, blockedBy("unsettled_effects"));
		now = 3_000;
		duringNextCommit(host, () => revoke(host));
		await host.request({
			operation: "operate-local",
			action: "acknowledge",
			expectedOperationRevision: blocked.operation.revision,
			requestId: "ack-1",
			runId: blocked.runs[0].runId,
		});
		await setTimeout(30);
		const loop = await state(host);
		expect(loop.runs[0].settlement).toEqual({ acknowledged: "ack-1" });
		expect(loop.operation.loop).toBe(blocked.operation.loop);
		expect(loop.operation.activity).toEqual({ kind: "blocked", reason: "unsettled_effects" });
		expect(host.faux.state.callCount).toBe(0);
	});

	it("refuses to open a purpose whose lifetime deadline has passed", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")], { deadlineAt: 60_000 }));
		now = 60_000;
		await expect(operate(host, "open", "open-1")).rejects.toThrow("deadline");
		expect((await state(host)).operation).toMatchObject({ state: { status: "closed" }, loop: null });
	});

	it("admits nothing under an open intent that only shares the applied sequence", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		const authority = (await readMissionAuthority(host.location))!;
		await writeMissionAuthority(host.location, {
			...authority,
			operationIntent: { ...authority.operationIntent!, requestId: "open-other" },
		});
		now = 2_000;
		host = await reopen(host, [writes("beta")]);
		const loop = await until(host, blockedBy("authority"));
		expect(host.faux.state.callCount).toBe(0);
		expect(loop.runs).toHaveLength(1);
	});

	it("keeps a pending (partial) provider response reserved instead of settling it", async () => {
		const partial = fauxAssistantMessage("partial", { stopReason: "pending" });
		const pending = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end(partial));
			return stream;
		};
		const host = await launch([], {
			models: (models) => {
				vi.spyOn(models, "stream").mockImplementation(pending);
				vi.spyOn(models, "streamSimple").mockImplementation(pending);
			},
		});
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		const loop = await until(host, blockedBy("unsettled_effects"));
		expect(loop.runs[0]).toMatchObject({ state: { status: "blocked", reason: "unknown_request_outcome" } });
		expect(loop.runs[0].attempts).toMatchObject([{ status: "reserved" }]);
		expect(loop.ledger).toMatchObject({ requests: 1, unknownRequests: 1 });
	});

	it("keeps a released attempt without a ceiling consistent with validation, and bounds run history", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		const loop = structuredClone(await until(host, idle));
		const terms = loop.agreements[0].terms;
		const reserved = reserveAttempt(loop, loop.runs[0], terms.works[0], terms.lifetime, null);
		if (!("attempt" in reserved)) throw new Error(reserved.denial);
		releaseAttempt(loop, reserved.attempt.attemptId);
		expect(loop.ledger).toMatchObject({ requests: 2, unknownRequests: 0, unboundedAttempts: 1 });
		expect(() => checkLoopState(structuredClone(loop))).not.toThrow();
		// More attempts than the run's own approved work allows is not history this owner can have written.
		loop.runs[0].attempts.push({ attemptId: "x", ceiling: 1, status: "released" });
		loop.ledger.requests++;
		expect(() => checkLoopState(loop)).toThrow("exceeds its approved work");
	});

	it("charges no work slot for B when the lifetime allowance cannot pay for its first cycle", async () => {
		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")], { maxCycles: 1 }));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		now = 2_000;
		host = await reopen(host, [writes("beta")]);
		const loop = await until(host, blockedBy("allowance_exhausted"));
		expect(loop.runs).toHaveLength(1);
		expect(loop.ledger).toMatchObject({ workItems: 1, cycles: 1, requests: 1 });
		expect(loop.proposals.map((proposal) => proposal.status)).toEqual(["admitted"]);
		expect(host.faux.state.callCount).toBe(0);
	});

	it("finalizes a run whose phase saw the restrictive commit before the abort mark", async () => {
		const started = latch();
		const answer = latch();
		const host = await launch([
			async () => {
				started.open();
				await answer.opened;
				return fauxAssistantMessage("progress only");
			},
		]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		await started.opened;
		const live = (await state(host)).operation.loop!;
		const abortTask = host.harness.abortTask.bind(host.harness);
		// The drain's abort mark arrives only after the loop's own phase already ended it on the restrictive commit.
		vi.spyOn(host.harness, "abortTask").mockImplementation(async (id, inner) => {
			answer.open();
			while ((await host.harness.getTask(live, inner))?.state.status !== "terminal") await setTimeout(5);
			return abortTask(id, inner);
		});
		await operate(host, "suspend", "suspend-1");
		const task = await host.harness.getTask(live, context);
		expect(task?.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
		const loop = await state(host);
		expect(loop.operation).toMatchObject({ state: { status: "suspended" }, drain: null, loop: null });
		expect(loop.runs[0]).toMatchObject({ state: { status: "aborted" }, settlement: "settled" });
	});

	it("projects unsettled runs of every revision so an amendment cannot hide one from acknowledgment", async () => {
		const started = latch();
		let host = await launch([hanging(started.open)]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		await started.opened;
		host = await reopen(host);
		const blocked = await until(host, blockedBy("unsettled_effects"));
		await operate(host, "close", "close-1");
		await approve(host, purpose([work("reports/b.txt", "beta")]), "2");
		const view = parseMissionView(JSON.parse(JSON.stringify(await host.request({ operation: "status" }))));
		expect(view.purpose?.works).toEqual([{ workId: "p2-w1", path: "reports/b.txt", result: "pending", runId: null }]);
		expect(view.purpose?.unsettled).toEqual([
			{ runId: blocked.runs[0].runId, workId: "p1-w1", path: "reports/a.txt", purposeRevision: 1 },
		]);
		expect(describeMission(view)).toContain(`Unsettled run ${blocked.runs[0].runId} (p1-w1 reports/a.txt)`);
		const acknowledged = await host.request({
			operation: "operate-local",
			action: "acknowledge",
			expectedOperationRevision: view.purpose!.operationRevision,
			requestId: "ack-1",
			runId: blocked.runs[0].runId,
		});
		expect(acknowledged.purpose?.unsettled).toEqual([]);
	});
});

describe("restart validation and request IDs", () => {
	/** A priced faux model: each request reserves (1000 * 2 + 1000 * 1) / 1e6 = 0.003 against a spend cap. */
	const priced = {
		models: [
			{ id: model.modelId, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 1_000 },
		],
	};

	it("rejects missing, nonnumeric or nonfinite ledger and attempt amounts, and malformed run counters", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		const loop = await until(host, idle);
		const tampered = (change: (copy: LoopState) => void) => {
			const copy = structuredClone(loop);
			change(copy);
			return () => checkLoopState(copy);
		};
		expect(tampered(() => {})).not.toThrow();
		const ledger = (copy: LoopState) => copy.ledger as Record<string, unknown>;
		expect(tampered((copy) => delete ledger(copy).estimatedCost)).toThrow("ledger");
		expect(tampered((copy) => delete ledger(copy).reservedCost)).toThrow("ledger");
		expect(tampered((copy) => (ledger(copy).reservedCost = "0"))).toThrow("ledger");
		expect(tampered((copy) => (ledger(copy).estimatedCost = Number.NaN))).toThrow("ledger");
		expect(tampered((copy) => (ledger(copy).estimatedCost = Number.POSITIVE_INFINITY))).toThrow("ledger");
		// Recomputed totals of zero: every attempt provably never sent.
		const unspent = (copy: LoopState) => {
			for (const item of copy.runs[0].attempts) {
				item.status = "released";
				delete item.cost;
			}
			Object.assign(copy.ledger, { estimatedCost: 0, reservedCost: 0, unknownRequests: 0, unpricedResponses: 0, unboundedAttempts: 0 });
		};
		expect(tampered(unspent)).not.toThrow();
		// Within the tolerance of zero, a negative total still lowers the balance enough to admit work at an exact cap.
		expect(tampered((copy) => (unspent(copy), (copy.ledger.reservedCost = -5e-10)))).toThrow("ledger");
		expect(tampered((copy) => (unspent(copy), (copy.ledger.estimatedCost = -5e-10)))).toThrow("ledger");
		const attempt = (copy: LoopState) => copy.runs[0].attempts[0] as Record<string, unknown>;
		// A priced attempt without its cost would count as free; with a lowered ledger it would hide spend.
		expect(
			tampered((copy) => {
				Object.assign(attempt(copy), { status: "priced", cost: undefined });
				copy.ledger.reservedCost = 0;
				copy.ledger.unpricedResponses = 0;
			}),
		).toThrow("attempt");
		expect(tampered((copy) => (attempt(copy).ceiling = Number.NaN))).toThrow("attempt");
		expect(tampered((copy) => (attempt(copy).status = "settled"))).toThrow("attempt");
		expect(tampered((copy) => delete (copy.runs[0] as Record<string, unknown>).noProgress)).toThrow("run");
		expect(tampered((copy) => ((copy.runs[0] as Record<string, unknown>).cycles = "1"))).toThrow("run");
	});

	it("runs and admits nothing over the spend cap when a saved cost total is missing after reopen", async () => {
		let host = await launch([writes("alpha")], { faux: priced });
		await configure(host, { maxEstimatedCost: 1 });
		const terms = purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")], { maxEstimatedCost: 0.005 });
		await approve(host, terms);
		await operate(host, "open", "open-1");
		const saved = await until(host, waiting);
		// A's response carries no price, so its 0.003 ceiling stays charged and B's 0.003 cannot fit under 0.005.
		expect(saved.ledger).toMatchObject({ requests: 1, unpricedResponses: 1, reservedCost: 0.003 });
		await host.harness.commit(async (tx) => {
			delete ((await tx.doc(MissionPurposeDoc)).loop.ledger as Partial<LoopState["ledger"]>).reservedCost;
		}, context);
		now = 2_000;
		host = await reopen(host, [writes("beta")], { faux: priced });
		await setTimeout(50);
		// Without the check, `NaN >= cap` is false: B's permanent work slot and first cycle were charged past the cap.
		const raw = (await host.harness.snapshot(MissionPurposeDoc, context))!.loop.ledger;
		expect(raw).toMatchObject({ workItems: 1, cycles: 1, requests: 1 });
		expect(host.faux.state.callCount).toBe(0);
		await expect(content("reports/b.txt")).rejects.toThrow("ENOENT");
		const view = await host.request({ operation: "status" });
		expect(view.purpose).toBeNull();
		expect(view.purposeError).toContain("ledger");
	});

	it("reports malformed legacy history beside a valid parked loop as invalid, live, and runs nothing", async () => {
		const empty = await launch();
		expect(await empty.request({ operation: "status" })).toMatchObject({ purposeError: null, loopRollback: "no-live-loop" });
		await empty.harness.close(context);
		opened.splice(opened.indexOf(empty.harness), 1);
		await rm(join(directory, "session.sqlite"), { force: true });

		let host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha"), work("reports/b.txt", "beta")]));
		await operate(host, "open", "open-1");
		await until(host, waiting);
		// The loop part stays valid; only the imported one-shot history is malformed.
		await host.harness.commit(async (tx) => {
			(await tx.doc(MissionPurposeDoc)).work.push({ workId: "legacy-9" } as never);
		}, context);
		now = 1_500;
		host = await reopen(host, [writes("beta")]);
		// Before the wake: the parked loop is live, so status must not read the failed records as "no purpose, no loop".
		const parked = parseMissionView(JSON.parse(JSON.stringify(await host.request({ operation: "status" }))));
		expect(parked).toMatchObject({ purpose: null, loopRollback: "live-loop" });
		expect(parked.purposeError).toBeTruthy();
		const text = describeMission(parked);
		expect(text).toContain("Purpose records are invalid");
		expect(text).toContain("Rollback: a loop task is still live.");
		now = 2_000;
		host = await reopen(host, [writes("beta")]);
		const loopLive = async () =>
			(await host.harness.inspect(context)).tasks.some((task) => task.record.kind === "unit.mission.loop");
		for (let i = 0; i < 100 && (await loopLive()); i++) await setTimeout(5);
		// Execution agrees with status: the woken loop ends on the same validation instead of admitting B.
		expect(await loopLive()).toBe(false);
		expect(host.faux.state.callCount).toBe(0);
		await expect(content("reports/b.txt")).rejects.toThrow("ENOENT");
		expect(await host.request({ operation: "status" })).toMatchObject({ purpose: null, loopRollback: "no-live-loop" });
	});

	it("refuses one request ID reused across acknowledge and close, and never reports the close as applied", async () => {
		const started = latch();
		let host = await launch([hanging(started.open)]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		await started.opened;
		host = await reopen(host);
		const blocked = await until(host, blockedBy("unsettled_effects"));
		const runId = blocked.runs[0].runId;
		const ack = { operation: "operate-local", action: "acknowledge", requestId: "same-1", runId } as const;
		await host.request({ ...ack, expectedOperationRevision: blocked.operation.revision });
		const open = await state(host);
		// The local writer refuses before saving authority.
		await expect(operate(host, "close", "same-1")).rejects.toThrow("Conflicting operation request ID");
		expect((await state(host)).operation.state.status).toBe("open");
		expect((await readMissionAuthority(host.location))!.operationIntent!.requestId).toBe("open-1");

		// A writer that saves both anyway: the restrictive close still applies, but the call cannot report success.
		const authority = (await readMissionAuthority(host.location))!;
		const close = nextOperationAuthority(
			{ ...authority, operationAcknowledgments: [] },
			open,
			undefined,
			{ operation: "operate-local", action: "close", expectedOperationRevision: open.operation.revision, requestId: "same-1" },
			now,
		);
		await writeMissionAuthority(host.location, { ...close, operationAcknowledgments: authority.operationAcknowledgments });
		await expect(host.request({ operation: "reconcile-operation", requestId: "same-1" })).rejects.toThrow(
			"names both",
		);
		expect((await state(host)).operation.state).toEqual({ status: "closed" });
		// The reverse order, an acknowledgment under the applied close's ID, is refused the same way.
		await expect(host.request({ operation: "reconcile-operation", requestId: "same-1" })).rejects.toThrow(
			"names both",
		);
	});
});

describe("rollback answer while a drain is persisted", () => {
	it("reports live-loop until the owner finishes the drain, even after the loop task is terminal", async () => {
		const host = await launch([writes("alpha")]);
		await configure(host);
		await approve(host, purpose([work("reports/a.txt", "alpha")]));
		await operate(host, "open", "open-1");
		await until(host, idle);
		expect(await host.request({ operation: "status" })).toMatchObject({ loopRollback: "no-live-loop" });
		// A suspend applied, its task already terminal, but the owner's cleanup commit has not run yet.
		const finished = (await host.harness.inspect(context)).tasks.find((t) => t.record.kind === "unit.mission.loop");
		await host.harness.commit(async (tx) => {
			(await tx.doc(MissionPurposeDoc)).loop.operation.drain = {
				loop: (finished?.record.id ?? "task-gone") as never,
				conversations: [],
			};
		}, context);
		expect(await host.request({ operation: "status" })).toMatchObject({ loopRollback: "live-loop" });
		await host.harness.commit(async (tx) => {
			(await tx.doc(MissionPurposeDoc)).loop.operation.drain = null;
		}, context);
		expect(await host.request({ operation: "status" })).toMatchObject({ loopRollback: "no-live-loop" });
	});
});
