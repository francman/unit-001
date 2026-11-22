// Managed one-click browser agreement: the gateway review and helper call, and the root helper that issues the receipt.
import { createHash } from "node:crypto";
import {
	matchingApproval,
	MAX_ISSUED_AGREEMENTS,
	missionDigest,
	parseCompleteMissionTerms,
	validateMissionTerms,
} from "./authority.ts";
import {
	type IssuedAgreement,
	MANAGED_MISSION_ACTIONS,
	type MissionApproval,
	type MissionAuthority,
	type MissionDraft,
	type MissionRequest,
	type MissionTerms,
	type MissionView,
	missionObject,
} from "./contract.ts";
import { type MissionRefusalCode, parseMissionRefusalCode } from "./refusal.ts";

/** The exact proposal the creator reviewed and clicked, and the protected receipt that was current when they did. */
export type AgreementClick = {
	revision: number;
	digest: string;
	requestId: string;
	/** The newest protected receipt the review saw; issuance is a compare-and-swap against it. */
	previousReceipt: string | null;
};

/**
 * What happened, as the gateway must report it: `issued` means the receipt is published (reconciliation may still be
 * pending), `refused` means nothing was written, `unknown` means the write may or may not have happened.
 */
export type AgreementOutcome =
	| { status: "issued"; receiptId: string; reconciled: boolean }
	| { status: "refused"; code: MissionRefusalCode }
	| { status: "unknown" };

/** The host operations the helper runs under; the root dispatcher supplies real ones, tests supply fixtures. */
export type AgreementHost = {
	installationId: string;
	/** The service UID from the root-owned installation record, never from the caller or the service. */
	serviceUid: number;
	/** Serializes with every other protected writer (the installation management lock); waiting ends when `signal` aborts. */
	lock<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>;
	readAuthority(): Promise<MissionAuthority | null>;
	writeAuthority(authority: MissionAuthority): Promise<void>;
	/** Whether maintenance or an unfinished update holds the installation; any owner wait ends when `signal` aborts. */
	held(signal: AbortSignal): Promise<boolean>;
	/** One request to the existing owner over its administrator socket, abandoned when `signal` aborts. */
	owner(request: MissionRequest, signal: AbortSignal): Promise<MissionView>;
	now(): number;
	receiptId(): string;
};

/** What the gateway shows for agreement, computed from protected authority and the exact terms it sends the browser. */
export type AgreementReview = {
	missionId: string;
	revision: number;
	/** The gateway's own digest of the terms it renders; the owner's claimed digest is never shown. */
	digest: string;
	authorityRevision: number;
	/** The newest protected receipt at review time; the click carries it unchanged as `previousReceipt`. */
	previousReceipt: string | null;
};

/** The only environment the dispatcher passes to the helper: built from nothing, never filtered from the caller's. */
export const AGREEMENT_ENVIRONMENT: Readonly<Record<string, string>> = {
	PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
	LANG: "C.UTF-8",
};

/**
 * Whether protected authority arms browser agreement for this gateway's account: enabled for exactly this creator UID
 * and the current authority revision, and never for root or the service UID. The gateway checks it at launch and again
 * at dispatch, together with the grant's `generation`.
 */
export function browserAgreementArmed(authority: MissionAuthority | null, uid: number): boolean {
	const grant = authority?.browserAgreement;
	return (
		authority != null &&
		grant !== undefined &&
		grant.enabled &&
		uid !== 0 &&
		uid !== grant.serviceUid &&
		grant.creatorUid === uid &&
		authority.creator.uid === uid &&
		grant.authorityRevision === authority.revision
	);
}

/**
 * The review for a proposed draft, or null when there is nothing agreeable: the gateway hashes the draft terms itself
 * against protected authority (read with `readMissionAuthority`) at status time, never at click time.
 */
export function agreementReview(draft: MissionDraft | null, authority: MissionAuthority): AgreementReview | null {
	if (draft?.status !== "proposed") return null;
	let terms: MissionTerms;
	try {
		terms = parseCompleteMissionTerms(draft.terms);
	} catch {
		return null;
	}
	return {
		missionId: draft.missionId,
		revision: draft.revision,
		digest: missionDigest(terms, draft.missionId, draft.revision, authority),
		authorityRevision: authority.revision,
		previousReceipt: authority.approvals.at(-1)?.receiptId ?? null,
	};
}

/**
 * The fixed `execFile` call for one click: sudo without a prompt, the installation's root-owned helper, the four exact
 * options and the clean environment. The helper's request ID is derived from the browser's, so a retried click replays.
 */
export function agreementInvocation(
	installationId: string,
	review: Pick<AgreementReview, "revision" | "digest" | "previousReceipt">,
	browserRequestId: string,
): { file: string; args: string[]; env: Readonly<Record<string, string>> } {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId))
		throw new Error("Invalid mission installation identity.");
	return {
		file: "/usr/bin/sudo",
		args: [
			"-n",
			`/usr/lib/unit-001/agents/${installationId}/mission-agree`,
			"--revision",
			String(review.revision),
			"--digest",
			review.digest,
			"--request-id",
			agreementRequestKey(browserRequestId),
			"--previous-receipt",
			review.previousReceipt ?? "none",
		],
		env: AGREEMENT_ENVIRONMENT,
	};
}

/** The helper's one stdout line for its outcome. */
export function formatAgreementOutcome(outcome: AgreementOutcome): string {
	return `${JSON.stringify(outcome)}\n`;
}

function agreementRequestKey(requestId: string): string {
	return createHash("sha256").update(requestId).digest("hex");
}

/** Looks up an exact issued click from protected history, including after the grant is disabled. */
export function lookupIssuedAgreement(
	click: AgreementClick,
	authority: MissionAuthority | null,
	uid: number | undefined,
	view: MissionView | null,
): AgreementOutcome | undefined {
	const grant = authority?.browserAgreement;
	if (
		authority === null ||
		grant === undefined ||
		uid === undefined ||
		uid === 0 ||
		uid === grant.serviceUid ||
		uid !== authority.creator.uid ||
		uid !== grant.creatorUid
	)
		return { status: "unknown" };
	const requestKey = agreementRequestKey(click.requestId);
	const issued = grant.issued.find((entry) => entry.requestId === requestKey);
	if (issued === undefined) return undefined;
	if (
		issued.revision !== click.revision ||
		issued.digest !== click.digest ||
		issued.previousReceipt !== click.previousReceipt
	)
		return { status: "refused", code: "conflicting-request" };
	const receipt = authority.approvals.at(-1);
	if (receipt?.receiptId !== issued.receiptId || receipt.authorityRevision !== authority.revision)
		return { status: "unknown" };
	const active = view?.formation.agreement;
	const reconciled =
		active != null &&
		active.approval.receiptId === issued.receiptId &&
		active.digest === receipt.digest &&
		matchingApproval(authority, issued.receiptId, active.missionId, active.revision, active.terms) !== undefined;
	return { status: "issued", receiptId: issued.receiptId, reconciled };
}

/**
 * Reads the helper's outcome after it exited. Only exit 0 with exactly one well-formed outcome line counts; a signal,
 * timeout, other exit or malformed output is `unknown`, never a refusal, since the receipt may have been published.
 */
export function parseAgreementOutcome(stdout: string, exitCode: number | null): AgreementOutcome {
	const oneLine = stdout.indexOf("\n") === stdout.length - 1;
	if (exitCode !== 0 || !oneLine) return { status: "unknown" };
	try {
		const input = missionObject(JSON.parse(stdout));
		const keys = Object.keys(input).sort().join(",");
		if (input.status === "refused" && keys === "code,status")
			return { status: "refused", code: parseMissionRefusalCode(input.code) };
		if (
			input.status === "issued" &&
			keys === "receiptId,reconciled,status" &&
			typeof input.receiptId === "string" &&
			typeof input.reconciled === "boolean"
		)
			return { status: "issued", receiptId: input.receiptId, reconciled: input.reconciled };
	} catch {
		// Falls through: unreadable output proves nothing about the write.
	}
	return { status: "unknown" };
}

/** Parses the helper's fixed argv: each of the four options exactly once, canonical values, nothing else. */
export function parseAgreementArguments(argv: readonly string[]): AgreementClick {
	const patterns: Record<string, RegExp> = {
		"--revision": /^[1-9][0-9]{0,14}$/,
		"--digest": /^[0-9a-f]{64}$/,
		"--request-id": /^[A-Za-z0-9-]{1,64}$/,
		"--previous-receipt": /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
	};
	const values = new Map<string, string>();
	if (argv.length !== 8) throw new Error("Browser agreement takes exactly four options.");
	for (let index = 0; index < argv.length; index += 2) {
		const [flag, value] = [argv[index]!, argv[index + 1]!];
		const pattern = patterns[flag];
		if (pattern === undefined || values.has(flag) || !pattern.test(value))
			throw new Error("Invalid browser agreement argument.");
		values.set(flag, value);
	}
	const previous = values.get("--previous-receipt")!;
	return {
		revision: Number(values.get("--revision")),
		digest: values.get("--digest")!,
		requestId: values.get("--request-id")!,
		previousReceipt: previous === "none" ? null : previous,
	};
}

/**
 * The invoking creator's UID from sudo's own variables, checked against the account database; null when they disagree.
 * Root itself and any other invoker never count as the creator.
 */
export function agreementActor(
	env: Readonly<Record<string, string | undefined>>,
	account: (uid: number) => { name: string; uid: number } | null,
): number | null {
	const uid = Number(env.SUDO_UID);
	if (env.SUDO_UID === undefined || !/^[1-9][0-9]{0,9}$/.test(env.SUDO_UID) || !Number.isSafeInteger(uid)) return null;
	const entry = account(uid);
	return entry !== null && entry.uid === uid && entry.name === env.SUDO_USER ? uid : null;
}

/**
 * Publishes a managed receipt for exactly the clicked proposal, or refuses before writing. Everything is re-read and
 * recomputed under the management lock from protected authority and the owner's current draft; the lock wait and every
 * owner wait end by `deadlineAt`. A replayed request ID never mints: it reports its own receipt, without needing a
 * current draft, and reconciles it while it is still current.
 */
export async function issueBrowserAgreement(
	click: AgreementClick,
	actorUid: number | null,
	host: AgreementHost,
	deadlineAt: number,
): Promise<AgreementOutcome> {
	const signal = AbortSignal.timeout(Math.max(0, deadlineAt - host.now()));
	try {
		return await host.lock(signal, async () => {
			const decision = await decide(click, actorUid, host, signal);
			if (decision.status !== "write") return decision;
			if (host.now() >= deadlineAt) return refused("unavailable");
			await host.writeAuthority(decision.authority);
			const reconciled = await reconcile(decision.receipt, decision.authority, host, signal);
			return { status: "issued", receiptId: decision.receipt.receiptId, reconciled };
		});
	} catch {
		// A failed lock or read may hide an earlier issuance. A failed write may already have published.
		return { status: "unknown" };
	}
}

type Decision = AgreementOutcome | { status: "write"; authority: MissionAuthority; receipt: MissionApproval };

async function decide(
	click: AgreementClick,
	actorUid: number | null,
	host: AgreementHost,
	signal: AbortSignal,
): Promise<Decision> {
	const authority = await host.readAuthority();
	if (authority === null) return { status: "unknown" };
	// No host-administrator fallback and never the service UID that runs Bob's tools: only the creator's own account
	// agrees from the browser, replays included.
	if (
		actorUid === null ||
		actorUid === 0 ||
		actorUid === host.serviceUid ||
		authority.creator.uid === host.serviceUid ||
		actorUid !== authority.creator.uid
	)
		return refused("creator-mismatch");
	const grant = authority.browserAgreement;
	if (grant === undefined) return { status: "unknown" };
	const replay = grant.issued.find((item) => item.requestId === click.requestId);
	if (replay) return replayed(replay, click, authority, host, signal);
	if (
		!grant.enabled ||
		grant.creatorUid !== authority.creator.uid ||
		grant.serviceUid !== host.serviceUid ||
		grant.authorityRevision !== authority.revision
	)
		return refused("not-enabled");
	// Bindings are never evicted, so a full grant stops taking new request IDs instead of forgetting old ones.
	if (grant.issued.length >= MAX_ISSUED_AGREEMENTS) return refused("agreement-limit");
	const newest = authority.approvals.at(-1) ?? null;
	if ((newest?.receiptId ?? null) !== click.previousReceipt) return refused("stale-authority");
	if (await host.held(signal)) return refused("held");
	// Formation revisions only grow, so a protected receipt at this revision or later means it was already agreed or
	// superseded; the service-owned draft is never asked.
	if ((newest?.revision ?? 0) >= click.revision || grant.issued.some((item) => item.revision >= click.revision))
		return refused("already-issued");
	const view = await host.owner({ operation: "status" }, signal);
	const draft = view.formation.draft;
	if (view.runtime && view.execution !== "stopped" && view.execution !== "completed")
		return refused("execution-active");
	if (!draft || draft.status !== "proposed" || draft.revision !== click.revision) return refused("stale-revision");
	const now = host.now();
	let digest: string;
	try {
		const terms = validateMissionTerms(draft.terms, authority, MANAGED_MISSION_ACTIONS, now);
		digest = missionDigest(terms, draft.missionId, draft.revision, authority);
	} catch {
		// A proposed draft was complete, so failing now means the deadline passed or the ceiling no longer admits it.
		return refused("outside-authority");
	}
	if (digest !== click.digest || draft.digest !== click.digest) return refused("stale-digest");
	const receipt: MissionApproval = {
		receiptId: host.receiptId(),
		requestId: click.requestId,
		installationId: host.installationId,
		session: "default",
		missionId: draft.missionId,
		revision: draft.revision,
		digest,
		creator: authority.creator,
		authorityRevision: authority.revision,
		approvedAt: now,
		provenance: "managed-administrator",
		approvedBy: { kind: "local-creator", uid: actorUid },
	};
	const issued: IssuedAgreement = {
		requestId: click.requestId,
		receiptId: receipt.receiptId,
		missionId: receipt.missionId,
		revision: receipt.revision,
		digest,
		authorityRevision: authority.revision,
		previousReceipt: click.previousReceipt,
		issuedAt: now,
	};
	// As the terminal approve keeps it: the agreed receipt stays beside the new one until the owner records it.
	const active = authority.approvals.find((item) => item.receiptId === view.formation.agreement?.approval.receiptId);
	return {
		status: "write",
		receipt,
		authority: {
			...authority,
			approvals: active ? [active, receipt] : [receipt],
			browserAgreement: { ...grant, issued: [...grant.issued, issued] },
		},
	};
}

// The request's receipt exists, so the answer is never a refusal: issued (reconciled or pending) while the receipt is
// still the current one at this authority revision, otherwise unknown for the creator to inspect.
async function replayed(
	replay: IssuedAgreement,
	click: AgreementClick,
	authority: MissionAuthority,
	host: AgreementHost,
	signal: AbortSignal,
): Promise<AgreementOutcome> {
	if (
		replay.revision !== click.revision ||
		replay.digest !== click.digest ||
		replay.previousReceipt !== click.previousReceipt
	)
		return refused("conflicting-request");
	const receipt = authority.approvals.at(-1);
	if (
		receipt?.receiptId !== replay.receiptId ||
		receipt.authorityRevision !== authority.revision ||
		authority.browserAgreement?.serviceUid !== host.serviceUid
	)
		return { status: "unknown" };
	return {
		status: "issued",
		receiptId: receipt.receiptId,
		reconciled: await reconcile(receipt, authority, host, signal),
	};
}

// A published receipt stays issued when a hold, failure or timeout stops reconciliation; a replay or the owner's next
// start reconciles it. Success needs the owner's agreement to match the protected receipt exactly, terms recomputed.
async function reconcile(
	receipt: MissionApproval,
	authority: MissionAuthority,
	host: AgreementHost,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		if (await host.held(signal)) return false;
		const agreement = (await host.owner({ operation: "reconcile", receiptId: receipt.receiptId }, signal)).formation
			.agreement;
		return (
			agreement !== null &&
			agreement.approval.receiptId === receipt.receiptId &&
			agreement.missionId === receipt.missionId &&
			agreement.revision === receipt.revision &&
			agreement.digest === receipt.digest &&
			missionDigest(parseCompleteMissionTerms(agreement.terms), receipt.missionId, receipt.revision, authority) ===
				receipt.digest
		);
	} catch {
		return false;
	}
}

function refused(code: MissionRefusalCode): { status: "refused"; code: MissionRefusalCode } {
	return { status: "refused", code };
}
