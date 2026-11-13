// Collects deterministic operating-system facts from the current process namespace without a model or shell.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { arch, platform, release, type, version } from "node:os";
import { dirname } from "node:path";

export type FactFailure = "missing" | "permission" | "unsupported" | "invalid_metadata" | "limit" | "timeout";

export type UserlandSystem = {
	id: string | null;
	name: string | null;
	prettyName: string | null;
	versionId: string | null;
};

export type OsMetadata =
	| { kind: "available"; source: string; value: UserlandSystem }
	| { kind: "unavailable"; source: string; reason: FactFailure };

export type OperatingSystemFacts = {
	observedAt: number;
	scope: "current-process-namespace";
	access: "service-account";
	container: "unknown";
	platform: NodeJS.Platform;
	architecture: string;
	kernel: { name: string; release: string; version: string; source: "node:os" };
	userland: OsMetadata;
};

export type OperatingSystemHost = {
	platform: NodeJS.Platform;
	architecture: string;
	kernel: OperatingSystemFacts["kernel"];
	linuxRelease(): Promise<OsMetadata>;
	macVersion(): Promise<OsMetadata>;
	now(): number;
};

/** Reads this process's OS and userland evidence; kernel version is never substituted for distribution version. */
export function operatingSystemFacts(): Promise<OperatingSystemFacts> {
	return collectOperatingSystem({
		platform: platform(),
		architecture: arch(),
		kernel: { name: type(), release: release(), version: version(), source: "node:os" },
		linuxRelease: readLinuxRelease,
		macVersion: readMacVersion,
		now: Date.now,
	});
}

/** Combines independently observed host facts without inferring container or underlying physical host identity. */
export async function collectOperatingSystem(host: OperatingSystemHost): Promise<OperatingSystemFacts> {
	const userland =
		host.platform === "linux"
			? await host.linuxRelease()
			: host.platform === "darwin"
				? await host.macVersion()
				: { kind: "unavailable" as const, source: "platform", reason: "unsupported" as const };
	return {
		observedAt: host.now(),
		scope: "current-process-namespace",
		access: "service-account",
		container: "unknown",
		platform: host.platform,
		architecture: host.architecture,
		kernel: host.kernel,
		userland,
	};
}

/** Renders the same observed facts for command and host-authored conversation replies without a provider call. */
export function renderOperatingSystemFacts(facts: OperatingSystemFacts): string {
	const system =
		facts.userland.kind === "available"
			? (facts.userland.value.prettyName ??
				[facts.userland.value.name ?? facts.userland.value.id, facts.userland.value.versionId]
					.filter(Boolean)
					.join(" "))
			: `Userland OS unavailable (${facts.userland.reason})`;
	return `${system}. Platform: ${facts.platform}; architecture: ${facts.architecture}. Kernel: ${facts.kernel.name} ${facts.kernel.release}.\nSources: kernel ${facts.kernel.source}; userland ${facts.userland.source}. Observed ${new Date(facts.observedAt).toISOString()} in the current process namespace; physical-host and container identity are unknown.`;
}

/** Parses only os-release assignments and selected public metadata, without expansion or executable shell syntax. */
export function parseOsRelease(text: string): UserlandSystem {
	if (Buffer.byteLength(text) > 16384 || /[\x00-\x09\x0b-\x1f\x7f]/.test(text))
		throw new Error("Invalid OS metadata.");
	const values: Record<string, string> = {};
	for (const line of text.split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const assignment = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line);
		if (!assignment) throw new Error("Invalid OS assignment.");
		const raw = assignment[2];
		let value: string;
		if (raw.startsWith('"')) {
			if (!/^"(?:[^"\\]|\\["\\$`])*"$/.test(raw)) throw new Error("Invalid OS quoting.");
			value = raw.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
		} else if (raw.startsWith("'")) {
			if (!/^'[^']*'$/.test(raw)) throw new Error("Invalid OS quoting.");
			value = raw.slice(1, -1);
		} else {
			if (!/^[A-Za-z0-9_.+^~/-]*$/.test(raw)) throw new Error("Invalid OS value.");
			value = raw;
		}
		if (["ID", "NAME", "PRETTY_NAME", "VERSION_ID"].includes(assignment[1])) {
			if (Buffer.byteLength(value) > 256) throw new Error("Oversize OS field.");
			values[assignment[1]] = value;
		}
	}
	if (values.ID && !/^[a-z0-9._-]+$/.test(values.ID)) throw new Error("Invalid OS identifier.");
	if (!values.ID && !values.NAME && !values.PRETTY_NAME) throw new Error("Missing OS identification.");
	return {
		id: values.ID || null,
		name: values.NAME || null,
		prettyName: values.PRETTY_NAME || null,
		versionId: values.VERSION_ID || null,
	};
}

/** Reads a fixed public metadata selector, accepting a trusted symlink while bounding the opened regular file. */
export async function readOsReleaseFile(selector: string, ownerUid: number): Promise<OsMetadata> {
	try {
		const selected = await lstat(selector);
		if (selected.uid !== ownerUid || (!selected.isSymbolicLink() && (selected.mode & 0o022) !== 0))
			return { kind: "unavailable", source: selector, reason: "permission" };
		const path = await realpath(selector);
		for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
			const info = await lstat(parent);
			const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
			if (
				!info.isDirectory() ||
				info.isSymbolicLink() ||
				(info.uid !== 0 && info.uid !== ownerUid) ||
				((info.mode & 0o022) !== 0 && !stickyRoot)
			)
				return { kind: "unavailable", source: selector, reason: "permission" };
		}
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.uid !== ownerUid || (info.mode & 0o022) !== 0)
				return { kind: "unavailable", source: selector, reason: "permission" };
			if (info.size > 16384) return { kind: "unavailable", source: selector, reason: "limit" };
			const bytes = Buffer.alloc(16385);
			let length = 0;
			while (length < bytes.length) {
				const read = await file.read(bytes, length, bytes.length - length, null);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			if (length > 16384) return { kind: "unavailable", source: selector, reason: "limit" };
			try {
				return {
					kind: "available",
					source: selector,
					value: parseOsRelease(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
				};
			} catch {
				return { kind: "unavailable", source: selector, reason: "invalid_metadata" };
			}
		} finally {
			await file.close();
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { kind: "unavailable", source: selector, reason: code === "ENOENT" ? "missing" : "permission" };
	}
}

async function readLinuxRelease(): Promise<OsMetadata> {
	const primary = await readOsReleaseFile("/etc/os-release", 0);
	return primary.kind === "unavailable" && primary.reason === "missing"
		? readOsReleaseFile("/usr/lib/os-release", 0)
		: primary;
}

async function readMacVersion(): Promise<OsMetadata> {
	return new Promise((resolve) => {
		execFile(
			"/usr/bin/sw_vers",
			["-productVersion"],
			{ timeout: 3000, maxBuffer: 1024, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } },
			(error, stdout) => {
				if (error) {
					const reason = error.killed
						? "timeout"
						: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? "limit"
							: error.code === "ENOENT"
								? "missing"
								: "permission";
					resolve({ kind: "unavailable", source: "sw_vers", reason });
					return;
				}
				const value = stdout.trim();
				if (!/^[0-9]+(?:\.[0-9]+){1,2}$/.test(value)) {
					resolve({ kind: "unavailable", source: "sw_vers", reason: "invalid_metadata" });
					return;
				}
				resolve({
					kind: "available",
					source: "sw_vers -productVersion",
					value: { id: "macos", name: "macOS", prettyName: `macOS ${value}`, versionId: value },
				});
			},
		);
	});
}
