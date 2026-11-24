import { MEMORY_RELATION_KINDS, type MemoryRelationRequest } from "unit-memory";
import { commandCatalog } from "./commands/catalog.ts";
import { OS_INSPECTION_PROMPT } from "./commands/facts.ts";
import { describeError, UsageError } from "./errors.ts";
import { inspectionCommand } from "./introspection/command.ts";
import type { InspectionQuery } from "./introspection/contract.ts";
import { memoryCommand } from "./memory-control.ts";
import { type MissionCommand, parseMissionCommand } from "./missions/command.ts";
import { parseRemoteArguments, type RemoteCommand } from "./remote/args.ts";

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
	| {
			readonly kind: "inspection";
			readonly query: InspectionQuery;
			readonly json: boolean;
			readonly options: ServiceOptions;
	  }
	| { readonly kind: "web"; readonly options: ServiceOptions; readonly port: number }
	| { readonly kind: "channels"; readonly options: ServiceOptions }
	| { readonly kind: "remote"; readonly command: RemoteCommand }
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
	| { readonly kind: "inspect-os"; readonly options: ServiceOptions; readonly requestId?: string }
	| { readonly kind: "service-status"; readonly options: ServiceOptions }
	| { readonly kind: "cancel"; readonly options: ServiceOptions }
	| { readonly kind: "attach"; readonly options: AttachOptions }
	| { readonly kind: "run"; readonly options: RunOptions };

/** Value flags of the default run command, each mapped to its long name. */
const RUN_VALUE_FLAGS = new Map<string, string>([
	["-p", "--print"],
	["--print", "--print"],
	["--session", "--session"],
	["--model", "--model"],
	["--data-dir", "--data-dir"],
]);

const DEFAULT_WEB_PORT = 4317;

export const USAGE = `Usage: agent [options]
       agent setup                      choose a provider, sign in, and save a default model
       agent login <anthropic|openai>   sign in with a Claude or ChatGPT subscription
       agent logout <anthropic|openai>  remove a stored sign-in
       agent status                     show how each provider is configured
       agent serve [options]            run without terminal input; shutdown preserves unfinished work
       agent attach [--plain] [options] chat with the running service; exiting detaches
       agent send <prompt> [options]     ask the running service (optional --request-id for safe retries)
       agent service-status [options]    inspect the running service
       agent cancel [options]            cancel chat: abort all work in the chat, including queued inputs
       agent remote --help               connect this terminal to a named remote installation
       agent web [--port 4317] [options]  open the browser workspace on a trusted workstation
       agent memory [stats|recall <query>|remember <text>|forget <id>|sleep] [options]
       agent mission [status|setup|draft|propose|creator|approve|start|pause|resume|stop] [options]
       agent mission plan approve --revision N --digest SHA256 [--request-id ID]
       agent channels [status] [options] show available adapters and observed channel state
       agent inspect [runtime|configuration|tools|channels|mission|tasks|host] [--json]
       agent inspect os [options]        read observed operating-system facts
       agent inspect file <path> [--offset N] [--json] [options]

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
Memory remember accepts up to 8 repeated --relation <relates|supports|contradicts|updates>:<id> options.

A provider is used when you have signed in to it or set its key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
OPENROUTER_API_KEY), checked in that order. A stored sign-in wins over a key for the same provider.`;

/** Splits `--flag=value` into its flag and inline value; a short flag or bare `--flag` has no inline value. */
function splitFlag(argument: string): { readonly flag: string; readonly inline: string | undefined } {
	const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
	return equals === -1
		? { flag: argument, inline: undefined }
		: { flag: argument.slice(0, equals), inline: argument.slice(equals + 1) };
}

/**
 * Reads the value of the flag at `argv[index]` (`--flag value` or `--flag=value`); `next` is the index of its last token.
 * Rejects a missing or empty value, and a flag `isTaken` says was already given.
 */
function takeFlagValue(
	argv: readonly string[],
	index: number,
	isTaken: (flag: string) => boolean,
): { readonly flag: string; readonly value: string; readonly next: number } {
	const { flag, inline } = splitFlag(argv[index]);
	const value = inline ?? argv[index + 1];
	if (value === undefined || value === "") throw new UsageError(`Option ${flag} needs a value.`);
	if (isTaken(flag)) throw new UsageError(`Option ${flag} was given more than once.`);
	return { flag, value, next: inline === undefined ? index + 1 : index };
}

function parseAccountCommand(kind: "login" | "logout" | "status" | "setup", rest: readonly string[]): Command {
	const values = new Map<string, string>();
	const positional: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const argument = rest[index];
		if (argument === "-h" || argument === "--help") return { kind: "help" };
		if (splitFlag(argument).flag === "--data-dir") {
			const taken = takeFlagValue(rest, index, (name) => values.has(name));
			values.set(taken.flag, taken.value);
			index = taken.next;
		} else if (argument.startsWith("-")) {
			throw new UsageError(`Unknown option: ${argument}`);
		} else {
			positional.push(argument);
		}
	}
	const dataDir = values.get("--data-dir");
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
	const allowed = ["--session", "--data-dir", ...(kind === "serve" ? ["--model"] : []), ...(kind === "send" ? ["--request-id"] : [])];
	const values = new Map<string, string>();
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
		const { flag } = splitFlag(argument);
		if (!allowed.includes(flag)) throw new UsageError(`Unknown option: ${flag}`);
		const taken = takeFlagValue(rest, index, (name) => values.has(name));
		values.set(taken.flag, taken.value);
		index = taken.next;
	}
	const dataDir = values.get("--data-dir");
	const options = { session: values.get("--session") ?? DEFAULT_SESSION, ...(dataDir === undefined ? {} : { dataDir }) };
	const model = values.get("--model");
	const requestId = values.get("--request-id");
	if (kind === "serve")
		return {
			kind,
			options: {
				...options,
				...(model === undefined ? {} : { model }),
				...(inhibited ? { inhibited: true } : {}),
			},
		};
	if (kind === "send") {
		if (prompt === undefined || prompt.trim() === "") throw new UsageError("Usage: agent send <prompt> [options]");
		return { kind, options, prompt, ...(requestId === undefined ? {} : { requestId }) };
	}
	return kind === "attach" && plain ? { kind, options: { ...options, plain: true } } : { kind, options };
}

/** Parses `web [--port N]` plus the shared service options. */
function parseWebCommand(rest: readonly string[]): Command {
	let port: number | undefined;
	const remaining: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const { flag, inline } = splitFlag(rest[index]);
		if (flag !== "--port") {
			remaining.push(rest[index]);
			continue;
		}
		if (port !== undefined) throw new UsageError("Option --port was given more than once.");
		const value = inline ?? rest[++index];
		if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
			throw new UsageError("Web port must be 1024 to 65535.");
		port = Number(value);
	}
	const parsed = parseServiceCommand("service-status", remaining);
	return parsed.kind === "service-status" ? { kind: "web", options: parsed.options, port: port ?? DEFAULT_WEB_PORT } : parsed;
}

/** Parses `channels [status]` plus the shared service options. */
function parseChannelsCommand(rest: readonly string[]): Command {
	const parsed = parseServiceCommand("service-status", rest[0] === "status" ? rest.slice(1) : rest);
	return parsed.kind === "service-status" ? { kind: "channels", options: parsed.options } : parsed;
}

/** Parses `inspect os` and `inspect SCOPE|file PATH [--offset N] [--json]` plus the shared service options. */
function parseInspectCommand(rest: readonly string[]): Command {
	if (rest[0] === "os") {
		const parsed = parseServiceCommand("send", [OS_INSPECTION_PROMPT, ...rest.slice(1)]);
		if (parsed.kind !== "send") return parsed;
		return {
			kind: "inspect-os",
			options: parsed.options,
			...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
		};
	}
	const remaining: string[] = [];
	const operands: string[] = [];
	let json = false;
	let offset = 0;
	for (let index = 0; index < rest.length; index++) {
		const argument = rest[index];
		if (argument === "--json") {
			if (json) throw new UsageError("Duplicate --json.");
			json = true;
		} else if (argument === "--offset") {
			const value = rest[++index];
			if (!value || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))
				throw new UsageError("Offset must be a nonnegative integer.");
			offset = Number(value);
		} else if (argument === "--session" || argument === "--data-dir") {
			remaining.push(argument, rest[++index]);
		} else if (argument.startsWith("-")) remaining.push(argument);
		else operands.push(argument);
	}
	if (operands.length > 2) throw new UsageError("Unexpected inspection operand.");
	const parsed = parseServiceCommand("service-status", remaining);
	if (parsed.kind !== "service-status") return parsed;
	try {
		return { kind: "inspection", query: inspectionCommand(operands[0], operands[1], offset), json, options: parsed.options };
	} catch (error) {
		throw new UsageError(describeError(error));
	}
}

/** Parses `mission ...`; the mission parser owns its grammar. */
function parseMissionArguments(rest: readonly string[]): Command {
	try {
		const { command, ...options } = parseMissionCommand(rest);
		return { kind: "mission", command, options };
	} catch (error) {
		throw new UsageError(describeError(error));
	}
}

const MEMORY_VALUE_FLAGS = ["--session", "--data-dir", "--request-id"];

/** Parses `memory [OPERATION [OPERAND]]` with its flags. */
function parseMemoryArguments(rest: readonly string[]): Command {
	const values = new Map<string, string>();
	const operands: string[] = [];
	const relations: MemoryRelationRequest[] = [];
	let yes = false;
	for (let index = 0; index < rest.length; index++) {
		const argument = rest[index];
		if (argument === "--help" || argument === "-h") return { kind: "help" };
		if (argument === "--yes") {
			if (yes) throw new UsageError("Option --yes was given more than once.");
			yes = true;
			continue;
		}
		if (argument === "--") {
			operands.push(...rest.slice(index + 1));
			break;
		}
		if (!argument.startsWith("-")) {
			operands.push(argument);
			continue;
		}
		const { flag, inline } = splitFlag(argument);
		if (flag === "--relation") {
			const value = inline ?? rest[++index];
			const separator = value?.indexOf(":") ?? -1;
			const kind = MEMORY_RELATION_KINDS.find((kind) => kind === value?.slice(0, separator));
			if (kind === undefined || value === undefined || separator < 1 || separator === value.length - 1)
				throw new UsageError("Usage: --relation <relates|supports|contradicts|updates>:<id>");
			relations.push({ kind, id: value.slice(separator + 1) });
			continue;
		}
		if (!MEMORY_VALUE_FLAGS.includes(flag)) throw new UsageError(`Unknown memory option: ${flag}`);
		const taken = takeFlagValue(rest, index, (name) => values.has(name));
		values.set(taken.flag, taken.value);
		index = taken.next;
	}
	const operation = operands[0] ?? "stats";
	if (operands.length > 2 || ((operation === "stats" || operation === "sleep") && operands.length > 1))
		throw new UsageError("Memory expects one quoted query, statement or ID.");
	if (yes && operation !== "forget") throw new UsageError("--yes applies only to memory forget.");
	const dataDir = values.get("--data-dir");
	return {
		kind: "memory",
		request: memoryCommand(
			operation,
			operands[1],
			values.get("--request-id"),
			relations.length === 0 ? undefined : relations,
		),
		yes,
		options: { session: values.get("--session") ?? DEFAULT_SESSION, ...(dataDir === undefined ? {} : { dataDir }) },
	};
}

/** Parses `maintenance-enter|maintenance-release` with their flags. */
function parseMaintenanceArguments(kind: "maintenance-enter" | "maintenance-release", rest: readonly string[]): Command {
	const allowed = ["--operation-id", "--session", "--data-dir", ...(kind === "maintenance-enter" ? ["--timeout-ms"] : [])];
	const values = new Map<string, string>();
	for (let index = 0; index < rest.length; index++) {
		const { flag } = splitFlag(rest[index]);
		if (!allowed.includes(flag)) throw new UsageError(`Unknown maintenance option: ${flag}`);
		const taken = takeFlagValue(rest, index, (name) => values.has(name));
		values.set(taken.flag, taken.value);
		index = taken.next;
	}
	const operationId = values.get("--operation-id");
	if (operationId === undefined || operationId.length > 200)
		throw new UsageError("Maintenance requires --operation-id (1 to 200 characters).");
	const dataDir = values.get("--data-dir");
	const options = { session: values.get("--session") ?? DEFAULT_SESSION, ...(dataDir === undefined ? {} : { dataDir }) };
	if (kind === "maintenance-release") return { kind, operationId, options };
	const timeoutMs = Number(values.get("--timeout-ms") ?? "30000");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000)
		throw new UsageError("Maintenance timeout must be 0 to 30000 ms.");
	return { kind, operationId, timeoutMs, options };
}

/** Parses the default command: run the agent in this process, optionally answering one prompt. */
function parseRunArguments(argv: readonly string[]): Command {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "-h" || argument === "--help") return { kind: "help" };
		if (argument === "-v" || argument === "--version") return { kind: "version" };
		const { flag } = splitFlag(argument);
		const name = RUN_VALUE_FLAGS.get(flag);
		if (name === undefined)
			throw new UsageError(argument.startsWith("-") ? `Unknown option: ${argument}` : `Unexpected argument: ${argument}`);
		// `-p` and `--print` are one option, so the repeat check looks at the long name.
		const taken = takeFlagValue(argv, index, (flag) => values.has(RUN_VALUE_FLAGS.get(flag) ?? flag));
		values.set(name, taken.value);
		index = taken.next;
	}
	const print = values.get("--print");
	const model = values.get("--model");
	const dataDir = values.get("--data-dir");
	return {
		kind: "run",
		options: {
			...(print === undefined ? {} : { print }),
			session: values.get("--session") ?? DEFAULT_SESSION,
			...(model === undefined ? {} : { model }),
			...(dataDir === undefined ? {} : { dataDir }),
		},
	};
}

/** Parses the command line, without the node and script entries. Throws `UsageError` on anything unrecognized. */
export function parseArguments(argv: readonly string[]): Command {
	const first = argv[0];
	const rest = argv.slice(1);
	const alias = commandCatalog("cli").find(
		(command) => !command.invocation.includes(" ") && command.aliases.includes(first),
	);
	if (alias !== undefined) return parseArguments([alias.invocation, ...rest]);
	if (first === "help") return { kind: "help" };
	if (first === "web") return parseWebCommand(rest);
	if (first === "channels") return parseChannelsCommand(rest);
	if (first === "inspect") return parseInspectCommand(rest);
	if (first === "remote") return { kind: "remote", command: parseRemoteArguments(rest) };
	if (first === "mission") return parseMissionArguments(rest);
	if (first === "memory") return parseMemoryArguments(rest);
	if (first === "maintenance-enter" || first === "maintenance-release") return parseMaintenanceArguments(first, rest);
	if (first === "login" || first === "logout" || first === "status" || first === "setup")
		return parseAccountCommand(first, rest);
	if (first === "serve" || first === "send" || first === "service-status" || first === "cancel" || first === "attach")
		return parseServiceCommand(first, rest);
	return parseRunArguments(argv);
}
