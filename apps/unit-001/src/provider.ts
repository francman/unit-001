import type { CredentialStore } from "@earendil-works/pi-ai";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { ConfigurationError } from "./errors.ts";

export const MODEL_VARIABLE = "UNIT_001_MODEL";

export interface ModelChoice {
	readonly provider: string;
	readonly modelId: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

interface ProviderEntry {
	readonly id: string;
	/** Environment variables that configure the provider; any one of them set selects it. */
	readonly keys: readonly string[];
	readonly defaultModelId: string;
	/** Loaded on demand so a run pays only for the provider it uses. */
	readonly load: () => Promise<Provider>;
}

/** The providers unit-001 can start with, in the order they are detected. */
export const PROVIDERS: readonly ProviderEntry[] = [
	{
		id: "anthropic",
		keys: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
		defaultModelId: "claude-sonnet-5-5",
		load: async () => (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider(),
	},
	{
		id: "openai",
		keys: ["OPENAI_API_KEY"],
		defaultModelId: "gpt-5",
		load: async () => (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider(),
	},
	{
		id: "google",
		keys: ["GEMINI_API_KEY"],
		defaultModelId: "gemini-3.5-flash",
		load: async () => (await import("@earendil-works/pi-ai/providers/google")).googleProvider(),
	},
	{
		id: "openrouter",
		keys: ["OPENROUTER_API_KEY"],
		defaultModelId: "anthropic/claude-sonnet-5.5",
		load: async () => (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider(),
	},
];

/** Parses `provider/model-id`. The model id may itself contain slashes, as OpenRouter's do. */
export function parseModelSpec(spec: string): ModelChoice {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) {
		throw new ConfigurationError(
			`Model "${spec}" must look like provider/model-id, for example anthropic/claude-sonnet-5-5.`,
		);
	}
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** The first provider the user has signed in to (`stored`) or set a key for, with its default model. */
export function detectModel(env: Environment, stored: ReadonlySet<string> = new Set()): ModelChoice | undefined {
	for (const entry of PROVIDERS) {
		if (stored.has(entry.id) || entry.keys.some((key) => env[key] !== undefined && env[key] !== "")) {
			return { provider: entry.id, modelId: entry.defaultModelId };
		}
	}
	return undefined;
}

/** A `Models` with only this provider installed, resolving auth from `credentials` and the environment. */
export async function createModelsFor(providerId: string, credentials?: CredentialStore): Promise<MutableModels> {
	const entry = PROVIDERS.find((candidate) => candidate.id === providerId);
	if (entry === undefined) {
		const supported = PROVIDERS.map((candidate) => candidate.id).join(", ");
		throw new ConfigurationError(`Provider "${providerId}" is not supported. Supported providers: ${supported}.`);
	}
	const models = createModels(credentials === undefined ? undefined : { credentials });
	models.setProvider(await entry.load());
	return models;
}

/**
 * Chooses the model (an explicit spec, else `UNIT_001_MODEL`, else the default of the first provider that is signed in
 * or has a key) and returns a `Models` with only that provider installed, checked against the catalog.
 */
export async function createConfiguredModels(
	env: Environment,
	spec?: string,
	credentials?: CredentialStore,
): Promise<{ readonly models: MutableModels; readonly choice: ModelChoice }> {
	const requested = spec ?? (env[MODEL_VARIABLE] || undefined);
	const stored = new Set((await credentials?.list())?.map((entry) => entry.providerId));
	const choice = requested === undefined ? detectModel(env, stored) : parseModelSpec(requested);
	if (choice === undefined) {
		const keys = PROVIDERS.map((entry) => entry.keys[0]).join(", ");
		throw new ConfigurationError(
			`No model provider is configured. Sign in using the installed command’s login subcommand to use a subscription, set one of ${keys}, or pass --model provider/model-id.`,
		);
	}
	const models = await createModelsFor(choice.provider, credentials);
	if (models.getModel(choice.provider, choice.modelId) === undefined) {
		const known = models
			.getModels(choice.provider)
			.slice(0, 8)
			.map((model) => model.id)
			.join(", ");
		throw new ConfigurationError(
			`Model "${choice.modelId}" is not in the ${choice.provider} catalog. Some known models: ${known}.`,
		);
	}
	return { models, choice };
}
