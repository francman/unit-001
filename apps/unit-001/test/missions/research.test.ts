// #27: One research run end to end on real SQLite with the faux provider and host fixtures; nothing leaves the host.
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { MaintenanceDoc } from "../../src/maintenance.ts";
import { MissionAdmission } from "../../src/missions/admission.ts";
import type { MissionRequest, PurposeTerms, ResearchWorkTerms } from "../../src/missions/contract.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { missionController } from "../../src/missions/controller.ts";
import { MissionOwner } from "../../src/missions/owner.ts";
import { readMissionPurpose } from "../../src/missions/purpose.ts";
import { initialLoop, type LoopState } from "../../src/missions/purpose-loop.ts";
import { fixtureSources, type ResearchSource, sha256Of } from "../../src/missions/research-sources.ts";
import { MissionResearchDoc, readResearch } from "../../src/missions/research-state.ts";
import { MissionFoundation } from "../../src/missions/state.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];
const model = { provider: "faux", modelId: "faux-1" };
type Response = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-research-"));
	now = 1_000;
});
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const page = (url: string, body: string): ResearchSource => ({ url, contentType: "text/html", body, sha256: sha256Of(body) });
const FIXTURE = page(
	"https://docs.example/undici",
	"<html><body><h1>undici</h1><p>undici is a fast HTTP/1.1 client written from scratch for Node.js.</p><script>evil()</script></body></html>",
);
const research = (overrides: Partial<ResearchWorkTerms> = {}): ResearchWorkTerms => ({
	kind: "research",
	question: "Which library should replace request?",
	sourcePolicy: { kind: "fixtures" },
	selection: "agent",
	posting: null,
	maxChildren: 1,
	maxConcurrentChildren: 1,
	maxRequests: 10,
	maxFetches: 3,
	maxFetchBytes: 100_000,
	maxToolRoundsPerChild: 4,
	...overrides,
});
const purpose = (work: ResearchWorkTerms): PurposeTerms => ({
	purpose: "Keep dependencies secure",
	scope: "This repository",
	reviewEveryMs: 1_000,
	works: [work],
	lifetime: { maxWorkItems: 4, maxCycles: 6, maxRequests: 20, deadlineAt: 600_000 },
});

async function launch(responses: Response[] = []) {
	const location = { kind: "developer-local" as const, directory, session: "default" };
	const admission = new MissionAdmission(location, () => now);
	const engine = missionController(admission, directory, fixtureSources([FIXTURE]));
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
	return { harness, faux, request: (input: MissionRequest) => owner.handle(input, context) };
}
type Host = Awaited<ReturnType<typeof launch>>;

async function reopen(host: Host, responses: Response[] = []) {
	await host.harness.close(context);
	opened.splice(opened.indexOf(host.harness), 1);
	const next = await launch(responses);
	next.harness.resume();
	return next;
}

/** Configures a creator whose ceiling grants research, agrees the purpose and opens operation. */
async function start(host: Host, work: ResearchWorkTerms = research()) {
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
			capabilities: ["artifact-digest", "research"],
			paths: ["reports/"],
			maxWorkItems: 8,
			maxCycles: 10,
			maxRequests: 20,
			maxRetries: 2,
			maxConsecutiveNoProgress: 4,
			maxDurationMs: 1_000_000,
			research: { maxRequests: 10, maxFetches: 3, maxFetchBytes: 100_000, maxToolRoundsPerChild: 4 },
		},
	});
	const proposed = await host.request({ operation: "purpose-propose", expectedRevision: 0, requestId: "pp", terms: purpose(work) });
	await host.request({
		operation: "purpose-approve-local",
		revision: proposed.purpose!.proposed!.revision,
		digest: proposed.purpose!.proposed!.digest,
		requestId: "pa",
	});
	const loop = await loopState(host);
	await host.request({ operation: "operate-local", action: "open", expectedOperationRevision: loop.operation.revision, requestId: "open-1" });
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
	const stored = await readResearch(host.harness, context);
	throw new Error(`Research did not settle: ${JSON.stringify(stored?.runs[0] ?? null)}`);
}

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]): Response => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string): Response => fauxAssistantMessage(text);
const plan = () => tool("research_plan", { branches: [{ focus: "maintained HTTP clients" }] });
const fetch = () => tool("research_fetch", { url: FIXTURE.url });
const submit = (quote: string) =>
	tool("research_submit_candidate", {
		title: "Replace request with undici",
		summary: "undici is maintained and fast.",
		approach: "Swap the client and adapt call sites.",
		claims: [{ text: "undici is a fast HTTP client.", citations: [{ artifact: FIXTURE.sha256, quote }] }],
		risks: "API differences.",
		effort: "small",
	});
/** Selects the stored candidate, reading its digest when the request arrives. */
const select = (host: () => Host): Response => async () => {
	const run = (await readResearch(host().harness, context))!.runs[0]!;
	return fauxAssistantMessage(
		fauxToolCall("research_select", {
			candidate: run.candidate!.digest,
			rationale: "Verified and maintained.",
			ticket: { title: "Replace request with undici", body: "Swap the HTTP client." },
		}),
		{ stopReason: "toolUse" },
	);
};
const settledLoop = (loop: LoopState) =>
	loop.operation.activity?.kind === "idle" || loop.operation.activity?.kind === "blocked";

describe("one research run", () => {
	it("plans, fetches, verifies, selects and drafts locally, then verifies the run under one LoopRun", async () => {
		let host: Host;
		host = await launch([
			plan(),
			say("Planned."),
			fetch(),
			submit("undici is a fast HTTP/1.1 client"),
			say("Submitted."),
			select(() => host),
			say("Selected."),
		]);
		await start(host);
		const loop = await until(host, settledLoop);
		expect(loop.operation.activity).toEqual({ kind: "idle", reason: "all_listed_work_done" });
		const stored = (await readResearch(host.harness, context))!.runs[0]!;
		expect(stored).toMatchObject({
			step: "settled",
			outcome: "selected",
			fetches: 1,
			decision: { accepted: true, reasons: [] },
			draft: { title: "Replace request with undici" },
		});
		expect(stored.draft!.body).toContain(`<!-- unit-001-ticket:${stored.draft!.marker} -->`);
		expect(loop.runs).toHaveLength(1);
		expect(loop.runs[0]).toMatchObject({ state: { status: "verified" }, settlement: "settled" });
		expect(loop.runs[0]!.evidence[0]).toMatchObject({ accepted: true, detail: stored.selection!.digest });
		// Every model request of coordinator and child was charged to the one run.
		expect(loop.ledger.requests).toBe(7);
		expect(loop.runs[0]!.attempts).toHaveLength(7);
		host = await reopen(host);
		await setTimeout(30);
		expect(host.faux.state.callCount).toBe(0);
	});

	it("rejects a forged quote and blocks the run with no_selection, drafting nothing", async () => {
		const host = await launch([plan(), say("Planned."), fetch(), submit("request is the best client ever"), say("Done.")]);
		await start(host);
		const loop = await until(host, settledLoop);
		expect(loop.operation.activity).toEqual({ kind: "blocked", reason: "no_selection" });
		const stored = (await readResearch(host.harness, context))!.runs[0]!;
		expect(stored.decision).toMatchObject({ accepted: false, reasons: ["claim 1: quote not found verbatim"] });
		expect(stored.selection).toBeNull();
		expect(stored.draft).toBeNull();
	});

	it("refuses selecting anything but the accepted candidate, and refuses a second selection", async () => {
		let host: Host;
		const reselect = (): Response => async () => {
			const stored = (await readResearch(host.harness, context))!.runs[0]!;
			return fauxAssistantMessage(
				fauxToolCall("research_select", {
					candidate: stored.candidate!.digest,
					rationale: "Again.",
					ticket: { title: "Second", body: "Second draft." },
				}),
				{ stopReason: "toolUse" },
			);
		};
		host = await launch([
			plan(),
			say("Planned."),
			fetch(),
			submit("undici is a fast HTTP/1.1 client"),
			say("Submitted."),
			tool("research_select", { candidate: "0".repeat(64), rationale: "x", ticket: { title: "Wrong", body: "x" } }),
			select(() => host),
			reselect(),
			say("Selected."),
		]);
		await start(host);
		await until(host, settledLoop);
		const stored = (await readResearch(host.harness, context))!.runs[0]!;
		expect(stored.outcome).toBe("selected");
		expect(stored.draft!.title).toBe("Replace request with undici");
	});

	it("settles source_unavailable when every fetch names an unknown source", async () => {
		const host = await launch([
			plan(),
			say("Planned."),
			tool("research_fetch", { url: "https://elsewhere.example/" }),
			say("Nothing to read."),
		]);
		await start(host);
		const loop = await until(host, settledLoop);
		expect(loop.operation.activity).toEqual({ kind: "blocked", reason: "source_unavailable" });
	});

	it("refuses a shell call from the child: nothing runs", async () => {
		const host = await launch([
			plan(),
			say("Planned."),
			tool("bash", { command: "touch pwned" }),
			say("Gave up."),
		]);
		await start(host);
		await until(host, settledLoop);
		await expect(readFile(join(directory, "pwned"))).rejects.toThrow("ENOENT");
		const stored = (await readResearch(host.harness, context))!.runs[0]!;
		expect(stored.candidate).toBeNull();
	});
});

/** A reply that never answers on its own: it records that it started and fails only when aborted. */
function hanging(started: () => void): Response {
	return async (_input, options) => {
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

describe("restart and suspend", () => {
	it("never plans or fetches again after a kill mid-child; the uncertain request blocks the run", async () => {
		const started = latch();
		let host = await launch([plan(), say("Planned."), fetch(), hanging(started.open)]);
		await start(host);
		await started.opened;
		host = await reopen(host, [plan(), fetch(), say("Never used.")]);
		const loop = await until(host, settledLoop);
		expect(loop.operation.activity).toEqual({ kind: "blocked", reason: "unsettled_effects" });
		const stored = (await readResearch(host.harness, context))!.runs[0]!;
		expect(stored).toMatchObject({ fetches: 1, plan: { focus: "maintained HTTP clients" } });
		expect(host.faux.state.callCount).toBe(0);
	});

	it("stops research at the next request once operation is suspended", async () => {
		const started = latch();
		const host = await launch([plan(), hanging(started.open), fetch()]);
		await start(host);
		await started.opened;
		const loop = await loopState(host);
		await host.request({
			operation: "operate-local",
			action: "suspend",
			expectedOperationRevision: loop.operation.revision,
			requestId: "suspend-1",
		});
		await setTimeout(40);
		const stored = (await readResearch(host.harness, context))!.runs[0]!;
		expect(stored.child).toBeNull();
		expect(stored.fetches).toBe(0);
		expect(host.faux.state.callCount).toBe(2);
		expect((await loopState(host)).operation.state.status).toBe("suspended");
	});
});

describe("contract", () => {
	it("refuses research work unless the creator's ceiling grants research", async () => {
		const host = await launch();
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
				maxRequests: 20,
				maxRetries: 2,
				maxConsecutiveNoProgress: 4,
				maxDurationMs: 1_000_000,
			},
		});
		await expect(
			host.request({ operation: "purpose-propose", expectedRevision: 0, requestId: "pp", terms: purpose(research()) }),
		).rejects.toThrow("grants no research");
	});
});

// #27
describe("research admission with unreadable records, refused candidates, hold and close", () => {
	it("unreadable research records block admission without charging a work slot", async () => {
		const host = await launch();
		await host.harness.commit(async (tx) => {
			(await tx.doc(MissionResearchDoc)).runs = "corrupt" as never;
		}, context);
		await start(host);
		const loop = await until(host, settledLoop);
		expect(loop.operation.activity).toEqual({ kind: "blocked", reason: "research_records" });
		expect(loop.runs).toHaveLength(0);
		expect(loop.ledger.workItems).toBe(0);
	});

	it("an out-of-bounds candidate is a no-effect refusal that strands no tool intent", async () => {
		let host: Host;
		const tooMany = tool("research_submit_candidate", {
			title: "t",
			summary: "s",
			approach: "a",
			claims: Array.from({ length: 9 }, () => ({ text: "x", citations: [] })),
			risks: "r",
			effort: "e",
		});
		host = await launch([
			plan(),
			say("Planned."),
			fetch(),
			tooMany,
			submit("undici is a fast HTTP/1.1 client"),
			say("Submitted."),
			select(() => host),
			say("Selected."),
		]);
		await start(host);
		const loop = await until(host, settledLoop);
		expect(loop.operation.activity).toEqual({ kind: "idle", reason: "all_listed_work_done" });
		expect(loop.runs[0]!.pendingTools).toEqual([]);
		expect((await readResearch(host.harness, context))!.runs[0]!.outcome).toBe("selected");
	});

	it("a hold mid-research sleeps before the next input, and the run resumes after release and reopen", async () => {
		let host: Host;
		const holdThenSay: Response = async () => {
			await host.harness.commit(async (tx) => {
				(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "op-1" };
			}, context);
			return fauxAssistantMessage("Planned.");
		};
		host = await launch([plan(), holdThenSay]);
		await start(host);
		const waiting = await until(host, (loop) => loop.operation.activity?.kind === "waiting");
		expect(waiting.operation.activity).toMatchObject({ kind: "waiting", reason: "maintenance" });
		expect((await readResearch(host.harness, context))!.runs[0]!.child).toBeNull();
		await host.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "open", operationId: null };
		}, context);
		now += 1_000;
		host = await reopen(host, [fetch(), submit("undici is a fast HTTP/1.1 client"), say("Submitted."), select(() => host), say("Selected.")]);
		const loop = await until(host, settledLoop);
		expect(loop.operation.activity).toEqual({ kind: "idle", reason: "all_listed_work_done" });
		// The plan was not made again after the reopen.
		expect(host.faux.state.callCount).toBe(5);
	});

	it("close mid-research stops it at the next request", async () => {
		const started = latch();
		const host = await launch([plan(), hanging(started.open), fetch()]);
		await start(host);
		await started.opened;
		const loop = await loopState(host);
		await host.request({ operation: "operate-local", action: "close", expectedOperationRevision: loop.operation.revision, requestId: "close-1" });
		await setTimeout(40);
		expect((await readResearch(host.harness, context))!.runs[0]!.child).toBeNull();
		expect(host.faux.state.callCount).toBe(2);
		expect((await loopState(host)).operation.state.status).toBe("closed");
	});
});

describe("rollback inspection", () => {
	it("reports no-research on a fresh owner, and research-present after a research proposal and after reopen", async () => {
		let host = await launch();
		expect((await host.request({ operation: "status" })).researchRollback).toBe("no-research");
		await host.request({
			operation: "configure-local",
			creator: { kind: "human", id: "creator", uid: process.getuid?.() ?? null },
			ceiling: { allowedTools: ["write"], maxCycles: 10, maxRequests: 20, maxRetries: 2, maxConsecutiveNoProgress: 10, maxDurationMs: 1_000_000 },
			purposeCeiling: {
				capabilities: ["artifact-digest", "research"],
				paths: ["reports/"],
				maxWorkItems: 8,
				maxCycles: 10,
				maxRequests: 20,
				maxRetries: 2,
				maxConsecutiveNoProgress: 4,
				maxDurationMs: 1_000_000,
				research: { maxRequests: 10, maxFetches: 3, maxFetchBytes: 100_000, maxToolRoundsPerChild: 4 },
			},
		});
		await host.request({ operation: "purpose-propose", expectedRevision: 0, requestId: "pp", terms: purpose(research()) });
		expect((await host.request({ operation: "status" })).researchRollback).toBe("research-present");
		host = await reopen(host);
		expect((await host.request({ operation: "status" })).researchRollback).toBe("research-present");
	});
});

// #27
describe("research request charging by the awaited conversation", () => {
	it("charges nothing for a coordinator request while the run awaits its child", async () => {
		const started = latch();
		const host = await launch([plan(), say("Planned."), hanging(started.open), say("Should never be sent.")]);
		await start(host);
		await started.opened;
		const stored = (await readResearch(host.harness, context))!.runs[0]!;
		expect(stored.awaiting?.conversation).toBe(stored.child!.conversation);
		const before = (await loopState(host)).ledger.requests;
		// The run is running and its coordinator session is real, but the coordinator is not the awaited conversation.
		const coordinator = await host.harness.conversation(stored.coordinator.conversation, context);
		await host.harness.commit(async (tx) => {
			await coordinator!.submit(tx, { type: "input", content: "Do more.", requestId: "stray-coordinator" });
		}, context);
		await coordinator!.waitForIdle(context);
		expect(host.faux.state.callCount).toBe(3);
		expect((await loopState(host)).ledger.requests).toBe(before);
	});
});
