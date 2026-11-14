// Tests exact channel grants and real filesystem ownership boundaries without live accounts.
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	channelAuthorityPath,
	issueChannelGrant,
	matchingChannelGrant,
	readChannelAuthority,
	writeChannelAuthority,
} from "../../src/channels/authority.ts";
import type { ChannelRequest } from "../../src/channels/contract.ts";
import { writeMissionAuthority } from "../../src/missions/authority.ts";
import { grantFixture } from "./fixtures.ts";

let directory: string | undefined;
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("channel authority", () => {
	it("#56 reclaims expired grants before enforcing the bounded approval capacity", () => {
		const fixture = grantFixture();
		fixture.channels.grants = Array.from({ length: 32 }, (_, index) => ({
			...fixture.channels.grants[0],
			requestId: `expired-${index}`,
			expiresAt: 1000,
		}));
		const issued = issueChannelGrant(fixture.request, fixture, 3500, 0, 1100);
		expect(issued.grants).toHaveLength(1);
		expect(issued.grants[0].requestId).toBe(fixture.request.requestId);
	});

	it("#56 binds issuer retries to exact terms and rejects grants beyond the protected ceiling or request expiry", () => {
		const fixture = grantFixture();
		const issued = issueChannelGrant(fixture.request, fixture, 3500, 0, 1100);
		const receipt = issued.grants.find((grant) => grant.requestId === fixture.request.requestId);
		expect(receipt).toMatchObject({ expiresAt: 3500, digest: fixture.request.digest });
		const retried = issueChannelGrant(fixture.request, { ...fixture, channels: issued }, 3500, 0, 1200);
		expect(retried.grants).toEqual(issued.grants);
		expect(() => issueChannelGrant(fixture.request, fixture, 6000, 0, 1100)).toThrow("exceeds");
		expect(() =>
			issueChannelGrant({ ...fixture.request, destination: "unexpected" }, fixture, 3500, 0, 1100),
		).toThrow("digest");
		expect(() =>
			issueChannelGrant(
				fixture.request,
				{ ...fixture, channels: { ...fixture.channels, ceiling: [] } },
				3500,
				0,
				1100,
			),
		).toThrow("exceeds");
	});

	it("requires exact current creator, installation, request, permissions and expiry", () => {
		const fixture = grantFixture();
		expect(matchingChannelGrant(fixture.request, fixture, 1000)?.id).toBe("grant-1");
		const alterations: Partial<ChannelRequest>[] = [
			{ destination: "43" },
			{ authorityRevision: 2 },
			{ digest: "a".repeat(64) },
			{ installationId: "different" },
			{ capabilities: ["trusted_operator_execution"] },
			{ creator: { ...fixture.request.creator, kind: "human" } },
		];
		for (const change of alterations)
			expect(matchingChannelGrant({ ...fixture.request, ...change }, fixture, 1000)).toBeUndefined();
		expect(matchingChannelGrant(fixture.request, fixture, 4000)).toBeUndefined();
		expect(
			matchingChannelGrant(fixture.request, { ...fixture, channels: { ...fixture.channels, grants: [] } }, 1000),
		).toBeUndefined();
		expect(
			matchingChannelGrant(fixture.request, { ...fixture, creator: { ...fixture.creator, revision: 2 } }, 1000),
		).toBeUndefined();
	});

	it("persists developer grants through protected files and rejects symlink/writable authority", async () => {
		directory = await mkdtemp(join(tmpdir(), "unit-channel-authority-"));
		const location = { kind: "developer-local" as const, directory, session: "default" };
		const fixture = grantFixture();
		await writeMissionAuthority(location, fixture.creator);
		await writeChannelAuthority(location, fixture.channels);
		expect((await readChannelAuthority(location))?.channels).toEqual(fixture.channels);
		await chmod(channelAuthorityPath(location), 0o666);
		await expect(readChannelAuthority(location)).rejects.toThrow("Untrusted");
		await rm(channelAuthorityPath(location));
		const target = join(directory, "attacker.json");
		await writeFile(target, JSON.stringify(fixture.channels), { mode: 0o600 });
		await symlink(target, channelAuthorityPath(location));
		await expect(readChannelAuthority(location)).rejects.toThrow("unavailable");
	});

	it("uses the actual process UID/platform gate for managed grant writes", async () => {
		if (process.platform === "linux" && process.geteuid?.() === 0) return;
		expect(process.geteuid?.() === 0 && process.platform === "linux").toBe(false);
		await expect(
			writeChannelAuthority(
				{ kind: "managed", installationId: "9b461de0-05b6-41d7-9847-06709353bd44", session: "default" },
				grantFixture().channels,
			),
		).rejects.toThrow("host administrator");
	});
});
