// Parses and binds the protected purpose grant, its receipts and operation intents; owner documents never grant them.
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalResearchWork, parseResearchCeiling, parseResearchWork, researchWorkDenial } from "./research-terms.ts";
import {
	isMissionDigest,
	type MissionApproval,
	type MissionAuthority,
	missionDigestText,
	missionInteger,
	missionNumber,
	missionObject,
	missionText,
	type OperationAcknowledgment,
	type OperationIntent,
	type PurposeCeiling,
	type PurposeLifetime,
	type PurposeTerms,
	type WorkTerms,
} from "./contract.ts";
import { creatorApproved, receiptBinds } from "./receipt.ts";

/** Most work items one purpose revision may list; bounds the stored runs and proposals. */
export const MAX_PURPOSE_WORKS = 32;

/** Validates the administrator's purpose-only grant: one capability, relative path prefixes and finite caps. */
export function parsePurposeCeiling(value: unknown): PurposeCeiling {
	const input = missionObject(value);
	const fields = [
		"capabilities",
		"paths",
		"maxWorkItems",
		"maxCycles",
		"maxRequests",
		"maxRetries",
		"maxConsecutiveNoProgress",
		"maxDurationMs",
		"maxEstimatedCost",
		"research",
	];
	if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unknown purpose ceiling field.");
	// Research is an explicit, separate grant: the capability and its finite caps come together or not at all.
	const capabilities = input.capabilities;
	const research = Array.isArray(capabilities) && capabilities.length === 2 && capabilities[1] === "research";
	if (
		!Array.isArray(capabilities) ||
		capabilities[0] !== "artifact-digest" ||
		(capabilities.length !== 1 && !research) ||
		research !== (input.research !== undefined)
	)
		throw new Error("A purpose ceiling grants artifact-digest, and research only with its research caps.");
	if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 16)
		throw new Error("A purpose ceiling needs 1 to 16 path prefixes.");
	const paths = input.paths.map((path) => workPath(missionText(path, 512), true));
	const ceiling: PurposeCeiling = {
		capabilities: research ? ["artifact-digest", "research"] : ["artifact-digest"],
		paths,
		maxWorkItems: count(input.maxWorkItems, 1, MAX_PURPOSE_WORKS),
		maxCycles: count(input.maxCycles, 1),
		maxRequests: count(input.maxRequests, 1),
		maxRetries: count(input.maxRetries, 0),
		maxConsecutiveNoProgress: count(input.maxConsecutiveNoProgress, 1),
		maxDurationMs: count(input.maxDurationMs, 1),
	};
	if (input.maxEstimatedCost !== undefined) ceiling.maxEstimatedCost = positive(input.maxEstimatedCost);
	if (research) ceiling.research = parseResearchCeiling(input.research);
	return ceiling;
}

/** Validates complete purpose terms crossing a wire or stored boundary; semantic limits are checked at approval. */
export function parsePurposeTerms(value: unknown): PurposeTerms {
	const input = missionObject(value);
	if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error("Purpose terms exceed 64 KiB.");
	if (Object.keys(input).some((key) => !["purpose", "scope", "reviewEveryMs", "works", "lifetime"].includes(key)))
		throw new Error("Unknown purpose term.");
	const purpose = missionText(input.purpose, 4096);
	const scope = missionText(input.scope, 4096);
	if (!purpose.trim() || !scope.trim()) throw new Error("A purpose needs its purpose and scope.");
	if (!Array.isArray(input.works) || input.works.length < 1 || input.works.length > MAX_PURPOSE_WORKS)
		throw new Error(`A purpose lists 1 to ${MAX_PURPOSE_WORKS} work items.`);
	const works = input.works.map(parseWorkTerms);
	const paths = works.flatMap((work) => (work.kind === "artifact-digest" ? [work.path] : []));
	if (new Set(paths).size !== paths.length) throw new Error("Purpose work items need distinct paths.");
	const lifetime = missionObject(input.lifetime);
	if (
		Object.keys(lifetime).some(
			(key) => !["maxWorkItems", "maxCycles", "maxRequests", "maxEstimatedCost", "deadlineAt"].includes(key),
		)
	)
		throw new Error("Unknown purpose lifetime limit.");
	const limits: PurposeLifetime = {
		maxWorkItems: count(lifetime.maxWorkItems, 1, MAX_PURPOSE_WORKS),
		maxCycles: count(lifetime.maxCycles, 1),
		maxRequests: count(lifetime.maxRequests, 1),
		deadlineAt: count(lifetime.deadlineAt, 1, 8_640_000_000_000_000),
	};
	if (lifetime.maxEstimatedCost !== undefined) limits.maxEstimatedCost = positive(lifetime.maxEstimatedCost);
	return { purpose, scope, reviewEveryMs: count(input.reviewEveryMs, 1), works, lifetime: limits };
}

/** Requires the purpose to fit the protected purpose ceiling; a one-shot tool ceiling grants no purpose work. */
export function validatePurposeTerms(terms: PurposeTerms, authority: MissionAuthority, now: number): PurposeTerms {
	const ceiling = authority.purposeCeiling;
	if (!ceiling) throw new Error("The creator authority grants no continuous purpose; provision a purpose ceiling.");
	for (const work of terms.works) {
		if (work.kind === "research") {
			const denial = researchWorkDenial(work, ceiling);
			if (denial) throw new Error(denial);
			continue;
		}
		if (!ceiling.paths.some((prefix) => work.path.startsWith(prefix)))
			throw new Error(`Work path ${work.path} is outside the creator's purpose paths.`);
		for (const key of ["maxCycles", "maxRequests", "maxRetries", "maxConsecutiveNoProgress"] as const)
			if (work[key] > ceiling[key]) throw new Error(`Work exceeds the ${key} purpose ceiling.`);
	}
	for (const key of ["maxWorkItems", "maxCycles", "maxRequests"] as const)
		if (terms.lifetime[key] > ceiling[key]) throw new Error(`Purpose exceeds the ${key} lifetime ceiling.`);
	if (terms.lifetime.deadlineAt <= now || terms.lifetime.deadlineAt - now > ceiling.maxDurationMs)
		throw new Error("Purpose deadline must be future and within creator authority.");
	if (
		ceiling.maxEstimatedCost !== undefined &&
		(terms.lifetime.maxEstimatedCost === undefined || terms.lifetime.maxEstimatedCost > ceiling.maxEstimatedCost)
	)
		throw new Error("Purpose estimated spend exceeds creator authority; this is not a billing guarantee.");
	return terms;
}

/** Hashes exact purpose terms bound to mission, revision, installation, session, authority revision and creator. */
export function purposeDigest(
	terms: PurposeTerms,
	missionId: string,
	revision: number,
	authority: Pick<MissionAuthority, "installationId" | "session" | "revision" | "creator">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: 1,
				kind: "unit.mission.purpose",
				installationId: authority.installationId,
				session: authority.session,
				missionId,
				revision,
				authorityRevision: authority.revision,
				creator: authority.creator,
				terms: canonicalTerms(terms),
			}),
		)
		.digest("hex");
}

/** Hashes one work definition, so identical work under a later purpose revision counts as already done. */
export function workDigest(work: WorkTerms): string {
	const identity =
		work.kind === "research"
			? canonicalResearchWork(work)
			: { kind: work.kind, path: work.path, sha256: work.sha256 };
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/**
 * Finds the current purpose receipt that agreed exactly these terms. Only the newest receipt counts, so issuing an
 * amendment closes the previous revision at once; a managed receipt also needs the creator's own assent.
 */
export function matchingPurposeApproval(
	authority: MissionAuthority,
	receiptId: string,
	missionId: string,
	revision: number,
	terms: PurposeTerms,
): MissionApproval | undefined {
	const receipt = authority.purposeApprovals?.at(-1);
	if (!receipt || receipt.receiptId !== receiptId) return undefined;
	const digest = purposeDigest(terms, missionId, revision, authority);
	return receiptBinds(authority, receipt, { receiptId, missionId, revision, digest }) && creatorApproved(authority, receipt)
		? receipt
		: undefined;
}

/** Validates the latest protected operation intent from the authority file. */
export function parseOperationIntent(value: unknown): OperationIntent {
	const input = missionObject(value);
	if (input.action !== "open" && input.action !== "suspend" && input.action !== "close")
		throw new Error("Unknown mission operation intent.");
	const requestId = missionText(input.requestId);
	const purposeDigest = missionText(input.purposeDigest, 64);
	const planDigest = input.planDigest === undefined ? undefined : missionText(input.planDigest, 64);
	if (planDigest !== undefined && (input.action !== "open" || !isMissionDigest(planDigest)))
		throw new Error("Invalid plan-bound open intent.");
	if (!requestId.trim() || !isMissionDigest(purposeDigest)) throw new Error("Invalid operation intent binding.");
	return {
		requestId,
		sequence: count(input.sequence, 1),
		missionId: missionText(input.missionId),
		purposeRevision: count(input.purposeRevision, 1),
		purposeDigest,
		...(planDigest === undefined ? {} : { planDigest }),
		authorityRevision: count(input.authorityRevision, 1),
		expectedOperationRevision: count(input.expectedOperationRevision, 0),
		action: input.action,
		issuedAt: missionNumber(input.issuedAt),
	};
}

/** Validates one protected acknowledgment of an unsettled run. */
export function parseOperationAcknowledgment(value: unknown): OperationAcknowledgment {
	const input = missionObject(value);
	const requestId = missionText(input.requestId);
	const runId = missionText(input.runId, 400);
	if (!requestId.trim() || !runId.trim()) throw new Error("Invalid operation acknowledgment binding.");
	return {
		requestId,
		missionId: missionText(input.missionId),
		runId,
		authorityRevision: count(input.authorityRevision, 1),
		issuedAt: missionNumber(input.issuedAt),
	};
}

function parseWorkTerms(value: unknown): WorkTerms {
	const input = missionObject(value);
	if (input.kind === "research") return parseResearchWork(input);
	const fields = [
		"kind",
		"path",
		"sha256",
		"instructions",
		"maxCycles",
		"maxRequests",
		"maxRetries",
		"maxConsecutiveNoProgress",
	];
	if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unknown purpose work term.");
	if (input.kind !== "artifact-digest") throw new Error("Purpose work supports only the artifact-digest kind.");
	const sha256 = missionDigestText(input.sha256, "Work needs an exact lowercase SHA-256.");
	return {
		kind: "artifact-digest",
		path: workPath(missionText(input.path, 512), false),
		sha256,
		instructions: missionText(input.instructions, 2048),
		maxCycles: count(input.maxCycles, 1),
		maxRequests: count(input.maxRequests, 1),
		maxRetries: count(input.maxRetries, 0),
		maxConsecutiveNoProgress: count(input.maxConsecutiveNoProgress, 1),
	};
}

// Workspace-relative POSIX paths only; the writer and verifier re-check symlinks and parents at the file boundary.
function workPath(path: string, prefix: boolean): string {
	if (
		path === "" ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes("\0") ||
		/[\r\n]/.test(path) ||
		path.split("/").some((part) => part === ".." || part === "." || (part === "" && !prefix))
	)
		throw new Error("Purpose paths must be workspace-relative without '.', '..' or empty parts.");
	if (prefix && !path.endsWith("/")) throw new Error("Purpose path prefixes end with '/'.");
	return path;
}

function canonicalTerms(terms: PurposeTerms): PurposeTerms {
	return {
		purpose: terms.purpose,
		scope: terms.scope,
		reviewEveryMs: terms.reviewEveryMs,
		// Artifact works keep their exact former shape, so every agreed artifact-only purpose keeps its digest.
		works: terms.works.map((work) =>
			work.kind === "research"
				? canonicalResearchWork(work)
				: {
						kind: work.kind,
						path: work.path,
						sha256: work.sha256,
						instructions: work.instructions,
						maxCycles: work.maxCycles,
						maxRequests: work.maxRequests,
						maxRetries: work.maxRetries,
						maxConsecutiveNoProgress: work.maxConsecutiveNoProgress,
					},
		),
		lifetime: {
			maxWorkItems: terms.lifetime.maxWorkItems,
			maxCycles: terms.lifetime.maxCycles,
			maxRequests: terms.lifetime.maxRequests,
			...(terms.lifetime.maxEstimatedCost === undefined ? {} : { maxEstimatedCost: terms.lifetime.maxEstimatedCost }),
			deadlineAt: terms.lifetime.deadlineAt,
		},
	};
}

function count(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
	return missionInteger(value, minimum, `Purpose limits need integers from ${minimum} to ${maximum}.`, maximum);
}

function positive(value: unknown): number {
	const number = missionNumber(value);
	if (number <= 0) throw new Error("Purpose estimated spend must be positive.");
	return number;
}
