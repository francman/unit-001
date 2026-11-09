// Coordinates provider authentication and model selection through the interactive setup UI.
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { ConfigurationError } from "./errors.ts";
import { type LoginLaunch, runLogin, SUBSCRIPTIONS } from "./login.ts";
import { createModelsFor, detectModel, PROVIDERS } from "./provider.ts";
import type { Terminal } from "./repl.ts";
import { SetupBack, SetupCancelled, type SetupChoice, SetupUI } from "./setup-ui.ts";

export interface SetupOptions {
	readonly terminal: Terminal;
	readonly interactive: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly credentials: CredentialStore;
	readonly platform: NodeJS.Platform;
	readonly launch: LoginLaunch;
	readonly currentModel?: string;
	readonly saveModel: (model: string) => Promise<void>;
}

export type SetupResult = { readonly kind: "completed"; readonly model: string } | { readonly kind: "cancelled" };
type Stage = "provider" | "authentication" | "key" | "model" | "review";

/** Runs explicit setup without provider requests or service startup, restoring the terminal on every exit. */
export async function runSetup(options: SetupOptions, outerSignal: AbortSignal): Promise<SetupResult> {
	if (!options.interactive || !options.terminal.output)
		throw new ConfigurationError("Setup requires an interactive terminal. Connect with ssh -t and run setup again.");
	const ui = new SetupUI(
		options.terminal,
		options.launch.name,
		options.env.NO_COLOR === undefined && options.env.TERM !== "dumb",
	);
	const signal = AbortSignal.any([outerSignal, ui.signal]);
	let credentialSaved: "api_key" | "oauth" | undefined;
	let modelSaved = false;
	try {
		signal.throwIfAborted();
		let stage: Stage = "provider";
		const stored = await options.credentials.list({ signal });
		const previous =
			options.currentModel?.split("/", 1)[0] ??
			detectModel(options.env, new Set(stored.map((entry) => entry.providerId)))?.provider;
		let provider = PROVIDERS.find((entry) => entry.id === previous) ?? PROVIDERS[0];
		let models: MutableModels | undefined;
		let key: string | undefined;
		let method = "";
		let model = "";
		let authError = "";
		for (;;) {
			signal.throwIfAborted();
			try {
				if (stage === "provider") {
					const providerCredentials = await options.credentials.list({ signal });
					const id = await ui.choose(
						{ step: 1, title: "Choose a provider", description: "Connect your agent to a model provider." },
						PROVIDERS.map((entry) => ({
							id: entry.id,
							label: providerLabel(entry.id),
							description: providerCredentials.some((credential) => credential.providerId === entry.id)
								? "Connected"
								: entry.keys.some((name) => options.env[name])
									? "Environment key"
									: "Not connected",
						})),
						provider.id,
						signal,
					);
					provider = PROVIDERS.find((entry) => entry.id === id) ?? provider;
					models = await createModelsFor(provider.id, options.credentials);
					key = undefined;
					authError = "";
					stage = "authentication";
				} else if (stage === "authentication") {
					const existing = (await options.credentials.list({ signal })).find(
						(entry) => entry.providerId === provider.id,
					);
					const environment = provider.keys.find((name) => options.env[name]);
					const choices: SetupChoice[] = [];
					if (existing || environment)
						choices.push({
							id: "keep",
							label: "Keep existing credentials",
							description: existing
								? existing.type === "oauth"
									? "Subscription sign-in"
									: "Stored API key"
								: `From ${environment}`,
						});
					const subscription = Object.hasOwn(SUBSCRIPTIONS, provider.id) ? SUBSCRIPTIONS[provider.id] : undefined;
					if (subscription)
						choices.push({
							id: "subscription",
							label: `Sign in with ${subscription.label}`,
							description: existing ? "Replace stored credential" : "Open the provider sign-in flow",
						});
					choices.push({
						id: "key",
						label: "Enter an API key",
						description: existing ? "Replace stored credential" : "Stored privately for this agent",
					});
					method = await ui.choose(
						{
							step: 2,
							title: `Sign in to ${providerLabel(provider.id)}`,
							description: authError || "Choose how this agent connects.",
							detail: authError ? ["Sign-in did not finish. Retry or go back."] : undefined,
						},
						choices,
						choices[0]?.id,
						signal,
					);
					authError = "";
					if (method === "subscription") {
						await ui.suspend();
						options.terminal.err(
							"Subscription sign-in is saved when completed; cancelling later steps does not remove it.\n",
						);
						try {
							if (!models) throw new Error("Provider models are unavailable.");
							const result = await runLogin(
								models,
								provider.id,
								options.terminal,
								signal,
								options.platform,
								options.launch,
							);
							if (result === 130) throw new SetupCancelled();
							if (result !== 0) throw new Error("Provider sign-in did not complete.");
							credentialSaved = "oauth";
							key = undefined;
							stage = "model";
						} catch (error) {
							if (signal.aborted || error instanceof SetupCancelled) throw error;
							authError = "The provider sign-in failed.";
						}
					} else {
						if (method === "keep") key = undefined;
						stage = method === "key" ? "key" : "model";
					}
				} else if (stage === "key") {
					key = await ui.secret(
						{
							step: 2,
							title: "Enter an API key",
							description: `Connect ${providerLabel(provider.id)}. Your key stays masked and is saved only after review.`,
						},
						signal,
					);
					stage = "model";
				} else if (stage === "model") {
					if (!models) throw new Error("Provider models are unavailable.");
					const catalog = models.getModels(provider.id);
					if (!catalog.length) throw new ConfigurationError(`No models are available in the ${provider.id} catalog.`);
					const saved = options.currentModel?.startsWith(`${provider.id}/`)
						? options.currentModel.slice(provider.id.length + 1)
						: undefined;
					const selected = model.startsWith(`${provider.id}/`) ? model.slice(provider.id.length + 1) : undefined;
					const preferred =
						catalog.find((entry) => entry.id === selected)?.id ??
						catalog.find((entry) => entry.id === saved)?.id ??
						catalog.find((entry) => entry.id === provider.defaultModelId)?.id ??
						catalog[0].id;
					const id = await ui.choose(
						{
							step: 3,
							title: "Choose a model",
							description: "Type to search this provider's models. No model request is made.",
						},
						catalog.map((entry) => ({
							id: entry.id,
							label: entry.id,
							description:
								entry.id === saved ? "Current" : entry.id === provider.defaultModelId ? "Recommended" : entry.name,
						})),
						preferred,
						signal,
					);
					model = `${provider.id}/${id}`;
					stage = "review";
				} else {
					const detail = [
						`Provider: ${providerLabel(provider.id)}`,
						`Model: ${model}`,
						`Credentials: ${method === "key" ? "New API key · hidden" : method === "subscription" ? "Subscription sign-in" : "Keep existing"}`,
					];
					if (options.env.UNIT_001_MODEL && options.env.UNIT_001_MODEL !== model)
						detail.push("UNIT_001_MODEL overrides this saved model.");
					const action = await ui.choose(
						{
							step: 4,
							title: "Review setup",
							description: "Save your choices. Service startup is a separate confirmation.",
							detail,
						},
						[
							{ id: "save", label: "Save configuration" },
							{ id: "model", label: "Change model" },
							{ id: "authentication", label: "Change authentication" },
							{ id: "provider", label: "Change provider" },
						],
						"save",
						signal,
					);
					if (action === "model" || action === "authentication" || action === "provider") {
						stage = action;
						continue;
					}
					signal.throwIfAborted();
					ui.busy({
						step: 4,
						title: "Saving configuration",
						description: "Saving private credentials and your selected model.",
					});
					if (key !== undefined) {
						await options.credentials.modify(provider.id, async () => ({ type: "api_key", key }), { signal });
						credentialSaved = "api_key";
					}
					signal.throwIfAborted();
					await options.saveModel(model);
					modelSaved = true;
					signal.throwIfAborted();
					await ui.close();
					options.terminal.err(`Setup complete. Default model: ${model}\n`);
					return { kind: "completed", model };
				}
			} catch (error) {
				if (!(error instanceof SetupBack)) throw error;
				if (stage === "provider") throw new SetupCancelled();
				stage = stage === "authentication" ? "provider" : stage === "review" ? "model" : "authentication";
			}
		}
	} catch (error) {
		await ui.close();
		if (modelSaved) options.terminal.err("Default model saved. Setup did not finish; the service was not started.\n");
		else if (credentialSaved)
			options.terminal.err(
				`${credentialSaved === "api_key" ? "API key" : "Subscription sign-in"} saved; default model was not saved. Rerun setup to finish.\n`,
			);
		if (error instanceof SetupCancelled || signal.aborted) {
			options.terminal.err("Setup cancelled.\n");
			return { kind: "cancelled" };
		}
		throw error;
	} finally {
		await ui.close();
	}
}

function providerLabel(id: string): string {
	switch (id) {
		case "anthropic":
			return "Anthropic (Claude)";
		case "openai":
			return "OpenAI (ChatGPT)";
		case "google":
			return "Google (Gemini)";
		case "openrouter":
			return "OpenRouter";
		default:
			return id;
	}
}
