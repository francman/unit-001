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

export type Command =
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "run"; readonly options: RunOptions };

const VALUE_FLAGS = new Map<string, "print" | "session" | "model" | "dataDir">([
	["-p", "print"],
	["--print", "print"],
	["--session", "session"],
	["--model", "model"],
	["--data-dir", "dataDir"],
]);

export const USAGE = `Usage: unit-001 [options]

Starts the unit-001 agent. Its conversations persist, so a restarted process resumes unfinished work.

Options:
  -p, --print <prompt>   Answer one prompt and exit ("-" reads the prompt from standard input)
      --session <name>   Session to open or create (default: ${DEFAULT_SESSION})
      --model <id>       Model as provider/model-id (default: UNIT_001_MODEL, else the configured provider)
      --data-dir <path>  Where sessions are stored (default: UNIT_001_HOME, else the per-user data directory)
  -v, --version          Print the version
  -h, --help             Print this help

Providers are detected from ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY, in that order.`;

/** Parses the command line, without the node and script entries. Throws `UsageError` on anything unrecognized. */
export function parseArguments(argv: readonly string[]): Command {
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
