import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Report } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { Agent } from "./agent.ts";
import { type Command, parseArguments, USAGE } from "./args.ts";
import { runAttach } from "./attach.ts";
import { FileCredentialStore } from "./credentials.ts";
import { ConfigurationError, UsageError } from "./errors.ts";
import { acquireSessionLock } from "./lock.ts";
import { describeStatus, runLogin, runLogout, subscriptionFor } from "./login.ts";
import { credentialsFile, dataDirectory, sessionFile } from "./paths.ts";
import { createConfiguredModels, createModelsFor } from "./provider.ts";
import { runPrint, runRepl, type Terminal } from "./repl.ts";
import {
	type MaintenanceRequest,
	requestService,
	runService,
	type ServiceRequest,
	serviceEndpoint,
} from "./service.ts";
import { runRichAttach } from "./terminal-ui.ts";

/** What the CLI reads from its process, so tests can run it against fakes. */
export interface ManagedIdentity {
	readonly id: string;
	readonly name: string;
	readonly state: string;
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
	const { models, choice } = await createConfiguredModels(
		runtime.env,
		options.model,
		credentialStore(directory, runtime),
	);

	let prompt = command.kind === "run" ? command.options.print : undefined;
	if (prompt === "-") prompt = (await readAll(runtime.stdin)).trim();
	if (prompt === "") throw new UsageError("The prompt is empty.");

	const terminal = terminalFor(runtime);

	const release = await acquireSessionLock(`${file}.lock`);
	let agent: Agent | undefined;
	try {
		agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(file),
				name: runtime.managed?.name ?? "agent",
				models,
				model: choice,
				cwd: runtime.cwd,
				platform: runtime.platform,
				startup: { kind: options.inhibited ? "inhibited" : "active" },
				onReport: (report) => terminal.err(describeReport(report)),
			},
			BACKGROUND_CONTEXT,
		);
		const opened = agent;
		if (endpoint !== undefined) {
			await runService(opened, endpoint, await version(), terminal.err, signal, runtime.managed?.id ?? null);
			return 0;
		}
		signal.addEventListener("abort", () => void opened.abort(BACKGROUND_CONTEXT).catch(() => {}), { once: true });
		return prompt === undefined
			? await runRepl(agent, terminal, signal)
			: await runPrint(agent, prompt, terminal, signal);
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
		{ kind: "send" | "service-status" | "cancel" | "attach" | "maintenance-enter" | "maintenance-release" }
	>,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
	if (command.kind === "attach" && !runtime.interactive)
		throw new UsageError(
			`Interactive attach requires a terminal. Use ${runtime.managed?.name ?? "agent"} send for scripts and pipes.`,
		);
	const endpoint = serviceEndpoint(
		resolveDirectory(command.options.dataDir, runtime),
		command.options.session,
		runtime.platform,
	);
	if (command.kind === "attach") {
		if (command.options.plain || runtime.env.TERM === undefined || runtime.env.TERM === "dumb")
			return runAttach(endpoint, terminalFor(runtime), signal);
		const terminal = new ProcessTerminal();
		if (terminal.columns < 40 || terminal.rows < 12) return runAttach(endpoint, terminalFor(runtime), signal);
		return runRichAttach(endpoint, terminal, signal, {
			colorMode: runtime.env.NO_COLOR === undefined ? "color" : "monochrome",
		});
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
	try {
		if (["start", "stop", "kill", "uninstall", "rename"].includes(argv[0] ?? ""))
			throw new ConfigurationError("Lifecycle commands require an installed named agent command.");
		const command = parseArguments(argv);
		serving = command.kind === "serve";
		if (signal.aborted) return serving ? 0 : 130;
		if (command.kind === "help") {
			runtime.stdout.write(`${USAGE.replaceAll(/\bagent\b/g, runtime.managed?.name ?? "agent")}\n`);
			if (runtime.managed !== undefined)
				runtime.stdout.write(
					`\nInstalled lifecycle: sudo ${runtime.managed.name} start|stop|kill|uninstall|rename <name>\nActions ask for confirmation; use --yes for automation (sudo authorization still applies).\n`,
				);
			return 0;
		}
		if (command.kind === "version") {
			runtime.stdout.write(`${await version()}\n`);
			return 0;
		}
		let code: number;
		if (command.kind === "run" || command.kind === "serve") code = await run(command, runtime, signal);
		else if (
			command.kind === "send" ||
			command.kind === "service-status" ||
			command.kind === "cancel" ||
			command.kind === "attach" ||
			command.kind === "maintenance-enter" ||
			command.kind === "maintenance-release"
		)
			code = await control(command, runtime, signal);
		else code = await account(command, runtime, signal);
		return signal.aborted && !serving ? 130 : code;
	} catch (error) {
		if (signal.aborted && !serving) return 130;
		if (error instanceof UsageError) {
			runtime.stderr.write(
				`${runtime.managed?.name ?? "agent"}: ${error.message.replaceAll("Usage: agent", `Usage: ${runtime.managed?.name ?? "agent"}`)}\nRun ${runtime.managed?.name ?? "agent"} --help for usage.\n`,
			);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		runtime.stderr.write(
			error instanceof ConfigurationError ? `${message}\n` : `${runtime.managed?.name ?? "agent"}: ${message}\n`,
		);
		return 1;
	}
}
