// Resolves declared aliases and bounded local suggestions without loading a model.
import { type CommandDefinition, type CommandSurface, commandCatalog } from "./catalog.ts";

export type LocalCommandResolution =
	| { readonly kind: "exact"; readonly command: CommandDefinition; readonly text: string }
	| { readonly kind: "suggestions"; readonly commands: readonly CommandDefinition[] }
	| { readonly kind: "unresolved" };

/** Resolves command vocabulary only; canonical text must still pass the ordinary command parser. */
export function resolveLocalCommand(input: string, surface: CommandSurface): LocalCommandResolution {
	const text = input.trim().replace(/^\//, "");
	if (text === "") return { kind: "unresolved" };
	const catalog = commandCatalog(surface);
	for (const command of [...catalog].sort((left, right) => right.invocation.length - left.invocation.length)) {
		for (const spelling of [command.invocation, ...command.aliases]) {
			if (text === spelling || text.startsWith(`${spelling} `))
				return { kind: "exact", command, text: command.invocation + text.slice(spelling.length) };
		}
	}
	if (text.length > 512) return { kind: "unresolved" };
	// Operands never influence local ranking; a private query or memory body is not command vocabulary.
	const words = text.toLowerCase().split(/\s+/, 1);
	const phrase = words.join(" ");
	const ranked = catalog
		.map((command) => {
			let score = 0;
			for (const spelling of [command.invocation, ...command.aliases]) {
				const distance = editDistance(words.slice(0, spelling.split(" ").length).join(" "), spelling);
				if (distance <= Math.max(1, Math.floor(spelling.length / 3))) score = Math.max(score, 100 - distance * 10);
			}
			for (const keyword of command.keywords) if (words.includes(keyword)) score += 15;
			if (command.invocation.startsWith(phrase)) score = Math.max(score, 70);
			return { command, score };
		})
		.filter((item) => item.score > 0)
		.sort((left, right) => right.score - left.score || left.command.id.localeCompare(right.command.id))
		.slice(0, 3);
	return ranked.length === 0
		? { kind: "unresolved" }
		: { kind: "suggestions", commands: ranked.map((item) => item.command) };
}

/** Formats suggestions as commands to enter; formatting grants no permission to run them. */
export function describeCommandSuggestions(commands: readonly CommandDefinition[], surface: CommandSurface): string {
	return `Did you mean:\n${commands.map((command) => `  ${surface === "slash" ? "/" : ""}${command.invocation} — ${command.summary}`).join("\n")}\nEnter a command to continue; nothing was executed.`;
}

function editDistance(left: string, right: string): number {
	if (left.length > 64 || right.length > 64) return 65;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++)
			current[column] = Math.min(
				current[column - 1] + 1,
				previous[column] + 1,
				previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
			);
		previous = current;
	}
	return previous[right.length];
}
