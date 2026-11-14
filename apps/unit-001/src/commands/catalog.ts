// Declares the implemented command vocabulary shared by local help and intent resolution.

export type CommandSurface = "cli" | "slash";

export interface CommandDefinition {
	readonly id: string;
	readonly surfaces: readonly CommandSurface[];
	readonly invocation: string;
	readonly summary: string;
	readonly aliases: readonly string[];
	readonly keywords: readonly string[];
	readonly effect: "read" | "write" | "administrator";
}

/** Version of the declared aliases and deterministic ranking rules. */
export const COMMAND_CATALOG_VERSION = 1;

/** Commands available in the shipped application; definitions never confer execution authority. */
export const COMMANDS: readonly CommandDefinition[] = [
	{
		id: "inspect.os",
		surfaces: ["cli", "slash"],
		invocation: "inspect os",
		summary: "Read observed operating-system facts",
		aliases: [],
		keywords: ["operating", "system", "distribution", "kernel", "architecture"],
		effect: "read",
	},
	{
		id: "help",
		surfaces: ["cli", "slash"],
		invocation: "help",
		summary: "Show available commands",
		aliases: ["?"],
		keywords: ["commands", "usage"],
		effect: "read",
	},
	{
		id: "status",
		surfaces: ["cli", "slash"],
		invocation: "status",
		summary: "Inspect agent status",
		aliases: [],
		keywords: ["health", "uptime", "running"],
		effect: "read",
	},
	{
		id: "memory",
		surfaces: ["cli", "slash"],
		invocation: "memory",
		summary: "Inspect memory statistics",
		aliases: ["brain"],
		keywords: ["memories", "remembered", "knowledge"],
		effect: "read",
	},
	{
		id: "memory.recall",
		surfaces: ["cli", "slash"],
		invocation: "memory recall",
		summary: "Search remembered information",
		aliases: [],
		keywords: ["search", "retrieve", "remembered"],
		effect: "read",
	},
	{
		id: "memory.remember",
		surfaces: ["cli", "slash"],
		invocation: "memory remember",
		summary: "Save an explicit memory",
		aliases: [],
		keywords: ["save", "memorize"],
		effect: "write",
	},
	{
		id: "memory.forget",
		surfaces: ["cli", "slash"],
		invocation: "memory forget",
		summary: "Forget one memory after confirmation",
		aliases: [],
		keywords: ["delete", "remove", "erase"],
		effect: "write",
	},
	{
		id: "memory.sleep",
		surfaces: ["cli", "slash"],
		invocation: "memory sleep",
		summary: "Schedule pending memory consolidation",
		aliases: [],
		keywords: ["consolidate"],
		effect: "write",
	},
	{
		id: "mission",
		surfaces: ["cli", "slash"],
		invocation: "mission",
		summary: "Inspect the saved mission",
		aliases: [],
		keywords: ["purpose", "objective", "agreement"],
		effect: "read",
	},
	{
		id: "mission.setup",
		surfaces: ["cli", "slash"],
		invocation: "mission setup",
		summary: "Form a mission draft",
		aliases: [],
		keywords: ["purpose", "objective", "draft"],
		effect: "write",
	},
	{
		id: "mission.draft",
		surfaces: ["cli"],
		invocation: "mission draft",
		summary: "Save mission terms from a file",
		aliases: [],
		keywords: ["terms"],
		effect: "write",
	},
	{
		id: "mission.propose",
		surfaces: ["cli"],
		invocation: "mission propose",
		summary: "Propose an exact mission revision",
		aliases: [],
		keywords: ["agreement"],
		effect: "write",
	},
	{
		id: "mission.creator",
		surfaces: ["cli"],
		invocation: "mission creator",
		summary: "Configure creator authority",
		aliases: [],
		keywords: ["authority"],
		effect: "administrator",
	},
	{
		id: "mission.approve",
		surfaces: ["cli"],
		invocation: "mission approve",
		summary: "Approve an exact mission revision",
		aliases: [],
		keywords: ["approval"],
		effect: "administrator",
	},
	{
		id: "setup",
		surfaces: ["cli"],
		invocation: "setup",
		summary: "Configure provider authentication and model",
		aliases: [],
		keywords: ["configure", "provider", "model", "key"],
		effect: "administrator",
	},
	{
		id: "login",
		surfaces: ["cli"],
		invocation: "login",
		summary: "Sign in to a provider",
		aliases: [],
		keywords: ["authenticate", "subscription"],
		effect: "administrator",
	},
	{
		id: "logout",
		surfaces: ["cli"],
		invocation: "logout",
		summary: "Remove a provider sign-in",
		aliases: [],
		keywords: ["signout"],
		effect: "administrator",
	},
	{
		id: "serve",
		surfaces: ["cli"],
		invocation: "serve",
		summary: "Run the storage owner without terminal input",
		aliases: [],
		keywords: ["headless", "daemon"],
		effect: "write",
	},
	{
		id: "attach",
		surfaces: ["cli"],
		invocation: "attach",
		summary: "Open the running owner's terminal interface",
		aliases: [],
		keywords: ["connect", "chat", "interactive"],
		effect: "read",
	},
	{
		id: "remote",
		surfaces: ["cli"],
		invocation: "remote",
		summary: "Manage SSH profiles and connect to a remote owner",
		aliases: [],
		keywords: ["ssh", "connection", "profile"],
		effect: "write",
	},
	{
		id: "send",
		surfaces: ["cli"],
		invocation: "send",
		summary: "Send a prompt to the running owner",
		aliases: [],
		keywords: ["ask", "question", "message"],
		effect: "write",
	},
	{
		id: "service-status",
		surfaces: ["cli"],
		invocation: "service-status",
		summary: "Inspect the running owner",
		aliases: [],
		keywords: ["service", "health"],
		effect: "read",
	},
	{
		id: "cancel",
		surfaces: ["cli", "slash"],
		invocation: "cancel",
		summary: "Cancel shared conversation work",
		aliases: [],
		keywords: ["abort", "interrupt"],
		effect: "write",
	},
	{
		id: "exit",
		surfaces: ["slash"],
		invocation: "exit",
		summary: "Close this terminal connection",
		aliases: ["quit", "detach"],
		keywords: ["close", "disconnect"],
		effect: "read",
	},
];

/** Returns only commands this interface currently supports. */
export function commandCatalog(surface: CommandSurface): readonly CommandDefinition[] {
	return COMMANDS.filter((command) => command.surfaces.includes(surface));
}
