// Projects a bounded terminal view without exposing internal conversation documents.
import {
	type AgentState,
	type ConversationView,
	type LiveState,
	ToolResultEntry,
	type UsageState,
} from "@earendil-works/pi-durable";

type TextContent = string | readonly { readonly type: string; readonly text?: string }[];

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

export interface ServiceView extends ServiceIdentity {
	readonly model: { readonly provider: string; readonly modelId: string } | null;
	readonly usage: ServiceUsage | null;
	readonly entries: readonly {
		readonly id: number;
		readonly role: "user" | "assistant";
		readonly text: string;
		readonly truncated: boolean;
	}[];
	readonly busy: boolean;
	readonly text: string;
	readonly textTruncated: boolean;
	readonly tools: readonly {
		readonly callId: string;
		readonly name: string;
		/** `done` has no known outcome; success/failure require a matching committed result. */
		readonly status: "pending" | "running" | "done" | "succeeded" | "failed";
	}[];
	readonly historyTruncated: boolean;
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
			const tool: ServiceView["tools"][number] = {
				callId: result.toolCallId.slice(0, 200),
				name: result.toolName.slice(0, 128),
				status: result.isError ? "failed" : "succeeded",
			};
			tools.delete(result.toolCallId);
			tools.set(result.toolCallId, tool);
			results.set(entry.id, tool);
		}
		let role: "user" | "assistant" | undefined;
		let text = "";
		for (const message of entry.model ?? []) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			role ??= message.role;
			const part = textPrefix(message.content, 4097 - text.length);
			if (part !== "") text += `${text === "" ? "" : "\n"}${part}`;
			if (text.length > 4096) break;
		}
		if (text !== "" && role !== undefined)
			entries.push({
				id: entry.id,
				role,
				text: text.slice(0, 4096),
				truncated: text.length > 4096,
			});
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
			result ?? { callId: slot.callId.slice(0, 200), name: slot.name.slice(0, 128), status: slot.status },
		);
	}
	return {
		...identity,
		model:
			agent?.model === undefined
				? null
				: { provider: agent.model.provider.slice(0, 128), modelId: agent.model.modelId.slice(0, 256) },
		usage: usage === undefined ? null : modelUsage(usage.models),
		entries: entries.slice(-20),
		busy: live?.run !== undefined,
		text: text.slice(0, 8192),
		textTruncated: text.length > 8192,
		tools: [...tools.values()].slice(-32),
		historyTruncated: view.before !== undefined || entries.length > 20,
	};
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
			entry.text.length > 4096 ||
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
			!["pending", "running", "done", "succeeded", "failed"].includes(tool.status)
		)
			throw new Error("Invalid service tool status.");
	// The wire boundary above establishes every field of the public projection.
	return event as unknown as ServiceEvent;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
