// Projects a bounded terminal view without exposing internal conversation documents.
import {
	type AgentState,
	type ConversationView,
	type Cursor,
	type EntryRecord,
	type LiveState,
	type Page,
	type RunFailureReason,
	ToolResultEntry,
	type UsageState,
} from "@earendil-works/pi-durable";
import { HostFactEntry } from "./commands/facts.ts";
import { cutText } from "./render.ts";
import { positiveId } from "./side-control.ts";

type TextContent = string | readonly { readonly type: string; readonly text?: string }[];

/**
 * Why a tool call failed, classified by the host from Durable's diagnostic codes. Frames reach every attached
 * observer, so they never carry tool output or error text; `/evidence` shows those on request.
 */
export type ToolFailure =
	| { readonly code: "exit_code"; readonly exitCode: number }
	| { readonly code: "timeout"; readonly seconds?: number }
	| {
			readonly code:
				| "aborted"
				| "not_found"
				| "permission_denied"
				| "unavailable"
				| "blocked"
				| "invalid_arguments"
				| "unknown";
	  };

/** The class of a provider error; the provider's text never enters a frame. */
export type ProviderProblem = "rate_limited" | "auth" | "overloaded" | "network" | "unknown";

/** Why the newest run ended without an answer: Durable's reason code plus validated, host-classified fields. */
export interface RunFailureView {
	readonly reason: RunFailureReason;
	/** `model_error` only. */
	readonly problem?: ProviderProblem;
	/** `turn_limit` only: the tool rounds the run took. */
	readonly turns?: number;
}

export interface ServiceIdentity {
	readonly pid: number;
	readonly version: string;
	readonly name: string;
	readonly installationId: string | null;
}

export interface ServiceUsage {
	readonly scope: "conversation-models";
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	/** Recorded model costs are estimates here: the ledger cannot establish subscription billing or mixed provenance. */
	readonly cost: { readonly kind: "estimate"; readonly usd: number } | { readonly kind: "unknown" };
}

type TranscriptRow = {
	readonly id: number;
	readonly role: "user" | "assistant";
	readonly text: string;
	readonly truncated: boolean;
	readonly source?: "host";
};

export interface ChatHistoryPage {
	readonly entries: readonly TranscriptRow[];
	readonly nextBefore: number | null;
}

const CHAT_TEXT_LIMIT = 4096;
const HISTORY_ROW_LIMIT = 5;

export interface ServiceView extends ServiceIdentity {
	readonly model: { readonly provider: string; readonly modelId: string } | null;
	readonly usage: ServiceUsage | null;
	readonly entries: readonly TranscriptRow[];
	readonly busy: boolean;
	readonly text: string;
	readonly textTruncated: boolean;
	readonly tools: readonly {
		readonly callId: string;
		readonly name: string;
		/** `done` has no known outcome; success/failure require a matching committed result. */
		readonly status: "pending" | "running" | "done" | "succeeded" | "failed";
		/** Host-classified reason of a failed call; absent for other outcomes. See docs/tool-evidence.md. */
		readonly reason?: ToolFailure;
	}[];
	readonly historyTruncated: boolean;
	/** Why the newest run ended without an answer; present until a later run starts. */
	readonly failure?: RunFailureView;
	/** Present while the provider request waits for its next attempt; `at` is epoch milliseconds. */
	readonly retry?: { readonly attempt: number; readonly at: number; readonly problem: ProviderProblem };
}

export type ServiceEvent = { readonly type: "view"; readonly view: ServiceView };

/** Selects only bounded presentation fields from the owner's structural watch. */
export function serviceView(view: ConversationView, identity: ServiceIdentity): ServiceView {
	const entries: ServiceView["entries"][number][] = [];
	const tools = new Map<string, ServiceView["tools"][number]>();
	const results = new Map<number, ServiceView["tools"][number]>();
	for (const entry of view.entries.slice(-20)) {
		const result = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
		if (result?.role === "toolResult") {
			// Only a failed call's diagnostic code is read; no output or error text of any call is touched here.
			const reason = result.isError ? toolFailure(entry) : undefined;
			const tool: ServiceView["tools"][number] = {
				callId: cutText(result.toolCallId, 200),
				name: cutText(result.toolName, 128),
				status: result.isError ? "failed" : "succeeded",
				...(reason === undefined ? {} : { reason }),
			};
			tools.delete(result.toolCallId);
			tools.set(result.toolCallId, tool);
			results.set(entry.id, tool);
		}
		const row = transcriptRow(entry);
		if (row !== undefined) entries.push(row);
	}
	const live = view.docs["pi.live"] as LiveState | undefined;
	// These documents come from Durable's schema-checked in-process watch, not from the socket.
	const agent = view.docs["pi.agent"] as AgentState | undefined;
	const usage = view.docs["pi.usage"] as UsageState | undefined;
	const text = textPrefix(live?.generation?.message?.content ?? [], 8193);
	for (const slot of (live?.tools ?? []).slice(0, 32)) {
		// Call IDs can be reused in another round; only the slot's exact result entry establishes its outcome.
		const result = slot.status === "done" && slot.entry !== undefined ? results.get(slot.entry) : undefined;
		tools.delete(slot.callId);
		tools.set(
			slot.callId,
			result ?? { callId: cutText(slot.callId, 200), name: cutText(slot.name, 128), status: slot.status },
		);
	}
	return {
		...identity,
		model:
			agent?.model === undefined
				? null
				: { provider: cutText(agent.model.provider, 128), modelId: cutText(agent.model.modelId, 256) },
		usage: usage === undefined ? null : modelUsage(usage.models),
		entries,
		busy: live?.run !== undefined,
		text: cutText(text, 8192),
		textTruncated: text.length > 8192,
		tools: [...tools.values()].slice(-32),
		historyTruncated: view.before !== undefined,
		...runProblems(live),
	};
}

/** Projects one descending raw page and advances across hidden records while retaining the sixth visible row. */
export function projectChatHistoryPage({ items, next }: Page<EntryRecord, Cursor>): ChatHistoryPage {
	const entries: TranscriptRow[] = [];
	let lastConsumed: number | null = null;
	for (const entry of items) {
		const row = transcriptRow(entry);
		if (row !== undefined) {
			if (entries.length === HISTORY_ROW_LIMIT) return { entries: entries.reverse(), nextBefore: lastConsumed };
			entries.push(row);
		}
		lastConsumed = entry.id;
	}
	return { entries: entries.reverse(), nextBefore: next === undefined ? null : lastConsumed };
}

function transcriptRow(entry: EntryRecord): TranscriptRow | undefined {
	if (HostFactEntry.is(entry))
		return {
			id: entry.id,
			role: entry.data.role,
			text: cutText(entry.data.text, CHAT_TEXT_LIMIT),
			truncated: entry.data.text.length > CHAT_TEXT_LIMIT,
			source: "host",
		};
	let role: TranscriptRow["role"] | undefined;
	let text = "";
	for (const message of entry.model ?? []) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		role ??= message.role;
		const part = textPrefix(message.content, CHAT_TEXT_LIMIT + 1 - text.length);
		if (part !== "") text += `${text === "" ? "" : "\n"}${part}`;
		if (text.length > CHAT_TEXT_LIMIT) break;
	}
	if (role !== undefined && text !== "")
		return { id: entry.id, role, text: cutText(text, CHAT_TEXT_LIMIT), truncated: text.length > CHAT_TEXT_LIMIT };
}

// Committed result entries are immutable and shared across watch values, so each is classified once.
const toolFailures = new WeakMap<EntryRecord, ToolFailure>();

// Durable's harness and built-in tools write these codes; only messages they generate themselves are parsed.
function toolFailure(entry: EntryRecord): ToolFailure {
	const known = toolFailures.get(entry);
	if (known !== undefined) return known;
	const diagnostics = (entry.data as { diagnostics?: readonly { severity?: unknown; code?: unknown; message?: unknown }[] })
		?.diagnostics;
	const diagnostic = Array.isArray(diagnostics) ? diagnostics.find((item) => item?.severity === "error") : undefined;
	const failure = classifyTool(diagnostic?.code, typeof diagnostic?.message === "string" ? diagnostic.message : "");
	toolFailures.set(entry, failure);
	return failure;
}

const TOOL_CODES = {
	aborted: "aborted",
	tool_unavailable: "unavailable",
	blocked: "blocked",
	invalid_arguments: "invalid_arguments",
} as const;

function classifyTool(code: unknown, message: string): ToolFailure {
	// Host-generated messages are short; a longer one is foreign text and is not parsed.
	const text = message.length <= 128 ? message : "";
	if (code === "exit_code") {
		const exited = /^Command exited with code (-?\d{1,10})$/.exec(text);
		const exitCode = exited === null ? Number.NaN : Number(exited[1]);
		return Number.isSafeInteger(exitCode) ? { code: "exit_code", exitCode } : { code: "unknown" };
	}
	if (typeof code === "string" && Object.hasOwn(TOOL_CODES, code))
		return { code: TOOL_CODES[code as keyof typeof TOOL_CODES] };
	if (code !== "tool_error") return { code: "unknown" };
	// Durable prints the timeout the call asked for as a JavaScript number, so fractions and exponents occur.
	const timedOut = /^Command timed out after (\d{1,7}(?:\.\d{1,17})?(?:e-\d{1,3})?) seconds$/.exec(text);
	const seconds = timedOut === null ? Number.NaN : Number(timedOut[1]);
	if (timedOut !== null) return timeoutSeconds(seconds) ? { code: "timeout", seconds } : { code: "timeout" };
	if (text === "Command aborted" || text === "Operation aborted") return { code: "aborted" };
	if (text.startsWith("ENOENT:")) return { code: "not_found" };
	if (text.startsWith("EACCES:") || text.startsWith("EPERM:")) return { code: "permission_denied" };
	return { code: "unknown" };
}

// Why the newest run ended and whether a provider retry is waiting, both from the already mounted live document.
function runProblems(live: LiveState | undefined): Pick<ServiceView, "failure" | "retry"> {
	const failure = live?.runFailure;
	const retry = live?.generation?.retry;
	return {
		...(failure === undefined ? {} : { failure: runFailure(failure) }),
		...(retry === undefined || live?.generation === undefined
			? {}
			: { retry: { attempt: live.generation.attempt, at: retry.at, problem: providerProblem(retry, retry.error) } }),
	};
}

function runFailure(failure: NonNullable<LiveState["runFailure"]>): RunFailureView {
	if (failure.reason === "model_error")
		return { reason: failure.reason, problem: providerProblem(failure, failure.detail ?? "") };
	const turns = failure.reason === "turn_limit" ? /^(\d{1,6}) turns?$/.exec(failure.detail ?? "") : null;
	return turns === null ? { reason: failure.reason } : { reason: failure.reason, turns: Number(turns[1]) };
}

// The live document keeps an unchanged failure or retry object across watch values, so each is classified once.
const providerProblems = new WeakMap<object, ProviderProblem>();

// Reads only a bounded prefix; status codes and fixed phrases select the class, the text itself is dropped.
function providerProblem(owner: object, error: string): ProviderProblem {
	const known = providerProblems.get(owner);
	if (known !== undefined) return known;
	const head = error.slice(0, 512).toLowerCase();
	const problem: ProviderProblem = /\b429\b|rate.?limit|too many requests/.test(head)
		? "rate_limited"
		: /\b40[13]\b|unauthori[sz]ed|authenticat|forbidden|invalid.{0,8}(?:api.?key|x-api-key|token)/.test(head)
			? "auth"
			: /\b(?:529|503)\b|overloaded|capacity/.test(head)
				? "overloaded"
				: /econnreset|econnrefused|etimedout|enotfound|eai_again|fetch failed|socket hang up|network/.test(head)
					? "network"
					: "unknown";
	providerProblems.set(owner, problem);
	return problem;
}

const TOOL_SUMMARIES = {
	aborted: "Aborted.",
	not_found: "File or directory not found.",
	permission_denied: "Permission denied.",
	unavailable: "Tool is not available.",
	blocked: "Blocked by a tool policy.",
	invalid_arguments: "The model sent invalid arguments.",
} as const;

/** A fixed English summary of a failed call; only validated numbers and the call ID prefix are interpolated. */
export function toolFailureSummary(failure: ToolFailure, callId: string): string {
	if (failure.code === "exit_code") return `Exited with code ${failure.exitCode}.`;
	if (failure.code === "timeout")
		return failure.seconds === undefined ? "Timed out." : `Timed out after ${failure.seconds} seconds.`;
	if (failure.code === "unknown") return `Tool failed; run /evidence ${cutText(callId, 12)} for details.`;
	return TOOL_SUMMARIES[failure.code];
}

const PROVIDER_SUMMARIES: Record<ProviderProblem, string> = {
	rate_limited: "provider rate limited",
	auth: "provider rejected the credentials",
	overloaded: "provider overloaded",
	network: "provider unreachable",
	unknown: "provider error",
};

/** A fixed English summary of a provider error class. */
export function providerProblemSummary(problem: ProviderProblem): string {
	return PROVIDER_SUMMARIES[problem];
}

const RUN_SUMMARIES: Record<RunFailureReason, string> = {
	model_error: "provider error",
	no_model: "no model is available",
	aborted: "the run was cancelled",
	reset: "the conversation was reset",
	faulted: "the run hit an internal error",
	orphaned: "the run could not resume",
	interrupted: "the host stopped repeatedly while the model was answering",
	restart_limit: "the run was cut off too often",
	nothing_to_answer: "there was nothing to answer",
	turn_limit: "the run reached its tool round limit",
};

/** A fixed English summary of why the newest run ended without an answer. */
export function runFailureSummary(failure: RunFailureView): string {
	if (failure.problem !== undefined) return providerProblemSummary(failure.problem);
	if (failure.turns !== undefined) return `${RUN_SUMMARIES[failure.reason]} (${failure.turns} turns)`;
	return RUN_SUMMARIES[failure.reason];
}

// Durable structurally shares unchanged buckets; do counted aggregation only when recorded model usage changes.
const usageSummaries = new WeakMap<UsageState["models"], ServiceUsage | null>();

function modelUsage(models: UsageState["models"]): ServiceUsage | null {
	const previous = usageSummaries.get(models);
	if (previous !== undefined) return previous;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let usd = 0;
	let known = true;
	let recorded = false;
	for (const usage of Object.values(models)) {
		recorded = true;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		totalTokens += usage.totalTokens;
		usd += usage.cost.total;
		// A zero ledger cost does not distinguish missing prices, subscriptions, or a genuinely free request.
		if (usage.cost.total <= 0) known = false;
	}
	const summary: ServiceUsage | null = recorded
		? {
				scope: "conversation-models",
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens,
				cost: known ? { kind: "estimate", usd } : { kind: "unknown" },
			}
		: null;
	usageSummaries.set(models, summary);
	return summary;
}

function textPrefix(content: TextContent, limit: number): string {
	if (typeof content === "string") return content.slice(0, limit);
	let text = "";
	for (const block of content) {
		if (block.type !== "text" || block.text === undefined) continue;
		text += block.text.slice(0, limit - text.length);
		if (text.length === limit) break;
	}
	return text;
}

/** Decodes the closed owner history page, including its ordering and exclusive bound when known. */
export function parseChatHistoryPage(value: unknown, before?: number | null): ChatHistoryPage {
	if (
		!closed(value, ["entries", "nextBefore"]) ||
		!Array.isArray(value.entries) ||
		value.entries.length > HISTORY_ROW_LIMIT
	)
		throw new Error("Invalid service chat history page.");
	const { nextBefore } = value;
	const entries: TranscriptRow[] = [];
	let previousId = 0;
	for (const row of value.entries) {
		if (
			!closed(row, ["id", "role", "text", "truncated", "source"]) ||
			!positiveId(row.id) ||
			row.id <= previousId ||
			(typeof before === "number" && row.id >= before) ||
			(row.role !== "user" && row.role !== "assistant") ||
			typeof row.text !== "string" ||
			row.text.length > CHAT_TEXT_LIMIT ||
			typeof row.truncated !== "boolean" ||
			(row.source !== undefined && row.source !== "host")
		)
			throw new Error("Invalid service chat history row.");
		entries.push({
			id: row.id,
			role: row.role,
			text: row.text,
			truncated: row.truncated,
			...(row.source === "host" ? { source: row.source } : {}),
		});
		previousId = row.id;
	}
	if (
		nextBefore !== null &&
		(!positiveId(nextBefore) ||
			(typeof before === "number" && nextBefore >= before) ||
			(entries[0] !== undefined && nextBefore > entries[0].id))
	)
		throw new Error("Invalid service chat history continuation.");
	return { entries, nextBefore };
}

/** Validates bounded untrusted socket frames before exposing them to terminal rendering. */
export function parseServiceEvent(wire: string): ServiceEvent {
	const event: unknown = JSON.parse(wire);
	if (!object(event) || event.type !== "view" || !object(event.view)) throw new Error("Invalid service view.");
	const value = event.view;
	if (
		value.model !== null &&
		(!object(value.model) ||
			typeof value.model.provider !== "string" ||
			value.model.provider.length > 128 ||
			typeof value.model.modelId !== "string" ||
			value.model.modelId.length > 256)
	)
		throw new Error("Invalid service model.");
	if (value.usage !== null) {
		if (!object(value.usage) || value.usage.scope !== "conversation-models" || !object(value.usage.cost))
			throw new Error("Invalid service usage.");
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			const count = value.usage[key];
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
				throw new Error("Invalid service usage.");
		}
		if (
			value.usage.cost.kind !== "unknown" &&
			(value.usage.cost.kind !== "estimate" ||
				typeof value.usage.cost.usd !== "number" ||
				!Number.isFinite(value.usage.cost.usd) ||
				value.usage.cost.usd <= 0)
		)
			throw new Error("Invalid service cost.");
	}
	if (
		!Number.isSafeInteger(value.pid) ||
		typeof value.version !== "string" ||
		typeof value.name !== "string" ||
		!(value.installationId === null || typeof value.installationId === "string") ||
		typeof value.busy !== "boolean" ||
		typeof value.text !== "string" ||
		value.text.length > 8192 ||
		typeof value.textTruncated !== "boolean" ||
		typeof value.historyTruncated !== "boolean" ||
		!Array.isArray(value.entries) ||
		value.entries.length > 20 ||
		!Array.isArray(value.tools) ||
		value.tools.length > 32
	)
		throw new Error("Invalid service view.");
	for (const entry of value.entries)
		if (
			!object(entry) ||
			!Number.isSafeInteger(entry.id) ||
			(entry.role !== "user" && entry.role !== "assistant") ||
			typeof entry.text !== "string" ||
			entry.text.length > CHAT_TEXT_LIMIT ||
			(entry.source !== undefined && entry.source !== "host") ||
			typeof entry.truncated !== "boolean"
		)
			throw new Error("Invalid service transcript.");
	for (const tool of value.tools)
		if (
			!object(tool) ||
			typeof tool.callId !== "string" ||
			tool.callId.length > 200 ||
			typeof tool.name !== "string" ||
			tool.name.length > 128 ||
			typeof tool.status !== "string" ||
			!["pending", "running", "done", "succeeded", "failed"].includes(tool.status) ||
			(tool.reason !== undefined && !toolFailureShape(tool.reason))
		)
			throw new Error("Invalid service tool status.");
	const { failure, retry } = value;
	if (
		failure !== undefined &&
		(!closed(failure, ["reason", "problem", "turns"]) ||
			!(RUN_FAILURE_REASONS as readonly unknown[]).includes(failure.reason) ||
			(failure.problem !== undefined && !(PROVIDER_PROBLEMS as readonly unknown[]).includes(failure.problem)) ||
			(failure.turns !== undefined && !count(failure.turns)))
	)
		throw new Error("Invalid service failure.");
	if (
		retry !== undefined &&
		(!closed(retry, ["attempt", "at", "problem"]) ||
			!Number.isSafeInteger(retry.attempt) ||
			!Number.isSafeInteger(retry.at) ||
			(retry.at as number) < 0 ||
			// A larger value is not a valid Date, which the terminal formats.
			(retry.at as number) > 8_640_000_000_000_000 ||
			!(PROVIDER_PROBLEMS as readonly unknown[]).includes(retry.problem))
	)
		throw new Error("Invalid service retry.");
	// The wire boundary above establishes every field of the public projection.
	return event as unknown as ServiceEvent;
}

const RUN_FAILURE_REASONS = Object.keys(RUN_SUMMARIES) as readonly RunFailureReason[];
const PROVIDER_PROBLEMS = Object.keys(PROVIDER_SUMMARIES) as readonly ProviderProblem[];
const PLAIN_TOOL_FAILURES: readonly unknown[] = [...Object.keys(TOOL_SUMMARIES), "unknown"];

// Closed shapes: a frame field that is not one of these typed values (such as free-form error text) is rejected.
function toolFailureShape(value: unknown): boolean {
	if (!object(value)) return false;
	if (value.code === "exit_code") return closed(value, ["code", "exitCode"]) && Number.isSafeInteger(value.exitCode);
	if (value.code === "timeout")
		return closed(value, ["code", "seconds"]) && (value.seconds === undefined || timeoutSeconds(value.seconds));
	return closed(value, ["code"]) && PLAIN_TOOL_FAILURES.includes(value.code);
}

// Durable accepts any positive timeout up to the timer limit of 2^31 - 1 milliseconds.
const MAX_TIMEOUT_SECONDS = 2_147_483.647;

function timeoutSeconds(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_TIMEOUT_SECONDS;
}

function count(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function closed(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
	return object(value) && Object.keys(value).every((field) => fields.includes(field));
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
