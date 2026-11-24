// Classifies one line of terminal input into a slash command or a prompt, for every terminal mode alike.
import { memoryCommand } from "../memory-control.ts";
import { type CommandDefinition, commandCatalog } from "./catalog.ts";
import { isOperatingSystemQuestion } from "./facts.ts";
import type { CommandInterpretation } from "./interpretation.ts";
import { describeCommandSuggestions, resolveLocalCommand } from "./resolution.ts";

/** Largest prompt, in bytes, a terminal sends to the owner. */
export const MAX_PROMPT_BYTES = 16_384;

/** Longest unrecognized command text a terminal asks the owner to interpret; longer input is simply unknown. */
export const MAX_INTERPRETED_INPUT = 256;

/** What one input line is; each terminal mode decides how to carry it out and how to recover a failed send. */
export type SlashInput =
	| { readonly kind: "empty" }
	| { readonly kind: "prompt"; readonly text: string }
	/** A near miss of local command vocabulary; nothing runs. */
	| { readonly kind: "suggestions"; readonly commands: readonly CommandDefinition[] }
	/** Starts with `/` and matches nothing locally; the mode may ask the owner to interpret `text`. */
	| { readonly kind: "unresolved"; readonly text: string }
	| { readonly kind: "unknown" }
	| { readonly kind: "exit" | "help" | "status" | "cancel" }
	| { readonly kind: "mission"; readonly setup: boolean }
	| { readonly kind: "inspect" | "memory"; readonly text: string }
	| { readonly kind: "evidence"; readonly argument: string };

/** Classifies a line; `text` in the result is the line after trimming and alias resolution. */
export function classifySlashInput(line: string): SlashInput {
	let text = line.trim();
	if (text.startsWith("/")) {
		const resolved = resolveLocalCommand(text, "slash");
		if (resolved.kind === "suggestions") return { kind: "suggestions", commands: resolved.commands };
		if (resolved.kind === "unresolved") return { kind: "unresolved", text };
		text = `/${resolved.text}`;
	}
	if (text === "/exit") return { kind: "exit" };
	if (text === "/help") return { kind: "help" };
	if (text === "/status") return { kind: "status" };
	if (text === "/cancel") return { kind: "cancel" };
	if (text === "/mission" || text === "/mission status") return { kind: "mission", setup: false };
	if (text === "/mission setup") return { kind: "mission", setup: true };
	if (text === "/evidence" || text.startsWith("/evidence ")) return { kind: "evidence", argument: text.slice(9).trim() };
	if ((text === "/inspect" || text.startsWith("/inspect ")) && !isOperatingSystemQuestion(text))
		return { kind: "inspect", text };
	if (text === "/memory" || text.startsWith("/memory ")) return { kind: "memory", text };
	if (text.startsWith("/") && !isOperatingSystemQuestion(text)) return { kind: "unknown" };
	return text === "" ? { kind: "empty" } : { kind: "prompt", text };
}

/** Parses the operands of a classified `/memory` line; throws a usage error for bad operands. */
export function parseMemorySlash(text: string): ReturnType<typeof memoryCommand> {
	const match = /^\/memory(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(text);
	return memoryCommand(match?.[1], match?.[2]);
}

/** Whether the answer to a pending forget confirmation is a yes; anything else cancels it. */
export function confirmsForget(line: string): boolean {
	return line.trim().toLowerCase() === "yes";
}

/** Whether a tool call ID is a single bounded token the owner can be asked about. */
export function isEvidenceCallId(callId: string): boolean {
	return !/\s/.test(callId) && callId.length <= 200;
}

/** The word every terminal uses for whether the conversation has work in flight. */
export function activityLabel(busy: boolean): "working" | "ready" {
	return busy ? "working" : "ready";
}

/** The notice for a slash command nothing recognizes; `help` is the mode's own command list. */
export function unknownCommandNotice(help: string): string {
	return `Unknown command. ${help}`;
}

/** The slash commands the owner's interpretation named, in catalog order; none when it only explained. */
export function interpretedCommands(result: CommandInterpretation): readonly CommandDefinition[] {
	return commandCatalog("slash").filter((command) => result.commandIds.includes(command.id));
}

/** Text for an interpretation: the suggested commands, or the owner's explanation when it named none. */
export function describeInterpretation(result: CommandInterpretation): string {
	const commands = interpretedCommands(result);
	return commands.length === 0 ? result.explanation : describeCommandSuggestions(commands, "slash");
}
