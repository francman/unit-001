import { commandCatalog } from "./commands/catalog.ts";
import { UsageError } from "./errors.ts";
import { memoryCommand } from "./memory-control.ts";
import { type MissionCommand, parseMissionCommand } from "./missions/command.ts";

export const DEFAULT_SESSION = "default";

export interface RunOptions {
	/** A prompt to answer once and exit; `-` reads it from standard input. Without it the agent chats interactively. */
	readonly print?: string;
	readonly session: string;
	/** `provider/model-id`; without it the model comes from `UNIT_001_MODEL` or the configured provider. */
	readonly model?: string;
	readonly dataDir?: string;
	readonly inhibited?: boolean;
}

export interface ServiceOptions {
	readonly session: string;
	readonly dataDir?: string;
}

export interface AttachOptions extends ServiceOptions {
	readonly plain?: boolean;
}

export type Command =
	| { readonly kind: "mission"; readonly command: MissionCommand; readonly options: ServiceOptions }
	| {
			readonly kind: "memory";
			readonly request: ReturnType<typeof memoryCommand>;
			readonly yes: boolean;
			readonly options: ServiceOptions;
	  }
	| {
			readonly kind: "maintenance-enter";
			readonly operationId: string;
			readonly timeoutMs: number;
			readonly options: ServiceOptions;
	  }
	| { readonly kind: "maintenance-release"; readonly operationId: string; readonly options: ServiceOptions }
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "login"; readonly provider: string; readonly dataDir?: string }
	| { readonly kind: "logout"; readonly provider: string; readonly dataDir?: string }
	| { readonly kind: "status"; readonly dataDir?: string }
	| { readonly kind: "setup"; readonly dataDir?: string }
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
       agent setup                      choose a provider, sign in, and save a default model
       agent login <anthropic|openai>   sign in with a Claude or ChatGPT subscription
       agent logout <anthropic|openai>  remove a stored sign-in
       agent status                     show how each provider is configured
       agent serve [options]            run without terminal input; shutdown preserves unfinished work
       agent attach [--plain] [options] chat with the running service; exiting detaches
       agent send <prompt> [options]     ask the running service (optional --request-id for safe retries)
       agent service-status [options]    inspect the running service
       agent cancel [options]            abort its current run
       agent memory [stats|recall <query>|remember <text>|forget <id>|sleep] [options]
       agent mission [status|setup|draft|propose|creator|approve] [options]

Starts the agent. Its conversations persist, so a restarted process resumes unfinished work.

Options:
  -p, --print <prompt>   Answer one prompt and exit ("-" reads the prompt from standard input)
      --session <name>   Session to open or create (default: ${DEFAULT_SESSION})
      --model <id>       Model as provider/model-id (default: UNIT_001_MODEL, saved setup choice, then provider)
      --data-dir <path>  Where sessions are stored (default: UNIT_001_HOME, else the per-user data directory)
      --plain            Basic line-oriented interface (attach only)
  -v, --version          Print the version
  -h, --help             Print this help

Use agent send [options] -- <prompt> when the prompt starts with a hyphen.
Memory commands contact the running owner. Forget asks for confirmation; --yes confirms for scripts.

A provider is used when you have signed in to it or set its key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
OPENROUTER_API_KEY), checked in that order. A stored sign-in wins over a key for the same provider.`;

function parseAccountCommand(kind: "login" | "logout" | "status" | "setup", rest: readonly string[]): Command {
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
	if (kind === "status" || kind === "setup") {
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
	let inhibited = false;
	for (let index = 0; index < rest.length; index++) {
		const argument = rest[index];
		if (kind === "serve" && argument === "--inhibited") {
			if (inhibited) throw new UsageError("Option --inhibited was given more than once.");
			inhibited = true;
			continue;
		}
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
		return {
			kind,
			options: {
				...options,
				...(values.model === undefined ? {} : { model: values.model }),
				...(inhibited ? { inhibited: true } : {}),
			},
		};
	if (kind === "send") {
		if (prompt === undefined || prompt.trim() === "") throw new UsageError("Usage: agent send <prompt> [options]");
		return { kind, options, prompt, ...(values.requestId === undefined ? {} : { requestId: values.requestId }) };
	}
	return kind === "attach" && plain ? { kind, options: { ...options, plain: true } } : { kind, options };
}

/** Parses the command line, without the node and script entries. Throws `UsageError` on anything unrecognized. */
export function parseArguments(argv: readonly string[]): Command {
	const first = argv[0];
	const alias = commandCatalog("cli").find(
		(command) => !command.invocation.includes(" ") && command.aliases.includes(first),
	);
	if (alias !== undefined) return parseArguments([alias.invocation, ...argv.slice(1)]);
	if (first === "help") return { kind: "help" };
	if (first === "inspect") {
		if (argv[1] !== "os") throw new UsageError("Usage: agent inspect os [options]");
		return parseServiceCommand("send", ["inspect os", ...argv.slice(2)]);
	}
	if (first === "mission") {
		try {
			const { command, ...options } = parseMissionCommand(argv.slice(1));
			return { kind: "mission", command, options };
		} catch (error) {
			throw new UsageError(error instanceof Error ? error.message : String(error));
		}
	}
	if (first === "memory") {
		const values = new Map<string, string>();
		const operands: string[] = [];
		let yes = false;
		for (let index = 1; index < argv.length; index++) {
			const argument = argv[index];
			if (argument === "--help" || argument === "-h") return { kind: "help" };
			if (argument === "--yes") {
				if (yes) throw new UsageError("Option --yes was given more than once.");
				yes = true;
				continue;
			}
			if (argument === "--") {
				operands.push(...argv.slice(index + 1));
				break;
			}
			if (!argument.startsWith("-")) {
				operands.push(argument);
				continue;
			}
			const equals = argument.indexOf("=");
			const flag = equals < 0 ? argument : argument.slice(0, equals);
			if (!["--session", "--data-dir", "--request-id"].includes(flag))
				throw new UsageError(`Unknown memory option: ${flag}`);
			const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
			if (!value || values.has(flag)) throw new UsageError(`Option ${flag} needs one value.`);
			values.set(flag, value);
		}
		const operation = operands[0] ?? "stats";
		if (operands.length > 2 || ((operation === "stats" || operation === "sleep") && operands.length > 1))
			throw new UsageError("Memory expects one quoted query, statement or ID.");
		if (yes && operation !== "forget") throw new UsageError("--yes applies only to memory forget.");
		return {
			kind: "memory",
			request: memoryCommand(operation, operands[1], values.get("--request-id")),
			yes,
			options: {
				session: values.get("--session") ?? DEFAULT_SESSION,
				...(values.has("--data-dir") ? { dataDir: values.get("--data-dir") } : {}),
			},
		};
	}
	if (first === "maintenance-enter" || first === "maintenance-release") {
		const values = new Map<string, string>();
		for (let index = 1; index < argv.length; index++) {
			const flag = argv[index];
			if (
				!["--operation-id", "--timeout-ms", "--session", "--data-dir"].includes(flag) ||
				(flag === "--timeout-ms" && first === "maintenance-release")
			)
				throw new UsageError(`Unknown maintenance option: ${flag}`);
			const value = argv[++index];
			if (value === undefined || value === "" || values.has(flag))
				throw new UsageError(`Option ${flag} needs one value.`);
			values.set(flag, value);
		}
		const operationId = values.get("--operation-id");
		if (operationId === undefined || operationId.length > 200)
			throw new UsageError("Maintenance requires --operation-id (1 to 200 characters).");
		const options = {
			session: values.get("--session") ?? DEFAULT_SESSION,
			...(values.has("--data-dir") ? { dataDir: values.get("--data-dir") } : {}),
		};
		if (first === "maintenance-release") return { kind: first, operationId, options };
		const timeoutMs = Number(values.get("--timeout-ms") ?? "30000");
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000)
			throw new UsageError("Maintenance timeout must be 0 to 30000 ms.");
		return { kind: first, operationId, timeoutMs, options };
	}
	if (first === "login" || first === "logout" || first === "status" || first === "setup")
		return parseAccountCommand(first, argv.slice(1));
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
