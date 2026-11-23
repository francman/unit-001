// Bounds a research candidate, verifies its citations against stored sources, and builds the selection and draft.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { missionObject, missionText } from "./contract.ts";
import { extractText, normalizeWhitespace, type ResearchSources, sha256Of } from "./research-sources.ts";
import type {
	ResearchCandidate,
	ResearchClaim,
	ResearchDecision,
	ResearchDraft,
	ResearchRun,
	ResearchSelection,
} from "./research-state.ts";

const MAX_CLAIMS = 8;
const MAX_CITATIONS = 4;
const MAX_QUOTE = 500;
const MAX_CANDIDATE_BYTES = 8192;

/** Parses the child's candidate at the tool boundary: closed, bounded, and digested over its exact fields. */
export function parseCandidate(value: unknown): ResearchCandidate {
	const input = missionObject(value);
	if (Buffer.byteLength(JSON.stringify(input)) > MAX_CANDIDATE_BYTES) throw new Error("A candidate fits 8 KiB.");
	if (!Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > MAX_CLAIMS)
		throw new Error(`A candidate makes 1 to ${MAX_CLAIMS} claims.`);
	const claims: ResearchClaim[] = input.claims.map((item) => {
		const claim = missionObject(item);
		if (!Array.isArray(claim.citations) || claim.citations.length > MAX_CITATIONS)
			throw new Error(`A claim cites at most ${MAX_CITATIONS} sources.`);
		return {
			text: missionText(claim.text, 1000),
			citations: claim.citations.map((entry) => {
				const citation = missionObject(entry);
				const quote = missionText(citation.quote, MAX_QUOTE * 4);
				// Whitespace is normalised before matching, so a quote must still say something once normalised.
				if (!normalizeWhitespace(quote) || quote.length > MAX_QUOTE)
					throw new Error(`Quotes are 1 to ${MAX_QUOTE} characters of text.`);
				return { artifact: missionText(citation.artifact, 64), quote };
			}),
		};
	});
	const body = {
		title: missionText(input.title, 256),
		summary: missionText(input.summary, 2000),
		approach: missionText(input.approach, 2000),
		claims,
		risks: missionText(input.risks, 1000),
		effort: missionText(input.effort, 200),
	};
	return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

/**
 * The host's verdict on a candidate. Accepted only if every claim cites at least one artifact this run fetched, that
 * artifact's source still matches its SHA-256, and every quote occurs verbatim in its extracted text after whitespace
 * normalisation. Relevance and quality are left to selection; nothing here is model judgment.
 */
export function verifyCandidate(
	run: ResearchRun,
	candidate: ResearchCandidate,
	sources: ResearchSources,
	now: number,
): ResearchDecision {
	const reasons: string[] = [];
	if (candidate.claims.length === 0) reasons.push("no claims");
	candidate.claims.forEach((claim, index) => {
		if (claim.citations.length === 0) reasons.push(`claim ${index + 1}: no citation`);
		for (const citation of claim.citations) {
			const fetched = run.artifacts.find((artifact) => artifact.sha256 === citation.artifact);
			if (!fetched) {
				reasons.push(`claim ${index + 1}: cites an artifact this run did not fetch`);
				continue;
			}
			const source = sources.bySha256(citation.artifact);
			if (!source) {
				reasons.push(`claim ${index + 1}: artifact expired`);
				continue;
			}
			// The cited bytes must be exactly what was fetched: same digest, size and content type.
			if (
				sha256Of(source.body) !== fetched.sha256 ||
				Buffer.byteLength(source.body) !== fetched.bytes ||
				source.contentType !== fetched.contentType
			) {
				reasons.push(`claim ${index + 1}: artifact does not match what was fetched`);
				continue;
			}
			const quote = normalizeWhitespace(citation.quote);
			if (!quote || !extractText(source).includes(quote)) reasons.push(`claim ${index + 1}: quote not found verbatim`);
		}
	});
	return { accepted: reasons.length === 0, reasons, decidedAt: now };
}

/**
 * Whether a stored selection and draft are exactly what selecting this run's candidate produced, and the candidate is
 * still accepted by the verifier now. A restart re-checks this before completing the run, so a stored "selected"
 * outcome is never trusted on its own.
 */
export function selectionHolds(missionId: string, run: ResearchRun, sources: ResearchSources, now: number): boolean {
	const { candidate, selection, draft } = run;
	if (!candidate || !selection || !draft || !run.decision?.accepted || selection.candidate !== candidate.digest)
		return false;
	// The stored candidate is reparsed and its digest recomputed: a stored digest is never trusted on its own.
	let reparsed: ResearchCandidate;
	try {
		const { digest: _digest, ...fields } = candidate;
		reparsed = parseCandidate(fields);
	} catch {
		return false;
	}
	if (reparsed.digest !== candidate.digest || !verifyCandidate(run, reparsed, sources, now).accepted) return false;
	const suffix = `

<!-- unit-001-ticket:${draft.marker} -->`;
	if (!draft.body.endsWith(suffix)) return false;
	const rebuilt = selectAndDraft(
		missionId,
		run,
		selection.rationale,
		{ title: draft.title, body: draft.body.slice(0, -suffix.length) },
		selection.selectedAt,
	);
	return isDeepStrictEqual(rebuilt, { selection, draft });
}

/** Builds the selection receipt and the local ticket draft together; the draft ends with its correlation marker. */
export function selectAndDraft(
	missionId: string,
	run: ResearchRun,
	rationale: string,
	ticket: { title: string; body: string },
	now: number,
): { selection: ResearchSelection; draft: ResearchDraft } {
	const candidate = run.candidate!;
	// The digest covers the exact ticket text before the marker, so editing the draft breaks the receipt.
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				runId: run.runId,
				plan: run.plan?.digest ?? null,
				candidate: candidate.digest,
				decision: run.decision,
				rationale,
				title: ticket.title,
				body: ticket.body,
			}),
		)
		.digest("hex");
	const marker = createHash("sha256").update(`${missionId}:${run.runId}:${digest}`).digest("hex").slice(0, 32);
	return {
		selection: { candidate: candidate.digest, rationale, digest, selectedAt: now },
		draft: { title: ticket.title, body: `${ticket.body}\n\n<!-- unit-001-ticket:${marker} -->`, marker },
	};
}
