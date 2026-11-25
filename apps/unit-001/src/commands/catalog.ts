// Declares the implemented command vocabulary shared by local help and intent resolution.

export type CommandSurface = "cli" | "slash";

export interface CommandDefinition {
	readonly id: string;
	readonly surfaces: readonly CommandSurface[];
	readonly invocation: string;
	readonly summary: string;
	readonly aliases: readonly string[];
	readonly keywords: readonly string[];
}

/** Version of the declared aliases and deterministic ranking rules. */
export const COMMAND_CATALOG_VERSION = 2;

/** Commands available in the shipped application; definitions never confer execution authority. */
export const COMMANDS: readonly CommandDefinition[] = [
	{
		id: "inspect",
		surfaces: ["cli", "slash"],
		invocation: "inspect",
		summary: "Read owner runtime, configuration, tools, channels, mission, tasks, host or public files",
		aliases: [],
		keywords: ["runtime", "configuration", "tools", "channels", "mission", "tasks", "host", "file", "introspect"],
	},
	{
		id: "inspect.os",
		surfaces: ["cli", "slash"],
		invocation: "inspect os",
		summary: "Read observed operating-system facts",
		aliases: [],
		keywords: ["operating", "system", "distribution", "kernel", "architecture"],
	},
	{
		id: "evidence",
		surfaces: ["slash"],
		invocation: "evidence",
		summary: "Show one tool call's bounded, redacted arguments, output and diff",
		aliases: [],
		keywords: ["tool", "arguments", "output", "diff", "failure"],
	},
	{
		id: "help",
		surfaces: ["cli", "slash"],
		invocation: "help",
		summary: "Show available commands",
		aliases: ["?"],
		keywords: ["commands", "usage"],
	},
	{
		id: "status",
		surfaces: ["cli", "slash"],
		invocation: "status",
		summary: "Inspect agent status",
		aliases: [],
		keywords: ["health", "uptime", "running"],
	},
	{
		id: "memory",
		surfaces: ["cli", "slash"],
		invocation: "memory",
		summary: "Inspect memory statistics",
		aliases: ["brain"],
		keywords: ["memories", "remembered", "knowledge"],
	},
	{
		id: "memory.recall",
		surfaces: ["cli", "slash"],
		invocation: "memory recall",
		summary: "Search remembered information",
		aliases: [],
		keywords: ["search", "retrieve", "remembered"],
	},
	{
		id: "memory.remember",
		surfaces: ["cli", "slash"],
		invocation: "memory remember",
		summary: "Save an explicit memory",
		aliases: [],
		keywords: ["save", "memorize"],
	},
	{
		id: "memory.forget",
		surfaces: ["cli", "slash"],
		invocation: "memory forget",
		summary: "Forget one memory after confirmation",
		aliases: [],
		keywords: ["delete", "remove", "erase"],
	},
	{
		id: "memory.sleep",
		surfaces: ["cli", "slash"],
		invocation: "memory sleep",
		summary: "Schedule pending memory consolidation",
		aliases: [],
		keywords: ["consolidate"],
	},
	{
		id: "mission",
		surfaces: ["cli", "slash"],
		invocation: "mission",
		summary: "Inspect the saved mission",
		aliases: [],
		keywords: ["purpose", "objective", "agreement"],
	},
	{
		id: "mission.setup",
		surfaces: ["cli", "slash"],
		invocation: "mission setup",
		summary: "Form a mission draft",
		aliases: [],
		keywords: ["purpose", "objective", "draft"],
	},
	{
		id: "mission.draft",
		surfaces: ["cli"],
		invocation: "mission draft",
		summary: "Save mission terms from a file",
		aliases: [],
		keywords: ["terms"],
	},
	{
		id: "mission.propose",
		surfaces: ["cli"],
		invocation: "mission propose",
		summary: "Propose an exact mission revision",
		aliases: [],
		keywords: ["agreement"],
	},
	{
		id: "mission.creator",
		surfaces: ["cli"],
		invocation: "mission creator",
		summary: "Configure creator authority",
		aliases: [],
		keywords: ["authority"],
	},
	{
		id: "mission.approve",
		surfaces: ["cli"],
		invocation: "mission approve",
		summary: "Approve an exact mission revision",
		aliases: [],
		keywords: ["approval"],
	},
	...(
		[
			["start", "Start the exact approved mission"],
			["pause", "Pause and drain mission-owned work"],
			["resume", "Resume a paused mission within its existing limits"],
			["stop", "Stop mission execution without stopping the owner"],
		] as const
	).map(([action, summary]) => ({
		id: `mission.${action}`,
		surfaces: ["cli"] as const,
		invocation: `mission ${action}`,
		summary,
		aliases: [],
		keywords: ["mission", action],
	})),
	{
		id: "setup",
		surfaces: ["cli"],
		invocation: "setup",
		summary: "Configure provider authentication and model",
		aliases: [],
		keywords: ["configure", "provider", "model", "key"],
	},
	{
		id: "login",
		surfaces: ["cli"],
		invocation: "login",
		summary: "Sign in to a provider",
		aliases: [],
		keywords: ["authenticate", "subscription"],
	},
	{
		id: "logout",
		surfaces: ["cli"],
		invocation: "logout",
		summary: "Remove a provider sign-in",
		aliases: [],
		keywords: ["signout"],
	},
	{
		id: "serve",
		surfaces: ["cli"],
		invocation: "serve",
		summary: "Run the storage owner without terminal input",
		aliases: [],
		keywords: ["headless", "daemon"],
	},
	{
		id: "attach",
		surfaces: ["cli"],
		invocation: "attach",
		summary: "Open the running owner's terminal interface",
		aliases: [],
		keywords: ["connect", "chat", "interactive"],
	},
	{
		id: "remote",
		surfaces: ["cli"],
		invocation: "remote",
		summary: "Manage SSH profiles and connect to a remote owner",
		aliases: [],
		keywords: ["ssh", "connection", "profile"],
	},
	{
		id: "send",
		surfaces: ["cli"],
		invocation: "send",
		summary: "Send a prompt to the running owner",
		aliases: [],
		keywords: ["ask", "question", "message"],
	},
	{
		id: "service-status",
		surfaces: ["cli"],
		invocation: "service-status",
		summary: "Inspect the running owner",
		aliases: [],
		keywords: ["service", "health"],
	},
	{
		id: "cancel",
		surfaces: ["cli", "slash"],
		invocation: "cancel",
		summary: "Cancel shared conversation work",
		aliases: [],
		keywords: ["abort", "interrupt"],
	},
	{
		id: "exit",
		surfaces: ["slash"],
		invocation: "exit",
		summary: "Close this terminal connection",
		aliases: ["quit", "detach"],
		keywords: ["close", "disconnect"],
	},
];

/** Returns only commands this interface currently supports. */
export function commandCatalog(surface: CommandSurface): readonly CommandDefinition[] {
	return COMMANDS.filter((command) => command.surfaces.includes(surface));
}
