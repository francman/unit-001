// Observes this process and its accessible filesystem without shell execution or privileged host claims.
import { statfs } from "node:fs/promises";
import { arch, availableParallelism, freemem, loadavg, totalmem, uptime } from "node:os";

export type HostResources = {
	observedAt: number;
	scope: "current-process-namespace";
	source: "node:process/node:os/node:fs";
	process: {
		pid: number;
		uid: number | null;
		gid: number | null;
		node: string;
		architecture: string;
		uptimeMs: number;
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
		externalBytes: number;
	};
	system: {
		availableParallelism: number;
		totalMemoryBytes: number;
		freeMemoryBytes: number;
		uptimeSeconds: number;
		loadAverage: readonly number[];
		containerLimit: "unobserved";
	};
	filesystem:
		| { kind: "available"; scope: "workspace-filesystem"; totalBytes: string; availableBytes: string }
		| { kind: "unavailable"; reason: "permission-or-unsupported" };
};

/** Reads process metrics and workspace filesystem capacity; system memory is never claimed as an enforced process limit. */
export async function hostResources(workspace: string): Promise<HostResources> {
	const memory = process.memoryUsage();
	let filesystem: HostResources["filesystem"];
	try {
		const fs = await statfs(workspace, { bigint: true });
		filesystem = {
			kind: "available",
			scope: "workspace-filesystem",
			totalBytes: String(fs.bsize * fs.blocks),
			availableBytes: String(fs.bsize * fs.bavail),
		};
	} catch {
		filesystem = { kind: "unavailable", reason: "permission-or-unsupported" };
	}
	return {
		observedAt: Date.now(),
		scope: "current-process-namespace",
		source: "node:process/node:os/node:fs",
		process: {
			pid: process.pid,
			uid: process.getuid?.() ?? null,
			gid: process.getgid?.() ?? null,
			node: process.version,
			architecture: arch(),
			uptimeMs: Math.floor(process.uptime() * 1000),
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
			heapTotalBytes: memory.heapTotal,
			externalBytes: memory.external,
		},
		system: {
			availableParallelism: availableParallelism(),
			totalMemoryBytes: totalmem(),
			freeMemoryBytes: freemem(),
			uptimeSeconds: uptime(),
			loadAverage: loadavg(),
			containerLimit: "unobserved",
		},
		filesystem,
	};
}
