// Makes one bounded, tool-free command interpretation only after local resolution and actual auth readiness.
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelChoice } from "../provider.ts";
import { COMMAND_CATALOG_VERSION, COMMANDS, type CommandSurface, commandCatalog } from "./catalog.ts";
import { resolveLocalCommand } from "./resolution.ts";

export type InterpretationUsage = {
	observedAt: number;
	provider: string;
	modelId: string;
	tokens: { kind: "observed"; input: number; output: number; total: number } | { kind: "unknown" };
	cost: { kind: "estimate"; usd: number } | { kind: "unknown" };
};

export type CommandInterpretation = {
	stage: "local" | "model" | "unavailable";
	commandIds: string[];
	explanation: string;
	usage: InterpretationUsage | null;
};

/** Validates an untrusted owner response before rendering suggestions or usage. */
export function parseCommandInterpretation(value: unknown): CommandInterpretation {
	if (
		typeof value !== "object" ||
		value === null ||
		!("stage" in value) ||
		!["local", "model", "unavailable"].includes(String(value.stage)) ||
		!("commandIds" in value) ||
		!Array.isArray(value.commandIds) ||
		value.commandIds.length > 3 ||
		!value.commandIds.every(
			(id: unknown) => typeof id === "string" && COMMANDS.some((command) => command.id === id),
		) ||
		!("explanation" in value) ||
		typeof value.explanation !== "string" ||
		value.explanation.length > 240 ||
		/[\x00-\x1f\x7f-\x9f]/.test(value.explanation) ||
		!("usage" in value)
	)
		throw new Error("Invalid command suggestions.");
	if (value.usage !== null) {
		const usage = value.usage;
		if (
			typeof usage !== "object" ||
			usage === null ||
			!("observedAt" in usage) ||
			typeof usage.observedAt !== "number" ||
			!Number.isSafeInteger(usage.observedAt) ||
			usage.observedAt <= 0 ||
			!("provider" in usage) ||
			typeof usage.provider !== "string" ||
			usage.provider.length > 128 ||
			!("modelId" in usage) ||
			typeof usage.modelId !== "string" ||
			usage.modelId.length > 256 ||
			!("tokens" in usage) ||
			typeof usage.tokens !== "object" ||
			usage.tokens === null ||
			!("kind" in usage.tokens) ||
			!("cost" in usage) ||
			typeof usage.cost !== "object" ||
			usage.cost === null ||
			!("kind" in usage.cost)
		)
			throw new Error("Invalid interpretation usage.");
		if (usage.tokens.kind !== "unknown") {
			if (usage.tokens.kind !== "observed") throw new Error("Invalid interpretation tokens.");
			for (const key of ["input", "output", "total"] as const)
				if (
					!(key in usage.tokens) ||
					typeof Reflect.get(usage.tokens, key) !== "number" ||
					!Number.isSafeInteger(Reflect.get(usage.tokens, key)) ||
					Reflect.get(usage.tokens, key) < 0
				)
					throw new Error("Invalid interpretation tokens.");
		}
		if (
			usage.cost.kind !== "unknown" &&
			(usage.cost.kind !== "estimate" ||
				!("usd" in usage.cost) ||
				typeof usage.cost.usd !== "number" ||
				!Number.isFinite(usage.cost.usd) ||
				usage.cost.usd <= 0)
		)
			throw new Error("Invalid interpretation cost.");
	}
	// The owner wire boundary above establishes the bounded public shape.
	return value as CommandInterpretation;
}

/** Returns suggestions only; no output from this function can supply shell arguments or execute a command. */
export async function interpretCommand(
	input: string,
	surface: CommandSurface,
	models: Models,
	choice: ModelChoice | null,
	signal: AbortSignal,
): Promise<CommandInterpretation> {
	const local = resolveLocalCommand(input, surface);
	if (local.kind !== "unresolved")
		return {
			stage: "local",
			commandIds: local.kind === "exact" ? [local.command.id] : local.commands.map((command) => command.id),
			explanation: "Enter a suggested command; nothing was executed.",
			usage: null,
		};
	const unavailable: CommandInterpretation = {
		stage: "unavailable",
		commandIds: [],
		explanation: "No local command match. Model suggestions require a configured running owner.",
		usage: null,
	};
	if (choice === null || input.length > 256 || input.includes("\n") || input.startsWith("-")) return unavailable;
	const model = models.getModel(choice.provider, choice.modelId);
	if (model === undefined) return unavailable;
	const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
	try {
		boundedSignal.throwIfAborted();
		if ((await models.checkAuth(choice.provider, { signal: boundedSignal })) === undefined) return unavailable;
		boundedSignal.throwIfAborted();
	} catch {
		return unavailable;
	}
	const catalog = commandCatalog(surface).map(({ id, summary }) => ({ id, summary }));
	const systemPrompt = `Choose up to three existing command IDs matching the user's command intent. Return JSON only: {"commandIds":["id"],"explanation":"brief explanation"}. Return an empty list if unsupported. Never return executable text, arguments or tools. Catalog v${COMMAND_CATALOG_VERSION}: ${JSON.stringify(catalog)}`;
	const usage: InterpretationUsage = {
		observedAt: Date.now(),
		provider: choice.provider,
		modelId: choice.modelId,
		tokens: { kind: "unknown" },
		cost: { kind: "unknown" },
	};
	try {
		const response = await models.completeSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: input.replace(/^\//, "").split(/\s+/, 1)[0], timestamp: Date.now() }],
			},
			{
				maxTokens: 192,
				maxRetries: 0,
				timeoutMs: 8000,
				signal: boundedSignal,
				toolChoice: "none",
			},
		);
		const counts = response.usage;
		if (
			counts.totalTokens > 0 &&
			[counts.input, counts.output, counts.totalTokens].every((count) => Number.isSafeInteger(count) && count >= 0)
		)
			usage.tokens = { kind: "observed", input: counts.input, output: counts.output, total: counts.totalTokens };
		if (Number.isFinite(counts.cost.total) && counts.cost.total > 0)
			usage.cost = { kind: "estimate", usd: counts.cost.total };
		if (response.stopReason !== "stop" || response.content.some((block) => block.type !== "text"))
			throw new Error("Invalid interpretation response.");
		const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		if (text.length > 2048) throw new Error("Oversize interpretation response.");
		const value: unknown = JSON.parse(text);
		if (
			typeof value !== "object" ||
			value === null ||
			!("commandIds" in value) ||
			!Array.isArray(value.commandIds) ||
			value.commandIds.length > 3 ||
			!("explanation" in value) ||
			typeof value.explanation !== "string" ||
			value.explanation.length > 240 ||
			/[\x00-\x1f\x7f-\x9f]/.test(value.explanation) ||
			!value.commandIds.every(
				(id: unknown) => typeof id === "string" && catalog.some((command) => command.id === id),
			)
		)
			throw new Error("Invalid interpretation response.");
		return {
			stage: "model",
			commandIds: [...new Set(value.commandIds as string[])],
			explanation: value.explanation,
			usage,
		};
	} catch {
		return {
			stage: "model",
			commandIds: [],
			explanation: "Command interpretation did not return a valid suggestion. Nothing was executed.",
			usage,
		};
	}
}
