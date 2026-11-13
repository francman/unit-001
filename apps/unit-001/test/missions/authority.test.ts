// #14: Approval is bound to exact host-owned metadata, never a caller-provided authority label.
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	matchingApproval,
	missionAuthorityPath,
	missionDigest,
	readMissionAuthority,
	validateMissionTerms,
	writeMissionAuthority,
} from "../../src/missions/authority.ts";
import type { MissionApproval, MissionAuthority, MissionTerms } from "../../src/missions/contract.ts";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-mission-authority-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function authority(kind: "human" | "elder" | "organization" = "human"): MissionAuthority {
	return {
		schemaVersion: 1,
		installationId: null,
		session: "default",
		revision: 1,
		creator: { kind, id: "local-authority", uid: process.getuid?.() ?? null },
		ceiling: {
			allowedTools: ["read"],
			maxCycles: 3,
			maxRequests: 6,
			maxRetries: 1,
			maxConsecutiveNoProgress: 2,
			maxDurationMs: 10000,
		},
		approvals: [],
	};
}

function terms(): MissionTerms {
	return {
		objective: "Inspect a fixture",
		scope: "Read the supplied fixture only",
		successCriteria: ["Report the source evidence"],
		policy: {
			allowedTools: ["read"],
			maxCycles: 2,
			maxRequests: 4,
			maxRetries: 0,
			maxConsecutiveNoProgress: 1,
			deadlineAt: 9000,
		},
		approvalBoundary: [],
		reviewEveryMs: 1000,
	};
}

describe("protected mission metadata", () => {
	it.each(["human", "elder", "organization"] as const)("retains explicit %s creator provenance", async (kind) => {
		const location = { kind: "developer-local" as const, directory, session: "default" };
		const expected = authority(kind);
		await writeMissionAuthority(location, expected);
		expect(await readMissionAuthority(location)).toEqual(expected);
		expect((await readFile(missionAuthorityPath(location), "utf8")).endsWith("\n")).toBe(true);
	});

	it("binds every approved term and authority revision independently of object property order", () => {
		const host = authority();
		const original = terms();
		const { reviewEveryMs, ...remaining } = original;
		const reordered = { reviewEveryMs, ...remaining };
		const digest = missionDigest(original, "mission-1", 1, host);
		expect(missionDigest(reordered, "mission-1", 1, host)).toBe(digest);
		for (const changed of [
			{ ...original, objective: "A different goal" },
			{ ...original, scope: "Another workspace" },
			{ ...original, approvalBoundary: ["Ask before reading"] },
			{ ...original, policy: { ...original.policy, maxRequests: 5 } },
		])
			expect(missionDigest(changed, "mission-1", 1, host)).not.toBe(digest);
		expect(missionDigest(original, "mission-2", 1, host)).not.toBe(digest);
		expect(missionDigest(original, "mission-1", 2, host)).not.toBe(digest);
		expect(missionDigest(original, "mission-1", 1, { ...host, revision: 2 })).not.toBe(digest);
	});

	it("never revives an older approval after a replacement receipt is issued", () => {
		const host = authority();
		const input = terms();
		const receipt: MissionApproval = {
			receiptId: "first",
			requestId: "approve-1",
			installationId: null,
			session: "default",
			missionId: "mission-1",
			revision: 1,
			digest: missionDigest(input, "mission-1", 1, host),
			creator: host.creator,
			authorityRevision: 1,
			approvedAt: 1000,
			provenance: "developer-local",
			approvedBy: { kind: "developer-local", uid: process.getuid?.() ?? null },
		};
		host.approvals = [receipt];
		expect(matchingApproval(host, "first", "mission-1", 1, input)).toEqual(receipt);
		host.approvals.push({ ...receipt, receiptId: "replacement", requestId: "approve-2" });
		expect(matchingApproval(host, "first", "mission-1", 1, input)).toBeUndefined();
		expect(matchingApproval(host, "replacement", "mission-1", 1, input)?.receiptId).toBe("replacement");
	});

	it.skipIf(process.platform === "win32")("rejects symlink, writable-file and writable-parent authority", async () => {
		const location = { kind: "developer-local" as const, directory, session: "default" };
		const path = missionAuthorityPath(location);
		await writeMissionAuthority(location, authority());
		await chmod(path, 0o666);
		await expect(readMissionAuthority(location)).rejects.toThrow("Untrusted mission authority file");
		await chmod(path, 0o644);
		await chmod(directory, 0o777);
		await expect(readMissionAuthority(location)).rejects.toThrow("Untrusted mission authority directory");
		await chmod(directory, 0o700);
		const target = join(directory, "another.json");
		await writeFile(target, JSON.stringify(authority()), { mode: 0o644 });
		await rm(path);
		await symlink(target, path);
		await expect(readMissionAuthority(location)).rejects.toThrow("Untrusted mission authority file");
	});

	it("rejects oversized metadata and cross-installation writes before replacing the current file", async () => {
		const location = { kind: "developer-local" as const, directory, session: "default" };
		await writeMissionAuthority(location, authority());
		const original = await readFile(missionAuthorityPath(location));
		await expect(writeMissionAuthority(location, { ...authority(), installationId: "other" })).rejects.toThrow(
			"binding",
		);
		expect(await readFile(missionAuthorityPath(location))).toEqual(original);
		await writeFile(missionAuthorityPath(location), "x".repeat(65537));
		await expect(readMissionAuthority(location)).rejects.toThrow("Untrusted mission authority file");
	});

	it("rejects unknown actions and incomplete, expired or excessive terms before approval", () => {
		const host = authority();
		expect(() => validateMissionTerms({ objective: "No permissions yet" }, host, ["read"], 1000)).toThrow("Complete");
		expect(() => validateMissionTerms(terms(), host, [], 1000)).toThrow("registered");
		expect(() => validateMissionTerms(terms(), host, ["read"], 9000)).toThrow("future");
		expect(() =>
			validateMissionTerms({ ...terms(), policy: { ...terms().policy, maxRequests: 7 } }, host, ["read"], 1000),
		).toThrow("ceiling");
	});
});
