// Validates separate creator channel grants against protected mission identity and host ceilings.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type MissionLocation, missionAuthorityPath, readMissionAuthority } from "../missions/authority.ts";
import { type MissionAuthority, parseMissionCreator } from "../missions/contract.ts";
import {
	CHANNEL_CAPABILITIES,
	type ChannelCapability,
	type ChannelRequest,
	channelInteger,
	channelObject,
	channelText,
	parseChannelSetupInput,
} from "./contract.ts";
import { channelRequestDigest } from "./registry.ts";

export type ChannelGrant = {
	id: string;
	requestId: string;
	digest: string;
	expiresAt: number;
	adapter: string;
	destination: string;
	capabilities: ChannelCapability[];
	approvedAt: number;
	approvedBy: { kind: "creator" | "administrator"; uid: number };
};

export type ChannelAuthority = {
	schemaVersion: 1;
	installationId: string | null;
	session: "default";
	authorityRevision: number;
	creator: MissionAuthority["creator"];
	disabled: string[];
	ceiling: { adapter: string; destinations: string[]; capabilities: ChannelCapability[] }[];
	grants: ChannelGrant[];
};

/** Resolves the separate protected grant file beside the existing creator authority. */
export function channelAuthorityPath(location: MissionLocation): string {
	return join(dirname(missionAuthorityPath(location)), "channel-authority.json");
}

/** Reads root-protected grants; a caller cannot supply an approval through model text or owner IPC. */
export async function readChannelAuthority(location: MissionLocation): Promise<{
	creator: MissionAuthority;
	channels: ChannelAuthority | null;
} | null> {
	const creator = await readMissionAuthority(location);
	if (!creator) return null;
	let file: FileHandle;
	try {
		file = await open(
			channelAuthorityPath(location),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { creator, channels: null };
		throw new Error("Channel authority is unavailable.");
	}
	try {
		const info = await file.stat();
		const uid = location.kind === "managed" ? 0 : process.getuid?.();
		if (!info.isFile() || info.size > 65536 || (uid !== undefined && (info.uid !== uid || (info.mode & 0o022) !== 0)))
			throw new Error("Untrusted channel authority.");
		const buffer = Buffer.alloc(65537);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > 65536) throw new Error("Channel authority exceeds 64 KiB.");
		return { creator, channels: parseChannelAuthority(JSON.parse(buffer.subarray(0, length).toString("utf8"))) };
	} finally {
		await file.close();
	}
}

/** Issues or revokes channel grants atomically; managed authority remains a root-only operation. */
export async function writeChannelAuthority(location: MissionLocation, value: ChannelAuthority): Promise<void> {
	if (location.kind === "managed" && (process.platform !== "linux" || process.geteuid?.() !== 0))
		throw new Error("Channel authority requires the host administrator.");
	const current = await readChannelAuthority(location);
	if (!current) throw new Error("Configure the protected creator before channel authority.");
	const parsed = parseChannelAuthority(value);
	if (
		parsed.installationId !== current.creator.installationId ||
		parsed.authorityRevision !== current.creator.revision ||
		JSON.stringify(parsed.creator) !== JSON.stringify(current.creator.creator)
	)
		throw new Error("Channel creator binding changed.");
	const data = `${JSON.stringify(parsed)}\n`;
	if (Buffer.byteLength(data) > 65536) throw new Error("Channel authority exceeds 64 KiB.");
	const path = channelAuthorityPath(location);
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
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Validates the administrator file at the filesystem trust boundary. */
export function parseChannelAuthority(value: unknown): ChannelAuthority {
	const input = channelObject(value);
	if (
		input.schemaVersion !== 1 ||
		input.session !== "default" ||
		!Array.isArray(input.ceiling) ||
		input.ceiling.length > 16 ||
		!Array.isArray(input.disabled) ||
		input.disabled.length > 16 ||
		!Array.isArray(input.grants) ||
		input.grants.length > 32
	)
		throw new Error("Unsupported channel authority.");
	return {
		schemaVersion: 1,
		installationId: input.installationId === null ? null : channelText(input.installationId),
		session: "default",
		authorityRevision: channelInteger(input.authorityRevision),
		creator: parseMissionCreator(input.creator),
		disabled: input.disabled.map((value) => channelText(value)),
		ceiling: input.ceiling.map((value) => {
			const entry = channelObject(value);
			if (!Array.isArray(entry.destinations) || entry.destinations.length > 16)
				throw new Error("Invalid channel destinations.");
			return {
				adapter: channelText(entry.adapter),
				destinations: entry.destinations.map((value) => channelText(value)),
				capabilities: capabilities(entry.capabilities),
			};
		}),
		grants: input.grants.map((value) => {
			const grant = channelObject(value);
			const digest = channelText(grant.digest, 64);
			if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid channel grant digest.");
			const actor = channelObject(grant.approvedBy);
			if (actor.kind !== "creator" && actor.kind !== "administrator")
				throw new Error("Invalid channel grant issuer.");
			return {
				id: channelText(grant.id),
				requestId: channelText(grant.requestId),
				digest,
				expiresAt: channelInteger(grant.expiresAt),
				adapter: channelText(grant.adapter),
				destination: channelText(grant.destination),
				capabilities: capabilities(grant.capabilities),
				approvedAt: channelInteger(grant.approvedAt),
				approvedBy: { kind: actor.kind, uid: channelInteger(actor.uid) },
			};
		}),
	};
}

/** Builds one exact receipt for a protected writer; this function alone grants no filesystem authority. */
export function issueChannelGrant(
	request: ChannelRequest,
	authority: { creator: MissionAuthority; channels: ChannelAuthority | null },
	expiresAt: number,
	actorUid: number,
	now: number,
): ChannelAuthority {
	const policy = authority.channels;
	if (!policy) throw new Error("Configure the channel ceiling before granting setup.");
	const input = parseChannelSetupInput({
		requestId: request.requestId,
		channelId: request.channelId,
		expectedRevision: request.revision - 1,
		adapter: request.adapter,
		destination: request.destination,
		capabilities: request.capabilities,
		expiresAt: request.expiresAt,
	});
	if (channelRequestDigest(input, authority.creator) !== request.digest)
		throw new Error("Channel request digest changed.");
	const previous = policy.grants.find(
		(grant) =>
			grant.requestId === request.requestId && grant.digest === request.digest && grant.expiresAt === expiresAt,
	);
	const grant: ChannelGrant = previous ?? {
		id: randomUUID(),
		requestId: request.requestId,
		digest: request.digest,
		expiresAt: channelInteger(expiresAt),
		adapter: request.adapter,
		destination: request.destination,
		capabilities: request.capabilities,
		approvedAt: channelInteger(now),
		approvedBy: {
			kind: actorUid === authority.creator.creator.uid ? "creator" : "administrator",
			uid: channelInteger(actorUid),
		},
	};
	const candidate = { ...policy, grants: [grant] };
	if (!matchingChannelGrant(request, { ...authority, channels: candidate }, now))
		throw new Error("Channel grant exceeds current creator authority.");
	const grants = policy.grants.filter((item) => item.expiresAt > now && item.requestId !== request.requestId);
	if (grants.length >= 32) throw new Error("Channel grant capacity reached.");
	return { ...policy, grants: [...grants, grant] };
}

/** Requires exact current creator, request, destination and permission binding before every setup effect. */
export function matchingChannelGrant(
	request: ChannelRequest,
	authority: { creator: MissionAuthority; channels: ChannelAuthority | null },
	now: number,
): ChannelGrant | undefined {
	const policy = authority.channels;
	if (
		!policy ||
		policy.disabled.includes(request.channelId) ||
		request.expiresAt <= now ||
		request.installationId !== authority.creator.installationId ||
		request.session !== authority.creator.session ||
		request.authorityRevision !== authority.creator.revision ||
		JSON.stringify(request.creator) !== JSON.stringify(authority.creator.creator) ||
		policy.installationId !== request.installationId ||
		policy.authorityRevision !== request.authorityRevision ||
		JSON.stringify(policy.creator) !== JSON.stringify(request.creator)
	)
		return undefined;
	const ceiling = policy.ceiling.find(
		(entry) => entry.adapter === request.adapter && entry.destinations.includes(request.destination),
	);
	if (!ceiling || request.capabilities.some((capability) => !ceiling.capabilities.includes(capability)))
		return undefined;
	return policy.grants.find(
		(grant) =>
			grant.requestId === request.requestId &&
			grant.digest === request.digest &&
			grant.adapter === request.adapter &&
			grant.destination === request.destination &&
			grant.expiresAt > now &&
			grant.expiresAt <= request.expiresAt &&
			JSON.stringify(grant.capabilities) === JSON.stringify(request.capabilities),
	);
}

function capabilities(value: unknown): ChannelCapability[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > CHANNEL_CAPABILITIES.length ||
		new Set(value).size !== value.length
	)
		throw new Error("Invalid channel capabilities.");
	return value.map((item) => {
		if (!CHANNEL_CAPABILITIES.some((entry) => entry === item)) throw new Error("Unknown channel capability.");
		return item as ChannelCapability;
	});
}
