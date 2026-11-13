import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Agent, Reply } from "./agent.ts";
import { commandCatalog } from "./commands/catalog.ts";
import { isOperatingSystemQuestion } from "./commands/facts.ts";
import { describeCommandSuggestions, resolveLocalCommand } from "./commands/resolution.ts";
import { describeMemory, type MemoryRequest, memoryCommand } from "./memory-control.ts";
import { describeMission } from "./missions/command.ts";
import { DeltaPrinter, liveText, sanitizeTerminalText, ToolAnnouncer } from "./render.ts";

export interface Terminal {
	readonly input: NodeJS.ReadableStream;
	/** Given to readline for line editing; present only when the terminal is interactive. */
	readonly output?: NodeJS.WritableStream;
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
}

const HELP =
	"Commands: /help, /status, /mission, /memory [stats|recall <query>|remember <text>|forget <id>|sleep], /exit (or Ctrl+D). Ctrl+C stops the current run.";

/** Runs one prompt, streaming the answer to `terminal.out` and tool use to `terminal.err`. */
async function turn(agent: Agent, prompt: string, terminal: Terminal, signal: AbortSignal): Promise<Reply> {
	const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
	const onAbort = () => cancel();
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	const printer = new DeltaPrinter(terminal.out);
	const tools = new ToolAnnouncer();
	try {
		const stop = await agent.watch((live) => {
			for (const name of tools.next(live)) terminal.err(`[${name}]\n`);
			printer.update(liveText(live));
		}, BACKGROUND_CONTEXT);
		let reply: Reply;
		try {
			reply = await agent.ask(prompt, context);
		} finally {
			await stop();
		}
		if (reply.status === "answered") printer.finish(reply.text);
		return reply;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function report(reply: Reply, terminal: Terminal): void {
	if (reply.status === "failed") {
		terminal.err(`unanswered: ${reply.reason}${reply.detail === undefined ? "" : ` (${reply.detail})`}\n`);
	}
}

/** Runs one prompt and prints only its answer, for scripts and pipes. Returns the exit code. */
export async function runPrint(agent: Agent, prompt: string, terminal: Terminal, signal: AbortSignal): Promise<number> {
	const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
	const onAbort = () => cancel();
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	const tools = new ToolAnnouncer();
	try {
		const stop = await agent.watch((live) => {
			for (const name of tools.next(live)) terminal.err(`[${name}]\n`);
		}, BACKGROUND_CONTEXT);
		try {
			const reply = await agent.ask(prompt, context);
			if (reply.status === "answered") {
				terminal.out(reply.text.endsWith("\n") ? reply.text : `${reply.text}\n`);
				return 0;
			}
			report(reply, terminal);
			return 1;
		} finally {
			await stop();
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** The interactive chat loop. Returns the exit code. */
export async function runRepl(agent: Agent, terminal: Terminal, signal: AbortSignal): Promise<number> {
	const interactive = terminal.output !== undefined;
	const readline = createInterface({ input: terminal.input, output: terminal.output, terminal: interactive });
	let current: AbortController | undefined;
	let stopping: Promise<void> | undefined;
	let closing = false;
	let forget: { readonly id: string; readonly requestId: string } | undefined;

	const onAbort = () => {
		current?.abort();
		readline.close();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	readline.on("SIGINT", () => {
		if (current === undefined) {
			closing = true;
			readline.close();
			return;
		}
		terminal.err("\n^C stopping the run\n");
		current.abort();
		stopping ??= agent.abort(BACKGROUND_CONTEXT).catch(() => {});
	});

	try {
		if (signal.aborted) return 0;
		if (interactive) terminal.err(`${agent.name} ready. ${HELP}\n`);
		const initial = await agent.status(BACKGROUND_CONTEXT);
		if (signal.aborted) return 0;
		if (agent.interrupted && initial.runtime.configuration === "unconfigured")
			terminal.err("Interrupted work is preserved. Configure a provider and reopen the owner to resume it.\n");
		if (agent.interrupted && initial.runtime.configuration === "configured") {
			current = new AbortController();
			const recovering = current;
			const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
			const onRecoveryAbort = () => cancel();
			recovering.signal.addEventListener("abort", onRecoveryAbort, { once: true });
			terminal.err("Resuming the run that was interrupted.\n");
			const printer = new DeltaPrinter(terminal.out);
			const stop = await agent.watch((live) => printer.update(liveText(live)), BACKGROUND_CONTEXT);
			try {
				printer.finish((await agent.idle(context)) ?? "");
			} catch (error) {
				if (!current.signal.aborted) throw error;
			} finally {
				recovering.signal.removeEventListener("abort", onRecoveryAbort);
				await stop();
				await stopping;
				stopping = undefined;
				current = undefined;
			}
		}

		readline.setPrompt("> ");
		if (interactive) readline.prompt();
		for await (const line of readline) {
			let text = line.trim();
			if (forget !== undefined) {
				const pending = forget;
				forget = undefined;
				try {
					if (text.toLowerCase() === "yes")
						terminal.err(
							`${describeMemory(await agent.memory({ operation: "forget", ...pending, confirmed: true }, BACKGROUND_CONTEXT))}\n`,
						);
					else terminal.err("Forget cancelled.\n");
				} catch (error) {
					terminal.err(`Memory: ${error instanceof Error ? error.message : String(error)}\n`);
				}
				if (interactive) readline.prompt();
				continue;
			}
			if (text.startsWith("/")) {
				const resolved = resolveLocalCommand(text, "slash");
				if (resolved.kind === "exact") text = `/${resolved.text}`;
				else {
					if (resolved.kind === "suggestions")
						terminal.err(`${describeCommandSuggestions(resolved.commands, "slash")}\n`);
					else {
						const result = await agent.resolveCommand(text, "slash", BACKGROUND_CONTEXT, signal);
						const commands = commandCatalog("slash").filter((command) => result.commandIds.includes(command.id));
						terminal.err(
							`${commands.length === 0 ? result.explanation : describeCommandSuggestions(commands, "slash")}\n`,
						);
					}
					if (interactive) readline.prompt();
					continue;
				}
			}
			if (text === "/exit" || text === "/quit") break;
			if (text === "/help") terminal.err(`${HELP}\n`);
			else if (text === "/status") {
				const status = await agent.status(BACKGROUND_CONTEXT);
				terminal.err(
					`${agent.name}: ${status.busy ? "busy" : "idle"}; PID ${status.runtime.pid}; started ${new Date(status.runtime.startedAt).toISOString()}; uptime ${Math.floor(status.runtime.uptimeMs / 1000)}s; observed ${new Date(status.runtime.observedAt).toISOString()}\n`,
				);
			} else if (text === "/mission" || text === "/mission status" || text === "/mission setup") {
				try {
					terminal.err(`${describeMission(await agent.mission({ operation: "status" }, BACKGROUND_CONTEXT))}\n`);
					if (text === "/mission setup")
						terminal.err(
							`Close this foreground session, run ${agent.name} serve, then run ${agent.name} mission setup in another terminal.\n`,
						);
				} catch (error) {
					terminal.err(`Mission: ${error instanceof Error ? error.message : String(error)}\n`);
				}
			} else if (text === "/memory" || text.startsWith("/memory ")) {
				try {
					const match = /^\/memory(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(text);
					const request = memoryCommand(match?.[1], match?.[2]);
					if (request.operation === "confirm-forget") {
						forget = { id: request.id, requestId: request.requestId };
						terminal.err(
							`Forget ${sanitizeTerminalText(request.id)}? Type yes; any other input cancels. History remains. [No]\n`,
						);
					} else
						terminal.err(
							`${describeMemory(await agent.memory(request satisfies MemoryRequest, BACKGROUND_CONTEXT))}\n`,
						);
				} catch (error) {
					terminal.err(`Memory: ${error instanceof Error ? error.message : String(error)}\n`);
				}
			} else if (text.startsWith("/") && !isOperatingSystemQuestion(text))
				terminal.err(`Unknown command ${text.split(/\s/, 1)[0]}. ${HELP}\n`);
			else if (text !== "") {
				current = new AbortController();
				try {
					report(await turn(agent, text, terminal, current.signal), terminal);
				} catch (error) {
					terminal.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
				} finally {
					await stopping;
					stopping = undefined;
					current = undefined;
				}
			}
			if (closing) break;
			if (interactive) readline.prompt();
		}
		return 0;
	} finally {
		signal.removeEventListener("abort", onAbort);
		readline.close();
	}
}
