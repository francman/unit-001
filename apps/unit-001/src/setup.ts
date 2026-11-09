// Guides interactive provider authentication and default-model selection without starting the service.
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { ConfigurationError } from "./errors.ts";
import { type LoginLaunch, runLogin, SUBSCRIPTIONS } from "./login.ts";
import { createModelsFor, detectModel, PROVIDERS } from "./provider.ts";
import { sanitizeTerminalText } from "./render.ts";
import type { Terminal } from "./repl.ts";

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

/** Configures one provider and saves a catalog-validated model; cancellation never requests service startup. */
export async function runSetup(options: SetupOptions, signal: AbortSignal): Promise<SetupResult> {
	if (!options.interactive || options.terminal.output === undefined)
		throw new ConfigurationError("Setup requires an interactive terminal. Connect with ssh -t and run setup again.");
	const prompts = new SetupPrompts(options.terminal, signal);
	let credentialSaved: "api_key" | "oauth" | undefined;
	let modelSaved = false;
	try {
		prompts.signal.throwIfAborted();
		options.terminal.err(
			`Set up ${options.launch.name}\nChoose a provider, sign in, and select a default model.\nSelections appear after Enter; API keys remain hidden.\n`,
		);
		if (options.launch.kind === "managed")
			options.terminal.err("Finish or cancel setup before other administrative commands; they report busy during setup.\n");
		const stored = await options.credentials.list({ signal: prompts.signal });
		const previous =
			options.currentModel?.split("/", 1)[0] ??
			detectModel(options.env, new Set(stored.map((entry) => entry.providerId)))?.provider;
		const providerId = await prompts.choose(
			"Provider",
			PROVIDERS.map((provider) => ({ id: provider.id, label: providerLabel(provider.id) })),
			previous,
		);
		const provider = PROVIDERS.find((entry) => entry.id === providerId);
		if (provider === undefined) throw new Error("Selected provider is unavailable.");
		const models = await createModelsFor(providerId, options.credentials);
		const existing = stored.find((entry) => entry.providerId === providerId);
		const environmentKey = provider.keys.find((name) => Boolean(options.env[name]));
		const methods: { id: string; label: string }[] = [];
		if (existing !== undefined || environmentKey !== undefined)
			methods.push({
				id: "keep",
				label:
					existing === undefined
						? `Keep ${environmentKey} from the environment`
						: `Keep stored ${existing.type === "oauth" ? "subscription sign-in" : "API key"}`,
			});
		const subscription = Object.hasOwn(SUBSCRIPTIONS, providerId) ? SUBSCRIPTIONS[providerId] : undefined;
		if (subscription !== undefined)
			methods.push({
				id: "subscription",
				label: `${existing === undefined ? "Sign in" : "Replace stored credential"} with ${subscription.label}`,
			});
		methods.push({
			id: "key",
			label: existing === undefined ? "Enter an API key" : "Replace stored credential with an API key",
		});
		const method = await prompts.choose("Authentication", methods, methods[0]?.id);
		let key: string | undefined;
		if (method === "subscription") {
			options.terminal.err(
				"Subscription sign-in is saved when completed; cancelling the remaining setup does not remove it.\n",
			);
			prompts.close();
			await runLogin(models, providerId, options.terminal, prompts.signal, options.platform, options.launch);
			credentialSaved = "oauth";
			prompts.signal.throwIfAborted();
		} else if (method === "key") {
			for (;;) {
				key = (await prompts.ask("API key (hidden): ", "secret")).trim();
				if (key !== "" && !/\s/.test(key)) break;
				options.terminal.err("Enter a non-empty API key without whitespace.\n");
			}
		}
		const catalog = models.getModels(providerId);
		if (catalog.length === 0) throw new ConfigurationError(`No models are available in the ${providerId} catalog.`);
		const savedId = options.currentModel?.startsWith(`${providerId}/`)
			? options.currentModel.slice(providerId.length + 1)
			: undefined;
		const defaultId =
			catalog.find((model) => model.id === savedId)?.id ??
			catalog.find((model) => model.id === provider.defaultModelId)?.id ??
			catalog[0]?.id;
		let query = "";
		let modelId: string;
		for (;;) {
			const visible = catalog.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(query)).slice(0, 12);
			options.terminal.err(
				`\nModels${query === "" ? "" : " matching your search"} (showing ${visible.length} of ${catalog.length}):\n`,
			);
			visible.forEach((model, index) => void options.terminal.err(`  ${index + 1}. ${selectionText(model.id)}\n`));
			const answer = (
				await prompts.ask(`Model [${selectionText(defaultId ?? "")}] (number, model ID, or /search): `)
			).trim();
			if (answer.startsWith("/")) {
				query = answer.slice(1).toLowerCase();
				continue;
			}
			const selected = answer === "" ? defaultId : /^\d+$/.test(answer) ? visible[Number(answer) - 1]?.id : answer;
			if (selected !== undefined && catalog.some((model) => model.id === selected)) {
				modelId = selected;
				break;
			}
			options.terminal.err("Choose a model from this provider's catalog, or use /search.\n");
		}
		const model = `${providerId}/${modelId}`;
		options.terminal.err(`\nDefault model: ${selectionText(model)}\nNo model request is made during setup.\n`);
		for (;;) {
			const answer = (await prompts.ask("Save configuration? [Y/n]: ")).trim().toLowerCase();
			if (answer === "n" || answer === "no") throw new SetupCancelled();
			if (answer === "" || answer === "y" || answer === "yes") break;
			options.terminal.err("Enter yes or no.\n");
		}
		prompts.signal.throwIfAborted();
		if (key !== undefined) {
			await options.credentials.modify(providerId, async () => ({ type: "api_key", key }), { signal: prompts.signal });
			credentialSaved = "api_key";
		}
		prompts.signal.throwIfAborted();
		await options.saveModel(model);
		modelSaved = true;
		prompts.signal.throwIfAborted();
		options.terminal.err(`Setup complete. Default model: ${selectionText(model)}\n`);
		return { kind: "completed", model };
	} catch (error) {
		if (modelSaved) options.terminal.err("Default model saved. Setup did not finish; the service was not started.\n");
		else if (credentialSaved !== undefined)
			options.terminal.err(
				`${credentialSaved === "api_key" ? "API key" : "Subscription sign-in"} saved; default model was not saved. Rerun setup to finish.\n`,
			);
		if (error instanceof SetupCancelled || prompts.signal.aborted) {
			options.terminal.err("Setup cancelled.\n");
			return { kind: "cancelled" };
		}
		throw error;
	} finally {
		prompts.close();
	}
}

function selectionText(text: string): string {
	return sanitizeTerminalText(text).replace(/\s/g, " ").slice(0, 160);
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

class SetupCancelled extends Error {}

class SetupPrompts {
	readonly signal: AbortSignal;
	readonly #terminal: Terminal;
	readonly #cancel = new AbortController();
	#readline: Interface | undefined;
	#lines: AsyncIterator<string> | undefined;

	constructor(terminal: Terminal, signal: AbortSignal) {
		this.#terminal = terminal;
		this.signal = AbortSignal.any([signal, this.#cancel.signal]);
	}

	async choose(
		question: string,
		choices: readonly { id: string; label: string }[],
		preferred?: string,
	): Promise<string> {
		this.#terminal.err(`\n${question}:\n`);
		choices.forEach(
			(choice, index) =>
				void this.#terminal.err(`  ${index + 1}. ${choice.label}${choice.id === preferred ? " (default)" : ""}\n`),
		);
		for (;;) {
			const answer = (await this.ask("Choose: ")).trim();
			const selected =
				answer === ""
					? choices.find((choice) => choice.id === preferred)
					: /^\d+$/.test(answer)
						? choices[Number(answer) - 1]
						: choices.find((choice) => choice.id === answer);
			if (selected !== undefined) {
				this.#terminal.err(`${selectionText(selected.label)}\n`);
				return selected.id;
			}
			this.#terminal.err("Enter a listed number or provider name.\n");
		}
	}

	async ask(question: string, mode: "text" | "secret" = "text"): Promise<string> {
		this.signal.throwIfAborted();
		if (this.#readline === undefined) {
			// readline consumes an entire pasted chunk before an async prompt can advance. Never echo ahead,
			// because a multiline paste may already contain the answer to a later secret prompt.
			const output = new Writable({ write: (_chunk, _encoding, callback) => callback() });
			this.#readline = createInterface({ input: this.#terminal.input, output, terminal: true, historySize: 0 });
			this.#readline.on("SIGINT", () => this.#cancel.abort(new SetupCancelled()));
			this.#lines = this.#readline[Symbol.asyncIterator]();
		}
		this.#terminal.err(question);
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(this.signal.reason);
			this.signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const line = await Promise.race([this.#lines?.next(), aborted]);
			if (line === undefined || line.done) throw new SetupCancelled();
			if (mode === "text") this.#terminal.err("\n");
			return line.value;
		} finally {
			if (onAbort !== undefined) this.signal.removeEventListener("abort", onAbort);
			if (mode === "secret") this.#terminal.err("\n");
		}
	}

	close(): void {
		this.#readline?.close();
		this.#readline = undefined;
		this.#lines = undefined;
	}
}
