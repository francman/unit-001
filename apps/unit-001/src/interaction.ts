import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { Terminal } from "./repl.ts";

/** The command that opens a URL in the user's browser, per platform; `undefined` where there is none. */
export function browserCommand(platform: NodeJS.Platform, url: string): readonly [string, ...string[]] | undefined {
	// Only web URLs: a sign-in flow must never make us launch some other kind of handler.
	if (!/^https?:\/\//i.test(url)) return undefined;
	if (platform === "darwin") return ["open", url];
	// rundll32 takes the URL as one argument, so characters such as & never reach a shell.
	if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
	return ["xdg-open", url];
}

function openBrowser(platform: NodeJS.Platform, url: string): void {
	const command = browserCommand(platform, url);
	if (command === undefined) return;
	const [program, ...args] = command;
	// Best effort: the URL is always printed too, so a missing opener or a headless machine only costs a click.
	const child = spawn(program, args, { stdio: "ignore", detached: true });
	child.on("error", () => {});
	child.unref();
}

export interface LoginInteraction {
	readonly interaction: AuthInteraction & { readonly signal: AbortSignal };
	/** Releases the terminal; call when the login ends. */
	close(): void;
}

/**
 * Drives a provider's sign-in flow on the terminal: prints links and codes, opens the browser on an interactive
 * terminal, and asks for pasted codes. Secret prompts are refused, since pasting an API key would echo it.
 */
export function createLoginInteraction(
	terminal: Terminal,
	signal: AbortSignal,
	platform: NodeJS.Platform = process.platform,
): LoginInteraction {
	const interactive = terminal.output !== undefined;
	const readline = createInterface({ input: terminal.input, output: terminal.output, terminal: interactive });
	const cancelled = new AbortController();
	const interactionSignal = AbortSignal.any([signal, cancelled.signal]);
	const cancel = () => {
		cancelled.abort(new Error("Sign-in cancelled."));
		readline.close();
	};
	readline.on("SIGINT", cancel);
	if (interactive) readline.on("close", cancel);
	// Lines are buffered by the iterator, so an answer typed or piped before its question is asked is not lost.
	const lines = readline[Symbol.asyncIterator]();

	const show = (text: string) => terminal.err(`${text}\n`);

	const ask = async (question: string, abort: AbortSignal): Promise<string> => {
		abort.throwIfAborted();
		if (interactive) {
			readline.setPrompt(question);
			readline.prompt();
		} else {
			terminal.err(question);
		}
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(abort.reason);
			abort.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const line = await Promise.race([lines.next(), aborted]);
			if (line.done) throw new Error("The input ended before the sign-in finished.");
			return line.value.trim();
		} finally {
			if (onAbort !== undefined) abort.removeEventListener("abort", onAbort);
		}
	};

	const notify = (event: AuthEvent): void => {
		switch (event.type) {
			case "info":
				show(event.message);
				for (const link of event.links ?? []) show(`  ${link.label ?? "Link"}: ${link.url}`);
				break;
			case "auth_url":
				show(`Open this URL to sign in:\n  ${event.url}`);
				if (event.instructions !== undefined) show(event.instructions);
				if (interactive) openBrowser(platform, event.url);
				break;
			case "device_code":
				show(`Go to ${event.verificationUri} and enter the code ${event.userCode}`);
				break;
			case "progress":
				show(event.message);
				break;
		}
	};

	const prompt = async (request: AuthPrompt): Promise<string> => {
		if (request.type === "secret") {
			throw new Error(
				"Entering a secret here is not supported. Set the provider's API key environment variable instead.",
			);
		}
		const abort =
			request.signal === undefined ? interactionSignal : AbortSignal.any([interactionSignal, request.signal]);
		if (request.type === "select") {
			show(request.message);
			request.options.forEach((option, index) => {
				show(`  ${index + 1}. ${option.label}${option.description === undefined ? "" : ` (${option.description})`}`);
			});
			for (;;) {
				const answer = await ask("Choose: ", abort);
				const chosen = request.options[Number.parseInt(answer, 10) - 1] ?? request.options.find((o) => o.id === answer);
				if (chosen !== undefined) return chosen.id;
				show("Enter the number of one of the choices.");
			}
		}
		return ask(`${request.message} `, abort);
	};

	return {
		interaction: { signal: interactionSignal, prompt, notify },
		close: () => {
			readline.removeListener("SIGINT", cancel);
			readline.removeListener("close", cancel);
			readline.close();
		},
	};
}
