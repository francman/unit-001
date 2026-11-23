// The one action a purpose run may take: write its own declared workspace file, inside an admitted run only.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { MissionPurposeDoc, validPurposeLoop } from "./purpose.ts";
import { listedWork, loopAgreement } from "./purpose-loop.ts";

export const WORK_TOOL = "unit_work_write";

const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

/**
 * Writes the current run's declared path with the given content. The model names no path. Not replay-safe: an
 * interrupted write stays uncertain. Its storage fence commit (`api.commit`) is where mission admission re-checks the
 * decision under the same transaction, so a write runs only after a fence that saw current authority.
 */
export function workWriteTool(cwd: string): ToolRegistration {
	return defineTool({
		name: WORK_TOOL,
		description:
			"Write the content of the file this purpose run must produce. The path is fixed by the approved work; only content is accepted.",
		parameters: Type.Object({ content: Type.String() }),
		// Offered only where a run's agent lists it; ordinary conversations never see it by default.
		deferred: true,
		execute: async (args, api, context) => {
			const loop = validPurposeLoop(await api.snapshot(MissionPurposeDoc, context));
			const run = loop?.runs.find(
				(item) =>
					item.conversation === api.conversationId &&
					item.state.status === "running" &&
					item.state.phase === "execution",
			);
			const agreement = run && loop && loopAgreement(loop, run.purposeRevision);
			const work = agreement && run && listedWork(agreement, run.workId);
			if (!work || work.kind !== "artifact-digest")
				return refusal(`${WORK_TOOL} runs only inside an admitted artifact purpose run.`);
			const content = Buffer.from(args.content, "utf8");
			if (content.length > MAX_CONTENT_BYTES) return refusal("Work content exceeds 4 MiB.");
			// The fence: mission admission wraps this commit and throws unless the decision still holds.
			await api.commit(() => undefined, context);
			await writeDeclared(cwd, work.path, content);
			return { output: [{ type: "text", text: `Wrote ${content.length} bytes to ${work.path}.` }] };
		},
	});
}

function refusal(message: string) {
	return {
		output: [{ type: "text" as const, text: message }],
		isError: true,
		diagnostics: [{ severity: "error" as const, code: "blocked", message }],
	};
}

// The declared path crosses the file boundary: every existing parent must be a real directory inside the workspace,
// and the file is replaced by rename from an exclusive temporary, so no symlink is followed.
async function writeDeclared(cwd: string, path: string, content: Buffer): Promise<void> {
	const root = await realpath(cwd);
	const target = resolve(root, path);
	const location = relative(root, target);
	if (location === "" || location.startsWith(`..${sep}`) || location === "..")
		throw new Error("Work path escapes the workspace.");
	const parents: string[] = [];
	for (let parent = dirname(target); parent !== root; parent = dirname(parent)) parents.unshift(parent);
	for (const parent of parents) {
		const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (info === null) await mkdir(parent, { mode: 0o755 });
		else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Work directory is not regular.");
	}
	const existing = await lstat(target).catch(() => null);
	if (existing && !existing.isFile()) throw new Error("Work target is not a regular file.");
	const temporary = join(dirname(target), `.${randomUUID()}.unit-work.tmp`);
	try {
		const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}
