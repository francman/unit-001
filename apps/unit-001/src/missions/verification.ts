// Verifies creator-selected file digests without trusting the model's completion claim.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { MissionEvidence } from "./execution-state.ts";

/** Reports whether every criterion has a deterministic verifier. */
export function supportedMissionCriteria(criteria: readonly string[]): boolean {
	return criteria.every((criterion) => parseCriterion(criterion) !== null);
}

/** Observes bounded regular files; unavailable, changing or mismatched files never count as success. */
export async function verifyMissionFiles(
	criteria: readonly string[],
	cwd: string,
	now: number,
): Promise<MissionEvidence[]> {
	const root = await realpath(cwd);
	return Promise.all(
		criteria.map(async (criterion) => {
			const check = parseCriterion(criterion);
			if (check === null) return { criterion, observedAt: now, accepted: false, detail: "Unsupported verifier." };
			try {
				const target = resolve(root, check.path);
				const location = relative(root, target);
				if (location === "" || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location))
					throw new Error("Verifier path must be inside the workspace.");
				// The approved criterion crosses the file boundary; directories and final files must not be symlinks.
				for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
					const info = await lstat(parent);
					if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Verifier directory is not regular.");
				}
				const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const before = await file.stat();
					const pathInfo = await lstat(target);
					const actualPath = relative(root, await realpath(target));
					if (
						pathInfo.isSymbolicLink() ||
						pathInfo.dev !== before.dev ||
						pathInfo.ino !== before.ino ||
						actualPath === ".." ||
						actualPath.startsWith(`..${sep}`) ||
						isAbsolute(actualPath)
					)
						throw new Error("Verifier file moved outside its workspace.");
					if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error("Verifier file must fit 4 MiB.");
					const hash = createHash("sha256");
					const buffer = Buffer.alloc(65536);
					let position = 0;
					for (;;) {
						const { bytesRead } = await file.read(
							buffer,
							0,
							Math.min(buffer.length, before.size + 1 - position),
							position,
						);
						if (bytesRead === 0) break;
						position += bytesRead;
						if (position > before.size) throw new Error("Verifier file changed while reading.");
						hash.update(buffer.subarray(0, bytesRead));
					}
					const after = await file.stat();
					if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
						throw new Error("Verifier file changed while reading.");
					const digest = hash.digest("hex");
					return {
						criterion,
						observedAt: now,
						accepted: digest === check.digest,
						detail: `Observed SHA-256 ${digest}.`,
					};
				} finally {
					await file.close();
				}
			} catch {
				return {
					criterion,
					observedAt: now,
					accepted: false,
					detail: "File absent, inaccessible, unsafe or changed.",
				};
			}
		}),
	);
}

function parseCriterion(criterion: string): { digest: string; path: string } | null {
	const match = /^sha256:([a-f0-9]{64}):([^\0\r\n]+)$/.exec(criterion);
	if (
		!match ||
		isAbsolute(match[2]) ||
		match[2] === "." ||
		/[\\/]$/.test(match[2]) ||
		match[2].split(/[\\/]/).includes("..")
	)
		return null;
	return { digest: match[1], path: match[2] };
}
