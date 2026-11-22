#!/usr/bin/env node
// Installed-bundle administrator entry: writes protected approvals and contacts the existing owner, never SQLite or Models.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	missionDigest,
	parseMissionCeiling,
	readMissionAuthority,
	validateMissionTerms,
	writeMissionAuthority,
} from "../app/dist/missions/authority.js";
import { MANAGED_MISSION_ACTIONS, missionObject, parseMissionCreator } from "../app/dist/missions/contract.js";
import { parsePurposeCeiling, purposeDigest, validatePurposeTerms } from "../app/dist/missions/purpose-authority.js";
import { parseMissionView } from "../app/dist/missions/wire.js";
import { installationPaths, readInstallation, withManagementLock } from "./installation.mjs";
import { readUpdateJournal } from "./update-activation.mjs";

if (process.platform !== "linux" || process.geteuid() !== 0)
	throw new Error("Managed mission authority requires the host administrator.");
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		id: { type: "string" },
		file: { type: "string" },
		revision: { type: "string" },
		digest: { type: "string" },
		"request-id": { type: "string" },
		"policy-revision": { type: "string" },
		"operation-revision": { type: "string" },
		run: { type: "string" },
		json: { type: "boolean" },
	},
});
const operateAction = positionals[0] === "operate" ? positionals[1] : undefined;
if (
	!values.id ||
	positionals.length !== (operateAction === undefined ? 1 : 2) ||
	!["creator", "approve", "approve-purpose", "operate", "start", "pause", "resume", "stop"].includes(positionals[0]) ||
	(positionals[0] === "operate" && !["open", "suspend", "close", "acknowledge"].includes(operateAction))
)
	throw new Error(
		"Usage: NAME mission creator --file FILE | approve --revision N --digest SHA256 | approve-purpose --revision N --digest SHA256 | operate open|suspend|close|acknowledge [--operation-revision N] [--request-id ID] [--run ID] | start|pause|resume|stop [--policy-revision N] [--request-id ID]",
	);
const record = readInstallation(values.id);
const location = { kind: "managed", installationId: record.id, session: "default" };
const actorUid = process.env.SUDO_UID === undefined ? 0 : Number(process.env.SUDO_UID);
if (!Number.isSafeInteger(actorUid) || actorUid < 0) throw new Error("Invalid administrator origin UID.");
const actor = execFileSync("getent", ["passwd", String(actorUid)], { encoding: "utf8" })
	.trim()
	.split(":");
if (actor[2] !== String(actorUid) || (process.env.SUDO_UID !== undefined && actor[0] !== process.env.SUDO_USER))
	throw new Error("Administrator origin does not match its OS account.");

await withManagementLock(async () => {
	const current = readInstallation(record.id);
	if (current.name !== record.name || current.desiredState === "uninstalled")
		throw new Error("The installation changed; retry its current command.");
	const journal = readUpdateJournal(record.id);
	if (journal && journal.phase !== "complete")
		throw new Error("Recover the incomplete update before changing mission authority.");
	const view = await owner({ operation: "status" });
	const previous = await readMissionAuthority(location);
	if (positionals[0] === "approve-purpose") return approvePurpose(view, previous);
	if (positionals[0] === "operate") return operatePurpose(view, previous);
	if (values["operation-revision"] !== undefined || values.run !== undefined)
		throw new Error("--operation-revision and --run belong to mission operate.");
	if (["start", "pause", "resume", "stop"].includes(positionals[0])) {
		if (values.file || values.revision || values.digest || previous === null || !view.formation.agreement)
			throw new Error(
				"Approve the mission before changing execution; lifecycle commands do not accept formation fields.",
			);
		if (values["request-id"] !== undefined && values["policy-revision"] === undefined)
			throw new Error("An explicit lifecycle request ID requires --policy-revision N for safe retries.");
		const requestId = values["request-id"] ?? randomUUID();
		if (!requestId.trim() || Buffer.byteLength(requestId) > 200)
			throw new Error("Mission lifecycle request ID must fit 200 bytes.");
		const retry = previous.executionIntent?.requestId === requestId ? previous.executionIntent : undefined;
		const expectedPolicyRevision =
			values["policy-revision"] === undefined
				? (retry?.expectedPolicyRevision ?? view.policyRevision ?? view.runtime?.policyRevision ?? 0)
				: Number(values["policy-revision"]);
		if (!Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 0)
			throw new Error("Mission policy revision must be a nonnegative integer.");
		if (retry) {
			if (retry.action !== positionals[0] || retry.expectedPolicyRevision !== expectedPolicyRevision)
				throw new Error("Conflicting mission lifecycle request ID.");
		} else {
			if ((view.policyRevision ?? view.runtime?.policyRevision ?? 0) !== expectedPolicyRevision)
				throw new Error("Stale mission policy revision.");
			if (positionals[0] === "start" ? view.runtime != null : view.runtime == null && positionals[0] !== "stop")
				throw new Error(
					positionals[0] === "start" ? "A mission execution already exists." : "No mission execution exists.",
				);
			if (positionals[0] === "pause" && (view.execution === "stopped" || view.execution === "completed"))
				throw new Error("A terminal mission cannot be paused or restarted.");
			if (positionals[0] === "resume" && view.execution !== "paused")
				throw new Error("Only a paused mission can resume.");
			const agreement =
				(positionals[0] === "pause" || positionals[0] === "stop") && view.runtime
					? {
							missionId: view.runtime.missionId,
							revision: view.runtime.agreementRevision,
							digest: view.runtime.agreementDigest,
						}
					: view.formation.agreement;
			await writeMissionAuthority(location, {
				...previous,
				executionIntent: {
					requestId,
					sequence: Math.max(previous.executionIntent?.sequence ?? 0, view.runtime?.intentSequence ?? 0) + 1,
					missionId: agreement.missionId,
					agreementRevision: agreement.revision,
					agreementDigest: agreement.digest,
					authorityRevision: previous.revision,
					expectedPolicyRevision,
					action: positionals[0],
					issuedAt: Date.now(),
				},
			});
		}
		try {
			const result = await owner({ operation: "reconcile-execution", requestId });
			process.stdout.write(`${JSON.stringify({ status: result.execution, runtime: result.runtime ?? null })}\n`);
		} catch (error) {
			process.stderr.write(
				`Mission intent saved; reconciliation is pending. Retry with --request-id ${requestId} --policy-revision ${expectedPolicyRevision}. ${error.message}\n`,
			);
			process.exitCode = 1;
		}
		return;
	}
	if (values["policy-revision"] !== undefined)
		throw new Error("Policy revision belongs to mission lifecycle commands.");
	if (positionals[0] === "creator") {
		if (!values.file || values.revision || values.digest || values["request-id"])
			throw new Error("Creator configuration requires one --file.");
		const descriptor = openSync(values.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		let input;
		try {
			const info = fstatSync(descriptor);
			if (
				!info.isFile() ||
				(info.uid !== 0 && info.uid !== actorUid) ||
				info.size > 32768 ||
				(info.mode & 0o022) !== 0
			)
				throw new Error("Creator input must be owned by root or the administrator, protected and at most 32 KiB.");
			// The input file is untrusted: one descriptor prevents path swaps, and a bounded read also covers growth.
			const buffer = Buffer.alloc(32769);
			let length = 0;
			while (length < buffer.length) {
				const count = readSync(descriptor, buffer, length, buffer.length - length, null);
				if (count === 0) break;
				length += count;
			}
			if (length > 32768) throw new Error("Creator input exceeds 32 KiB.");
			input = missionObject(JSON.parse(buffer.subarray(0, length).toString("utf8")));
		} finally {
			closeSync(descriptor);
		}
		const creator = parseMissionCreator(input.creator);
		const ceiling = parseMissionCeiling(input.ceiling);
		// The purpose-only grant: the artifact-digest capability under path prefixes, never a one-shot tool name.
		const purposeCeiling = input.purposeCeiling === undefined ? undefined : parsePurposeCeiling(input.purposeCeiling);
		if (creator.uid === null) throw new Error("A managed creator requires a provisioned local OS UID.");
		const account = execFileSync("getent", ["passwd", String(creator.uid)], { encoding: "utf8" })
			.trim()
			.split(":");
		if (account[2] !== String(creator.uid)) throw new Error("Creator UID does not match a local OS account.");
		if (ceiling.allowedTools.some((tool) => !MANAGED_MISSION_ACTIONS.includes(tool)))
			throw new Error("Authority names an unregistered tool action.");
		if (
			previous &&
			JSON.stringify(previous.creator) === JSON.stringify(creator) &&
			JSON.stringify(previous.ceiling) === JSON.stringify(ceiling) &&
			JSON.stringify(previous.purposeCeiling) === JSON.stringify(purposeCeiling)
		) {
			process.stdout.write(
				`${JSON.stringify({ status: "creator-configured", revision: previous.revision, creator })}\n`,
			);
			return;
		}
		const authority = {
			schemaVersion: 1,
			installationId: record.id,
			session: "default",
			revision: (previous?.revision ?? 0) + 1,
			creator,
			ceiling,
			approvals: [],
			...(previous?.executionIntent ? { executionIntent: previous.executionIntent } : {}),
			// The revision bump closes purpose receipts and the open intent; restrictive history stays for replay.
			...(purposeCeiling ? { purposeCeiling } : {}),
			...(previous?.operationIntent ? { operationIntent: previous.operationIntent } : {}),
			...(previous?.operationAcknowledgments ? { operationAcknowledgments: previous.operationAcknowledgments } : {}),
		};
		await writeMissionAuthority(location, authority);
		process.stdout.write(
			`${JSON.stringify({ status: "creator-configured", revision: authority.revision, creator, previousAgreement: "requires-new-approval" })}\n`,
		);
		return;
	}
	if (values.file || !values.revision || !values.digest || previous === null)
		throw new Error("Configure the creator, then approve one exact --revision and --digest.");
	const revision = Number(values.revision);
	const requestId = values["request-id"] ?? randomUUID();
	if (
		!Number.isSafeInteger(revision) ||
		revision < 1 ||
		!/^[0-9a-f]{64}$/.test(values.digest) ||
		!requestId.trim() ||
		requestId.length > 200
	)
		throw new Error("Approval requires a positive revision, SHA-256 digest and bounded request ID.");
	const retry = previous.approvals.find((receipt) => receipt.requestId === requestId);
	const draft = view.formation.draft;
	if (retry) {
		if (retry.revision !== revision || retry.digest !== values.digest)
			throw new Error("Conflicting approval request ID.");
		const result = await owner({ operation: "reconcile", receiptId: retry.receiptId });
		process.stdout.write(`${JSON.stringify({ status: "agreed", receipt: retry, execution: result.execution })}\n`);
		return;
	}
	if (view.runtime && view.execution !== "stopped" && view.execution !== "completed")
		throw new Error("Stop the existing mission execution before approving an amendment.");
	if (!draft || draft.status !== "proposed" || draft.revision !== revision || draft.digest !== values.digest)
		throw new Error("Stale mission proposal; inspect its current revision and digest.");
	const terms = validateMissionTerms(draft.terms, previous, MANAGED_MISSION_ACTIONS, Date.now());
	const digest = missionDigest(terms, draft.missionId, revision, previous);
	if (digest !== values.digest) throw new Error("Creator authority changed; propose the exact terms again.");
	const receipt = {
		receiptId: randomUUID(),
		requestId,
		installationId: record.id,
		session: "default",
		missionId: draft.missionId,
		revision,
		digest,
		creator: previous.creator,
		authorityRevision: previous.revision,
		approvedAt: Date.now(),
		provenance: "managed-administrator",
		approvedBy: { kind: actorUid === previous.creator.uid ? "local-creator" : "host-administrator", uid: actorUid },
	};
	const active = previous.approvals.find((item) => item.receiptId === view.formation.agreement?.approval.receiptId);
	await writeMissionAuthority(location, { ...previous, approvals: active ? [active, receipt] : [receipt] });
	try {
		const result = await owner({ operation: "reconcile", receiptId: receipt.receiptId });
		process.stdout.write(`${JSON.stringify({ status: "agreed", receipt, execution: result.execution })}\n`);
	} catch (error) {
		process.stderr.write(
			`Approval receipt ${receipt.receiptId} saved; owner reconciliation is pending. Retry with --request-id ${requestId}. ${error.message}\n`,
		);
		process.exitCode = 1;
	}
});

// A continuous-operation grant needs the creator's own assent: run with sudo from the creator's account.
async function approvePurpose(view, previous) {
	if (values.file || values["policy-revision"] || values["operation-revision"] || values.run)
		throw new Error("Purpose approval takes only --revision, --digest and --request-id.");
	if (previous === null || !values.revision || !values.digest)
		throw new Error("Configure the creator and purpose ceiling, then approve one exact --revision and --digest.");
	if (actorUid !== previous.creator.uid)
		throw new Error("Purpose approval requires the creator's own account: run it with sudo as the creator.");
	const revision = Number(values.revision);
	const requestId = values["request-id"] ?? randomUUID();
	if (!Number.isSafeInteger(revision) || revision < 1 || !/^[0-9a-f]{64}$/.test(values.digest) || !requestId.trim())
		throw new Error("Purpose approval requires a positive revision, SHA-256 digest and bounded request ID.");
	const retry = previous.purposeApprovals?.find((receipt) => receipt.requestId === requestId);
	if (retry) {
		if (retry.revision !== revision || retry.digest !== values.digest) throw new Error("Conflicting approval request ID.");
		await owner({ operation: "reconcile-purpose", receiptId: retry.receiptId });
		process.stdout.write(`${JSON.stringify({ status: "purpose-agreed", receipt: retry })}\n`);
		return;
	}
	const purpose = view.purpose;
	if (purpose?.operation === "open") throw new Error("Suspend or close continuous operation before changing its purpose.");
	const proposed = purpose?.proposed;
	if (!proposed || proposed.revision !== revision || proposed.digest !== values.digest || !purpose.missionId)
		throw new Error("Stale purpose proposal; inspect its current revision and digest.");
	const terms = validatePurposeTerms(proposed.terms, previous, Date.now());
	const digest = purposeDigest(terms, purpose.missionId, revision, previous);
	if (digest !== values.digest) throw new Error("Creator authority changed; propose the exact purpose again.");
	const receipt = {
		receiptId: randomUUID(),
		requestId,
		installationId: record.id,
		session: "default",
		missionId: purpose.missionId,
		revision,
		digest,
		creator: previous.creator,
		authorityRevision: previous.revision,
		approvedAt: Date.now(),
		provenance: "managed-administrator",
		approvedBy: { kind: "local-creator", uid: actorUid },
	};
	const agreed = previous.purposeApprovals?.find((item) => item.digest === purpose.digest);
	await writeMissionAuthority(location, { ...previous, purposeApprovals: agreed ? [agreed, receipt] : [receipt] });
	try {
		await owner({ operation: "reconcile-purpose", receiptId: receipt.receiptId });
		process.stdout.write(`${JSON.stringify({ status: "purpose-agreed", receipt })}\n`);
	} catch (error) {
		process.stderr.write(
			`Purpose receipt ${receipt.receiptId} saved; owner reconciliation is pending. Retry with --request-id ${requestId}. ${error.message}\n`,
		);
		process.exitCode = 1;
	}
}

// Opening, suspending, closing and acknowledging use the administrator path, like start and stop.
async function operatePurpose(view, previous) {
	if (values.file || values.revision || values.digest || values["policy-revision"])
		throw new Error("Mission operate takes only --operation-revision, --request-id and --run.");
	const purpose = view.purpose;
	if (previous === null || !purpose || purpose.revision === null)
		throw new Error("Approve a purpose before operating it.");
	if (values["request-id"] !== undefined && values["operation-revision"] === undefined)
		throw new Error("An explicit operation request ID requires --operation-revision N for safe retries.");
	if ((operateAction === "acknowledge") !== (values.run !== undefined))
		throw new Error("Acknowledge needs exactly one --run ID; other operation actions take none.");
	const requestId = values["request-id"] ?? randomUUID();
	if (!requestId.trim() || Buffer.byteLength(requestId) > 200) throw new Error("Request ID must fit 200 bytes.");
	const expected =
		values["operation-revision"] === undefined ? purpose.operationRevision : Number(values["operation-revision"]);
	if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Operation revision must be a nonnegative integer.");
	let next;
	// A request ID names one command: the owner reconciles an acknowledgment first, so a shared ID would report an
	// intent applied that it never read.
	if (
		operateAction === "acknowledge"
			? previous.operationIntent?.requestId === requestId
			: previous.operationAcknowledgments?.some((item) => item.requestId === requestId)
	)
		throw new Error("Conflicting operation request ID.");
	if (operateAction === "acknowledge") {
		const known = previous.operationAcknowledgments?.find((item) => item.requestId === requestId);
		if (known && known.runId !== values.run) throw new Error("Conflicting acknowledgment request ID.");
		// `unsettled` spans every purpose revision; `works` shows only the current one, hiding older blocking runs.
		if (!known && !purpose.unsettled.some((run) => run.runId === values.run))
			throw new Error("Only a run with unsettled effects can be acknowledged.");
		next = known
			? previous
			: {
					...previous,
					operationAcknowledgments: [
						...(previous.operationAcknowledgments ?? []),
						{
							requestId,
							missionId: purpose.missionId,
							runId: values.run,
							authorityRevision: previous.revision,
							issuedAt: Date.now(),
						},
					].slice(-8),
				};
	} else {
		const retry = previous.operationIntent?.requestId === requestId ? previous.operationIntent : undefined;
		if (retry && (retry.action !== operateAction || retry.expectedOperationRevision !== expected))
			throw new Error("Conflicting operation request ID.");
		if (!retry && purpose.operationRevision !== expected) throw new Error("Stale operation revision.");
		if (!retry && operateAction === "open" && purpose.operation === "open") throw new Error("Operation is already open.");
		if (!retry && operateAction !== "open" && purpose.operation === "closed") throw new Error("Operation is not open.");
		next = retry
			? previous
			: {
					...previous,
					operationIntent: {
						requestId,
						sequence: Math.max(previous.operationIntent?.sequence ?? 0, purpose.appliedSequence) + 1,
						missionId: purpose.missionId,
						purposeRevision: purpose.revision,
						purposeDigest: purpose.digest,
						authorityRevision: previous.revision,
						expectedOperationRevision: expected,
						action: operateAction,
						issuedAt: Date.now(),
					},
				};
	}
	if (next !== previous) await writeMissionAuthority(location, next);
	try {
		const result = await owner({ operation: "reconcile-operation", requestId });
		process.stdout.write(`${JSON.stringify({ status: "operation-reconciled", purpose: result.purpose ?? null })}\n`);
	} catch (error) {
		process.stderr.write(
			`Operation intent saved; reconciliation is pending. Retry with --request-id ${requestId} --operation-revision ${expected}. ${error.message}\n`,
		);
		process.exitCode = 1;
	}
}

function owner(request) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(join(installationPaths(record.id).state, "control/default.sock"));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () =>
			socket.destroy(new Error(`Owner unavailable; run sudo ${record.name} start before forming its mission.`)),
		);
		socket.once("error", reject);
		socket.once("connect", () => socket.write(`${JSON.stringify({ type: "mission", request })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 1048576)
				return socket.destroy(new Error("Mission owner response exceeds 1 MiB."));
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline));
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "mission") throw new Error("Unexpected mission owner response.");
				resolve(parseMissionView(response.result));
			} catch (error) {
				reject(error);
			}
			socket.destroy();
		});
		socket.once("end", () => reject(new Error("Mission owner disconnected before responding.")));
	});
}
