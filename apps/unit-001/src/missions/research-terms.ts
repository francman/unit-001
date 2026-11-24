// Parses and bounds research work terms and the administrator's research ceiling; terms grant nothing by themselves.
import {
	missionInteger,
	missionObject,
	missionText,
	type PurposeCeiling,
	type ResearchCeiling,
	type ResearchWorkTerms,
} from "./contract.ts";

/** Parses one research work item crossing the wire or stored boundary: closed shape, fixtures, agent selection, no posting. */
export function parseResearchWork(input: Record<string, unknown>): ResearchWorkTerms {
	const fields = [
		"kind",
		"question",
		"sourcePolicy",
		"selection",
		"posting",
		"maxChildren",
		"maxConcurrentChildren",
		"maxRequests",
		"maxFetches",
		"maxFetchBytes",
		"maxToolRoundsPerChild",
	];
	if (Object.keys(input).length !== fields.length || Object.keys(input).some((key) => !fields.includes(key)))
		throw new Error(`Research work needs exactly: ${fields.join(", ")}.`);
	const policy = missionObject(input.sourcePolicy);
	// This slice reads host-provided fixtures only; live sources, creator selection and posting are later slices.
	if (Object.keys(policy).length !== 1 || policy.kind !== "fixtures")
		throw new Error("Research reads host fixtures only in this release.");
	if (input.selection !== "agent") throw new Error("Research selection is by the agent in this release.");
	if (input.posting !== null) throw new Error("Research posting is not available; tickets stay local drafts.");
	if (input.maxChildren !== 1 || input.maxConcurrentChildren !== 1)
		throw new Error("Research runs exactly one child in this release.");
	const question = missionText(input.question, 2048);
	if (!question.trim()) throw new Error("Research needs a question.");
	return {
		kind: "research",
		question,
		sourcePolicy: { kind: "fixtures" },
		selection: "agent",
		posting: null,
		maxChildren: 1,
		maxConcurrentChildren: 1,
		maxRequests: count(input.maxRequests, 1),
		maxFetches: count(input.maxFetches, 1),
		maxFetchBytes: count(input.maxFetchBytes, 1),
		maxToolRoundsPerChild: count(input.maxToolRoundsPerChild, 1),
	};
}

/** Parses the administrator's research ceiling, present only with the explicit `research` capability. */
export function parseResearchCeiling(value: unknown): ResearchCeiling {
	const input = missionObject(value);
	const fields = ["maxRequests", "maxFetches", "maxFetchBytes", "maxToolRoundsPerChild"];
	if (Object.keys(input).length !== fields.length || Object.keys(input).some((key) => !fields.includes(key)))
		throw new Error("The research ceiling needs exactly its four caps.");
	return {
		maxRequests: count(input.maxRequests, 1),
		maxFetches: count(input.maxFetches, 1),
		maxFetchBytes: count(input.maxFetchBytes, 1),
		maxToolRoundsPerChild: count(input.maxToolRoundsPerChild, 1),
	};
}

/** Why a research work exceeds the creator's protected research grant, if it does. */
export function researchWorkDenial(work: ResearchWorkTerms, ceiling: PurposeCeiling): string | undefined {
	const research = ceiling.research;
	if (ceiling.capabilities[1] !== "research" || !research)
		return "The creator's purpose ceiling grants no research.";
	for (const key of ["maxRequests", "maxFetches", "maxFetchBytes", "maxToolRoundsPerChild"] as const)
		if (work[key] > research[key]) return `Research exceeds the ${key} research ceiling.`;
	return undefined;
}

/** The research terms in fixed key order for digests, so a client's JSON order never changes what was agreed. */
export function canonicalResearchWork(work: ResearchWorkTerms): ResearchWorkTerms {
	return {
		kind: "research",
		question: work.question,
		sourcePolicy: { kind: "fixtures" },
		selection: "agent",
		posting: null,
		maxChildren: 1,
		maxConcurrentChildren: 1,
		maxRequests: work.maxRequests,
		maxFetches: work.maxFetches,
		maxFetchBytes: work.maxFetchBytes,
		maxToolRoundsPerChild: work.maxToolRoundsPerChild,
	};
}

function count(value: unknown, minimum: number): number {
	return missionInteger(value, minimum, `Research limits are integers from ${minimum}.`);
}
