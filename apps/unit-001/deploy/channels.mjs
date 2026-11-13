#!/usr/bin/env node
// Issues separate root-owned channel grants and securely captures owner-private bootstrap credentials.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	issueChannelGrant,
	parseChannelAuthority,
	readChannelAuthority,
	writeChannelAuthority,
} from "../app/dist/channels/authority.js";
import { channelInteger, channelObject, channelText, parseChannelRequest } from "../app/dist/channels/contract.js";
import { ChannelCredentials } from "../app/dist/channels/credentials.js";
import { installationPaths, readInstallation, withManagementLock } from "./installation.mjs";
import { readUpdateJournal } from "./update-activation.mjs";

try {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			id: { type: "string" },
			file: { type: "string" },
			channel: { type: "string" },
			revision: { type: "string" },
			digest: { type: "string" },
			"expires-at": { type: "string" },
		},
	});
	if (
		!values.id ||
		positionals.length !== 1 ||
		!["policy", "approve", "revoke", "telegram-bootstrap", "credential-import"].includes(positionals[0])
	)
		throw new Error(
			"Usage: NAME channels policy --file FILE | approve --channel ID --revision N --digest SHA256 --expires-at MS | revoke --channel ID | telegram-bootstrap --file FILE",
		);
	const record = readInstallation(values.id);
	if (positionals[0] === "credential-import") {
		const account = execFileSync("getent", ["passwd", record.account], { encoding: "utf8", maxBuffer: 8192 })
			.trim()
			.split(":");
		if (
			process.platform !== "linux" ||
			process.geteuid?.() === 0 ||
			String(process.geteuid?.()) !== account[2] ||
			account[0] !== record.account ||
			values.file ||
			values.channel ||
			values.revision ||
			values.digest ||
			values["expires-at"]
		)
			throw new Error("Credential import requires the exact installation service UID.");
		const bytes = Buffer.alloc(8193);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(0, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length > 8192) throw new Error("Credential import exceeds limit.");
		const credentials = new ChannelCredentials(join(installationPaths(record.id).state, "channels"));
		await credentials.write(
			"telegram-manager",
			channelObject(JSON.parse(bytes.subarray(0, length).toString("utf8"))),
		);
	} else {
		if (process.platform !== "linux" || process.geteuid?.() !== 0)
			throw new Error("Channel administration requires Linux root privileges.");
		const location = { kind: "managed", installationId: record.id, session: "default" };
		const actorUid = process.env.SUDO_UID === undefined ? 0 : Number(process.env.SUDO_UID);
		if (!Number.isSafeInteger(actorUid) || actorUid < 0) throw new Error("Invalid administrator origin UID.");
		const actor = execFileSync("getent", ["passwd", String(actorUid)], { encoding: "utf8", maxBuffer: 8192 })
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
				throw new Error("Recover the incomplete update before changing channel authority.");
			const authority = await readChannelAuthority(location);
			if (!authority) throw new Error("Configure the protected creator before channel setup.");
			const action = positionals[0];
			if (action === "telegram-bootstrap") {
				if (!values.file || values.channel || values.revision || values.digest || values["expires-at"])
					throw new Error("Telegram bootstrap requires only --file.");
				const input = protectedInput(values.file, actorUid);
				if (Object.keys(input).some((key) => !["token", "creatorId", "username", "botId"].includes(key)))
					throw new Error("Unknown Telegram bootstrap field.");
				const token = channelText(input.token, 256);
				const username = channelText(input.username, 32);
				if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token) || !/^[A-Za-z0-9_]{5,32}$/.test(username))
					throw new Error("Invalid Telegram bootstrap identity.");
				const bootstrap = {
					token,
					creatorId: channelInteger(input.creatorId),
					username,
					...(input.botId === undefined ? {} : { botId: channelInteger(input.botId) }),
				};
				// Never write as root through a service-owned directory; establish the service UID before any private-file IO.
				execFileSync(
					"runuser",
					[
						"-u",
						record.account,
						"--",
						process.execPath,
						fileURLToPath(import.meta.url),
						"credential-import",
						"--id",
						record.id,
					],
					{
						input: JSON.stringify(bootstrap),
						stdio: ["pipe", "ignore", "pipe"],
						env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
						timeout: 5000,
						maxBuffer: 8192,
					},
				);
				console.log(
					JSON.stringify({
						status: "telegram-bootstrap-saved",
						credentials: "owner-private",
						botManagementMode: "creator-must-enable",
						activation: "requires-separate-exact-grant",
					}),
				);
				return;
			}
			if (action === "policy") {
				if (!values.file || values.channel || values.revision || values.digest || values["expires-at"])
					throw new Error("Channel policy requires only --file.");
				const input = protectedInput(values.file, actorUid);
				if (Object.keys(input).some((key) => !["ceiling", "disabled"].includes(key)))
					throw new Error("Unknown channel policy field.");
				const policy = parseChannelAuthority({
					schemaVersion: 1,
					installationId: record.id,
					session: "default",
					authorityRevision: authority.creator.revision,
					creator: authority.creator.creator,
					ceiling: input.ceiling,
					disabled: input.disabled,
					grants: [],
				});
				await writeChannelAuthority(location, policy);
				console.log(
					JSON.stringify({
						status: "channel-policy-saved",
						priorGrants: "revoked",
						creatorRevision: policy.authorityRevision,
					}),
				);
				return;
			}
			if (values.file || !values.channel) throw new Error("Channel authority changes require --channel.");
			const policy = authority.channels;
			if (!policy) throw new Error("Configure the channel ceiling first.");
			if (action === "revoke") {
				if (values.revision || values.digest || values["expires-at"])
					throw new Error("Channel revoke requires only --channel.");
				const channelId = channelText(values.channel);
				await writeChannelAuthority(location, {
					...policy,
					disabled: [...new Set([...policy.disabled, channelId])],
				});
				console.log(JSON.stringify({ status: "channel-disabled", channelId }));
				return;
			}
			if (!values.revision || !values.digest || !values["expires-at"])
				throw new Error("Approve the exact channel revision, digest and expiry.");
			const response = await owner(installationPaths(record.id).state);
			const result = channelObject(response.result);
			const view = channelObject(result.view);
			if (result.operation !== "status" || !Array.isArray(view.channels) || view.channels.length > 16)
				throw new Error("Invalid channel owner projection.");
			const requests = view.channels.map((value) => parseChannelRequest(channelObject(value).request));
			const request = requests.find((value) => value.channelId === values.channel);
			if (!request || request.revision !== Number(values.revision) || request.digest !== values.digest)
				throw new Error("Channel proposal changed; inspect its exact current revision and digest.");
			const updated = issueChannelGrant(request, authority, Number(values["expires-at"]), actorUid, Date.now());
			await writeChannelAuthority(location, updated);
			console.log(
				JSON.stringify({
					status: "channel-granted",
					channelId: request.channelId,
					revision: request.revision,
					digest: request.digest,
					grant: updated.grants.at(-1),
				}),
			);
		});
	}
} catch {
	// Bootstrap input and provider data can contain tokens; never print raw exception messages or stacks.
	process.stderr.write(
		"Channel administration failed. Verify root access, protected input, current creator policy and the exact owner proposal.\n",
	);
	process.exitCode = 1;
}

function protectedInput(path, actorUid) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || ![0, actorUid].includes(info.uid) || info.size > 32768 || (info.mode & 0o077) !== 0)
			throw new Error("Protected input must be private.");
		const bytes = Buffer.alloc(32769);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length > 32768) throw new Error("Protected input exceeds limit.");
		return channelObject(JSON.parse(bytes.subarray(0, length).toString("utf8")));
	} finally {
		closeSync(fd);
	}
}

function owner(directory) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(join(directory, "control/default.sock"));
		let bytes = "";
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () => socket.destroy(new Error("Owner unavailable.")));
		socket.once("error", reject);
		socket.once("connect", () =>
			socket.write(`${JSON.stringify({ type: "channels", request: { operation: "status" } })}\n`),
		);
		socket.on("data", (chunk) => {
			bytes += chunk;
			if (Buffer.byteLength(bytes) > 1048576) return socket.destroy(new Error("Owner response exceeds limit."));
			const newline = bytes.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = channelObject(JSON.parse(bytes.slice(0, newline)));
				if (response.type !== "channels") throw new Error("Unexpected owner response.");
				resolve(response);
			} catch (error) {
				reject(error);
			}
			socket.destroy();
		});
		socket.once("end", () => reject(new Error("Owner disconnected.")));
	});
}
