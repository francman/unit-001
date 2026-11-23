// #27: The host verifier accepts a candidate only on verbatim quotes from artifacts this run fetched.
import { describe, expect, it } from "vitest";
import { parseCandidate, selectAndDraft, selectionHolds, verifyCandidate } from "../../src/missions/research-evidence.ts";
import { fixtureSources, NO_RESEARCH_SOURCES, sha256Of } from "../../src/missions/research-sources.ts";
import type { ResearchRun } from "../../src/missions/research-state.ts";

const body = "<p>undici is a fast HTTP/1.1 client written from scratch.</p>";
const source = { url: "https://docs.example/u", contentType: "text/html", body, sha256: sha256Of(body) };
const sources = fixtureSources([source]);

function run(): ResearchRun {
	return {
		runId: "r1",
		workDigest: "w",
		question: "q",
		step: "verify",
		awaiting: null,
		coordinator: { conversation: 1 as never, providerSession: "s" },
		plan: { focus: "f", digest: "d" },
		child: null,
		fetches: 1,
		fetchBytes: body.length,
		unavailable: 0,
		artifacts: [{ sha256: source.sha256, url: source.url, contentType: source.contentType, bytes: body.length, fetchedAt: 1 }],
		candidate: null,
		decision: null,
		selection: null,
		draft: null,
		outcome: null,
	};
}

const candidate = (quote: string, artifact = source.sha256) =>
	parseCandidate({
		title: "t",
		summary: "s",
		approach: "a",
		claims: [{ text: "fast", citations: [{ artifact, quote }] }],
		risks: "r",
		effort: "e",
	});

describe("candidate bounds", () => {
	it("refuses too many claims, long quotes and oversized candidates", () => {
		const claim = { text: "x", citations: [] };
		expect(() => parseCandidate({ title: "t", summary: "s", approach: "a", claims: Array(9).fill(claim), risks: "r", effort: "e" })).toThrow("claims");
		expect(() => candidate("x".repeat(501))).toThrow("Quotes");
		expect(() => parseCandidate({ title: "t", summary: "s".repeat(9000), approach: "a", claims: [claim], risks: "r", effort: "e" })).toThrow();
	});
});

describe("verification", () => {
	it("accepts a verbatim quote after whitespace normalisation", () => {
		expect(verifyCandidate(run(), candidate("undici is a  fast\nHTTP/1.1 client"), sources, 5)).toEqual({
			accepted: true,
			reasons: [],
			decidedAt: 5,
		});
	});

	it("rejects a forged quote, an unfetched artifact, a claim without citation and an expired source", () => {
		expect(verifyCandidate(run(), candidate("the best client ever"), sources, 1).reasons).toEqual([
			"claim 1: quote not found verbatim",
		]);
		expect(verifyCandidate(run(), candidate("undici", "b".repeat(64)), sources, 1).reasons).toEqual([
			"claim 1: cites an artifact this run did not fetch",
		]);
		const bare = parseCandidate({ title: "t", summary: "s", approach: "a", claims: [{ text: "x", citations: [] }], risks: "r", effort: "e" });
		expect(verifyCandidate(run(), bare, sources, 1).reasons).toEqual(["claim 1: no citation"]);
		expect(verifyCandidate(run(), candidate("undici"), NO_RESEARCH_SOURCES, 1).reasons).toEqual([
			"claim 1: artifact expired",
		]);
	});
});

describe("selection and draft", () => {
	it("binds the chosen candidate and ends the draft with its marker", () => {
		const settled = { ...run(), candidate: candidate("undici"), decision: { accepted: true, reasons: [], decidedAt: 1 } };
		const { selection, draft } = selectAndDraft("m", settled, "why", { title: "T", body: "B" }, 9);
		expect(selection).toMatchObject({ candidate: settled.candidate.digest, rationale: "why", selectedAt: 9 });
		expect(draft.body).toBe(`B\n\n<!-- unit-001-ticket:${draft.marker} -->`);
		expect(selectAndDraft("m", settled, "why", { title: "T", body: "B" }, 9)).toEqual({ selection, draft });
	});
});

describe("fixture sources", () => {
	it("refuses a fixture whose body does not match its SHA-256", () => {
		expect(() => fixtureSources([{ ...source, sha256: "c".repeat(64) }])).toThrow("does not match");
	});
});

describe("codex #27 HOLD", () => {
	it("item 1: a quote that is empty once whitespace is normalised never passes", () => {
		expect(() => candidate("   ")).toThrow("Quotes");
		const blank = { ...candidate("undici"), claims: [{ text: "x", citations: [{ artifact: source.sha256, quote: " \n " }] }] };
		expect(verifyCandidate(run(), blank, sources, 1).reasons).toEqual(["claim 1: quote not found verbatim"]);
	});

	it("item 5: the cited source must match the fetched size and content type, not only its digest", () => {
		const fetchedAsPlain = { ...run(), artifacts: [{ ...run().artifacts[0]!, contentType: "text/plain" }] };
		expect(verifyCandidate(fetchedAsPlain, candidate("undici"), sources, 1).reasons).toEqual([
			"claim 1: artifact does not match what was fetched",
		]);
		const fetchedShorter = { ...run(), artifacts: [{ ...run().artifacts[0]!, bytes: 3 }] };
		expect(verifyCandidate(fetchedShorter, candidate("undici"), sources, 1).reasons).toEqual([
			"claim 1: artifact does not match what was fetched",
		]);
	});

	it("item 2: a stored selection holds only when it rebuilds exactly and the candidate still verifies", () => {
		const accepted = { ...run(), candidate: candidate("undici"), decision: { accepted: true, reasons: [], decidedAt: 1 } };
		const chosen = selectAndDraft("m", accepted, "why", { title: "T", body: "B" }, 9);
		const settled = { ...accepted, ...chosen };
		expect(selectionHolds("m", settled, sources, 10)).toBe(true);
		expect(selectionHolds("other", settled, sources, 10)).toBe(false);
		expect(selectionHolds("m", { ...settled, draft: { ...chosen.draft, body: "Tampered" } }, sources, 10)).toBe(false);
		expect(selectionHolds("m", { ...settled, selection: { ...chosen.selection, rationale: "x" } }, sources, 10)).toBe(false);
		expect(selectionHolds("m", { ...settled, decision: { accepted: false, reasons: [], decidedAt: 1 } }, sources, 10)).toBe(false);
		expect(selectionHolds("m", settled, NO_RESEARCH_SOURCES, 10)).toBe(false);
	});
});

describe("codex #27 re-review A", () => {
	const accepted = () => ({ ...run(), candidate: candidate("undici"), decision: { accepted: true, reasons: [], decidedAt: 1 } });

	it("breaks the receipt when the draft's title or body is edited behind an unchanged marker", () => {
		const base = accepted();
		const chosen = selectAndDraft("m", base, "why", { title: "T", body: "B" }, 9);
		const marker = `\n\n<!-- unit-001-ticket:${chosen.draft.marker} -->`;
		const retitled = { ...base, ...chosen, draft: { ...chosen.draft, title: "Other" } };
		const rebodied = { ...base, ...chosen, draft: { ...chosen.draft, body: `Edited${marker}` } };
		expect(selectionHolds("m", { ...base, ...chosen }, sources, 10)).toBe(true);
		expect(selectionHolds("m", retitled, sources, 10)).toBe(false);
		expect(selectionHolds("m", rebodied, sources, 10)).toBe(false);
	});

	it("recomputes the restored candidate instead of trusting its stored digest, and rejects an empty claim list", () => {
		const base = accepted();
		const chosen = selectAndDraft("m", base, "why", { title: "T", body: "B" }, 9);
		const edited = { ...base, ...chosen, candidate: { ...base.candidate, summary: "changed" } };
		expect(selectionHolds("m", edited, sources, 10)).toBe(false);
		const empty = { ...base.candidate, claims: [] };
		expect(verifyCandidate(run(), empty, sources, 1).reasons).toEqual(["no claims"]);
	});
});
