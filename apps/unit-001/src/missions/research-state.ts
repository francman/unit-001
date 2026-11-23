// Stores research runs beside the purpose loop: plan, child, cited artifacts, candidate, verdict, selection and draft.
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { missionObject } from "./contract.ts";
import { MAX_PURPOSE_WORKS } from "./purpose-authority.ts";

/** One fetched source as research cites it; the body itself stays with the source, addressed by its SHA-256. */
export type ResearchArtifact = { sha256: string; url: string; contentType: string; bytes: number; fetchedAt: number };

/** One cited claim; each quote must occur verbatim in the cited artifact's extracted text. */
export type ResearchClaim = { text: string; citations: { artifact: string; quote: string }[] };

/** The child's one proposal, bounded and stored under its digest. */
export type ResearchCandidate = {
	title: string;
	summary: string;
	approach: string;
	claims: ResearchClaim[];
	risks: string;
	effort: string;
	digest: string;
};

/** The host verifier's deterministic verdict; model judgment never accepts evidence. */
export type ResearchDecision = { accepted: boolean; reasons: string[]; decidedAt: number };

/** The selection receipt: the accepted candidate it chose, the model's rationale (untrusted text) and its digest. */
export type ResearchSelection = { candidate: string; rationale: string; digest: string; selectedAt: number };

/** The local ticket draft; the marker makes a later post findable. Never posted in this release. */
export type ResearchDraft = { title: string; body: string; marker: string };

/** Where a run is; `awaiting` names the submission the loop waits on before the next step. */
export type ResearchStep = "plan" | "child" | "verify" | "select" | "settled";

/** How a settled run ended: a selected candidate with its draft, nothing acceptable, or no source to read. */
export type ResearchOutcome = "selected" | "no_selection" | "source_unavailable";

/** One research run, keyed by the purpose loop run that charges its requests. */
export type ResearchRun = {
	runId: string;
	workDigest: string;
	question: string;
	step: ResearchStep;
	awaiting: { conversation: ConversationId; requestId: string } | null;
	coordinator: { conversation: ConversationId; providerSession: string };
	plan: { focus: string; digest: string } | null;
	child: { conversation: ConversationId; providerSession: string } | null;
	fetches: number;
	fetchBytes: number;
	unavailable: number;
	artifacts: ResearchArtifact[];
	candidate: ResearchCandidate | null;
	decision: ResearchDecision | null;
	selection: ResearchSelection | null;
	draft: ResearchDraft | null;
	outcome: ResearchOutcome | null;
};

/** Research runs; additive, so a release without research ignores it. One run per purpose loop run at most. */
export type ResearchState = { runs: ResearchRun[] };

/** The research document; absent reads as no runs. */
export const MissionResearchDoc = defineDoc<ResearchState>({
	kind: "unit.research",
	version: 1,
	scope: "session",
	initial: () => ({ runs: [] }),
	checkpointWhen: () => true,
});

/** Reads stored research after validation; throws on a malformed document. */
export async function readResearch(harness: Harness, context: Context): Promise<ResearchState | undefined> {
	const saved = await harness.snapshot(MissionResearchDoc, context);
	if (saved !== undefined) checkResearchState(saved);
	return saved;
}

/** Research validated inside the caller's transaction; undefined when unreadable or invalid, which admits nothing. */
export async function storedResearch(tx: Tx): Promise<ResearchState | undefined> {
	try {
		return checkResearchState(await tx.doc(MissionResearchDoc));
	} catch {
		return undefined;
	}
}

/** The research run a conversation belongs to, and the conversation's role in it. */
export function researchRole(
	state: ResearchState,
	conversation: ConversationId,
): { run: ResearchRun; role: "coordinator" | "child" } | undefined {
	for (const run of state.runs) {
		if (run.coordinator.conversation === conversation) return { run, role: "coordinator" };
		if (run.child?.conversation === conversation) return { run, role: "child" };
	}
	return undefined;
}

/** The research run whose coordinator or child owns a provider session. */
export function researchRunBySession(state: ResearchState, session: string): ResearchRun | undefined {
	return state.runs.find(
		(run) => run.coordinator.providerSession === session || run.child?.providerSession === session,
	);
}

/** Validates stored research: bounded, unique runs, and the fields admission and status read are well-formed. */
export function checkResearchState(value: unknown): ResearchState {
	const state = missionObject(value) as ResearchState;
	if (!Array.isArray(state.runs) || state.runs.length > MAX_PURPOSE_WORKS) throw new Error("Invalid stored research.");
	const steps: readonly unknown[] = ["plan", "child", "verify", "select", "settled"];
	for (const run of state.runs) {
		const input = missionObject(run);
		if (
			typeof input.runId !== "string" ||
			!steps.includes(run.step) ||
			!Array.isArray(run.artifacts) ||
			![run.fetches, run.fetchBytes, run.unavailable].every((count) => Number.isSafeInteger(count) && count >= 0) ||
			typeof missionObject(run.coordinator).providerSession !== "string"
		)
			throw new Error("Invalid stored research run.");
	}
	if (new Set(state.runs.map((run) => run.runId)).size !== state.runs.length) throw new Error("Duplicate research run.");
	return state;
}
