// Projects bounded mission execution facts and validates them at owner-client boundaries.
import { missionNumber, missionObject, missionText } from "./contract.ts";
import type { MissionEvidence, MissionExecution } from "./execution-state.ts";

export type MissionExecutionView = {
	missionId: string;
	objective: string;
	agreementRevision: number;
	agreementDigest: string;
	intentSequence: number;
	revision: number;
	policyRevision: number;
	controller: number;
	conversation: number;
	status: MissionExecution["state"]["status"];
	blocker: string | null;
	nextWakeAt: number | null;
	cycles: number;
	requests: number;
	retries: number;
	noProgress: number;
	estimatedCost: number;
	reservedCost: number;
	unknownRequests: number;
	unpricedResponses: number;
	uncertainTools: number;
	evidence: MissionEvidence[];
	observedAt: number;
};

/** Reports current evidence, limits consumed and waiting reasons without treating task completion as mission success. */
export function missionExecutionView(current: MissionExecution, now: number): MissionExecutionView {
	return {
		missionId: current.agreement.missionId,
		objective: current.agreement.terms.objective,
		agreementRevision: current.agreement.revision,
		agreementDigest: current.agreement.digest,
		intentSequence: current.intent?.sequence ?? 0,
		revision: current.revision,
		policyRevision: current.policyRevision,
		controller: current.controller,
		conversation: current.conversation,
		status: current.state.status,
		blocker:
			current.state.status === "blocked"
				? current.state.reason
				: current.state.status === "waiting"
					? current.state.reason
					: null,
		nextWakeAt: current.state.status === "waiting" ? current.state.until : null,
		cycles: current.cycles,
		requests: current.requests,
		retries: current.retries,
		noProgress: current.noProgress,
		estimatedCost: current.estimatedCost,
		reservedCost: current.reservedCost,
		unknownRequests: current.unknownRequests,
		unpricedResponses: current.unpricedResponses,
		uncertainTools: current.pendingTools.length,
		evidence: current.evidence,
		observedAt: now,
	};
}

/** Rejects malformed execution reports from an owner or remote endpoint before rendering them. */
export function parseMissionExecutionView(value: unknown): MissionExecutionView {
	const input = missionObject(value);
	const status = input.status;
	if (
		status !== "ready" &&
		status !== "running" &&
		status !== "waiting" &&
		status !== "paused" &&
		status !== "blocked" &&
		status !== "completed" &&
		status !== "stopped"
	)
		throw new Error("Invalid mission execution status.");
	const counts = [
		"revision",
		"policyRevision",
		"agreementRevision",
		"intentSequence",
		"controller",
		"conversation",
		"cycles",
		"requests",
		"retries",
		"noProgress",
		"unknownRequests",
		"unpricedResponses",
		"uncertainTools",
	] as const;
	const numbers = Object.fromEntries(
		counts.map((key) => {
			const number = missionNumber(input[key]);
			if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid mission execution count.");
			return [key, number];
		}),
	);
	const estimatedCost = missionNumber(input.estimatedCost);
	const reservedCost = missionNumber(input.reservedCost);
	if (estimatedCost < 0 || reservedCost < 0 || !Array.isArray(input.evidence) || input.evidence.length > 32)
		throw new Error("Invalid mission evidence or estimate.");
	const evidence = input.evidence.map((value) => {
		const item = missionObject(value);
		if (typeof item.accepted !== "boolean") throw new Error("Invalid mission evidence decision.");
		return {
			criterion: missionText(item.criterion, 2000),
			observedAt: missionNumber(item.observedAt),
			accepted: item.accepted,
			detail: missionText(item.detail, 1000),
		};
	});
	return {
		missionId: missionText(input.missionId),
		objective: missionText(input.objective, 4096),
		agreementRevision: numbers.agreementRevision,
		agreementDigest: missionText(input.agreementDigest, 64),
		intentSequence: numbers.intentSequence,
		revision: numbers.revision,
		policyRevision: numbers.policyRevision,
		controller: numbers.controller,
		conversation: numbers.conversation,
		status,
		blocker: input.blocker === null ? null : missionText(input.blocker),
		nextWakeAt: input.nextWakeAt === null ? null : missionNumber(input.nextWakeAt),
		cycles: numbers.cycles,
		requests: numbers.requests,
		retries: numbers.retries,
		noProgress: numbers.noProgress,
		estimatedCost,
		reservedCost,
		unknownRequests: numbers.unknownRequests,
		unpricedResponses: numbers.unpricedResponses,
		uncertainTools: numbers.uncertainTools,
		evidence,
		observedAt: missionNumber(input.observedAt),
	};
}
