import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Report } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { Agent } from "./agent.ts";
import { type Command, parseArguments, USAGE } from "./args.ts";
import { runAttach } from "./attach.ts";
import { commandCatalog } from "./commands/catalog.ts";
import { isOperatingSystemQuestion } from "./commands/facts.ts";
import { describeCommandSuggestions, resolveLocalCommand } from "./commands/resolution.ts";
import { FileCredentialStore } from "./credentials.ts";
import { ConfigurationError, UsageError } from "./errors.ts";
import { acquireSessionLock } from "./lock.ts";
import { describeStatus, runLogin, runLogout, subscriptionFor } from "./login.ts";
import { describeMemory, type MemoryRequest } from "./memory-control.ts";
import { parseMissionCeiling } from "./missions/authority.ts";
import { describeMission } from "./missions/command.ts";
import {
	type MissionRequest,
	type MissionView,
	missionObject,
	parseMissionCreator,
	parseMissionDraftTerms,
} from "./missions/contract.ts";
import { runMissionSetup } from "./missions/setup.ts";
import { credentialsFile, dataDirectory, sessionFile } from "./paths.ts";
import { createConfiguredModels, createModelsFor, createOwnerModels } from "./provider.ts";
import { sanitizeTerminalText } from "./render.ts";
import { runPrint, runRepl, type Terminal } from "./repl.ts";
import {
	type MaintenanceRequest,
	operatorEndpoint,
	requestService,
	runService,
	type ServiceRequest,
	serviceEndpoint,
} from "./service.ts";
import { readDefaultModel, saveDefaultModel } from "./settings.ts";
import { runSetup } from "./setup.ts";
import { runRichAttach, runRichForeground } from "./terminal-ui.ts";

/** What the CLI reads from its process, so tests can run it against fakes. */
export interface ManagedIdentity {
	readonly id: string;
	readonly name: string;
	readonly state: string;
	readonly access?: "operator";
}

export interface Runtime {
	readonly managed?: ManagedIdentity;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly cwd: string;
	readonly stdin: NodeJS.ReadableStream;
	readonly stdout: NodeJS.WritableStream;
	readonly stderr: NodeJS.WritableStream;
	/** Standard input and output are both terminals. */
	readonly interactive: boolean;
}

export function processRuntime(): Runtime {
	return {
		env: process.env,
		platform: process.platform,
		home: homedir(),
		cwd: process.cwd(),
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
	};
}

async function version(): Promise<string> {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
		version: string;
	};
	return manifest.version;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf8");
}

function describeReport(report: Report): string {
	const error = (report as { error?: unknown }).error;
	return `[report] ${report.kind}${error instanceof Error ? `: ${error.message}` : ""}\n`;
}

function resolveDirectory(dataDir: string | undefined, runtime: Runtime): string {
	if (runtime.managed !== undefined) {
		if (dataDir !== undefined && resolve(runtime.cwd, dataDir) !== runtime.managed.state)
			throw new ConfigurationError("A named installation cannot change its data directory.");
		return runtime.managed.state;
	}
	return dataDir === undefined
		? dataDirectory({ platform: runtime.platform, env: runtime.env, home: runtime.home })
		: resolve(runtime.cwd, dataDir);
}

function terminalFor(runtime: Runtime): Terminal {
	return {
		input: runtime.stdin,
		...(runtime.interactive ? { output: runtime.stdout } : {}),
		out: (text) => void runtime.stdout.write(text),
		err: (text) => void runtime.stderr.write(text),
	};
}

function richTerminalFor(runtime: Runtime): ProcessTerminal | undefined {
	if (!runtime.interactive || runtime.env.TERM === undefined || runtime.env.TERM === "dumb") return undefined;
	const terminal = new ProcessTerminal();
	return terminal.columns < 40 || terminal.rows < 12 ? undefined : terminal;
}

function credentialStore(directory: string, runtime: Runtime): FileCredentialStore {
	return new FileCredentialStore(credentialsFile(directory, runtime.platform));
}

async function account(
	command: Command & { kind: "login" | "logout" | "status" },
	runtime: Runtime,
	signal: AbortSignal,
) {
	const directory = resolveDirectory(command.dataDir, runtime);
	const credentials = credentialStore(directory, runtime);
	const terminal = terminalFor(runtime);
	if (command.kind === "status") {
		for (const line of await describeStatus(credentials, runtime.env)) terminal.out(`${line}\n`);
		return 0;
	}
	const { provider } = subscriptionFor(command.provider);
	if (command.kind === "logout") return runLogout(credentials, command.provider, terminal);
	const models = await createModelsFor(provider, credentials);
	return runLogin(
		models,
		command.provider,
		terminal,
		signal,
		runtime.platform,
		runtime.managed === undefined
			? { kind: "foreground", name: "agent" }
			: { kind: "managed", name: runtime.managed.name },
	);
}

async function setup(command: Extract<Command, { kind: "setup" }>, runtime: Runtime, signal: AbortSignal) {
	if (!runtime.interactive) throw new UsageError("Setup requires an interactive terminal.");
	const directory = resolveDirectory(command.dataDir, runtime);
	let savedModel: string | undefined;
	try {
		savedModel = await readDefaultModel(directory);
	} catch (error) {
		if (!(error instanceof ConfigurationError)) throw error;
		runtime.stderr.write("Existing settings are invalid; completing setup will replace them.\n");
	}
	const result = await runSetup(
		{
			terminal: terminalFor(runtime),
			interactive: runtime.interactive,
			env: runtime.env,
			credentials: credentialStore(directory, runtime),
			platform: runtime.platform,
			launch:
				runtime.managed === undefined
					? { kind: "foreground", name: "agent" }
					: { kind: "managed", name: runtime.managed.name },
			currentModel: runtime.env.UNIT_001_MODEL || savedModel,
			saveModel: (model) => saveDefaultModel(directory, model),
		},
		signal,
	);
	if (result.kind === "cancelled") return 130;
	if (runtime.env.UNIT_001_MODEL && runtime.env.UNIT_001_MODEL !== result.model)
		runtime.stderr.write(
			"UNIT_001_MODEL overrides the saved model. Update that environment setting to use this choice.\n",
		);
	if (runtime.managed === undefined)
		runtime.stdout.write("Setup saved. Run this launcher without setup to begin chatting.\n");
	return 0;
}

async function run(
	command: Extract<Command, { kind: "run" | "serve" }>,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
	const options = command.options;
	const directory = resolveDirectory(options.dataDir, runtime);
	const file = sessionFile(directory, options.session, runtime.platform);
	const endpoint =
		command.kind === "serve" ? serviceEndpoint(directory, options.session, runtime.platform) : undefined;
	let prompt = command.kind === "run" ? command.options.print : undefined;
	if (prompt === "-") prompt = (await readAll(runtime.stdin)).trim();
	if (prompt === "") throw new UsageError("The prompt is empty.");
	const { models, choice } = await (command.kind === "serve" ||
		(command.kind === "run" && command.options.print === undefined) ||
		(prompt !== undefined && isOperatingSystemQuestion(prompt))
		? createOwnerModels
		: createConfiguredModels)(
		runtime.env,
		options.model ?? (runtime.env.UNIT_001_MODEL || (await readDefaultModel(directory))),
		credentialStore(directory, runtime),
	);

	const terminal = terminalFor(runtime);
	if (choice === null)
		terminal.err(
			`No model provider is configured. Mission drafting and memory remain available. Run ${runtime.managed === undefined ? "" : "sudo "}${runtime.managed?.name ?? "agent"} setup to connect a provider, then restart the owner. Mission formation uses the default session.\n`,
		);

	const release = await acquireSessionLock(`${file}.lock`);
	let agent: Agent | undefined;
	try {
		agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(file),
				name: runtime.managed?.name ?? "agent",
				models,
				model: choice,
				mission:
					runtime.managed === undefined
						? { kind: "developer-local", directory, session: options.session }
						: { kind: "managed", installationId: runtime.managed.id, session: options.session },
				cwd: runtime.cwd,
				platform: runtime.platform,
				startup: { kind: options.inhibited ? "inhibited" : "active" },
				onReport: (report) => terminal.err(describeReport(report)),
			},
			BACKGROUND_CONTEXT,
		);
		const opened = agent;
		if (endpoint !== undefined) {
			await runService(
				opened,
				endpoint,
				await version(),
				terminal.err,
				signal,
				runtime.managed?.id ?? null,
				runtime.managed === undefined ? undefined : operatorEndpoint(runtime.managed.id, options.session),
			);
			return 0;
		}
		signal.addEventListener("abort", () => void opened.abort(BACKGROUND_CONTEXT).catch(() => {}), { once: true });
		if (prompt !== undefined) return await runPrint(agent, prompt, terminal, signal);
		const rich = richTerminalFor(runtime);
		return rich === undefined
			? await runRepl(agent, terminal, signal)
			: await runRichForeground(agent, options.session, await version(), rich, signal, {
					colorMode: runtime.env.NO_COLOR === undefined ? "color" : "monochrome",
					missionSetup: (flowSignal) =>
						runMissionSetup(
							terminalFor(runtime),
							opened.name,
							(request) => opened.mission(request, BACKGROUND_CONTEXT),
							flowSignal,
							runtime.env.NO_COLOR === undefined && runtime.env.TERM !== "dumb",
						),
				});
	} finally {
		try {
			if (command.kind === "serve") await agent?.close(BACKGROUND_CONTEXT);
			else await agent?.close(BACKGROUND_CONTEXT).catch(() => {});
		} finally {
			await release();
		}
	}
}

async function control(
	command: Extract<
		Command,
		{
			kind:
				| "send"
				| "service-status"
				| "cancel"
				| "attach"
				| "maintenance-enter"
				| "maintenance-release"
				| "memory"
				| "mission";
		}
	>,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
	if (command.kind === "attach" && !runtime.interactive)
		throw new UsageError(
			`Interactive attach requires a terminal. Use ${runtime.managed?.name ?? "agent"} send for scripts and pipes.`,
		);
	const endpoint =
		runtime.managed?.access === "operator"
			? operatorEndpoint(runtime.managed.id, command.options.session)
			: serviceEndpoint(
					resolveDirectory(command.options.dataDir, runtime),
					command.options.session,
					runtime.platform,
				);
	if (command.kind === "mission") {
		const request = async (request: MissionRequest): Promise<MissionView> => {
			const response = await requestService(endpoint, { type: "mission", request }, signal);
			if (response.type === "error") throw new ConfigurationError(response.message);
			if (response.type !== "mission") throw new Error("Unexpected mission response.");
			return response.result;
		};
		const input = command.command;
		if (input.action === "setup")
			return runMissionSetup(
				terminalFor(runtime),
				runtime.managed?.name ?? "agent",
				request,
				signal,
				runtime.env.NO_COLOR === undefined && runtime.env.TERM !== "dumb",
			);
		let operation: MissionRequest;
		if (input.action === "draft" || input.action === "creator") {
			const path = resolve(runtime.cwd, input.file);
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 32768)
				throw new UsageError("Mission input must be a regular file of at most 32 KiB.");
			const data: unknown = JSON.parse(await readFile(path, "utf8"));
			if (input.action === "draft")
				operation = {
					operation: "draft",
					expectedRevision: input.revision,
					requestId: input.requestId,
					terms: parseMissionDraftTerms(data),
				};
			else {
				const authority = missionObject(data);
				operation = {
					operation: "configure-local",
					creator: parseMissionCreator(authority.creator),
					ceiling: parseMissionCeiling(authority.ceiling),
				};
			}
		} else if (input.action === "propose")
			operation = { operation: "propose", expectedRevision: input.revision, requestId: input.requestId };
		else if (input.action === "approve")
			operation = {
				operation: "approve-local",
				expectedRevision: input.revision,
				requestId: input.requestId,
				digest: input.digest,
			};
		else operation = { operation: "status" };
		const view = await request(operation);
		runtime.stdout.write(`${input.json ? JSON.stringify(view) : describeMission(view)}\n`);
		return 0;
	}
	if (command.kind === "attach") {
		const terminal = command.options.plain ? undefined : richTerminalFor(runtime);
		if (terminal === undefined) return runAttach(endpoint, terminalFor(runtime), signal);
		return runRichAttach(endpoint, terminal, signal, {
			colorMode: runtime.env.NO_COLOR === undefined ? "color" : "monochrome",
			missionSetup: (flowSignal) =>
				runMissionSetup(
					terminalFor(runtime),
					runtime.managed?.name ?? "agent",
					async (request) => {
						const response = await requestService(endpoint, { type: "mission", request }, flowSignal);
						if (response.type === "error") throw new ConfigurationError(response.message);
						if (response.type !== "mission") throw new Error("Unexpected mission response.");
						return response.result;
					},
					flowSignal,
					runtime.env.NO_COLOR === undefined && runtime.env.TERM !== "dumb",
				),
			...(runtime.managed === undefined
				? {}
				: {
						name: runtime.managed.name,
						unavailableHint: `Configure: sudo ${runtime.managed.name} setup\nStart: sudo ${runtime.managed.name} start\nOpen: ${runtime.managed.access === "operator" ? "" : "sudo "}${runtime.managed.name}`,
					}),
		});
	}
	if (command.kind === "memory") {
		let request: MemoryRequest;
		if (command.request.operation === "confirm-forget") {
			if (!command.yes) {
				if (!runtime.interactive)
					throw new UsageError("Memory forget requires an interactive confirmation or --yes.");
				const readline = createInterface({ input: runtime.stdin, output: runtime.stdout });
				try {
					const answer = await readline.question(
						`Forget ${sanitizeTerminalText(command.request.id)}? Conversation history remains. [y/N] `,
						{ signal },
					);
					if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
						runtime.stdout.write("Forget cancelled.\n");
						return 0;
					}
				} finally {
					readline.close();
				}
			}
			request = {
				operation: "forget",
				id: command.request.id,
				requestId: command.request.requestId,
				confirmed: true,
			};
		} else request = command.request;
		const response = await requestService(endpoint, { type: "memory", request }, signal);
		if (response.type === "error") {
			runtime.stderr.write(`${response.message}\n`);
			return 1;
		}
		if (response.type !== "memory") throw new Error("Unexpected memory response.");
		runtime.stdout.write(`${describeMemory(response.result)}\n`);
		return 0;
	}
	const request: ServiceRequest | MaintenanceRequest =
		command.kind === "maintenance-enter"
			? { type: command.kind, operationId: command.operationId, timeoutMs: command.timeoutMs }
			: command.kind === "maintenance-release"
				? { type: command.kind, operationId: command.operationId }
				: command.kind === "send"
					? {
							type: "send",
							prompt: command.prompt,
							...(command.requestId === undefined ? {} : { requestId: command.requestId }),
						}
					: { type: command.kind === "cancel" ? "cancel" : "status" };
	const response = await requestService(endpoint, request, signal);
	if (response.type === "error") {
		runtime.stderr.write(`${response.message}\n`);
		return 1;
	}
	if (response.type === "reply") {
		if (response.reply.status === "failed") {
			runtime.stderr.write(
				`unanswered: ${response.reply.reason}${response.reply.detail === undefined ? "" : ` (${response.reply.detail})`}\n`,
			);
			return 1;
		}
		runtime.stdout.write(response.reply.text.endsWith("\n") ? response.reply.text : `${response.reply.text}\n`);
	} else {
		runtime.stdout.write(`${JSON.stringify(response)}\n`);
	}
	return 0;
}

/**
 * Runs the CLI and returns its exit code: 0 on success, 1 on a failed run or a configuration problem, 2 on a usage
 * error, and 130 when interrupted. Service shutdown returns 0 and preserves unfinished work.
 */
export async function main(argv: readonly string[], runtime: Runtime, signal: AbortSignal): Promise<number> {
	let serving = false;
	let foreground = false;
	try {
		if (["start", "stop", "kill", "uninstall", "rename"].includes(argv[0] ?? ""))
			throw new ConfigurationError("Lifecycle commands require an installed named agent command.");
		const command = parseArguments(argv);
		serving = command.kind === "serve";
		foreground = command.kind === "run" && command.options.print === undefined && runtime.interactive;
		if (signal.aborted) return serving ? 0 : 130;
		if (command.kind === "help") {
			const usage =
				runtime.managed?.access === "operator"
					? USAGE.replace("show how each provider is configured", "inspect the running service")
					: USAGE;
			runtime.stdout.write(`${usage.replaceAll(/\bagent\b/g, runtime.managed?.name ?? "agent")}\n`);
			if (runtime.managed !== undefined)
				runtime.stdout.write(
					`\nInstalled lifecycle: sudo ${runtime.managed.name} start|stop|kill|uninstall|rename <name>\nActions ask for confirmation; use --yes for automation (sudo authorization still applies).\n`,
				);
			if (runtime.managed?.access === "operator")
				runtime.stdout.write(
					`Authorized operator clients use the running owner's socket. Setup, sign-in and access changes require sudo.\nUse sudo ${runtime.managed.name} status for the provider-configuration summary.\n`,
				);
			return 0;
		}
		if (command.kind === "version") {
			runtime.stdout.write(`${await version()}\n`);
			return 0;
		}
		if (runtime.managed?.access === "operator") {
			if (command.kind === "status") {
				if (command.dataDir !== undefined)
					throw new UsageError("Operator clients cannot change their data directory.");
				return control({ kind: "service-status", options: { session: "default" } }, runtime, signal);
			}
			if (
				command.kind !== "attach" &&
				command.kind !== "send" &&
				command.kind !== "cancel" &&
				command.kind !== "service-status" &&
				command.kind !== "memory" &&
				command.kind !== "mission" &&
				!(command.kind === "run" && argv.length === 0 && runtime.interactive)
			)
				throw new ConfigurationError("This operation requires the administrator command.");
			if (
				command.kind === "mission" &&
				(command.command.action === "creator" || command.command.action === "approve")
			)
				throw new ConfigurationError("Mission creator and approval changes require the administrator command.");
			if (command.kind !== "run" && command.options.dataDir !== undefined)
				throw new UsageError("Operator clients cannot change their data directory.");
		}
		let code: number;
		if (command.kind === "setup") code = await setup(command, runtime, signal);
		else if (command.kind === "run" && argv.length === 0 && runtime.managed !== undefined && runtime.interactive) {
			// The normal installed entry is a client; explicit foreground flags retain their existing owner semantics.
			try {
				code = await control({ kind: "attach", options: { session: command.options.session } }, runtime, signal);
			} catch (error) {
				if (!(error instanceof ConfigurationError)) throw error;
				throw new ConfigurationError(
					`Cannot connect to ${runtime.managed.name}. Run sudo ${runtime.managed.name} setup or sudo ${runtime.managed.name} start, then try again.`,
				);
			}
		} else if (command.kind === "run" || command.kind === "serve") code = await run(command, runtime, signal);
		else if (
			command.kind === "send" ||
			command.kind === "service-status" ||
			command.kind === "cancel" ||
			command.kind === "attach" ||
			command.kind === "maintenance-enter" ||
			command.kind === "maintenance-release" ||
			command.kind === "memory" ||
			command.kind === "mission"
		)
			code = await control(command, runtime, signal);
		else code = await account(command, runtime, signal);
		return signal.aborted && !serving ? 130 : code;
	} catch (error) {
		if (signal.aborted && !serving) return 130;
		if (error instanceof UsageError) {
			const local = resolveLocalCommand(argv.join(" "), "cli");
			let suggestions = local.kind === "suggestions" ? local.commands : [];
			if (local.kind === "unresolved" && argv.length > 0 && !argv[0].startsWith("-")) {
				// An unresolved invocation may ask an existing owner; it never opens a provider or owner of its own.
				try {
					const endpoint =
						runtime.managed?.access === "operator"
							? operatorEndpoint(runtime.managed.id, "default")
							: serviceEndpoint(resolveDirectory(undefined, runtime), "default", runtime.platform);
					const response = await requestService(
						endpoint,
						{ type: "resolve-command", input: argv[0].slice(0, 256), surface: "cli" },
						signal,
					);
					if (response.type === "command-suggestions")
						suggestions = commandCatalog("cli").filter((command) =>
							response.result.commandIds.includes(command.id),
						);
				} catch {
					/* Ordinary usage remains available when no owner can interpret the command. */
				}
			}
			runtime.stderr.write(
				`${runtime.managed?.name ?? "agent"}: ${error.message.replaceAll("Usage: agent", `Usage: ${runtime.managed?.name ?? "agent"}`)}\nRun ${runtime.managed?.name ?? "agent"} --help for usage.\n`,
			);
			if (suggestions.length > 0)
				runtime.stderr.write(`${sanitizeTerminalText(describeCommandSuggestions(suggestions, "cli"))}\n`);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		runtime.stderr.write(
			error instanceof ConfigurationError ? `${message}\n` : `${runtime.managed?.name ?? "agent"}: ${message}\n`,
		);
		if (foreground && error instanceof ConfigurationError)
			runtime.stderr.write(
				`Run ${runtime.managed === undefined ? "" : "sudo "}${runtime.managed?.name ?? "agent"} setup to review provider and model settings.\n`,
			);
		return 1;
	}
}
