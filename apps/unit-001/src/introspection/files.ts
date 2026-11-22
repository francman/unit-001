// Reads bounded public implementation excerpts without entering owner state or following file symlinks.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { redactJsonWebTokens } from "../evidence-redaction.ts";

export type ImplementationExcerpt =
	| {
			kind: "available";
			path: string;
			offset: number;
			nextOffset: number | null;
			totalBytes: number;
			text: string;
			redacted: boolean;
	  }
	| {
			kind: "unavailable";
			path: string;
			reason: "denied" | "missing" | "permission" | "not_regular" | "invalid_text" | "limit";
	  };

/** Reads at most 8 KiB from an allowed implementation path selected relative to the host's application root. */
export async function implementationExcerpt(root: string, path: string, offset = 0): Promise<ImplementationExcerpt> {
	if (!allowedPath(path) || !Number.isSafeInteger(offset) || offset < 0)
		return { kind: "unavailable", path, reason: "denied" };
	try {
		const canonical = await realpath(root);
		let selected = canonical;
		for (const component of path.split("/")) {
			selected = join(selected, component);
			const info = await lstat(selected);
			if (info.isSymbolicLink() || (info.mode & 0o022) !== 0) return { kind: "unavailable", path, reason: "denied" };
		}
		if (!selected.startsWith(`${canonical}${sep}`)) return { kind: "unavailable", path, reason: "denied" };
		const file = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await file.stat();
			if (!info.isFile()) return { kind: "unavailable", path, reason: "not_regular" };
			if ((info.mode & 0o022) !== 0) return { kind: "unavailable", path, reason: "denied" };
			if (info.size > 131072) return { kind: "unavailable", path, reason: "limit" };
			// Redact the entire bounded public file before paging, so a credential spanning a page cannot leak in fragments.
			const bytes = Buffer.alloc(131073);
			let length = 0;
			while (length < bytes.length) {
				const read = await file.read(bytes, length, bytes.length - length, null);
				if (read.bytesRead === 0) break;
				length += read.bytesRead;
			}
			if (length > 131072) return { kind: "unavailable", path, reason: "limit" };
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
			} catch {
				return { kind: "unavailable", path, reason: "invalid_text" };
			}
			const cleaned = redactImplementationText(text);
			const safeBytes = Buffer.from(cleaned);
			let excerpt: string;
			try {
				excerpt = new TextDecoder("utf-8", { fatal: true }).decode(safeBytes.subarray(offset, offset + 8192), {
					stream: true,
				});
			} catch {
				return { kind: "unavailable", path, reason: "invalid_text" };
			}
			const end = offset + Buffer.byteLength(excerpt);
			return {
				kind: "available",
				path,
				offset,
				nextOffset: end < safeBytes.length ? end : null,
				totalBytes: safeBytes.length,
				text: excerpt,
				redacted: cleaned !== text,
			};
		} finally {
			await file.close();
		}
	} catch (error) {
		return {
			kind: "unavailable",
			path,
			reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "permission",
		};
	}
}

function allowedPath(path: string): boolean {
	if (path.length > 300 || !path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) return false;
	return (
		path === "package.json" ||
		path === "README.md" ||
		/^docs\/.+\.md$/.test(path) ||
		/^src\/.+\.ts$/.test(path) ||
		/^dist\/.+\.js$/.test(path)
	);
}

/** Removes common literal credential forms from otherwise public implementation excerpts. */
export function redactImplementationText(text: string): string {
	const redacted = text
		.replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" || character === "\t" ? character : "�"))
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
			"[redacted private key]",
		)
		.replace(
			/(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
			"[redacted credential]",
		)
		.replace(
			/((?:["'])?\b[A-Za-z0-9_-]{0,80}(?:api[_-]?key|token|password|passwd|secret)[A-Za-z0-9_-]{0,40}(?:["'])?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
			"$1[redacted]",
		)
		.replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]")
		.replace(/(?:xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})/g, "[redacted credential]")
		.replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
	// A JWT can start anywhere inside a base64url run; the shared matcher reads each run once.
	return redactJsonWebTokens(redacted);
}
