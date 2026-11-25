// Projects one tool call's bounded, redacted evidence on explicit request; the boundary is docs/tool-evidence.md.
import { realpath } from "node:fs/promises";
import type { JsonValue } from "@earendil-works/chord";
import { type EntryRecord, ToolResultEntry } from "@earendil-works/pi-durable";
import {
	ARGUMENT_LIMITS,
	credentialLocation,
	namesCredentialPath,
	REDACTION_SOURCE_LIMIT,
	redactArguments,
	redactEvidenceText,
	resolvedCredentialRoots,
} from "./evidence-redaction.ts";
import { FILE_TOOLS, type FileProvenance, readProvenance } from "./file-provenance.ts";
import { cutText, sanitizeTerminalText } from "./render.ts";

export const EVIDENCE_LIMITS = { arguments: 2048, output: 4096, diff: 4096 } as const;

/** Newest conversation entries one explicit request may scan. */
export const EVIDENCE_SCAN_ENTRIES = 200;

/** Shortest call ID prefix that selects a call. */
export const EVIDENCE_MIN_PREFIX = 6;

/** Redacted text cut to its limit; `bytes` is the redacted size before the cut, or the source size when withheld. */
export interface EvidenceField {
	readonly text: string;
	readonly bytes: number;
	readonly truncated: boolean;
	readonly redacted: boolean;
}

export type ToolEvidence =
	| {
			readonly kind: "found";
			readonly callId: string;
			readonly name: string;
			/** `pending`: the call was issued and has no committed result yet. */
			readonly status: "pending" | "succeeded" | "failed";
			readonly arguments: EvidenceField;
			readonly output: EvidenceField | null;
			readonly diff: EvidenceField | null;
			/**
			 * Output, diff and content-bearing arguments are not shown: `credential-path`, the call used a credential file;
			 * `unverified-file`, a file tool whose file cannot be established from what it recorded when it ran.
			 */
			readonly withheld: Withheld | null;
			/** `classified`: a file tool whose recorded file is not a credential location; else only patterns redacted it. */
			readonly redaction: "classified" | "pattern-only";
			/** The tool's output was already cut before evidence saw it, so context identifying a secret may be missing. */
			readonly sourceTruncated: boolean;
	  }
	| { readonly kind: "unavailable"; readonly reason: "not-found" | "ambiguous" };

/** Why evidence content is withheld. */
export type Withheld = "credential-path" | "unverified-file";

/** What the owner supplies to classify and redact evidence; computed once per owner process. */
export interface EvidenceScope {
	/** The directory the agent's tools resolve relative paths against. */
	readonly cwd: string;
	/** Literal values to redact, such as the owner's secret-named environment values. */
	readonly secrets: readonly string[];
	/** Directories whose every file is a credential location, such as /etc/unit-001 and channel credentials. */
	readonly credentialRoots: readonly string[];
}

type Block = {
	readonly type?: string;
	readonly id?: string;
	readonly name?: string;
	readonly text?: string;
	readonly arguments?: JsonValue;
};
type EvidenceMessage = {
	readonly role?: string;
	readonly content?: unknown;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly details?: unknown;
};

/** Finds a call in newest-first entries and projects its evidence, withholding what a credential file produced. */
export async function projectToolEvidence(
	entries: readonly EntryRecord[],
	callId: string,
	scope: EvidenceScope,
): Promise<ToolEvidence> {
	const lookup = resolveCallId(entries, callId);
	if (lookup.kind === "unavailable") return lookup;
	const { id } = lookup;
	let result: { readonly entry: EntryRecord; readonly message: EvidenceMessage } | undefined;
	for (const entry of entries) {
		const message = entry.model?.[0] as EvidenceMessage | undefined;
		if (ToolResultEntry.is(entry) && message?.role === "toolResult" && message.toolCallId === id) {
			result ??= { entry, message };
			continue;
		}
		const call = message?.role === "assistant" ? toolCalls(message).find((block) => block.id === id) : undefined;
		if (call === undefined) continue;
		const name = call.name ?? result?.message.toolName ?? "";
		const args = call.arguments ?? {};
		const details = result?.message.details as { diff?: unknown } | undefined;
		const source = await classifySource(name, args, readProvenance(details), scope);
		const diff = typeof details?.diff === "string" ? details.diff : undefined;
		const shown = source.withheld === null ? result?.message : undefined;
		const projected = redactArguments(source.withheld === null ? args : withheldArguments(args), scope.secrets);
		return {
			kind: "found",
			callId: cutText(id, 200),
			name: cutText(name, 128),
			status: result === undefined ? "pending" : result.message.isError ? "failed" : "succeeded",
			arguments: cutField(JSON.stringify(projected.value), EVIDENCE_LIMITS.arguments, projected.redacted),
			output: shown === undefined ? null : outputField(shown, scope.secrets),
			diff: shown === undefined || diff === undefined ? null : textField(diff, EVIDENCE_LIMITS.diff, scope.secrets),
			withheld: source.withheld,
			redaction: source.redaction,
			sourceTruncated: result !== undefined && truncatedUpstream(result.entry),
		};
	}
	return { kind: "unavailable", reason: "not-found" };
}

// An exact ID wins; otherwise a unique prefix of at least EVIDENCE_MIN_PREFIX characters selects the call.
function resolveCallId(
	entries: readonly EntryRecord[],
	wanted: string,
): { readonly kind: "found"; readonly id: string } | Extract<ToolEvidence, { readonly kind: "unavailable" }> {
	if (wanted.length < EVIDENCE_MIN_PREFIX) return { kind: "unavailable", reason: "not-found" };
	const matches = new Set<string>();
	for (const entry of entries) {
		const message = entry.model?.[0] as EvidenceMessage | undefined;
		const ids =
			message?.role === "toolResult"
				? [message.toolCallId]
				: message?.role === "assistant"
					? toolCalls(message).map((block) => block.id)
					: [];
		for (const id of ids) if (id !== undefined && id.startsWith(wanted)) matches.add(id);
	}
	if (matches.has(wanted)) return { kind: "found", id: wanted };
	if (matches.size === 1) return { kind: "found", id: [...matches][0] };
	return { kind: "unavailable", reason: matches.size === 0 ? "not-found" : "ambiguous" };
}

function toolCalls(message: EvidenceMessage): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]).filter((block) => block.type === "toolCall") : [];
}

const PATH_LIMIT = 4096;

type Source = { readonly withheld: Withheld | null; readonly redaction: "classified" | "pattern-only" };

/**
 * A file tool is classified by the files it recorded when it ran (`file-provenance.ts`), never by resolving its
 * arguments now: a path retargeted since then would name a different file. No record (a pending call, an entry from
 * before recording, a malformed record) or a record the file system now contradicts withholds. Any other tool is
 * opaque (a shell command can open any file whatever it spells), so only an obvious credential name in its arguments
 * withholds it, and the reply says only patterns redacted it.
 */
async function classifySource(
	name: string,
	args: JsonValue,
	provenance: FileProvenance | undefined,
	scope: EvidenceScope,
): Promise<Source> {
	const path = typeof args === "object" && args !== null && !Array.isArray(args) ? args.path : undefined;
	if (!FILE_TOOLS.has(name) || typeof path !== "string")
		return { withheld: spellsCredentialPath(args) ? "credential-path" : null, redaction: "pattern-only" };
	if (path.length > PATH_LIMIT || namesCredentialPath(path))
		return { withheld: "credential-path", redaction: "classified" };
	if (provenance === undefined || !provenance.complete || provenance.files.length === 0)
		return { withheld: "unverified-file", redaction: "pattern-only" };
	// The decision taken when the call ran stands, so a root retargeted since cannot clear it; today's roots can only
	// add to it.
	const roots = await resolvedCredentialRoots(scope.credentialRoots);
	for (const file of provenance.files)
		if (
			file.credential ||
			credentialLocation(file.path, roots) ||
			(file.resolved !== null && credentialLocation(file.resolved, roots))
		)
			return { withheld: "credential-path", redaction: "classified" };
	for (const file of provenance.files) {
		if (file.resolved === null) return { withheld: "unverified-file", redaction: "pattern-only" };
		// A path that now resolves elsewhere contradicts the record, so the record is not trusted. A file removed since
		// leaves the record standing: it still names what the call used.
		const now = await realpath(file.path).catch(() => undefined);
		if (now !== undefined && now !== file.resolved) return { withheld: "unverified-file", redaction: "pattern-only" };
	}
	return { withheld: null, redaction: "classified" };
}

// String leaves and keys within one budget of nodes and characters, charged before each child is visited, so a wide
// structure stops matching at the budget (key collection stays linear in width, see `redactNode`); arguments too large
// or too deep to scan cannot be cleared, so they withhold.
function spellsCredentialPath(value: JsonValue, budget = { nodes: 0, chars: 0 }, depth = 0): boolean {
	if (++budget.nodes > ARGUMENT_LIMITS.nodes) return true;
	if (typeof value === "string") {
		budget.chars += value.length;
		return budget.chars > REDACTION_SOURCE_LIMIT || namesCredentialPath(value);
	}
	if (typeof value !== "object" || value === null) return false;
	if (depth >= ARGUMENT_LIMITS.depth) return true;
	if (Array.isArray(value)) {
		for (const item of value) if (spellsCredentialPath(item, budget, depth + 1)) return true;
		return false;
	}
	for (const name in value) {
		const item = value[name];
		if (item === undefined) continue;
		if (spellsCredentialPath(name, budget, depth) || spellsCredentialPath(item, budget, depth + 1)) return true;
	}
	return false;
}

const WITHHELD_ARGUMENT_NAMES = 16;

// Only the path survives: for write and edit the other arguments are the file's content. Names are kept up to a bound
// and a wide argument object is not copied past it.
function withheldArguments(args: JsonValue): JsonValue {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return "[withheld]";
	const kept: Record<string, JsonValue> = {};
	let names = 0;
	for (const name in args) {
		const value = args[name];
		if (value === undefined) continue;
		if (++names > WITHHELD_ARGUMENT_NAMES) {
			kept["[withheld]"] = "[withheld: more arguments]";
			break;
		}
		kept[name] = name === "path" && typeof value === "string" ? value : "[withheld]";
	}
	return kept;
}

const OUTPUT_BLOCK_LIMIT = 1024;
const IMAGE_PLACEHOLDER = "[image omitted]";

// Durable bounds adjacent text blocks as one text, so they are joined without a separator, as the model saw them. The
// block count and the joined size, placeholders included, are checked before anything is joined.
function outputField(message: EvidenceMessage, secrets: readonly string[]): EvidenceField {
	if (!Array.isArray(message.content)) return textField("", EVIDENCE_LIMITS.output, secrets);
	const blocks = message.content as Block[];
	if (blocks.length > OUTPUT_BLOCK_LIMIT) return withheldField(blocks.length * IMAGE_PLACEHOLDER.length);
	let size = 0;
	for (const block of blocks) size += block.type === "text" ? (block.text?.length ?? 0) : IMAGE_PLACEHOLDER.length;
	if (size > REDACTION_SOURCE_LIMIT) return withheldField(size);
	const text = blocks.map((block) => (block.type === "text" ? (block.text ?? "") : IMAGE_PLACEHOLDER)).join("");
	return textField(text, EVIDENCE_LIMITS.output, secrets);
}

// Redact the whole field before cutting, so a secret straddling the limit is never half shown.
function textField(text: string, limit: number, secrets: readonly string[]): EvidenceField {
	if (text.length > REDACTION_SOURCE_LIMIT) return withheldField(text.length);
	const redacted = redactEvidenceText(text, secrets);
	return cutField(redacted, limit, redacted !== text);
}

// Too large to redact within bounded work, so nothing of it is shown; `bytes` is a UTF-16 lower bound of its size.
function withheldField(size: number): EvidenceField {
	return { text: "[withheld: too large to redact]", bytes: size, truncated: true, redacted: true };
}

function cutField(text: string, limit: number, redacted: boolean): EvidenceField {
	const bytes = Buffer.byteLength(text);
	if (bytes <= limit) return { text, bytes, truncated: false, redacted };
	let cut = new TextDecoder().decode(Buffer.from(text).subarray(0, limit));
	// A cut inside a multibyte character leaves one replacement character at the end.
	if (cut.endsWith("�")) cut = cut.slice(0, -1);
	return { text: cut, bytes, truncated: true, redacted };
}

function truncatedUpstream(entry: EntryRecord): boolean {
	const diagnostics = (entry.data as { diagnostics?: readonly { code?: unknown }[] } | undefined)?.diagnostics;
	return Array.isArray(diagnostics) && diagnostics.some((diagnostic) => diagnostic?.code === "truncated");
}

/** Validates an untrusted evidence reply from the owner socket. */
export function parseToolEvidence(value: unknown): ToolEvidence {
	if (typeof value !== "object" || value === null) throw new Error("Invalid tool evidence.");
	const evidence = value as Record<string, unknown>;
	if (evidence.kind === "unavailable") {
		if (evidence.reason !== "not-found" && evidence.reason !== "ambiguous") throw new Error("Invalid tool evidence.");
		return { kind: "unavailable", reason: evidence.reason };
	}
	if (
		evidence.kind !== "found" ||
		typeof evidence.callId !== "string" ||
		evidence.callId.length > 200 ||
		typeof evidence.name !== "string" ||
		evidence.name.length > 128 ||
		(evidence.status !== "pending" && evidence.status !== "succeeded" && evidence.status !== "failed") ||
		(evidence.withheld !== null && evidence.withheld !== "credential-path" && evidence.withheld !== "unverified-file") ||
		(evidence.redaction !== "classified" && evidence.redaction !== "pattern-only") ||
		typeof evidence.sourceTruncated !== "boolean"
	)
		throw new Error("Invalid tool evidence.");
	return {
		kind: "found",
		callId: evidence.callId,
		name: evidence.name,
		status: evidence.status,
		arguments: parseField(evidence.arguments, EVIDENCE_LIMITS.arguments),
		output: parseOptionalField(evidence.output, EVIDENCE_LIMITS.output),
		diff: parseOptionalField(evidence.diff, EVIDENCE_LIMITS.diff),
		withheld: evidence.withheld,
		redaction: evidence.redaction,
		sourceTruncated: evidence.sourceTruncated,
	};
}

function parseOptionalField(value: unknown, limit: number): EvidenceField | null {
	return value === null ? null : parseField(value, limit);
}

function parseField(value: unknown, limit: number): EvidenceField {
	const item = value as Record<string, unknown> | null;
	if (
		typeof item !== "object" ||
		item === null ||
		typeof item.text !== "string" ||
		Buffer.byteLength(item.text) > limit ||
		typeof item.bytes !== "number" ||
		!Number.isSafeInteger(item.bytes) ||
		item.bytes < 0 ||
		typeof item.truncated !== "boolean" ||
		typeof item.redacted !== "boolean"
	)
		throw new Error("Invalid tool evidence field.");
	return { text: item.text, bytes: item.bytes, truncated: item.truncated, redacted: item.redacted };
}

const WITHHELD_OUTPUT: Record<Withheld | "none", string> = {
	"credential-path": "withheld, the call used a credential file",
	"unverified-file": "withheld, the file this call used cannot be established from its record",
	none: "no committed result yet",
};

/** Renders evidence as terminal-safe lines; every owner string is sanitized here. */
export function evidenceLines(evidence: ToolEvidence): string[] {
	if (evidence.kind === "unavailable")
		return [
			evidence.reason === "ambiguous"
				? `Evidence: that call ID prefix matches several calls; use more characters.`
				: `Evidence: no such call in the newest ${EVIDENCE_SCAN_ENTRIES} entries (IDs need at least ${EVIDENCE_MIN_PREFIX} characters).`,
		];
	const lines = [
		`Evidence · ${sanitizeTerminalText(evidence.name)} · ${evidence.status} · ${sanitizeTerminalText(evidence.callId)}`,
	];
	if (evidence.withheld === null && evidence.redaction === "pattern-only")
		lines.push("Redaction: pattern-only (source unclassified); a secret in an unrecognized format can remain.");
	if (evidence.sourceTruncated)
		lines.push("Source: output was truncated before evidence saw it; context identifying a secret may be missing.");
	const section = (title: string, item: EvidenceField | null, absent: string) => {
		if (item === null) {
			lines.push(`${title}: ${absent}`);
			return;
		}
		const notes = [
			...(item.redacted ? ["redacted"] : []),
			...(item.truncated ? [`truncated, ${item.bytes} bytes before cut`] : []),
		];
		lines.push(`${title}${notes.length === 0 ? "" : ` [${notes.join("; ")}]`}:`);
		lines.push(...sanitizeTerminalText(item.text).split("\n"));
	};
	section("Arguments", evidence.arguments, "");
	section("Output", evidence.output, WITHHELD_OUTPUT[evidence.withheld ?? "none"]);
	if (evidence.diff !== null) section("Diff", evidence.diff, "");
	return lines;
}
