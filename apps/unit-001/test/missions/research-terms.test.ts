// #27: Research work terms are closed and bounded, need the explicit research grant, and leave artifact digests alone.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArtifactWorkTerms, PurposeCeiling, PurposeTerms, ResearchWorkTerms } from "../../src/missions/contract.ts";
import { parsePurposeCeiling, parsePurposeTerms, purposeDigest, workDigest } from "../../src/missions/purpose-authority.ts";
import { parseResearchWork, researchWorkDenial } from "../../src/missions/research-terms.ts";

const research: ResearchWorkTerms = {
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
};
const artifact: ArtifactWorkTerms = {
	kind: "artifact-digest",
	path: "reports/a.txt",
	sha256: "a".repeat(64),
	instructions: "Write it.",
	maxCycles: 2,
	maxRequests: 2,
	maxRetries: 0,
	maxConsecutiveNoProgress: 2,
};
const ceiling = (research?: PurposeCeiling["research"]): PurposeCeiling =>
	parsePurposeCeiling({
		capabilities: research ? ["artifact-digest", "research"] : ["artifact-digest"],
		paths: ["reports/"],
		maxWorkItems: 4,
		maxCycles: 4,
		maxRequests: 10,
		maxRetries: 1,
		maxConsecutiveNoProgress: 2,
		maxDurationMs: 1_000,
		...(research ? { research } : {}),
	});

describe("research work terms", () => {
	it("parse only fixtures, agent selection, no posting and exactly one child", () => {
		expect(parseResearchWork({ ...research })).toEqual(research);
		expect(() => parseResearchWork({ ...research, sourcePolicy: { kind: "allowlist", hosts: [] } })).toThrow("fixtures");
		expect(() => parseResearchWork({ ...research, selection: "creator" })).toThrow("agent");
		expect(() => parseResearchWork({ ...research, posting: { repository: "a/b" } })).toThrow("posting");
		expect(() => parseResearchWork({ ...research, maxChildren: 2 })).toThrow("one child");
		const { maxFetches: _fetches, ...missing } = research;
		expect(() => parseResearchWork(missing)).toThrow("exactly");
	});

	it("need the explicit research capability and caps within it", () => {
		expect(researchWorkDenial(research, ceiling())).toMatch("grants no research");
		const granted = ceiling({ maxRequests: 10, maxFetches: 3, maxFetchBytes: 100_000, maxToolRoundsPerChild: 4 });
		expect(researchWorkDenial(research, granted)).toBeUndefined();
		expect(researchWorkDenial({ ...research, maxFetches: 4 }, granted)).toMatch("maxFetches");
	});

	it("refuse a research capability without its caps, and caps without the capability", () => {
		const base = { paths: ["reports/"], maxWorkItems: 4, maxCycles: 4, maxRequests: 10, maxRetries: 1, maxConsecutiveNoProgress: 2, maxDurationMs: 1_000 };
		expect(() => parsePurposeCeiling({ ...base, capabilities: ["artifact-digest", "research"] })).toThrow("research caps");
		expect(() =>
			parsePurposeCeiling({
				...base,
				capabilities: ["artifact-digest"],
				research: { maxRequests: 1, maxFetches: 1, maxFetchBytes: 1, maxToolRoundsPerChild: 1 },
			}),
		).toThrow("research caps");
	});
});

describe("digests", () => {
	it("leave an artifact work's digest exactly as before research existed", () => {
		const before = createHash("sha256")
			.update(JSON.stringify({ kind: artifact.kind, path: artifact.path, sha256: artifact.sha256 }))
			.digest("hex");
		expect(workDigest(artifact)).toBe(before);
	});

	it("leave an artifact-only purpose's digest exactly as before research existed", () => {
		const terms: PurposeTerms = parsePurposeTerms({
			purpose: "p",
			scope: "s",
			reviewEveryMs: 1,
			works: [artifact],
			lifetime: { maxWorkItems: 1, maxCycles: 1, maxRequests: 1, deadlineAt: 5 },
		});
		const authority = { installationId: null, session: "default" as const, revision: 1, creator: { kind: "human" as const, id: "c", uid: 1 } };
		const before = createHash("sha256")
			.update(
				JSON.stringify({
					schemaVersion: 1,
					kind: "unit.mission.purpose",
					installationId: null,
					session: "default",
					missionId: "m",
					revision: 1,
					authorityRevision: 1,
					creator: authority.creator,
					terms: {
						purpose: "p",
						scope: "s",
						reviewEveryMs: 1,
						works: [{ ...artifact }],
						lifetime: { maxWorkItems: 1, maxCycles: 1, maxRequests: 1, deadlineAt: 5 },
					},
				}),
			)
			.digest("hex");
		expect(purposeDigest(terms, "m", 1, authority)).toBe(before);
	});

	it("bind a research work's every term", () => {
		expect(workDigest({ ...research, question: "Another question?" })).not.toBe(workDigest(research));
		expect(workDigest({ ...research, maxFetchBytes: 1 })).not.toBe(workDigest(research));
	});
});
