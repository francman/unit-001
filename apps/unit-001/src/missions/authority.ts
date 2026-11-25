// Binds mission approvals to protected host metadata instead of model-controlled conversation state.
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type BrowserAgreementGrant,
	isMissionDigest,
	type IssuedAgreement,
	type MissionApproval,
	type MissionAuthority,
	type MissionCeiling,
	type MissionDraftTerms,
	type MissionExecutionIntent,
	type MissionTerms,
	type PlanRequestBinding,
	missingMissionTerms,
	missionDigestText,
	missionInteger,
	missionNumber,
	missionObject,
	missionText,
	missionTextList,
	parseMissionCreator,
	parseMissionDraftTerms,
} from "./contract.ts";
import { parseOperationAcknowledgment, parseOperationIntent, parsePurposeCeiling } from "./purpose-authority.ts";
import { creatorApproved, receiptBinds } from "./receipt.ts";

export type MissionLocation =
	| { kind: "managed"; installationId: string; session: string }
	| { kind: "developer-local"; directory: string; session: string };

/** Resolves only fixed managed metadata paths; developer paths never claim administrator attestation. */
export function missionAuthorityPath(location: MissionLocation): string {
	if (location.kind === "developer-local") return join(location.directory, "mission-authority.json");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(location.installationId))
		throw new Error("Invalid mission installation identity.");
	return `/etc/unit-001/agents/${location.installationId}/mission-authority.json`;
}

/** Reads bounded, protected authority; absence leaves the mission unapproved rather than inventing a creator. */
export async function readMissionAuthority(location: MissionLocation): Promise<MissionAuthority | null> {
	if (location.session !== "default")
		throw new Error(
			"Mission formation belongs to the default owner session; this session remains available for ordinary work.",
		);
	const path = missionAuthorityPath(location);
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const owner = location.kind === "managed" ? 0 : (process.getuid?.() ?? info.uid);
	// Windows developer instances have no POSIX ownership attestation; their provenance remains explicitly local.
	const posix = location.kind === "managed" || process.platform !== "win32";
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		(posix && (info.uid !== owner || (info.mode & 0o022) !== 0)) ||
		info.size > 65536
	)
		throw new Error("Untrusted mission authority file.");
	// Developer data may use the platform's root-controlled /var or /tmp alias; managed paths are fixed and literal.
	await validateParents(location.kind === "developer-local" ? await realpath(path) : path, owner, location.kind, "read");
	const authority = parseMissionAuthority(JSON.parse(await readFile(path, "utf8")));
	if (
		authority.installationId !== (location.kind === "managed" ? location.installationId : null) ||
		authority.session !== location.session
	)
		throw new Error("Mission authority belongs to another installation or session.");
	return authority;
}

/** Publishes authority atomically; a managed authority can only be written by the host administrator. */
export async function writeMissionAuthority(location: MissionLocation, authority: MissionAuthority): Promise<void> {
	if (
		location.session !== "default" ||
		authority.session !== "default" ||
		authority.installationId !== (location.kind === "managed" ? location.installationId : null)
	)
		throw new Error("Mission authority binding mismatch.");
	if (location.kind === "managed" && (process.platform !== "linux" || process.geteuid?.() !== 0))
		throw new Error("Managed mission authority requires the host administrator.");
	const path = missionAuthorityPath(location);
	if (location.kind === "developer-local") await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await readMissionAuthority(location);
	// Even the first write must validate its parent before creating a temporary file. The raw directory is checked
	// before resolving it, so a symlinked directory is refused and never followed.
	const parent = await lstat(dirname(path));
	if (parent.isSymbolicLink()) throw new Error("Untrusted mission authority directory.");
	const owner = location.kind === "managed" ? 0 : (process.getuid?.() ?? parent.uid);
	await validateParents(
		location.kind === "developer-local" ? join(await realpath(dirname(path)), "mission-authority.json") : path,
		owner,
		location.kind,
		"write",
	);
	const data = `${JSON.stringify(parseMissionAuthority(authority))}\n`;
	if (Buffer.byteLength(data) > 65536) throw new Error("Mission authority exceeds 64 KiB.");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o644);
		try {
			await file.writeFile(data);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

// Every ancestor must be a directory only its owner or root can write. A write also holds the directory the file is
// created in to the stricter rule: owned by the file's owner, with no root or sticky-bit exemption.
async function validateParents(
	path: string,
	owner: number,
	provenance: MissionLocation["kind"],
	use: "read" | "write",
): Promise<void> {
	for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
		const entry = await lstat(parent);
		const strict = use === "write" && parent === dirname(path);
		const stickyRoot = !strict && provenance === "developer-local" && entry.uid === 0 && (entry.mode & 0o1000) !== 0;
		if (
			!entry.isDirectory() ||
			entry.isSymbolicLink() ||
			((provenance === "managed" || process.platform !== "win32") &&
				((entry.uid !== owner && (strict || entry.uid !== 0)) || ((entry.mode & 0o022) !== 0 && !stickyRoot)))
		)
			throw new Error("Untrusted mission authority directory.");
	}
}

/** Validates the administrator's finite authority ceiling independently of any draft. */
export function parseMissionCeiling(value: unknown): MissionCeiling {
	const input = missionObject(value);
	const allowedTools = missionTextList(input.allowedTools, 128, 100);
	const positive = ["maxCycles", "maxRequests", "maxConsecutiveNoProgress", "maxDurationMs"] as const;
	const result: MissionCeiling = {
		allowedTools,
		maxCycles: 0,
		maxRequests: 0,
		maxRetries: missionNumber(input.maxRetries),
		maxConsecutiveNoProgress: 0,
		maxDurationMs: 0,
	};
	for (const key of positive) {
		const number = missionNumber(input[key]);
		if (!Number.isSafeInteger(number) || number <= 0)
			throw new Error("Authority ceilings need positive finite integers.");
		result[key] = number;
	}
	if (!Number.isSafeInteger(result.maxRetries) || result.maxRetries < 0)
		throw new Error("Authority retry ceiling must be a nonnegative integer.");
	if (input.maxEstimatedCost !== undefined) {
		result.maxEstimatedCost = missionNumber(input.maxEstimatedCost);
		if (result.maxEstimatedCost <= 0) throw new Error("Authority estimated spend ceiling must be positive.");
	}
	if (
		Object.keys(input).some(
			(key) => ![...positive, "maxRetries", "allowedTools", "maxEstimatedCost"].some((field) => field === key),
		)
	)
		throw new Error("Unknown authority ceiling field.");
	return result;
}

/** Validates one receipt from protected metadata; owner documents are never used as its source. */
export function parseMissionApproval(value: unknown): MissionApproval {
	const input = missionObject(value);
	const installationId = input.installationId === null ? null : missionText(input.installationId);
	if (input.provenance !== "managed-administrator" && input.provenance !== "developer-local")
		throw new Error("Unknown approval provenance.");
	const revision = missionNumber(input.revision);
	const authorityRevision = missionNumber(input.authorityRevision);
	const digest = missionText(input.digest, 64);
	if (
		!Number.isSafeInteger(revision) ||
		revision < 1 ||
		!Number.isSafeInteger(authorityRevision) ||
		authorityRevision < 1 ||
		!isMissionDigest(digest)
	)
		throw new Error("Invalid mission approval revision or digest.");
	const actor = missionObject(input.approvedBy);
	if (actor.kind !== "local-creator" && actor.kind !== "host-administrator" && actor.kind !== "developer-local")
		throw new Error("Unknown approval actor provenance.");
	const uid = actor.uid === null ? null : missionNumber(actor.uid);
	if (uid !== null && (!Number.isSafeInteger(uid) || uid < 0)) throw new Error("Invalid approval actor UID.");
	const creator = parseMissionCreator(input.creator);
	if (
		input.provenance === "managed-administrator" &&
		(installationId === null || uid === null || creator.uid === null || actor.kind === "developer-local")
	)
		throw new Error("Managed approval needs authenticated host identities.");
	if (input.provenance === "developer-local" && (installationId !== null || actor.kind !== "developer-local"))
		throw new Error("Invalid developer-local approval binding.");
	return {
		receiptId: missionText(input.receiptId),
		requestId: missionText(input.requestId),
		installationId,
		session: missionText(input.session),
		missionId: missionText(input.missionId),
		revision,
		digest,
		creator,
		authorityRevision,
		approvedAt: missionNumber(input.approvedAt),
		provenance: input.provenance,
		approvedBy: { kind: actor.kind, uid },
	};
}

/** Validates bounded host authority metadata, including its current and pending approval receipts. */
export function parseMissionAuthority(value: unknown): MissionAuthority {
	const input = missionObject(value);
	if (
		input.schemaVersion !== 1 ||
		input.session !== "default" ||
		!Array.isArray(input.approvals) ||
		input.approvals.length > 2
	)
		throw new Error("Unsupported mission authority metadata.");
	const revision = missionNumber(input.revision);
	if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid mission authority revision.");
	const creator = parseMissionCreator(input.creator);
	if (input.installationId !== null && creator.uid === null)
		throw new Error("Managed creator needs an authenticated host UID.");
	const installationId = input.installationId === null ? null : missionText(input.installationId);
	const planApprovals =
		input.planApprovals === undefined ? undefined : boundedList(input.planApprovals, 2).map(parseMissionApproval);
	for (const receipt of planApprovals ?? []) {
		const managed = installationId !== null;
		if (
			receipt.installationId !== installationId ||
			receipt.session !== input.session ||
			receipt.authorityRevision > revision ||
			(receipt.authorityRevision === revision && JSON.stringify(receipt.creator) !== JSON.stringify(creator)) ||
			receipt.approvedBy.uid !== receipt.creator.uid ||
			receipt.provenance !== (managed ? "managed-administrator" : "developer-local") ||
			receipt.approvedBy.kind !== (managed ? "local-creator" : "developer-local") ||
			(managed && receipt.creator.uid === 0) ||
			!Number.isSafeInteger(receipt.approvedAt) ||
			receipt.approvedAt < 0 ||
			!receipt.requestId.trim() ||
			!receipt.receiptId.trim() ||
			!receipt.missionId.trim()
		)
			throw new Error("Plan approval does not bind this authority and creator.");
	}
	const planRequests =
		input.planRequests === undefined ? undefined : boundedList(input.planRequests, 32).map(parsePlanRequest);
	if (planRequests) {
		if (
			new Set(planRequests.map((item) => item.requestId)).size !== planRequests.length ||
			new Set(planRequests.map((item) => item.receiptId)).size !== planRequests.length ||
			planRequests.some(
				(item, index) =>
					item.authorityRevision > revision ||
					(index > 0 &&
						(item.missionId !== planRequests[index - 1].missionId ||
							item.revision <= planRequests[index - 1].revision ||
							item.authorityRevision < planRequests[index - 1].authorityRevision)),
			)
		)
			throw new Error("Invalid protected plan request history.");
	}
	if (planApprovals?.length === 2) {
		const [prior, head] = planApprovals;
		if (
			head.missionId !== prior.missionId ||
			head.revision <= prior.revision ||
			head.receiptId === prior.receiptId ||
			head.requestId === prior.requestId
		)
			throw new Error("Invalid protected plan receipt history.");
	}
	return {
		schemaVersion: 1,
		installationId,
		session: "default",
		revision,
		creator,
		ceiling: parseMissionCeiling(input.ceiling),
		approvals: input.approvals.map(parseMissionApproval),
		...(planApprovals === undefined ? {} : { planApprovals }),
		...(planRequests === undefined ? {} : { planRequests }),
		...(input.executionIntent === undefined
			? {}
			: { executionIntent: parseMissionExecutionIntent(input.executionIntent) }),
		// Purpose fields are optional and additive: an old writer drops them, which closes continuous operation.
		...(input.purposeCeiling === undefined ? {} : { purposeCeiling: parsePurposeCeiling(input.purposeCeiling) }),
		...(input.purposeApprovals === undefined
			? {}
			: { purposeApprovals: boundedList(input.purposeApprovals, 2).map(parseMissionApproval) }),
		...(input.operationIntent === undefined ? {} : { operationIntent: parseOperationIntent(input.operationIntent) }),
		...(input.operationAcknowledgments === undefined
			? {}
			: {
					operationAcknowledgments: boundedList(input.operationAcknowledgments, 8).map(
						parseOperationAcknowledgment,
					),
				}),
		// Additive too: a writer that drops the grant disables browser agreement, which is the safe direction.
		...(input.browserAgreement === undefined
			? {}
			: { browserAgreement: parseBrowserAgreementGrant(input.browserAgreement) }),
	};
}

function parsePlanRequest(value: unknown): PlanRequestBinding {
	const input = missionObject(value);
	const fields = ["requestId", "receiptId", "missionId", "revision", "digest", "authorityRevision", "issuedAt"];
	if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unknown plan request field.");
	const requestId = missionText(input.requestId);
	const receiptId = missionText(input.receiptId);
	const missionId = missionText(input.missionId);
	const digest = missionText(input.digest, 64);
	if (!requestId.trim() || !receiptId.trim() || !missionId.trim() || !isMissionDigest(digest))
		throw new Error("Invalid plan request binding.");
	return {
		requestId,
		receiptId,
		missionId,
		digest,
		revision: counter(input.revision, 1),
		authorityRevision: counter(input.authorityRevision, 1),
		issuedAt: counter(input.issuedAt, 0),
	};
}

/**
 * Most browser-issued receipts one grant records. Entries are never evicted (an evicted request ID could later name
 * different terms); at this count the helper refuses new request IDs until the administrator issues a new grant.
 */
export const MAX_ISSUED_AGREEMENTS = 32;

function parseBrowserAgreementGrant(value: unknown): BrowserAgreementGrant {
	const input = missionObject(value);
	const fields = ["enabled", "creatorUid", "serviceUid", "authorityRevision", "generation", "issued"];
	if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unknown browser agreement field.");
	if (typeof input.enabled !== "boolean") throw new Error("Invalid browser agreement grant.");
	const grant: BrowserAgreementGrant = {
		enabled: input.enabled,
		creatorUid: counter(input.creatorUid, 1),
		serviceUid: counter(input.serviceUid, 1),
		authorityRevision: counter(input.authorityRevision, 1),
		generation: counter(input.generation, 1),
		issued: boundedList(input.issued, MAX_ISSUED_AGREEMENTS).map(parseIssuedAgreement),
	};
	// Bob's tools run as the service UID; a grant naming it as the creator would let the agent approve its own mission.
	if (grant.creatorUid === grant.serviceUid) throw new Error("Browser agreement creator must not be the service account.");
	if (new Set(grant.issued.map((item) => item.requestId)).size !== grant.issued.length)
		throw new Error("Duplicate browser agreement request ID.");
	return grant;
}

function parseIssuedAgreement(value: unknown): IssuedAgreement {
	const input = missionObject(value);
	const fields = ["requestId", "receiptId", "missionId", "revision", "digest", "authorityRevision", "previousReceipt", "issuedAt"];
	if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unknown issued agreement field.");
	const digest = missionDigestText(input.digest, "Invalid issued agreement digest.");
	return {
		requestId: missionText(input.requestId, 64),
		receiptId: missionText(input.receiptId),
		missionId: missionText(input.missionId),
		revision: counter(input.revision, 1),
		digest,
		authorityRevision: counter(input.authorityRevision, 1),
		previousReceipt: input.previousReceipt === null ? null : missionText(input.previousReceipt),
		issuedAt: counter(input.issuedAt, 0),
	};
}

function counter(value: unknown, minimum: number): number {
	return missionInteger(value, minimum, "Invalid protected authority counter.");
}

function boundedList(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error("Unsupported mission authority metadata.");
	return value;
}

/** Validates the latest protected lifecycle intent, never accepting it from an ordinary owner-wire frame. */
export function parseMissionExecutionIntent(value: unknown): MissionExecutionIntent {
	const input = missionObject(value);
	if (input.action !== "start" && input.action !== "pause" && input.action !== "resume" && input.action !== "stop")
		throw new Error("Unknown mission lifecycle intent.");
	const sequence = missionNumber(input.sequence);
	const agreementRevision = missionNumber(input.agreementRevision);
	const authorityRevision = missionNumber(input.authorityRevision);
	const expectedPolicyRevision = missionNumber(input.expectedPolicyRevision);
	const agreementDigest = missionText(input.agreementDigest, 64);
	const requestId = missionText(input.requestId);
	if (
		!requestId.trim() ||
		![sequence, agreementRevision, authorityRevision].every((number) => Number.isSafeInteger(number) && number > 0) ||
		!Number.isSafeInteger(expectedPolicyRevision) ||
		expectedPolicyRevision < 0 ||
		!/^[a-f0-9]{64}$/.test(agreementDigest)
	)
		throw new Error("Invalid mission lifecycle binding.");
	return {
		requestId,
		sequence,
		missionId: missionText(input.missionId),
		agreementRevision,
		agreementDigest,
		authorityRevision,
		expectedPolicyRevision,
		action: input.action,
		issuedAt: missionNumber(input.issuedAt),
	};
}

/** Requires complete terms, real registered tools and limits within the provisioned ceiling. */
export function validateMissionTerms(
	draft: MissionDraftTerms,
	authority: MissionAuthority,
	tools: readonly string[],
	now: number,
): MissionTerms {
	const missing = missingMissionTerms(draft);
	if (missing.length) throw new Error(`Complete mission terms: ${missing.join(", ")}.`);
	// Completeness above establishes every required field in the bounded draft schema.
	const terms = draft as MissionTerms;
	if (
		new Set(terms.policy.allowedTools).size !== terms.policy.allowedTools.length ||
		terms.policy.allowedTools.some((tool) => !tools.includes(tool) || !authority.ceiling.allowedTools.includes(tool))
	)
		throw new Error("Mission tool actions must be registered and within creator authority.");
	for (const key of ["maxCycles", "maxRequests", "maxRetries", "maxConsecutiveNoProgress"] as const)
		if (terms.policy[key] > authority.ceiling[key]) throw new Error(`Mission exceeds the ${key} authority ceiling.`);
	if (terms.policy.deadlineAt <= now || terms.policy.deadlineAt - now > authority.ceiling.maxDurationMs)
		throw new Error("Mission deadline must be future and within creator authority.");
	if (
		authority.ceiling.maxEstimatedCost !== undefined &&
		(terms.policy.maxEstimatedCost === undefined ||
			terms.policy.maxEstimatedCost > authority.ceiling.maxEstimatedCost)
	)
		throw new Error("Mission estimated spend exceeds creator authority; this is not a billing guarantee.");
	return terms;
}

/** Hashes the fixed approved schema, binding exact terms, principal, installation, session and revisions. */
export function missionDigest(
	terms: MissionTerms,
	missionId: string,
	revision: number,
	authority: Pick<MissionAuthority, "installationId" | "session" | "revision" | "creator">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: 1,
				installationId: authority.installationId,
				session: authority.session,
				missionId,
				revision,
				authorityRevision: authority.revision,
				creator: authority.creator,
				terms: {
					objective: terms.objective,
					scope: terms.scope,
					successCriteria: terms.successCriteria,
					policy: {
						allowedTools: terms.policy.allowedTools,
						maxCycles: terms.policy.maxCycles,
						maxRequests: terms.policy.maxRequests,
						maxRetries: terms.policy.maxRetries,
						maxConsecutiveNoProgress: terms.policy.maxConsecutiveNoProgress,
						deadlineAt: terms.policy.deadlineAt,
						...(terms.policy.maxEstimatedCost === undefined
							? {}
							: { maxEstimatedCost: terms.policy.maxEstimatedCost }),
					},
					approvalBoundary: terms.approvalBoundary,
					reviewEveryMs: terms.reviewEveryMs,
				},
			}),
		)
		.digest("hex");
}

/**
 * Checks exact receipt binding; neither an approval-looking wire frame nor an owner document can grant authority.
 * Unlike purpose and plan receipts, a managed one-shot receipt may also be the host administrator's own approval.
 */
export function matchingApproval(
	authority: MissionAuthority,
	receiptId: string,
	missionId: string,
	revision: number,
	terms: MissionTerms,
): MissionApproval | undefined {
	// Only the newest receipt counts: issuing an amendment closes the previous authority immediately, including across
	// an owner crash or stale draft.
	const receipt = authority.approvals.at(-1);
	const digest = missionDigest(terms, missionId, revision, authority);
	if (!receipt || !receiptBinds(authority, receipt, { receiptId, missionId, revision, digest })) return undefined;
	const administrator = authority.installationId !== null && receipt.approvedBy.kind === "host-administrator";
	return administrator || creatorApproved(authority, receipt) ? receipt : undefined;
}

/** Validates complete terms received across a protocol boundary before a host approves them. */
export function parseCompleteMissionTerms(value: unknown): MissionTerms {
	const draft = parseMissionDraftTerms(value);
	const missing = missingMissionTerms(draft);
	if (missing.length) throw new Error(`Incomplete mission proposal: ${missing.join(", ")}.`);
	return draft as MissionTerms;
}
