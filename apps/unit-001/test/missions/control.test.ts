// #14: Mission agreement persists without executing work or accepting conversation claims as authority.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missionAuthorityPath, readMissionAuthority, writeMissionAuthority } from "../../src/missions/authority.ts";
import type { MissionCeiling, MissionTerms } from "../../src/missions/contract.ts";
import { MissionControl } from "../../src/missions/control.ts";
import { MissionDoc, MissionFoundation } from "../../src/missions/state.ts";

let directory: string;
let now: number;
const opened: Harness[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-control-"));
	now = 1000;
});
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});

const ceiling: MissionCeiling = {
	allowedTools: ["read"],
	maxCycles: 3,
	maxRequests: 5,
	maxRetries: 1,
	maxConsecutiveNoProgress: 2,
	maxDurationMs: 10000,
	maxEstimatedCost: 1,
};
const creator = { kind: "human" as const, id: "local-fixture", uid: process.getuid?.() ?? null };
function terms(): MissionTerms {
	return {
		objective: "Inspect a fixture repository",
		scope: "Only inspect the fixture",
		successCriteria: ["Cite the inspected evidence"],
		policy: {
			allowedTools: ["read"],
			maxCycles: 2,
			maxRequests: 4,
			maxRetries: 1,
			maxConsecutiveNoProgress: 2,
			deadlineAt: 10000,
			maxEstimatedCost: 0.5,
		},
		approvalBoundary: ["Ask before changing files"],
		reviewEveryMs: 1000,
	};
}

async function launch(session = "default") {
	const registry = createRegistry();
	registry.install(MissionFoundation);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, `${session}.sqlite`)),
		{ registry, models, now: () => now, setTimer: () => () => {} },
		context,
	);
	opened.push(harness);
	const location = { kind: "developer-local" as const, directory, session };
	const mission = new MissionControl(harness, location, ["read", "write"], () => now);
	return { harness, mission, faux, location };
}

async function configure(mission: MissionControl) {
	return mission.handle({ operation: "configure-local", creator, ceiling }, context);
}
async function propose(mission: MissionControl) {
	await configure(mission);
	const saved = await mission.handle(
		{ operation: "draft", expectedRevision: 0, requestId: "draft-1", terms: terms() },
		context,
	);
	return mission.handle(
		{ operation: "propose", expectedRevision: saved.formation.draft!.revision, requestId: "propose-1" },
		context,
	);
}

describe("mission formation", () => {
	it("preserves an incomplete draft and exact revision across a closed SQLite restart", async () => {
		const first = await launch();
		const saved = await first.mission.handle(
			{
				operation: "draft",
				expectedRevision: 0,
				requestId: "partial",
				terms: { objective: "Watch the fixture repository" },
			},
			context,
		);
		expect(saved.stage).toBe("awaiting_creator");
		expect(saved.formation.draft?.status).toBe("editing");
		await first.harness.close(context);
		opened.splice(opened.indexOf(first.harness), 1);
		const second = await launch();
		await second.mission.initialize(context);
		expect(await second.mission.inspect(context)).toEqual(saved);
		expect((await second.harness.inspect(context)).tasks).toEqual([]);
		expect((await second.harness.inspect(context)).submissions).toEqual([]);
		expect(second.faux.state.callCount).toBe(0);
	});

	it("saves exact approval without allocating a controller or claiming execution", async () => {
		const { harness, mission, faux } = await launch();
		const proposed = await propose(mission);
		const draft = proposed.formation.draft!;
		const agreed = await mission.handle(
			{
				operation: "approve-local",
				expectedRevision: draft.revision,
				digest: draft.digest!,
				requestId: "approve-1",
			},
			context,
		);
		expect(agreed.stage).toBe("agreed");
		expect(agreed.agreementValid).toBe(true);
		expect(agreed.formation.agreement?.approval.provenance).toBe("developer-local");
		expect(agreed.execution).toBe("not-implemented");
		expect((await harness.snapshot(MissionDoc, context))?.current).toBeNull();
		expect((await harness.inspect(context)).tasks).toEqual([]);
		expect(faux.state.callCount).toBe(0);
		expect(
			await mission.handle(
				{
					operation: "approve-local",
					expectedRevision: draft.revision,
					digest: draft.digest!,
					requestId: "approve-1",
				},
				context,
			),
		).toEqual(agreed);
	});

	it("reconciles a protected pending receipt after a crash before the document commit", async () => {
		const first = await launch();
		const proposed = await propose(first.mission);
		const draft = proposed.formation.draft!;
		await first.mission.handle(
			{ operation: "approve-local", expectedRevision: draft.revision, digest: draft.digest!, requestId: "issued" },
			context,
		);
		// Restore only the uncommitted owner projection; the issued authority receipt is the crash boundary.
		await first.harness.commit(async (tx) => {
			const state = await tx.doc(MissionDoc);
			state.formation = proposed.formation;
		}, context);
		await first.harness.close(context);
		opened.splice(opened.indexOf(first.harness), 1);
		const second = await launch();
		await second.mission.initialize(context);
		expect((await second.mission.inspect(context)).agreementValid).toBe(true);
		expect(second.faux.state.callCount).toBe(0);
	});

	it("#14 keeps startup available when a pending receipt names a tool removed by a release", async () => {
		const { harness, mission, location, faux } = await launch();
		const proposed = await propose(mission);
		const draft = proposed.formation.draft!;
		await mission.handle(
			{ operation: "approve-local", expectedRevision: draft.revision, digest: draft.digest!, requestId: "issued" },
			context,
		);
		await harness.commit(async (tx) => {
			(await tx.doc(MissionDoc)).formation = proposed.formation;
		}, context);
		const changed = new MissionControl(harness, location, ["write"], () => now);
		await expect(changed.initialize(context)).resolves.toBeUndefined();
		const view = await changed.inspect(context);
		expect(view.stage).toBe("awaiting_approval");
		expect(view.formation.draft).toEqual(draft);
		expect(view.formation.agreement).toBeNull();
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects stale, conflicting and forged approvals and permits only exact latest draft replay", async () => {
		const { mission } = await launch();
		await configure(mission);
		const request = { operation: "draft" as const, expectedRevision: 0, requestId: "stable", terms: terms() };
		const saved = await mission.handle(request, context);
		expect(await mission.handle(request, context)).toEqual(saved);
		await expect(
			mission.handle({ ...request, terms: { objective: "Conflicting purpose" } }, context),
		).rejects.toThrow("Conflicting");
		await expect(mission.handle({ ...request, requestId: "stale" }, context)).rejects.toThrow("Stale");
		await expect(mission.handle({ operation: "reconcile", receiptId: "claimed-by-model" }, context)).rejects.toThrow(
			"No exact proposed",
		);
		const proposed = await mission.handle(
			{ operation: "propose", expectedRevision: 1, requestId: "proposed" },
			context,
		);
		await expect(
			mission.handle(
				{
					operation: "approve-local",
					expectedRevision: 2,
					digest: proposed.formation.draft!.digest!,
					requestId: "wrong",
				},
				context,
			),
		).rejects.toThrow("Stale");
		await expect(mission.handle({ operation: "reconcile", receiptId: "claimed-by-model" }, context)).rejects.toThrow(
			"does not match",
		);
	});

	it.each(["tools", "requests", "deadline", "spend"])("rejects %s beyond provisioned authority", async (kind) => {
		const { mission } = await launch();
		await configure(mission);
		const input = terms();
		if (kind === "tools") input.policy.allowedTools = ["write"];
		else if (kind === "requests") input.policy.maxRequests = 6;
		else if (kind === "deadline") input.policy.deadlineAt = 20000;
		else input.policy.maxEstimatedCost = 2;
		await mission.handle({ operation: "draft", expectedRevision: 0, requestId: "outside", terms: input }, context);
		await expect(
			mission.handle({ operation: "propose", expectedRevision: 1, requestId: "propose" }, context),
		).rejects.toThrow(/authority|ceiling/);
	});

	it("does not replace a current agreement when an operator edits its next draft", async () => {
		const { mission } = await launch();
		const proposed = await propose(mission);
		const draft = proposed.formation.draft!;
		const agreed = await mission.handle(
			{ operation: "approve-local", expectedRevision: draft.revision, digest: draft.digest!, requestId: "first" },
			context,
		);
		const next = await mission.handle(
			{
				operation: "draft",
				expectedRevision: draft.revision,
				requestId: "amend",
				terms: { ...terms(), objective: "Changed objective" },
			},
			context,
		);
		expect(next.agreementValid).toBe(true);
		expect(next.formation.agreement).toEqual(agreed.formation.agreement);
		expect(next.formation.draft?.revision).toBe(2);
	});

	it("keeps expired or changed authority from authorizing work after restart", async () => {
		const { mission, location } = await launch();
		const proposed = await propose(mission);
		const draft = proposed.formation.draft!;
		await mission.handle(
			{ operation: "approve-local", expectedRevision: draft.revision, digest: draft.digest!, requestId: "first" },
			context,
		);
		now = 10000;
		expect((await mission.inspect(context)).agreementValid).toBe(false);
		now = 1000;
		const authority = (await readMissionAuthority(location))!;
		await writeMissionAuthority(location, { ...authority, revision: 2, approvals: [] });
		await mission.initialize(context);
		expect((await mission.inspect(context)).agreementValid).toBe(false);
	});

	it("rejects managed local-approval/configuration bypasses even through the private API", async () => {
		const { harness } = await launch();
		const managed = new MissionControl(
			harness,
			{ kind: "managed", installationId: "11111111-1111-4111-8111-111111111111", session: "default" },
			["read"],
			() => now,
		);
		await expect(managed.handle({ operation: "configure-local", creator, ceiling }, context)).rejects.toThrow(
			"administrator",
		);
		await expect(
			managed.handle(
				{ operation: "approve-local", expectedRevision: 1, digest: "a".repeat(64), requestId: "forged" },
				context,
			),
		).rejects.toThrow("administrator");
	});

	it("does not route other sessions into the default mission", async () => {
		const { mission, location } = await launch("other");
		await expect(
			mission.handle({ operation: "draft", expectedRevision: 0, requestId: "other", terms: terms() }, context),
		).rejects.toThrow("default");
		await expect(readFile(missionAuthorityPath(location))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
