// Separates the enduring mission purpose from bounded work and agent operation; these records grant no authority.
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import { missionDigest, parseCompleteMissionTerms, parseMissionApproval } from "./authority.ts";
import { type MissionAgreement, type MissionCreator, missionObject } from "./contract.ts";
import { MissionExecutionDoc } from "./execution-state.ts";
import { checkLoopState, initialLoop, type LoopState } from "./purpose-loop.ts";
import { MissionDoc } from "./state.ts";

/** What the creator approved beyond individual work; an imported one-shot approval approves nothing further. */
export type StandingAuthority = {
	workSelection: "not-approved";
	grantableActions: [];
	allowances: "lifetime";
};

/** One agreed purpose revision; its approval is the exact protected receipt and digest that agreed it. */
export type PurposeAgreement = {
	missionId: string;
	revision: number;
	purpose: string;
	scope: string;
	approvalBoundary: string[];
	reviewEveryMs: number;
	creator: MissionCreator;
	standingAuthority: StandingAuthority;
	approval: { kind: "legacy-agreement"; receiptId: string; digest: string };
};

/** One bounded unit of work under a purpose revision; legacy work keeps the exact approved one-shot agreement. */
export type WorkDefinition = {
	workId: string;
	missionId: string;
	purposeRevision: number;
	source: { kind: "legacy-agreement"; agreement: MissionAgreement };
};

/** Whether the agent may admit autonomous work; it stays closed until a creator approves autonomous selection. */
export type AgentOperation = { status: "closed"; reason: "autonomy_not_approved" };

/**
 * `purpose`, `work` and `operation` hold imported one-shot history and never open; `loop` holds purposes approved for
 * continuous operation. An imported one-shot amendment adds legacy work and never replaces a loop agreement.
 */
export type MissionPurposeState = {
	purpose: PurposeAgreement | null;
	work: WorkDefinition[];
	operation: AgentOperation;
	loop: LoopState;
};

/** Stores purpose, work definitions and agent operation beside the formation and execution documents it never replaces. */
export const MissionPurposeDoc = defineDoc<MissionPurposeState>({
	kind: "unit.mission.purpose",
	version: 2,
	scope: "session",
	initial: () => ({ purpose: null, work: [], operation: closedOperation(), loop: initialLoop() }),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`Unsupported mission purpose document version ${fromVersion}.`);
		// Version one holds imported one-shot history only; nothing it stored approves continuous operation.
		return { ...(value as Omit<MissionPurposeState, "loop">), loop: initialLoop() };
	},
	checkpointWhen: () => true,
});

/** Reads the stored purpose records after full validation; throws on a newer, malformed or self-inconsistent document. */
export async function readMissionPurpose(harness: Harness, context: Context): Promise<MissionPurposeState | undefined> {
	const saved = await harness.snapshot(MissionPurposeDoc, context);
	if (saved !== undefined) checkPurposeState(saved);
	return saved;
}

/**
 * The loop part of the stored purpose, validated inside the caller's transaction; undefined when validation fails.
 * Durable returns same-version fields as stored, so every loop phase and admission reads through this, never the raw
 * document: a tampered or corrupted ledger runs and admits nothing.
 */
export async function storedLoop(tx: Tx): Promise<LoopState | undefined> {
	return validPurposeLoop(await tx.doc(MissionPurposeDoc));
}

/**
 * The loop of a stored purpose document if the whole document validates, else undefined. Status reads through the
 * same check (`readMissionPurpose`), so a document status reports as invalid never runs or admits a loop effect.
 */
export function validPurposeLoop(state: MissionPurposeState | undefined): LoopState | undefined {
	if (state === undefined) return undefined;
	try {
		checkPurposeState(state);
	} catch {
		return undefined;
	}
	return state.loop;
}

/** Imports saved one-shot agreements as legacy work under their purpose; idempotent, and never touches protected authority. */
export async function importLegacyAgreements(harness: Harness, context: Context): Promise<void> {
	const agreements = [
		(await harness.snapshot(MissionExecutionDoc, context))?.current?.agreement,
		(await harness.snapshot(MissionDoc, context))?.formation.agreement,
	]
		.filter((agreement) => agreement != null)
		.map(parseLegacyAgreement);
	const saved = await readMissionPurpose(harness, context);
	// Every agreement is checked against saved history before the shortcut, so a conflict fails even when nothing is missing.
	const missing = agreements.filter((agreement) => !(saved && recorded(saved, agreement)));
	if (missing.length === 0) return;
	await harness.commit(async (tx) => {
		// A drained, held Session stays byte-stable for backup; the next owner start imports instead.
		if ((await tx.doc(MaintenanceDoc)).current.state === "held") return;
		for (const agreement of missing) await recordLegacyAgreement(tx, agreement);
	}, context);
}

/** Records one approved one-shot agreement as legacy work; the highest agreed revision is the current purpose. */
export async function recordLegacyAgreement(tx: Tx, agreement: MissionAgreement): Promise<void> {
	const exact = parseLegacyAgreement(agreement);
	const state = await tx.doc(MissionPurposeDoc);
	checkPurposeState(state);
	if (!recorded(state, exact)) state.work.push(legacyWork(exact));
	if (state.purpose === null || state.purpose.revision < exact.revision) state.purpose = legacyPurpose(exact);
}

function closedOperation(): AgentOperation {
	return { status: "closed", reason: "autonomy_not_approved" };
}

// Durable returns same-version application fields as stored, so the formation, execution and purpose documents are
// a trust boundary: an agreement counts only if it is exactly what its embedded receipt approved. The receipt copy,
// not the protected authority file, is the check, so history keeps its provenance after the file drops that receipt.
function parseLegacyAgreement(value: unknown): MissionAgreement {
	const input = missionObject(value);
	const terms = parseCompleteMissionTerms(input.terms);
	const approval = parseMissionApproval(input.approval);
	if (approval.session !== "default") throw new Error("Invalid stored mission agreement.");
	const exact: MissionAgreement = {
		missionId: approval.missionId,
		revision: approval.revision,
		terms,
		digest: missionDigest(terms, approval.missionId, approval.revision, {
			installationId: approval.installationId,
			session: approval.session,
			revision: approval.authorityRevision,
			creator: approval.creator,
		}),
		approval,
		execution: "not-implemented",
	};
	if (approval.digest !== exact.digest || !isDeepStrictEqual(value, exact))
		throw new Error("Invalid stored mission agreement.");
	return exact;
}

// The legacy part must be what recording its own agreements produces (links, purpose, closed operation); the loop part
// is checked against its own receipts and ledger.
function checkPurposeState(state: MissionPurposeState): void {
	const input = missionObject(state);
	if (!Array.isArray(input.work)) throw new Error("Invalid stored mission purpose records.");
	const agreements = input.work.map((item) =>
		parseLegacyAgreement(missionObject(missionObject(item).source).agreement),
	);
	const latest = agreements.reduce<MissionAgreement | null>(
		(best, agreement) => (best === null || agreement.revision > best.revision ? agreement : best),
		null,
	);
	const expected: MissionPurposeState = {
		purpose: latest && legacyPurpose(latest),
		work: agreements.map(legacyWork),
		operation: closedOperation(),
		loop: checkLoopState(input.loop),
	};
	if (
		new Set(expected.work.map((work) => work.workId)).size !== expected.work.length ||
		!isDeepStrictEqual(state, expected)
	)
		throw new Error("Invalid stored mission purpose records.");
}

function recorded(state: Pick<MissionPurposeState, "work">, agreement: MissionAgreement): boolean {
	const work = state.work.find((item) => item.workId === legacyWorkId(agreement));
	if (!work) return false;
	// One formation revision is agreed once; different approved content there means corrupted history, not an amendment.
	if (!isDeepStrictEqual(work.source.agreement, agreement)) throw new Error("Conflicting legacy mission agreement.");
	return true;
}

function legacyWork(agreement: MissionAgreement): WorkDefinition {
	return {
		workId: legacyWorkId(agreement),
		missionId: agreement.missionId,
		purposeRevision: agreement.revision,
		source: { kind: "legacy-agreement", agreement },
	};
}

function legacyWorkId(agreement: MissionAgreement): string {
	return `legacy-${agreement.revision}`;
}

function legacyPurpose(agreement: MissionAgreement): PurposeAgreement {
	const terms = agreement.terms;
	return {
		missionId: agreement.missionId,
		revision: agreement.revision,
		purpose: terms.objective,
		scope: terms.scope,
		approvalBoundary: terms.approvalBoundary,
		reviewEveryMs: terms.reviewEveryMs,
		creator: agreement.approval.creator,
		// The old receipt approved one bounded work item only; autonomous selection and renewal need a new approval.
		standingAuthority: { workSelection: "not-approved", grantableActions: [], allowances: "lifetime" },
		approval: { kind: "legacy-agreement", receiptId: agreement.approval.receiptId, digest: agreement.digest },
	};
}
