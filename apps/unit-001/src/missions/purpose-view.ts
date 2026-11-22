// Projects continuous operation for status clients and validates that projection at the owner-client boundary.
import { missionNumber, missionObject, missionText, type PurposeTerms } from "./contract.ts";
import { parsePurposeTerms, workDigest } from "./purpose-authority.ts";
import { type LoopState, listedWork, listedWorkId, loopAgreement } from "./purpose-loop.ts";

type WorkResult = "pending" | "working" | "verified" | "unsettled" | "acknowledged" | "blocked" | "aborted";

/** Purpose revision, operation, activity, next wake, per-work result and lifetime use, as distinct fields. */
export type MissionPurposeView = {
	missionId: string | null;
	revision: number | null;
	digest: string | null;
	purpose: string | null;
	appliedSequence: number;
	proposed: { revision: number; digest: string; terms: PurposeTerms } | null;
	operation: "closed" | "open" | "suspended";
	operationRevision: number;
	activity: string | null;
	reason: string | null;
	nextWakeAt: number | null;
	works: { workId: string; path: string; result: WorkResult; runId: string | null }[];
	/** Every run whose effects are unsettled, from any purpose revision: what an acknowledgment may name. */
	unsettled: { runId: string; workId: string; path: string; purposeRevision: number }[];
	used: { workItems: number; cycles: number; requests: number; estimatedCost: number; reservedCost: number; unknownRequests: number; unpricedResponses: number };
	limits: { maxWorkItems: number; maxCycles: number; maxRequests: number; maxEstimatedCost: number | null } | null;
	rollback: "no-live-loop" | "live-loop";
};

/** Projects the stored loop; `live` says whether a loop task is still live, which the stored state alone cannot. */
export function missionPurposeView(loop: LoopState, live: boolean): MissionPurposeView {
	const agreement = loop.agreements.at(-1);
	const activity = loop.operation.activity;
	return {
		missionId: loop.missionId,
		revision: agreement?.revision ?? null,
		digest: agreement?.digest ?? null,
		purpose: agreement?.terms.purpose ?? null,
		appliedSequence: loop.operation.applied?.sequence ?? 0,
		proposed: loop.draft && { revision: loop.draft.revision, digest: loop.draft.digest, terms: loop.draft.terms },
		operation: loop.operation.state.status,
		operationRevision: loop.operation.revision,
		activity: activity?.kind ?? null,
		reason: activity === null ? null : "reason" in activity ? activity.reason : null,
		nextWakeAt: activity?.kind === "waiting" ? activity.until : loop.operation.nextObservationAt,
		works: (agreement?.terms.works ?? []).map((work, index) => {
			const digest = workDigest(work);
			const run = loop.runs.findLast((item) => item.workDigest === digest);
			return {
				workId: listedWorkId(agreement!.revision, index),
				path: work.path,
				result: run ? result(run) : "pending",
				runId: run?.runId ?? null,
			};
		}),
		// The loop blocks on unsettled runs of every revision, so an amendment that drops older work must not hide them.
		unsettled: loop.runs
			.filter((run) => run.settlement === "unsettled")
			.map((run) => ({
				runId: run.runId,
				workId: run.workId,
				path: listedWork(loopAgreement(loop, run.purposeRevision)!, run.workId)!.path,
				purposeRevision: run.purposeRevision,
			})),
		used: {
			workItems: loop.ledger.workItems,
			cycles: loop.ledger.cycles,
			requests: loop.ledger.requests,
			estimatedCost: loop.ledger.estimatedCost,
			reservedCost: loop.ledger.reservedCost,
			unknownRequests: loop.ledger.unknownRequests,
			unpricedResponses: loop.ledger.unpricedResponses,
		},
		limits: agreement
			? {
					maxWorkItems: agreement.terms.lifetime.maxWorkItems,
					maxCycles: agreement.terms.lifetime.maxCycles,
					maxRequests: agreement.terms.lifetime.maxRequests,
					maxEstimatedCost: agreement.terms.lifetime.maxEstimatedCost ?? null,
				}
			: null,
		rollback: live ? "live-loop" : "no-live-loop",
	};
}

/** Validates a purpose projection received from the owner before a terminal or administrator client uses it. */
export function parseMissionPurposeView(value: unknown): MissionPurposeView {
	const input = missionObject(value);
	const operation = input.operation;
	if (operation !== "closed" && operation !== "open" && operation !== "suspended")
		throw new Error("Invalid purpose operation projection.");
	if (input.rollback !== "no-live-loop" && input.rollback !== "live-loop")
		throw new Error("Invalid purpose rollback projection.");
	const nullable = <T>(item: unknown, parse: (item: unknown) => T) => (item === null ? null : parse(item));
	const used = missionObject(input.used);
	const proposed = nullable(input.proposed, missionObject);
	if (!Array.isArray(input.works) || input.works.length > 32) throw new Error("Invalid purpose work projection.");
	if (!Array.isArray(input.unsettled) || input.unsettled.length > 32)
		throw new Error("Invalid purpose unsettled projection.");
	const results = ["pending", "working", "verified", "unsettled", "acknowledged", "blocked", "aborted"];
	return {
		missionId: nullable(input.missionId, missionText),
		revision: nullable(input.revision, missionNumber),
		digest: nullable(input.digest, (item) => missionText(item, 64)),
		purpose: nullable(input.purpose, (item) => missionText(item, 4096)),
		appliedSequence: missionNumber(input.appliedSequence),
		proposed: proposed && {
			revision: missionNumber(proposed.revision),
			digest: missionText(proposed.digest, 64),
			terms: parsePurposeTerms(proposed.terms),
		},
		operation,
		operationRevision: missionNumber(input.operationRevision),
		activity: nullable(input.activity, missionText),
		reason: nullable(input.reason, missionText),
		nextWakeAt: nullable(input.nextWakeAt, missionNumber),
		works: input.works.map((item) => {
			const work = missionObject(item);
			if (!results.includes(work.result as string)) throw new Error("Invalid purpose work result.");
			return {
				workId: missionText(work.workId),
				path: missionText(work.path, 512),
				result: work.result as WorkResult,
				runId: nullable(work.runId, (id) => missionText(id, 400)),
			};
		}),
		unsettled: input.unsettled.map((item) => {
			const run = missionObject(item);
			return {
				runId: missionText(run.runId, 400),
				workId: missionText(run.workId),
				path: missionText(run.path, 512),
				purposeRevision: missionNumber(run.purposeRevision),
			};
		}),
		used: {
			workItems: missionNumber(used.workItems),
			cycles: missionNumber(used.cycles),
			requests: missionNumber(used.requests),
			estimatedCost: missionNumber(used.estimatedCost),
			reservedCost: missionNumber(used.reservedCost),
			unknownRequests: missionNumber(used.unknownRequests),
			unpricedResponses: missionNumber(used.unpricedResponses),
		},
		limits: nullable(input.limits, (item) => {
			const limits = missionObject(item);
			return {
				maxWorkItems: missionNumber(limits.maxWorkItems),
				maxCycles: missionNumber(limits.maxCycles),
				maxRequests: missionNumber(limits.maxRequests),
				maxEstimatedCost: nullable(limits.maxEstimatedCost, missionNumber),
			};
		}),
		rollback: input.rollback,
	};
}

function result(run: LoopState["runs"][number]): WorkResult {
	if (run.state.status === "running") return "working";
	if (run.settlement === "unsettled") return "unsettled";
	// Done needs verified evidence; an acknowledged run without it is shown apart, as unfinished work.
	if (run.state.status === "verified") return "verified";
	if (run.settlement !== null && run.settlement !== "settled") return "acknowledged";
	return run.state.status;
}
