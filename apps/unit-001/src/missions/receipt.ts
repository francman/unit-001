// The receipt rule every mission approval kind shares: a protected receipt binds this authority epoch and exact terms.
import { randomUUID } from "node:crypto";
import type { MissionApproval, MissionAuthority } from "./contract.ts";

/** What a receipt must name to approve a revision: its own ID and the mission, revision and digest it approved. */
export type ReceiptBinding = { receiptId: string; missionId: string; revision: number; digest: string };

/**
 * Whether a protected receipt binds the current authority epoch and exactly these terms: installation, session,
 * authority revision, provenance and creator, then the expected receipt, mission, revision and digest. Who may approve
 * is each kind's own rule (`creatorApproved`); a plan also binds its predecessor.
 */
export function receiptBinds(authority: MissionAuthority, receipt: MissionApproval, expected: ReceiptBinding): boolean {
	return (
		receipt.receiptId === expected.receiptId &&
		receipt.installationId === authority.installationId &&
		receipt.session === authority.session &&
		receipt.missionId === expected.missionId &&
		receipt.revision === expected.revision &&
		receipt.authorityRevision === authority.revision &&
		receipt.digest === expected.digest &&
		receipt.provenance === (authority.installationId === null ? "developer-local" : "managed-administrator") &&
		receipt.creator.kind === authority.creator.kind &&
		receipt.creator.id === authority.creator.id &&
		receipt.creator.uid === authority.creator.uid
	);
}

/** Whether a receipt records the creator's own assent: the creator's UID, as the local creator when managed. */
export function creatorApproved(authority: MissionAuthority, receipt: MissionApproval): boolean {
	const managed = authority.installationId !== null;
	return (
		receipt.approvedBy.kind === (managed ? "local-creator" : "developer-local") &&
		receipt.approvedBy.uid === authority.creator.uid
	);
}

/** A developer-local receipt for exact terms, approved now by this process's own OS user. */
export function developerReceipt(
	authority: MissionAuthority,
	approved: { requestId: string; missionId: string; revision: number; digest: string },
	approvedAt: number,
): MissionApproval {
	return {
		receiptId: randomUUID(),
		requestId: approved.requestId,
		installationId: null,
		session: "default",
		missionId: approved.missionId,
		revision: approved.revision,
		digest: approved.digest,
		creator: authority.creator,
		authorityRevision: authority.revision,
		approvedAt,
		provenance: "developer-local",
		approvedBy: { kind: "developer-local", uid: process.getuid?.() ?? null },
	};
}
