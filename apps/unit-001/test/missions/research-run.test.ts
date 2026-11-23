// #27: A research run's next action follows from its stored record, so a restart reopens saved work and never repeats it.
import { describe, expect, it } from "vitest";
import { parseCandidate } from "../../src/missions/research-evidence.ts";
import { advanceAfterAwait, nextResearchAction, researchBound, researchPrompt, verifyRun } from "../../src/missions/research-run.ts";
import { workDigest } from "../../src/missions/purpose-authority.ts";
import type { LoopRun } from "../../src/missions/purpose-loop.ts";
import { fixtureSources, sha256Of } from "../../src/missions/research-sources.ts";
import type { ResearchRun } from "../../src/missions/research-state.ts";

const body = "undici is fast.";
const source = { url: "https://docs.example/u", contentType: "text/plain", body, sha256: sha256Of(body) };

function run(overrides: Partial<ResearchRun> = {}): ResearchRun {
	return {
		runId: "r1",
		workDigest: "w",
		question: "q",
		step: "plan",
		awaiting: null,
		coordinator: { conversation: 1 as never, providerSession: "s1" },
		plan: null,
		child: null,
		fetches: 0,
		fetchBytes: 0,
		unavailable: 0,
		artifacts: [],
		candidate: null,
		decision: null,
		selection: null,
		draft: null,
		outcome: null,
		...overrides,
	};
}

describe("next action", () => {
	it("submits under fixed request IDs and awaits a pending submission", () => {
		expect(nextResearchAction(run())).toEqual({ kind: "submit", to: "coordinator", requestId: "r1:plan" });
		expect(nextResearchAction(run({ step: "child" }))).toEqual({ kind: "spawn-child" });
		const child = { conversation: 2 as never, providerSession: "s2" };
		expect(nextResearchAction(run({ step: "child", child }))).toEqual({ kind: "submit", to: "child", requestId: "r1:child:1:1" });
		expect(nextResearchAction(run({ step: "select" }))).toEqual({ kind: "submit", to: "coordinator", requestId: "r1:synthesis" });
		expect(nextResearchAction(run({ awaiting: { conversation: 1 as never, requestId: "r1:plan" } }))).toEqual({ kind: "await" });
	});
});

describe("advancing", () => {
	it("settles no_selection when planning recorded no plan, and moves on when it did", () => {
		const none = run({ awaiting: { conversation: 1 as never, requestId: "r1:plan" } });
		advanceAfterAwait(none);
		expect(none).toMatchObject({ awaiting: null, step: "settled", outcome: "no_selection" });
		const planned = run({ plan: { focus: "f", digest: "d" }, awaiting: { conversation: 1 as never, requestId: "r1:plan" } });
		advanceAfterAwait(planned);
		expect(planned.step).toBe("child");
	});

	it("settles selected only with both a selection and a draft", () => {
		const selected = run({
			step: "select",
			selection: { candidate: "c", rationale: "r", digest: "d", selectedAt: 1 },
			draft: { title: "t", body: "b", marker: "m" },
		});
		advanceAfterAwait(selected);
		expect(selected.outcome).toBe("selected");
		const unselected = run({ step: "select" });
		advanceAfterAwait(unselected);
		expect(unselected.outcome).toBe("no_selection");
	});
});

describe("verification step", () => {
	it("settles source_unavailable when every fetch named an unknown source, else no_selection", () => {
		const unknown = run({ step: "verify", fetches: 2, unavailable: 2 });
		verifyRun(unknown, fixtureSources([source]), 1);
		expect(unknown.outcome).toBe("source_unavailable");
		const empty = run({ step: "verify", fetches: 1, unavailable: 0 });
		verifyRun(empty, fixtureSources([source]), 1);
		expect(empty.outcome).toBe("no_selection");
	});

	it("opens selection only for an accepted candidate", () => {
		const candidate = parseCandidate({
			title: "t",
			summary: "s",
			approach: "a",
			claims: [{ text: "fast", citations: [{ artifact: source.sha256, quote: "undici is fast." }] }],
			risks: "r",
			effort: "e",
		});
		const fetched = { sha256: source.sha256, url: source.url, contentType: "text/plain", bytes: 15, fetchedAt: 1 };
		const accepted = run({ step: "verify", fetches: 1, artifacts: [fetched], candidate });
		verifyRun(accepted, fixtureSources([source]), 1);
		expect(accepted.step).toBe("select");
	});
});

describe("codex #27 HOLD", () => {
	const work = {
		kind: "research" as const,
		question: "q",
		sourcePolicy: { kind: "fixtures" as const },
		selection: "agent" as const,
		posting: null,
		maxChildren: 1 as const,
		maxConcurrentChildren: 1 as const,
		maxRequests: 5,
		maxFetches: 2,
		maxFetchBytes: 100,
		maxToolRoundsPerChild: 3,
	};

	it("item 3: stored research binds to exactly its run's work digest, question and identities", () => {
		const stored = run({ workDigest: workDigest(work) });
		const loopRun = { runId: "r1", workDigest: workDigest(work), conversation: 1, providerSession: "s1" } as LoopRun;
		expect(researchBound(stored, loopRun, work)).toBe(true);
		expect(researchBound({ ...stored, question: "other" }, loopRun, work)).toBe(false);
		expect(researchBound(stored, { ...loopRun, providerSession: "s9" }, work)).toBe(false);
		expect(researchBound(stored, { ...loopRun, conversation: 7 as never }, work)).toBe(false);
		expect(researchBound(stored, loopRun, { ...work, maxFetches: 3 })).toBe(false);
	});

	it("item 7: synthesis receives the whole bounded verified candidate as data", () => {
		const candidate = parseCandidate({
			title: "t",
			summary: "the summary",
			approach: "the approach",
			claims: [{ text: "fast", citations: [{ artifact: source.sha256, quote: "undici is fast." }] }],
			risks: "the risks",
			effort: "e",
		});
		const prompt = researchPrompt(run({ step: "select", candidate }), work, "coordinator");
		for (const part of ["the summary", "the approach", "undici is fast.", "the risks"]) expect(prompt).toContain(part);
	});
});
