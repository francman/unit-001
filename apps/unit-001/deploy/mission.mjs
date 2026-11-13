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
		json: { type: "boolean" },
	},
});
if (!values.id || positionals.length !== 1 || !["creator", "approve"].includes(positionals[0]))
	throw new Error("Usage: NAME mission creator --file FILE | approve --revision N --digest SHA256 [--request-id ID]");
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
			JSON.stringify(previous.ceiling) === JSON.stringify(ceiling)
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
		await owner({ operation: "reconcile", receiptId: retry.receiptId });
		process.stdout.write(`${JSON.stringify({ status: "agreed", receipt: retry, execution: "not-implemented" })}\n`);
		return;
	}
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
		await owner({ operation: "reconcile", receiptId: receipt.receiptId });
		process.stdout.write(`${JSON.stringify({ status: "agreed", receipt, execution: "not-implemented" })}\n`);
	} catch (error) {
		process.stderr.write(
			`Approval receipt ${receipt.receiptId} saved; owner reconciliation is pending. Retry with --request-id ${requestId}. ${error.message}\n`,
		);
		process.exitCode = 1;
	}
});

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
