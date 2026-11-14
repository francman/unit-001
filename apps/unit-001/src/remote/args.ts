// Defines explicit remote commands for the CLI and its command discovery catalog.
import { UsageError } from "../errors.ts";
import { validateSessionName } from "../paths.ts";
import { validateRemoteName } from "./profiles.ts";

export type RemoteCommand =
	| { readonly action: "help" }
	| { readonly action: "list" }
	| { readonly action: "remove"; readonly name: string }
	| {
			readonly action: "add";
			readonly name: string;
			readonly host: string;
			readonly agentName: string;
			readonly session: string;
	  }
	| { readonly action: "connect"; readonly name: string; readonly session?: string; readonly plain: boolean }
	| { readonly action: "status" | "cancel"; readonly name: string; readonly session?: string }
	| {
			readonly action: "send";
			readonly name: string;
			readonly session?: string;
			readonly prompt: string;
			readonly requestId?: string;
	  };

export const REMOTE_COMMANDS = [
	{
		name: "add",
		usage: "agent remote add <name> --host <SSH-alias> [--agent agent] [--session default]",
		description: "Pin a running managed installation",
	},
	{ name: "list", usage: "agent remote list", description: "List local remote bookmarks" },
	{ name: "remove", usage: "agent remote remove <name>", description: "Remove a local bookmark" },
	{
		name: "connect",
		usage: "agent remote connect <name> [--session <name>] [--plain]",
		description: "Open the existing rich terminal remotely",
	},
	{ name: "status", usage: "agent remote status <name> [--session <name>]", description: "Inspect a remote owner" },
	{
		name: "send",
		usage: "agent remote send <name> [--session <name>] [--request-id <id>] -- <prompt>",
		description: "Submit once without automatic retries",
	},
	{
		name: "cancel",
		usage: "agent remote cancel <name> [--session <name>]",
		description: "Request cancellation explicitly",
	},
] as const;

export const REMOTE_USAGE = REMOTE_COMMANDS.map((command) => `${command.usage}\n  ${command.description}`).join("\n");

/** Parses only known remote commands; it never invokes a model or creates an owner. */
export function parseRemoteArguments(argv: readonly string[]): RemoteCommand {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { action: "help" };
	const action = argv[0];
	if (!REMOTE_COMMANDS.some((command) => command.name === action))
		throw new UsageError(`Unknown remote command: ${action}`);
	const values = new Map<string, string>();
	const positional: string[] = [];
	let plain = false;
	for (let index = 1; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") return { action: "help" };
		if (argument === "--") {
			positional.push(...argv.slice(index + 1));
			break;
		}
		if (!argument.startsWith("-")) {
			positional.push(argument);
			continue;
		}
		if (argument === "--plain" && action === "connect" && !plain) {
			plain = true;
			continue;
		}
		const equals = argument.indexOf("=");
		const flag = equals < 0 ? argument : argument.slice(0, equals);
		const allowed =
			action === "add"
				? ["--host", "--agent", "--session"]
				: action === "send"
					? ["--session", "--request-id"]
					: action === "connect" || action === "status" || action === "cancel"
						? ["--session"]
						: [];
		if (!allowed.includes(flag)) throw new UsageError(`Unknown remote option: ${flag}`);
		const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
		if (!value || values.has(flag)) throw new UsageError(`Option ${flag} needs one value.`);
		values.set(flag, value);
	}
	if (action === "list") {
		if (positional.length !== 0) throw new UsageError("Usage: agent remote list");
		return { action };
	}
	if (positional.length !== (action === "send" ? 2 : 1)) throw new UsageError(`Invalid arguments.\n${REMOTE_USAGE}`);
	const name = validateRemoteName(positional[0]);
	const session = values.get("--session");
	if (session !== undefined) validateSessionName(session);
	if (action === "remove") return { action, name };
	if (action === "add") {
		const host = values.get("--host");
		if (host === undefined) throw new UsageError("Remote add requires --host <SSH-alias>.");
		return {
			action,
			name,
			host: validateRemoteName(host),
			agentName: validateRemoteName(values.get("--agent") ?? "agent"),
			session: session ?? "default",
		};
	}
	if (action === "connect") return { action, name, session, plain };
	if (action === "status" || action === "cancel") return { action, name, session };
	const prompt = positional[1];
	const requestId = values.get("--request-id");
	if (prompt.trim() === "" || (requestId !== undefined && requestId.length > 200))
		throw new UsageError("Remote send requires a prompt and a request ID of at most 200 characters.");
	return { action: "send", name, session, prompt, requestId };
}
