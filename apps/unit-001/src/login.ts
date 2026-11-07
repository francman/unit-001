import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { UsageError } from "./errors.ts";
import { createLoginInteraction } from "./interaction.ts";
import { PROVIDERS } from "./provider.ts";
import type { Terminal } from "./repl.ts";

/** Providers that can be signed in to with a subscription, by the name used on the command line. */
export const SUBSCRIPTIONS: Readonly<Record<string, { readonly provider: string; readonly label: string }>> = {
	anthropic: { provider: "anthropic", label: "Claude Pro or Max" },
	openai: { provider: "openai", label: "ChatGPT Plus or Pro" },
};

export type LoginLaunch =
	| { readonly kind: "foreground"; readonly name: string }
	| { readonly kind: "managed"; readonly name: string };

export function subscriptionFor(name: string): { readonly provider: string; readonly label: string } {
	const subscription = Object.hasOwn(SUBSCRIPTIONS, name) ? SUBSCRIPTIONS[name] : undefined;
	if (subscription === undefined) {
		throw new UsageError(`Unknown provider "${name}". Choose one of: ${Object.keys(SUBSCRIPTIONS).join(", ")}.`);
	}
	return subscription;
}

/** Signs in with the provider's account flow and stores the credential. Returns the exit code. */
export async function runLogin(
	models: Pick<Models, "login">,
	name: string,
	terminal: Terminal,
	signal: AbortSignal,
	platform: NodeJS.Platform = process.platform,
	launch: LoginLaunch = { kind: "foreground", name: "agent" },
): Promise<number> {
	const subscription = subscriptionFor(name);
	const { interaction, close } = createLoginInteraction(terminal, signal, platform);
	try {
		await models.login(subscription.provider, "oauth", interaction, { agentName: launch.name });
	} finally {
		close();
	}
	const next =
		launch.kind === "managed"
			? `Use sudo ${launch.name} attach if already running; otherwise run sudo ${launch.name} start, then sudo ${launch.name} attach.`
			: "For foreground chat, run this launcher again without login arguments.";
	terminal.err(`Signed in with ${subscription.label}. ${next}\n`);
	return 0;
}

/** Removes the stored sign-in of a provider. Returns the exit code. */
export async function runLogout(credentials: CredentialStore, name: string, terminal: Terminal): Promise<number> {
	const subscription = subscriptionFor(name);
	const stored = (await credentials.list()).some((entry) => entry.providerId === subscription.provider);
	await credentials.delete(subscription.provider);
	terminal.err(stored ? `Signed out of ${name}.\n` : `Not signed in to ${name}.\n`);
	return 0;
}

/** One line per provider: a stored sign-in, an environment key, or nothing. Never prints a secret. */
export async function describeStatus(
	credentials: CredentialStore,
	env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
	const stored = new Map((await credentials.list()).map((entry) => [entry.providerId, entry.type]));
	return PROVIDERS.map((entry) => {
		const credential = stored.get(entry.id);
		const key = entry.keys.find((name) => env[name] !== undefined && env[name] !== "");
		let state = "not configured";
		if (credential === "oauth") state = "signed in with a subscription";
		else if (credential === "api_key") state = "stored API key";
		else if (key !== undefined) state = `API key from ${key}`;
		const overridden =
			credential !== undefined && key !== undefined ? ` (${key} is set but the stored sign-in wins)` : "";
		return `${entry.id.padEnd(11)} ${state}${overridden}`;
	});
}
