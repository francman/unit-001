import { UsageError } from "./errors.ts";

export const DEFAULT_SESSION = "default";

export interface RunOptions {
	/** A prompt to answer once and exit; `-` reads it from standard input. Without it the agent chats interactively. */
	readonly print?: string;
	readonly session: string;
	/** `provider/model-id`; without it the model comes from `UNIT_001_MODEL` or the configured provider. */
	readonly model?: string;
	readonly dataDir?: string;
}

export interface ServiceOptions {
	readonly session: string;
	readonly dataDir?: string;
}

export interface AttachOptions extends ServiceOptions {
	readonly plain?: boolean;
}

export type Command =
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "login"; readonly provider: string; readonly dataDir?: string }
	| { readonly kind: "logout"; readonly provider: string; readonly dataDir?: string }
	| { readonly kind: "status"; readonly dataDir?: string }
	| { readonly kind: "serve"; readonly options: Omit<RunOptions, "print"> }
	| { readonly kind: "send"; readonly options: ServiceOptions; readonly prompt: string; readonly requestId?: string }
	| { readonly kind: "service-status"; readonly options: ServiceOptions }
	| { readonly kind: "cancel"; readonly options: ServiceOptions }
	| { readonly kind: "attach"; readonly options: AttachOptions }
	| { readonly kind: "run"; readonly options: RunOptions };

const VALUE_FLAGS = new Map<string, "print" | "session" | "model" | "dataDir">([
	["-p", "print"],
	["--print", "print"],
	["--session", "session"],
	["--model", "model"],
	["--data-dir", "dataDir"],
]);

export const USAGE = `Usage: agent [options]
       agent login <anthropic|openai>   sign in with a Claude or ChatGPT subscription
       agent logout <anthropic|openai>  remove a stored sign-in
       agent status                     show how each provider is configured
       agent serve [options]            run without terminal input; shutdown preserves unfinished work
       agent attach [--plain] [options] chat with the running service; exiting detaches
       agent send <prompt> [options]     ask the running service (optional --request-id for safe retries)
       agent service-status [options]    inspect the running service
       agent cancel [options]            abort its current run

Starts the agent. Its conversations persist, so a restarted process resumes unfinished work.

Options:
  -p, --print <prompt>   Answer one prompt and exit ("-" reads the prompt from standard input)
      --session <name>   Session to open or create (default: ${DEFAULT_SESSION})
      --model <id>       Model as provider/model-id (default: UNIT_001_MODEL, else the configured provider)
      --data-dir <path>  Where sessions are stored (default: UNIT_001_HOME, else the per-user data directory)
      --plain            Basic line-oriented interface (attach only)
  -v, --version          Print the version
  -h, --help             Print this help

Use agent send [options] -- <prompt> when the prompt starts with a hyphen.

A provider is used when you have signed in to it or set its key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
OPENROUTER_API_KEY), checked in that order. A stored sign-in wins over a key for the same provider.`;

function parseAccountCommand(kind: "login" | "logout" | "status", rest: readonly string[]): Command {
	let dataDir: string | undefined;
	const positional: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const argument = rest[index];
		if (argument === "-h" || argument === "--help") return { kind: "help" };
		if (argument === "--data-dir" || argument.startsWith("--data-dir=")) {
			const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : rest[++index];
			if (value === undefined || value === "") throw new UsageError("Option --data-dir needs a value.");
			dataDir = value;
		} else if (argument.startsWith("-")) {
			throw new UsageError(`Unknown option: ${argument}`);
		} else {
			positional.push(argument);
		}
	}
	const withDataDir = dataDir === undefined ? {} : { dataDir };
	if (kind === "status") {
		if (positional.length > 0) throw new UsageError(`Unexpected argument: ${positional[0]}`);
		return { kind, ...withDataDir };
	}
	if (positional.length === 0) throw new UsageError(`Usage: agent ${kind} <provider>`);
	if (positional.length > 1) throw new UsageError(`Unexpected argument: ${positional[1]}`);
	return { kind, provider: positional[0], ...withDataDir };
}

function parseServiceCommand(
	kind: "serve" | "send" | "service-status" | "cancel" | "attach",
	rest: readonly string[],
): Command {
	const values: { session?: string; dataDir?: string; model?: string; requestId?: string } = {};
	let prompt: string | undefined;
	let plain = false;
	for (let index = 0; index < rest.length; index++) {
		const argument = rest[index];
		if (kind === "attach" && argument === "--plain") {
			if (plain) throw new UsageError("Option --plain was given more than once.");
			plain = true;
			continue;
		}
		if (kind === "send" && argument === "--") {
			if (prompt !== undefined || rest.length !== index + 2)
				throw new UsageError("Usage: agent send [options] -- <prompt>");
			prompt = rest[index + 1];
			break;
		}
		if (argument === "-h" || argument === "--help") return { kind: "help" };
		if (!argument.startsWith("-")) {
			if (kind !== "send" || prompt !== undefined) throw new UsageError(`Unexpected argument: ${argument}`);
			prompt = argument;
			continue;
		}
		const equals = argument.indexOf("=");
		const flag = equals === -1 ? argument : argument.slice(0, equals);
		const key =
			flag === "--session"
				? "session"
				: flag === "--data-dir"
					? "dataDir"
					: flag === "--model" && kind === "serve"
						? "model"
						: flag === "--request-id" && kind === "send"
							? "requestId"
							: undefined;
		if (key === undefined) throw new UsageError(`Unknown option: ${flag}`);
		const value = equals === -1 ? rest[++index] : argument.slice(equals + 1);
		if (value === undefined || value === "") throw new UsageError(`Option ${flag} needs a value.`);
		if (values[key] !== undefined) throw new UsageError(`Option ${flag} was given more than once.`);
		values[key] = value;
	}
	const options = {
		session: values.session ?? DEFAULT_SESSION,
		...(values.dataDir === undefined ? {} : { dataDir: values.dataDir }),
	};
	if (kind === "serve")
		return { kind, options: { ...options, ...(values.model === undefined ? {} : { model: values.model }) } };
	if (kind === "send") {
		if (prompt === undefined || prompt.trim() === "") throw new UsageError("Usage: agent send <prompt> [options]");
		return { kind, options, prompt, ...(values.requestId === undefined ? {} : { requestId: values.requestId }) };
	}
	return kind === "attach" && plain ? { kind, options: { ...options, plain: true } } : { kind, options };
}

/** Parses the command line, without the node and script entries. Throws `UsageError` on anything unrecognized. */
export function parseArguments(argv: readonly string[]): Command {
	const first = argv[0];
	if (first === "login" || first === "logout" || first === "status") return parseAccountCommand(first, argv.slice(1));
	if (first === "serve" || first === "send" || first === "service-status" || first === "cancel" || first === "attach")
		return parseServiceCommand(first, argv.slice(1));
	const values: { print?: string; session?: string; model?: string; dataDir?: string } = {};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "-h" || argument === "--help") return { kind: "help" };
		if (argument === "-v" || argument === "--version") return { kind: "version" };

		const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
		const flag = equals === -1 ? argument : argument.slice(0, equals);
		const key = VALUE_FLAGS.get(flag);
		if (key === undefined) {
			throw new UsageError(
				argument.startsWith("-") ? `Unknown option: ${argument}` : `Unexpected argument: ${argument}`,
			);
		}
		let value: string | undefined;
		if (equals !== -1) value = argument.slice(equals + 1);
		else value = argv[++index];
		if (value === undefined || value === "") throw new UsageError(`Option ${flag} needs a value.`);
		if (values[key] !== undefined) throw new UsageError(`Option ${flag} was given more than once.`);
		values[key] = value;
	}
	return { kind: "run", options: { ...values, session: values.session ?? DEFAULT_SESSION } };
}
