// #72: Imports saved one-shot agreements into purpose and work records on real SQLite without widening authority.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createRegistry, defineDoc, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaintenanceDoc } from "../../src/maintenance.ts";
import {
	matchingApproval,
	missionAuthorityPath,
	missionDigest,
	readMissionAuthority,
	writeMissionAuthority,
} from "../../src/missions/authority.ts";
import type {
	MissionAgreement,
	MissionApproval,
	MissionAuthority,
	MissionCeiling,
	MissionDraft,
	MissionTerms,
} from "../../src/missions/contract.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { type MissionExecution, MissionExecutionDoc } from "../../src/missions/execution-state.ts";
import { MissionPurposeDoc, type MissionPurposeState, readMissionPurpose } from "../../src/missions/purpose.ts";
import { initialLoop } from "../../src/missions/purpose-loop.ts";
import { MissionDoc, MissionFoundation, type MissionRecord } from "../../src/missions/state.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-purpose-"));
	now = 1000;
});

afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const location = () => ({ kind: "developer-local" as const, directory, session: "default" });
const creator = { kind: "human" as const, id: "purpose-fixture", uid: process.getuid?.() ?? null };
const ceiling: MissionCeiling = {
	allowedTools: ["read", "write"],
	maxCycles: 5,
	maxRequests: 8,
	maxRetries: 2,
	maxConsecutiveNoProgress: 3,
	maxDurationMs: 100_000,
};

function terms(objective = "Keep the fixture repository's dependencies secure"): MissionTerms {
	return {
		objective,
		scope: "Only the fixture repository",
		successCriteria: ["Cite the advisories that were checked"],
		policy: {
			allowedTools: ["read"],
			maxCycles: 2,
			maxRequests: 4,
			maxRetries: 1,
			maxConsecutiveNoProgress: 2,
			deadlineAt: 50_000,
		},
		approvalBoundary: [],
		reviewEveryMs: 1000,
	};
}

async function launch() {
	const registry = createRegistry();
	registry.install(MissionFoundation);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "default.sqlite")),
		{ registry, models, now: () => now, setTimer: () => () => {} },
		context,
	);
	opened.push(harness);
	return { harness, faux, mission: new MissionControl(harness, location(), ["read", "write"], () => now) };
}

async function reopen(harness: Harness) {
	await harness.close(context);
	opened.splice(opened.indexOf(harness), 1);
	return launch();
}

// Issues a protected receipt exactly as a pre-#72 release did; the receipt is the only source of approval.
async function issue(revision: number, missionTerms: MissionTerms): Promise<MissionAgreement> {
	const prior = await readMissionAuthority(location());
	const authority: MissionAuthority = {
		schemaVersion: 1,
		installationId: null,
		session: "default",
		revision: 1,
		creator,
		ceiling,
		approvals: [],
	};
	const digest = missionDigest(missionTerms, "dependency-care", revision, authority);
	const approval: MissionApproval = {
		receiptId: randomUUID(),
		requestId: `approve-${revision}`,
		installationId: null,
		session: "default",
		missionId: "dependency-care",
		revision,
		digest,
		creator,
		authorityRevision: 1,
		approvedAt: now,
		provenance: "developer-local",
		approvedBy: { kind: "developer-local", uid: creator.uid },
	};
	await writeMissionAuthority(location(), {
		...authority,
		approvals: [...(prior?.approvals.slice(-1) ?? []), approval],
	});
	return {
		missionId: "dependency-care",
		revision,
		terms: missionTerms,
		digest,
		approval,
		execution: "not-implemented",
	};
}

// Writes the version-two formation an older owner saved, with no purpose document.
async function saveFormation(harness: Harness, agreement: MissionAgreement): Promise<void> {
	await harness.commit(async (tx) => {
		(await tx.doc(MissionDoc)).formation = {
			nextRevision: agreement.revision + 1,
			draft: null,
			agreement,
			lastOperation: {
				requestId: `propose-${agreement.revision}`,
				digest: "f".repeat(64),
				revision: agreement.revision,
			},
		};
	}, context);
}

// Writes the version-two execution ledger an older owner saved; its ids refer to a conversation and controller.
async function saveExecution(
	harness: Harness,
	agreement: MissionAgreement,
	state: MissionExecution["state"],
): Promise<void> {
	await harness.commit(async (tx) => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		(await tx.doc(MissionExecutionDoc)).current = {
			agreement,
			// The fixture keeps a stable controller reference; this test never schedules it.
			controller: 41 as TaskId<null>,
			conversation: conversation.id as ConversationId,
			providerSession: "unit-mission:fixture",
			revision: 9,
			policyRevision: 3,
			intent: { requestId: "pause-fixture", sequence: 2 },
			cycles: 2,
			requests: 3,
			retries: 1,
			noProgress: 1,
			estimatedCost: 0.25,
			reservedCost: 0.1,
			unknownRequests: 0,
			unpricedResponses: 1,
			pendingTools: [],
			evidence: [
				{ criterion: "Cite the advisories that were checked", observedAt: 900, accepted: false, detail: "missing" },
			],
			lastAnswer: null,
			submission: null,
			state,
		};
	}, context);
}

// Slice 1's stored shape: version one, without the loop.
const VersionOnePurposeDoc = defineDoc<Omit<MissionPurposeState, "loop">>({
	kind: "unit.mission.purpose",
	version: 1,
	scope: "session",
	initial: () => ({ purpose: null, work: [], operation: { status: "closed", reason: "autonomy_not_approved" } }),
	checkpointWhen: () => true,
});

// A later release's purpose document; this release must neither read nor overwrite it.
const NewerPurposeDoc = defineDoc<MissionPurposeState>({ ...MissionPurposeDoc.definition, version: 3 });

async function saveNewerPurpose(harness: Harness): Promise<void> {
	await harness.commit((tx) => tx.retireDoc(MissionPurposeDoc), context);
	await harness.commit(async (tx) => {
		(await tx.doc(NewerPurposeDoc)).purpose = null;
	}, context);
}

// Drafts, proposes and approves one revision through the owner's own developer-local path.
async function agreeLocal(mission: MissionControl, expectedRevision: number, objective: string) {
	const proposed = await proposeLocal(mission, expectedRevision, objective);
	return mission.handle(
		{
			operation: "approve-local",
			expectedRevision: proposed.formation.draft!.revision,
			digest: proposed.formation.draft!.digest!,
			requestId: `approve-${objective}`,
		},
		context,
	);
}

async function proposeLocal(mission: MissionControl, expectedRevision: number, objective: string) {
	const saved = await mission.handle(
		{ operation: "draft", expectedRevision, requestId: `draft-${objective}`, terms: terms(objective) },
		context,
	);
	return mission.handle(
		{ operation: "propose", expectedRevision: saved.formation.draft!.revision, requestId: `propose-${objective}` },
		context,
	);
}

// Issues a receipt for the proposed draft outside the owner, as the managed administrator command does.
async function issueForDraft(draft: MissionDraft): Promise<MissionApproval> {
	const authority = (await readMissionAuthority(location()))!;
	const receipt: MissionApproval = {
		receiptId: randomUUID(),
		requestId: `administrator-${draft.revision}`,
		installationId: null,
		session: "default",
		missionId: draft.missionId,
		revision: draft.revision,
		digest: draft.digest!,
		creator: authority.creator,
		authorityRevision: authority.revision,
		approvedAt: now,
		provenance: "developer-local",
		approvedBy: { kind: "developer-local", uid: creator.uid },
	};
	await writeMissionAuthority(location(), { ...authority, approvals: [...authority.approvals.slice(-1), receipt] });
	return receipt;
}

describe("legacy agreement import", () => {
	it("records a saved one-shot agreement as one purpose and its exact legacy work", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, agreement);
		const formation = (await first.harness.snapshot(MissionDoc, context))!;
		const view = await first.mission.inspect(context);
		const authorityFile = await readFile(missionAuthorityPath(location()), "utf8");
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		const saved = (await second.harness.snapshot(MissionPurposeDoc, context))!;
		expect(saved.purpose).toEqual({
			missionId: "dependency-care",
			revision: 1,
			purpose: agreement.terms.objective,
			scope: agreement.terms.scope,
			approvalBoundary: [],
			reviewEveryMs: 1000,
			creator,
			standingAuthority: { workSelection: "not-approved", grantableActions: [], allowances: "lifetime" },
			approval: { kind: "legacy-agreement", receiptId: agreement.approval.receiptId, digest: agreement.digest },
		});
		expect(saved.work).toEqual([
			{
				workId: "legacy-1",
				missionId: "dependency-care",
				purposeRevision: 1,
				source: { kind: "legacy-agreement", agreement },
			},
		]);
		expect(saved.operation).toEqual({ status: "closed", reason: "autonomy_not_approved" });
		// Formation, projection and protected authority stay byte-for-byte what the older owner wrote.
		expect(await second.harness.snapshot(MissionDoc, context)).toEqual(formation);
		expect(await second.mission.inspect(context)).toEqual(view);
		expect(await readFile(missionAuthorityPath(location()), "utf8")).toBe(authorityFile);
		expect((await second.harness.inspect(context)).tasks).toEqual([]);
		expect((await second.harness.inspect(context)).submissions).toEqual([]);
		expect(second.faux.state.callCount).toBe(0);
	});

	it("#72 migrates a stored version-one document to version two with an empty, closed loop", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, agreement);
		await first.mission.initialize(context);
		const current = (await first.harness.snapshot(MissionPurposeDoc, context))!;
		// Rewrite the stored document exactly as slice 1 (version 1, no loop) left it.
		const { loop: _loop, ...legacy } = current;
		await first.harness.commit((tx) => tx.retireDoc(MissionPurposeDoc), context);
		await first.harness.commit(async (tx) => {
			Object.assign(await tx.doc(VersionOnePurposeDoc), legacy);
		}, context);
		const second = await reopen(first.harness);
		const migrated = (await readMissionPurpose(second.harness, context))!;
		expect(migrated).toEqual({ ...legacy, loop: initialLoop() });
		expect(migrated.loop.operation.state).toEqual({ status: "closed" });
		expect(migrated.loop.ledger.workItems).toBe(0);
		expect(second.faux.state.callCount).toBe(0);
	});

	it("#72 grants no autonomous selection, actions or renewal from an old approval", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, agreement);
		await first.mission.initialize(context);
		const saved = (await first.harness.snapshot(MissionPurposeDoc, context))!;
		const authority = (await readMissionAuthority(location()))!;
		// The receipt still verifies only the exact old terms; the purpose reuses its digest and adds none.
		expect(saved.purpose!.approval.digest).toBe(missionDigest(agreement.terms, "dependency-care", 1, authority));
		expect(
			matchingApproval(
				authority,
				agreement.approval.receiptId,
				"dependency-care",
				1,
				saved.work[0].source.agreement.terms,
			),
		).toEqual(agreement.approval);
		expect(
			matchingApproval(authority, agreement.approval.receiptId, "dependency-care", 1, {
				...agreement.terms,
				policy: { ...agreement.terms.policy, allowedTools: ["read", "write"] },
			}),
		).toBeUndefined();
		expect(saved.purpose!.standingAuthority.workSelection).toBe("not-approved");
		expect(saved.purpose!.standingAuthority.grantableActions).toEqual([]);
		expect(saved.purpose!.standingAuthority.allowances).toBe("lifetime");
		expect(saved.operation.status).toBe("closed");
		expect(authority.approvals).toEqual([agreement.approval]);
	});

	it("preserves a paused execution ledger and links it to the same legacy work", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, agreement);
		await saveExecution(first.harness, agreement, { status: "paused" });
		const execution = await first.harness.snapshot(MissionExecutionDoc, context);
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		const saved = (await second.harness.snapshot(MissionPurposeDoc, context))!;
		expect(saved.work.map((work) => work.workId)).toEqual(["legacy-1"]);
		expect(saved.work[0].source.agreement).toEqual(execution!.current!.agreement);
		expect(await second.harness.snapshot(MissionExecutionDoc, context)).toEqual(execution);
		expect(second.faux.state.callCount).toBe(0);
	});

	it("keeps a stopped execution's older agreement as separate work under the amended purpose", async () => {
		const first = await launch();
		const original = await issue(1, terms());
		await saveExecution(first.harness, original, { status: "stopped" });
		const amended = await issue(3, terms("Keep dependencies and lockfiles secure"));
		await saveFormation(first.harness, amended);
		const execution = await first.harness.snapshot(MissionExecutionDoc, context);
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		const saved = (await second.harness.snapshot(MissionPurposeDoc, context))!;
		expect(saved.purpose).toMatchObject({
			revision: 3,
			purpose: "Keep dependencies and lockfiles secure",
			approval: { receiptId: amended.approval.receiptId, digest: amended.digest },
		});
		expect(saved.work.map((work) => [work.workId, work.purposeRevision])).toEqual([
			["legacy-1", 1],
			["legacy-3", 3],
		]);
		expect(saved.work[0].source.agreement).toEqual(original);
		expect(await second.harness.snapshot(MissionExecutionDoc, context)).toEqual(execution);
	});

	it("leaves a version-one holder without approved terms unrecorded", async () => {
		const first = await launch();
		const legacy = defineDoc<{ current: MissionRecord | null }>({
			kind: "unit.mission",
			version: 1,
			scope: "session",
			initial: () => ({ current: null }),
			checkpointWhen: () => true,
		});
		await first.harness.commit(async (tx) => {
			const control = await tx.createConversation({ ownership: { kind: "ownerless" } });
			(await tx.doc(legacy)).current = {
				missionId: "legacy-holder",
				policyRevision: 2,
				// The fixture keeps the stored holder reference only; this test never schedules it.
				controllerTaskId: 7 as TaskId<null>,
				objective: "Inspect the fixture",
				successCriteria: ["Report evidence"],
				policy: terms().policy,
				revision: 4,
				controlConversationId: control.id,
				executionConversationId: control.id,
				state: { status: "paused" },
			};
		}, context);
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		expect(await second.harness.snapshot(MissionPurposeDoc, context)).toBeUndefined();
		const migrated = (await second.harness.snapshot(MissionDoc, context))!;
		expect(migrated.current?.state).toEqual({ status: "paused" });
		expect(migrated.formation.agreement).toBeNull();
	});

	it("is idempotent across restarts and records a rollback reader's later amendment", async () => {
		const first = await launch();
		const original = await issue(1, terms());
		await saveFormation(first.harness, original);
		await first.mission.initialize(context);
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		const once = await second.harness.snapshot(MissionPurposeDoc, context);
		await second.mission.initialize(context);
		expect(await second.harness.snapshot(MissionPurposeDoc, context)).toBe(once);
		// A published rollback reader agrees an amendment without knowing the purpose document.
		const amended = await issue(2, terms("Keep dependencies and lockfiles secure"));
		await saveFormation(second.harness, amended);
		const third = await reopen(second.harness);
		await third.mission.initialize(context);
		const saved = (await third.harness.snapshot(MissionPurposeDoc, context))!;
		expect(saved.purpose?.revision).toBe(2);
		expect(saved.work.map((work) => work.source.agreement)).toEqual([original, amended]);
	});

	it("defers the import while maintenance holds the Session", async () => {
		const first = await launch();
		await saveFormation(first.harness, await issue(1, terms()));
		await first.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "held", operationId: "backup" };
		}, context);
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		expect(await second.harness.snapshot(MissionPurposeDoc, context)).toBeUndefined();
		await second.harness.commit(async (tx) => {
			(await tx.doc(MaintenanceDoc)).current = { protocol: 1, state: "open", operationId: null };
		}, context);
		await second.mission.initialize(context);
		expect((await second.harness.snapshot(MissionPurposeDoc, context))?.purpose?.revision).toBe(1);
	});

	it("keeps owner startup available when saved history conflicts or is newer", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, agreement);
		await first.mission.initialize(context);
		await first.harness.commit(async (tx) => {
			(await tx.doc(MissionPurposeDoc)).work[0].source.agreement.digest = "0".repeat(64);
		}, context);
		const conflicting = await first.harness.snapshot(MissionPurposeDoc, context);
		await expect(first.mission.initialize(context)).resolves.toBeUndefined();
		expect(await first.harness.snapshot(MissionPurposeDoc, context)).toEqual(conflicting);
		await first.harness.commit((tx) => tx.retireDoc(MissionPurposeDoc), context);
		await first.harness.commit((tx) => tx.doc(NewerPurposeDoc), context);
		const second = await reopen(first.harness);
		await expect(second.mission.initialize(context)).resolves.toBeUndefined();
		expect((await second.mission.inspect(context)).agreementValid).toBe(true);
		await expect(second.harness.snapshot(MissionPurposeDoc, context)).rejects.toThrow("newer version");
	});
});

describe("approval records purpose and work", () => {
	it("records the agreed purpose and its bounded work in the approval commit", async () => {
		const { harness, mission, faux } = await launch();
		await mission.handle({ operation: "configure-local", creator, ceiling }, context);
		await mission.handle({ operation: "draft", expectedRevision: 0, requestId: "draft", terms: terms() }, context);
		const proposed = await mission.handle(
			{ operation: "propose", expectedRevision: 1, requestId: "propose" },
			context,
		);
		const agreed = await mission.handle(
			{
				operation: "approve-local",
				expectedRevision: 1,
				digest: proposed.formation.draft!.digest!,
				requestId: "approve",
			},
			context,
		);
		const saved = (await harness.snapshot(MissionPurposeDoc, context))!;
		expect(saved.purpose?.approval).toEqual({
			kind: "legacy-agreement",
			receiptId: agreed.formation.agreement!.approval.receiptId,
			digest: agreed.formation.agreement!.digest,
		});
		expect(saved.work).toHaveLength(1);
		expect(saved.work[0].source.agreement).toEqual(agreed.formation.agreement);
		expect(saved.purpose?.standingAuthority.workSelection).toBe("not-approved");
		expect(agreed.execution).toBe("not-implemented");
		expect((await harness.inspect(context)).tasks).toEqual([]);
		expect(faux.state.callCount).toBe(0);
		const reopened = await reopen(harness);
		expect(await reopened.harness.snapshot(MissionPurposeDoc, context)).toEqual(saved);
	});
});

// Each change keeps the work item's receipt ID and digest, which is all the first import's shortcut compared.
const tamperings: [string, (state: MissionPurposeState) => void][] = [
	[
		"work scope diverges from its receipt",
		(state) => void (state.work[0].source.agreement.terms.scope = "Every repository"),
	],
	["purpose is null beside imported work", (state) => void (state.purpose = null)],
	["purpose scope differs from its work", (state) => void (state.purpose!.scope = "Every repository")],
	["work links to another purpose revision", (state) => void (state.work[0].purposeRevision = 2)],
	["operation is open", (state) => void Object.assign(state.operation, { status: "open" })],
	[
		"standing authority approves work selection",
		(state) => void Object.assign(state.purpose!.standingAuthority, { workSelection: "approved" }),
	],
	[
		"receipt copy gains a field",
		(state) => void Object.assign(state.work[0].source.agreement.approval, { scope: "all" }),
	],
];

describe("stored purpose records are a trust boundary", () => {
	it.each(tamperings)("#72 fails closed when %s", async (_name, tamper) => {
		const first = await launch();
		await saveFormation(first.harness, await issue(1, terms()));
		await first.mission.initialize(context);
		await first.harness.commit(async (tx) => tamper(await tx.doc(MissionPurposeDoc)), context);
		const tampered = await first.harness.snapshot(MissionPurposeDoc, context);
		// An amendment the import would otherwise record into the tampered document.
		await saveFormation(first.harness, await issue(2, terms("Keep dependencies and lockfiles secure")));
		const second = await reopen(first.harness);
		await expect(second.mission.initialize(context)).resolves.toBeUndefined();
		expect(await second.harness.snapshot(MissionPurposeDoc, context)).toEqual(tampered);
		await expect(readMissionPurpose(second.harness, context)).rejects.toThrow(/^Invalid stored mission/);
	});

	it("#72 imports nothing from a saved agreement whose terms differ from its receipt digest", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, { ...agreement, terms: { ...agreement.terms, scope: "Every repository" } });
		await first.mission.initialize(context);
		expect(await first.harness.snapshot(MissionPurposeDoc, context)).toBeUndefined();
		expect((await first.mission.inspect(context)).agreementValid).toBe(false);
	});

	it("#72 imports nothing when the execution ledger's agreement differs from its receipt", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, agreement);
		await saveExecution(
			first.harness,
			{
				...agreement,
				terms: { ...agreement.terms, policy: { ...agreement.terms.policy, allowedTools: ["read", "write"] } },
			},
			{ status: "stopped" },
		);
		await first.mission.initialize(context);
		expect(await first.harness.snapshot(MissionPurposeDoc, context)).toBeUndefined();
	});

	it("#72 keeps receipt provenance after the authority file stops recognizing the receipt", async () => {
		const first = await launch();
		const agreement = await issue(1, terms());
		await saveFormation(first.harness, agreement);
		// A creator reconfiguration drops every receipt; the history it approved stays verifiable from its own copy.
		const authority = (await readMissionAuthority(location()))!;
		await writeMissionAuthority(location(), { ...authority, revision: 2, approvals: [] });
		await first.mission.initialize(context);
		const saved = await readMissionPurpose(first.harness, context);
		expect(saved?.work.map((work) => work.source.agreement)).toEqual([agreement]);
		expect(saved?.purpose?.approval).toEqual({
			kind: "legacy-agreement",
			receiptId: agreement.approval.receiptId,
			digest: agreement.digest,
		});
		// History is not authority: the dropped receipt no longer approves the agreement.
		expect((await first.mission.inspect(context)).agreementValid).toBe(false);
	});
});

describe("approval while the purpose document is unreadable", () => {
	it("#72 refuses a new receipt and keeps the agreed revision in force", async () => {
		const { harness, mission, faux } = await launch();
		await mission.handle({ operation: "configure-local", creator, ceiling }, context);
		const agreed = await agreeLocal(mission, 0, "Keep dependencies secure");
		const proposed = await proposeLocal(mission, 1, "Keep dependencies and lockfiles secure");
		await saveNewerPurpose(harness);
		const newer = await harness.snapshot(NewerPurposeDoc, context);
		const authorityFile = await readFile(missionAuthorityPath(location()), "utf8");
		const draft = proposed.formation.draft!;
		await expect(
			mission.handle(
				{
					operation: "approve-local",
					expectedRevision: draft.revision,
					digest: draft.digest!,
					requestId: "approve-2",
				},
				context,
			),
		).rejects.toThrow("Mission purpose records are unreadable by this release; the agreed revision stays in force.");
		// The administrator command approves only a proposal, so refusing to propose also precedes its receipt.
		await expect(proposeLocal(mission, 2, "Keep every lockfile secure")).rejects.toThrow(
			"Mission purpose records are unreadable by this release",
		);
		expect(await readFile(missionAuthorityPath(location()), "utf8")).toBe(authorityFile);
		const view = await mission.inspect(context);
		expect(view.agreementValid).toBe(true);
		expect(view.formation.agreement).toEqual(agreed.formation.agreement);
		expect(await harness.snapshot(NewerPurposeDoc, context)).toEqual(newer);
		expect(faux.state.callCount).toBe(0);
	});

	it("#72 reconciles a receipt already issued at restart and preserves the newer document", async () => {
		const first = await launch();
		await first.mission.handle({ operation: "configure-local", creator, ceiling }, context);
		await agreeLocal(first.mission, 0, "Keep dependencies secure");
		const proposed = await proposeLocal(first.mission, 1, "Keep dependencies and lockfiles secure");
		await saveNewerPurpose(first.harness);
		const newer = await first.harness.snapshot(NewerPurposeDoc, context);
		const receipt = await issueForDraft(proposed.formation.draft!);
		// The issued receipt closes revision 1 at once; only reconciling revision 2 restores an agreement.
		expect((await first.mission.inspect(context)).agreementValid).toBe(false);
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		const view = await second.mission.inspect(context);
		expect(view.agreementValid).toBe(true);
		expect(view.formation.draft).toBeNull();
		expect(view.formation.agreement?.approval).toEqual(receipt);
		expect(await second.harness.snapshot(NewerPurposeDoc, context)).toEqual(newer);
		expect(second.faux.state.callCount).toBe(0);
	});

	it("#72 reconciles past an invalid document, and the next start imports once it is repaired", async () => {
		const first = await launch();
		await first.mission.handle({ operation: "configure-local", creator, ceiling }, context);
		await agreeLocal(first.mission, 0, "Keep dependencies secure");
		const proposed = await proposeLocal(first.mission, 1, "Keep dependencies and lockfiles secure");
		await first.harness.commit(async (tx) => {
			(await tx.doc(MissionPurposeDoc)).purpose = null;
		}, context);
		const invalid = await first.harness.snapshot(MissionPurposeDoc, context);
		const receipt = await issueForDraft(proposed.formation.draft!);
		const view = await first.mission.handle({ operation: "reconcile", receiptId: receipt.receiptId }, context);
		expect(view.agreementValid).toBe(true);
		expect(await first.harness.snapshot(MissionPurposeDoc, context)).toEqual(invalid);
		// Repair: the invalid document is retired; formation still holds the agreement to import.
		await first.harness.commit((tx) => tx.retireDoc(MissionPurposeDoc), context);
		const second = await reopen(first.harness);
		await second.mission.initialize(context);
		const saved = await readMissionPurpose(second.harness, context);
		expect(saved?.purpose?.revision).toBe(2);
		expect(saved?.work.map((work) => work.source.agreement)).toEqual([view.formation.agreement]);
	});
});
