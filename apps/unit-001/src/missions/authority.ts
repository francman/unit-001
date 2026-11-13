// Binds mission approvals to protected host metadata instead of model-controlled conversation state.
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type MissionApproval,
	type MissionAuthority,
	type MissionCeiling,
	type MissionDraftTerms,
	type MissionTerms,
	missingMissionTerms,
	missionNumber,
	missionObject,
	missionText,
	missionTextList,
	parseMissionCreator,
	parseMissionDraftTerms,
} from "./contract.ts";

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
	await validateParents(location.kind === "developer-local" ? await realpath(path) : path, owner, location.kind);
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
	// Even the first write must validate its parent before creating a temporary file.
	const parent = await lstat(dirname(path));
	const owner = location.kind === "managed" ? 0 : (process.getuid?.() ?? parent.uid);
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		((location.kind === "managed" || process.platform !== "win32") &&
			(parent.uid !== owner || (parent.mode & 0o022) !== 0))
	)
		throw new Error("Untrusted mission authority directory.");
	await validateParents(
		location.kind === "developer-local" ? join(await realpath(dirname(path)), "mission-authority.json") : path,
		owner,
		location.kind,
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

async function validateParents(path: string, owner: number, provenance: MissionLocation["kind"]): Promise<void> {
	for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
		const entry = await lstat(parent);
		const stickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
		if (
			!entry.isDirectory() ||
			entry.isSymbolicLink() ||
			((provenance === "managed" || process.platform !== "win32") &&
				((entry.uid !== 0 && entry.uid !== owner) ||
					((entry.mode & 0o022) !== 0 && !(provenance === "developer-local" && stickyRoot))))
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
		!/^[0-9a-f]{64}$/.test(digest)
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
	return {
		schemaVersion: 1,
		installationId: input.installationId === null ? null : missionText(input.installationId),
		session: "default",
		revision,
		creator,
		ceiling: parseMissionCeiling(input.ceiling),
		approvals: input.approvals.map(parseMissionApproval),
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
	authority: MissionAuthority,
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

/** Checks exact receipt binding; neither an approval-looking wire frame nor an owner document can grant authority. */
export function matchingApproval(
	authority: MissionAuthority,
	receiptId: string,
	missionId: string,
	revision: number,
	terms: MissionTerms,
): MissionApproval | undefined {
	// Issuing an amendment closes the previous authority immediately, including across an owner crash or stale draft.
	if (authority.approvals.at(-1)?.receiptId !== receiptId) return undefined;
	const digest = missionDigest(terms, missionId, revision, authority);
	return authority.approvals.find(
		(receipt) =>
			receipt.receiptId === receiptId &&
			receipt.installationId === authority.installationId &&
			receipt.session === authority.session &&
			receipt.missionId === missionId &&
			receipt.revision === revision &&
			receipt.authorityRevision === authority.revision &&
			receipt.digest === digest &&
			receipt.provenance === (authority.installationId === null ? "developer-local" : "managed-administrator") &&
			JSON.stringify(receipt.creator) === JSON.stringify(authority.creator),
	);
}

/** Validates complete terms received across a protocol boundary before a host approves them. */
export function parseCompleteMissionTerms(value: unknown): MissionTerms {
	const draft = parseMissionDraftTerms(value);
	const missing = missingMissionTerms(draft);
	if (missing.length) throw new Error(`Incomplete mission proposal: ${missing.join(", ")}.`);
	return draft as MissionTerms;
}
