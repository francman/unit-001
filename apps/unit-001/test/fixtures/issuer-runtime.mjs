// Runs the installed issuer with temporary installation paths and file-backed authority and owner endpoints.
// Durable state under the root: mission-authority.json (protected authority), mission-owner-view.json (the owner's
// mission view), authority-events (one line per authority read or write) and owner-requests (one JSON line per frame).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	installationPaths as paths,
	readInstallation as readRecord,
	withManagementLock as lock,
} from "../../deploy/installation.mjs";
import { assertSelectedIssuer as assertSelected } from "../../deploy/issuer-release.mjs";
import { readUpdateJournal as readJournal } from "../../deploy/update-activation.mjs";

// Reuse the source mission parsers without importing the live channel registry.
export { missionDigest, parseMissionCeiling, validateMissionTerms } from "../../src/missions/authority.ts";
export { unexpectedChannelMutation as issueChannelGrant, unexpectedChannelMutation as parseChannelAuthority };

const root = process.env.UNIT_TEST_ISSUER_ROOT;
assert.ok(root && process.argv[1]?.startsWith(`${root}/`));
const issuer = pathToFileURL(process.argv[1]).href;
const platform = Object.getOwnPropertyDescriptor(process, "platform");
let locked = false;

registerHooks({
	resolve(specifier, context, next) {
		if (context.parentURL !== issuer) return next(specifier, context);
		if (
			[
				"node:child_process",
				"node:net",
				"./installation.mjs",
				"./issuer-release.mjs",
				"./update-activation.mjs",
				"../app/dist/channels/authority.js",
				"../app/dist/missions/authority.js",
				"../app/dist/missions/wire.js",
			].includes(specifier)
		)
			return { url: import.meta.url, shortCircuit: true };
		if (specifier.startsWith("../app/dist/")) {
			const source = specifier.replace("../app/dist/", "../../src/").replace(/\.js$/, ".ts");
			return next(new URL(source, import.meta.url).href, context);
		}
		return next(specifier, context);
	},
});

Object.defineProperty(process, "platform", { value: "linux" });
process.geteuid = () => 0;

export function installationPaths(id) {
	return paths(id, root);
}

export function readInstallation(id) {
	return readRecord(id, root);
}

export function readUpdateJournal(id) {
	return readJournal(id, root);
}

export function withManagementLock(callback) {
	Object.defineProperty(process, "platform", platform);
	return lock(async () => {
		locked = true;
		try {
			return await callback();
		} finally {
			locked = false;
		}
	}, root);
}

export function assertSelectedIssuer(record, executingPath) {
	assert.equal(locked, true);
	assertSelected(record, executingPath, root);
}

export function execFileSync(command, [database, uid]) {
	assert.equal(command, "getent");
	assert.equal(database, "passwd");
	return `fixture:x:${uid}:`;
}

export function createConnection() {
	const socket = new EventEmitter();
	socket.setEncoding = () => {};
	socket.setTimeout = () => {};
	socket.destroy = () => {};
	socket.write = (frame) => {
		const { type, request } = JSON.parse(frame);
		assert.equal(type, "mission");
		appendFileSync(join(root, "owner-requests"), `${JSON.stringify(request)}\n`);
		const view = ownerView();
		if (request.operation === "status") socket.emit("data", `${JSON.stringify({ type: "mission", result: view })}\n`);
		else if (request.operation === "reconcile-operation")
			socket.emit("data", `${JSON.stringify({ type: "mission", result: { purpose: view.purpose } })}\n`);
		else assert.fail(`The fixture owner does not serve ${request.operation}.`);
	};
	queueMicrotask(() => socket.emit("connect"));
	return socket;
}

function ownerView() {
	const file = join(root, "mission-owner-view.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { formation: {} };
}

export function parseMissionView(view) {
	return view;
}

export function readMissionAuthority() {
	recordAuthority("read mission");
	const file = join(root, "mission-authority.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function readChannelAuthority() {
	recordAuthority("read channels");
	return { channels: { disabled: [] } };
}

export function writeMissionAuthority(_location, authority) {
	recordAuthority("write mission");
	writeFileSync(join(root, "mission-authority.json"), JSON.stringify(authority));
}

export function writeChannelAuthority() {
	recordAuthority("write channels");
}

function recordAuthority(event) {
	assert.equal(locked, true);
	appendFileSync(join(root, "authority-events"), `${event}\n`);
}

function unexpectedChannelMutation() {
	assert.fail("The fixture only exercises channel revocation.");
}
