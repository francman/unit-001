import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Report } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { Agent } from "./agent.ts";
import { type Command, parseArguments, type ServiceOptions, USAGE } from "./args.ts";
import { runServiceAttach } from "./attach.ts";
import { commandCatalog } from "./commands/catalog.ts";
import { isOperatingSystemQuestion, OS_INSPECTION_PROMPT } from "./commands/facts.ts";
import { describeCommandSuggestions, resolveLocalCommand } from "./commands/resolution.ts";
import { FileCredentialStore } from "./credentials.ts";
import { createDraftStore, type DraftStore } from "./draft-store.ts";
import { ConfigurationError, describeError, UsageError } from "./errors.ts";
import { describeInspection } from "./introspection/command.ts";
import { acquireSessionLock } from "./lock.ts";
import { describeStatus, runLogin, runLogout, subscriptionFor } from "./login.ts";
import { describeMemory, type MemoryRequest } from "./memory-control.ts";
import { parseMissionCeiling } from "./missions/authority.ts";
import { describeMission, type MissionCommand } from "./missions/command.ts";
import { parsePurposeCeiling, parsePurposeTerms } from "./missions/purpose-authority.ts";
import {
	type MissionRequest,
	type MissionView,
	missionObject,
	parseMissionCreator,
	parseMissionDraftTerms,
} from "./missions/contract.ts";
import { describeMissionRefusal } from "./missions/refusal.ts";
import { runMissionSetup } from "./missions/setup.ts";
import { credentialsFile, dataDirectory, sessionFile } from "./paths.ts";
import { createConfiguredModels, createModelsFor, createOwnerModels } from "./provider.ts";
import { runRemoteCommand } from "./remote/cli.ts";
import { sanitizeTerminalText } from "./render.ts";
import { runPrint, runRepl } from "./repl.ts";
import {
	type MaintenanceRequest,
	operatorEndpoint,
	requestService,
	runService,
	type ServiceRequest,
	serviceEndpoint,
} from "./service.ts";
import { localServiceClient } from "./service-client.ts";
import { readDefaultModel, saveDefaultModel } from "./settings.ts";
import { runSetup } from "./setup.ts";
import type { TerminalIO } from "./terminal-io.ts";
import { runRichAttach, runRichForeground } from "./terminal-ui.ts";
import { runWebWorkspace } from "./web/launcher.ts";

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
	return `[report] ${report.kind}${report.error instanceof Error ? `: ${report.error.message}` : ""}\n`;
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

/**
 * Drafts are client-side state under the invoking OS user's data directory, never the installation's. The managed
 * administrator path runs as the service account, whose home is the installation's state the agent can read, so it
 * keeps no drafts.
 */
export function draftsFor(runtime: Runtime, installationId: string, session: string): DraftStore | undefined {
	if (runtime.managed !== undefined && runtime.managed.access !== "operator") return undefined;
	return createDraftStore({
		directory: join(dataDirectory({ platform: runtime.platform, env: runtime.env, home: runtime.home }), "drafts"),
		installationId,
		session,
	});
}

/** Colour is on unless NO_COLOR is set or the terminal is dumb. */
function colorEnabled(runtime: Runtime): boolean {
	return runtime.env.NO_COLOR === undefined && runtime.env.TERM !== "dumb";
}

function colorModeFor(runtime: Runtime): "color" | "monochrome" {
	return colorEnabled(runtime) ? "color" : "monochrome";
}

function terminalFor(runtime: Runtime): TerminalIO {
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
			color: colorEnabled(runtime),
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
	const endpoint = command.kind === "serve" ? serviceEndpoint(directory, options.session, runtime.platform) : undefined;
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

	const appVersion = await version();
	const release = await acquireSessionLock(`${file}.lock`);
	let agent: Agent | undefined;
	try {
		agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(file),
				name: runtime.managed?.name ?? "agent",
				version: appVersion,
				models,
				model: choice,
				channelCredentialsDirectory: join(directory, "channels"),
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
		if (endpoint !== undefined) {
			await runService(
				agent,
				endpoint,
				appVersion,
				terminal.err,
				signal,
				runtime.managed?.id ?? null,
				runtime.managed === undefined ? undefined : operatorEndpoint(runtime.managed.id, options.session),
			);
			return 0;
		}
		const opened = agent;
		signal.addEventListener("abort", () => void opened.abort(BACKGROUND_CONTEXT).catch(() => {}), { once: true });
		if (prompt !== undefined) return await runPrint(agent, prompt, terminal, signal);
		const rich = richTerminalFor(runtime);
		return rich === undefined
			? await runRepl(agent, terminal, signal)
			: await runRichForeground(agent, options.session, appVersion, rich, signal, {
					colorMode: colorModeFor(runtime),
					drafts: draftsFor(runtime, runtime.managed?.id ?? `local:${directory}`, options.session),
					missionSetup: (flowSignal) =>
						runMissionSetup(
							terminalFor(runtime),
							opened.name,
							(request) => opened.mission(request, BACKGROUND_CONTEXT),
							flowSignal,
							colorEnabled(runtime),
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

/** The commands that talk to a running owner through its socket. */
type ControlCommand = Extract<
	Command,
	{
		kind:
			| "send"
			| "inspect-os"
			| "service-status"
			| "cancel"
			| "attach"
			| "maintenance-enter"
			| "maintenance-release"
			| "memory"
			| "channels"
			| "mission"
			| "inspection";
	}
>;

const CONTROL_KINDS: ReadonlySet<string> = new Set<ControlCommand["kind"]>([
	"send",
	"inspect-os",
	"service-status",
	"cancel",
	"attach",
	"maintenance-enter",
	"maintenance-release",
	"memory",
	"channels",
	"mission",
	"inspection",
]);

function isControlCommand(command: Command): command is ControlCommand {
	return CONTROL_KINDS.has(command.kind);
}

/** The commands an operator client may run; everything else needs the administrator command. */
type OperatorCommand = Extract<
	Command,
	{
		kind:
			| "attach"
			| "send"
			| "inspect-os"
			| "cancel"
			| "service-status"
			| "memory"
			| "channels"
			| "mission"
			| "inspection"
			| "web";
	}
>;

const OPERATOR_KINDS: ReadonlySet<string> = new Set<OperatorCommand["kind"]>([
	"attach",
	"send",
	"inspect-os",
	"cancel",
	"service-status",
	"memory",
	"channels",
	"mission",
	"inspection",
	"web",
]);

function isOperatorCommand(command: Command): command is OperatorCommand {
	return OPERATOR_KINDS.has(command.kind);
}

/** Runs a command against the running owner and returns the exit code. */
async function control(command: ControlCommand, runtime: Runtime, signal: AbortSignal): Promise<number> {
	if (command.kind === "attach" && !runtime.interactive)
		throw new UsageError(
			`Interactive attach requires a terminal. Use ${runtime.managed?.name ?? "agent"} send for scripts and pipes.`,
		);
	const endpoint = ownerEndpoint(command.options, runtime);
	switch (command.kind) {
		case "inspection":
			return controlInspection(command, endpoint, runtime, signal);
		case "channels":
			return controlChannels(endpoint, runtime, signal);
		case "mission":
			return controlMission(command, endpoint, runtime, signal);
		case "attach":
			return controlAttach(command, endpoint, runtime, signal);
		case "memory":
			return controlMemory(command, endpoint, runtime, signal);
		case "inspect-os":
			return controlService(
				{
					kind: "send",
					options: command.options,
					prompt: OS_INSPECTION_PROMPT,
					...(command.requestId === undefined ? {} : { requestId: command.requestId }),
				},
				endpoint,
				runtime,
				signal,
			);
		default:
			return controlService(command, endpoint, runtime, signal);
	}
}

function ownerEndpoint(options: ServiceOptions, runtime: Runtime): string {
	return runtime.managed?.access === "operator"
		? operatorEndpoint(runtime.managed.id, options.session)
		: serviceEndpoint(resolveDirectory(options.dataDir, runtime), options.session, runtime.platform);
}

async function controlInspection(
	command: Extract<ControlCommand, { kind: "inspection" }>,
	endpoint: string,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
	const response = await requestService(endpoint, { type: "inspection", query: command.query }, signal);
	if (response.type === "error") throw new ConfigurationError(response.message);
	if (response.type !== "inspection") throw new Error("Unexpected inspection response.");
	runtime.stdout.write(
		`${command.json ? JSON.stringify(response.report) : sanitizeTerminalText(describeInspection(response.report))}\n`,
	);
	return 0;
}

async function controlChannels(endpoint: string, runtime: Runtime, signal: AbortSignal): Promise<number> {
	const response = await requestService(endpoint, { type: "channels", request: { operation: "status" } }, signal);
	if (response.type === "error") throw new ConfigurationError(response.message);
	if (response.type !== "channels") throw new Error("Unexpected channel response.");
	const result = response.result;
	if (result.operation !== "status") throw new Error("Unexpected channel status operation.");
	const lines = [
		`Available adapters: ${result.view.available.map((adapter) => `${adapter.id} (${adapter.capabilities.join(", ")})`).join("; ") || "none"}`,
		...result.view.channels.map(
			(channel) =>
				`${channel.request.channelId}: ${channel.outcome.kind}${channel.outcome.kind === "awaiting_creator" ? ` (${channel.outcome.step})` : ""}; ${channel.request.adapter} destination ${channel.request.destination}`,
		),
	];
	if (!result.view.channels.length) lines.push("No channels configured.");
	lines.push(`Observed: ${new Date(result.observedAt).toISOString()}`);
	runtime.stdout.write(`${sanitizeTerminalText(lines.join("\n"))}\n`);
	return 0;
}

/** Sends mission requests to the owner; an owner error or refusal becomes a configuration error with its text. */
function missionRequester(
	endpoint: string,
	signal: AbortSignal,
): (request: MissionRequest) => Promise<MissionView> {
	return async (request) => {
		const response = await requestService(endpoint, { type: "mission", request }, signal);
		if (response.type === "error") throw new ConfigurationError(response.message);
		if (response.type === "mission-refused") throw new ConfigurationError(describeMissionRefusal(response.code));
		if (request.operation === "plan-agree" && response.type === "mission-plan-issued")
			throw new ConfigurationError(
				`Plan agreement ${response.receiptId} was issued and is awaiting reconciliation. Retry with the same --request-id. Request ID: ${sanitizeTerminalText(request.requestId)}`,
			);
		if (response.type !== "mission") throw new Error("Unexpected mission response.");
		return response.result;
	};
}

async function controlMission(
	command: Extract<ControlCommand, { kind: "mission" }>,
	endpoint: string,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
	const request = missionRequester(endpoint, signal);
	const input = command.command;
	if (input.action === "setup") return runMissionSetup(...missionSetupArguments(runtime, request, signal));
	const view = await request(await missionOperation(input, request, runtime));
	runtime.stdout.write(`${input.json ? JSON.stringify(view) : describeMission(view)}\n`);
	return 0;
}

/** The arguments `runMissionSetup` takes for this terminal, shared by the setup command and the attach flow. */
function missionSetupArguments(
	runtime: Runtime,
	request: (request: MissionRequest) => Promise<MissionView>,
	signal: AbortSignal,
): Parameters<typeof runMissionSetup> {
	return [
		terminalFor(runtime),
		runtime.managed?.name ?? "agent",
		request,
		signal,
		colorEnabled(runtime),
	];
}

/** Builds the owner request for one non-setup mission action, reading the current revision or a file where needed. */
async function missionOperation(
	input: Exclude<MissionCommand, { action: "setup" }>,
	request: (request: MissionRequest) => Promise<MissionView>,
	runtime: Runtime,
): Promise<MissionRequest> {
	switch (input.action) {
		case "start":
		case "pause":
		case "resume":
		case "stop": {
			const view = await request({ operation: "status" });
			return {
				operation: "control-local",
				action: input.action,
				expectedPolicyRevision: input.policyRevision ?? view.policyRevision ?? view.runtime?.policyRevision ?? 0,
				requestId: input.requestId,
			};
		}
		case "operate": {
			const view = await request({ operation: "status" });
			return {
				operation: "operate-local",
				action: input.operate,
				expectedOperationRevision: input.operationRevision ?? view.purpose?.operationRevision ?? 0,
				requestId: input.requestId,
				...(input.runId === undefined ? {} : { runId: input.runId }),
			};
		}
		case "approve-purpose":
			return {
				operation: "purpose-approve-local",
				revision: input.revision,
				digest: input.digest,
				requestId: input.requestId,
			};
		case "draft":
		case "creator":
		case "purpose": {
			const data = await readMissionFile(input.file, runtime);
			if (input.action === "purpose")
				return {
					operation: "purpose-propose",
					expectedRevision: input.revision,
					requestId: input.requestId,
					terms: parsePurposeTerms(data),
				};
			if (input.action === "draft")
				return {
					operation: "draft",
					expectedRevision: input.revision,
					requestId: input.requestId,
					terms: parseMissionDraftTerms(data),
				};
			const authority = missionObject(data);
			return {
				operation: "configure-local",
				creator: parseMissionCreator(authority.creator),
				ceiling: parseMissionCeiling(authority.ceiling),
				...(authority.purposeCeiling === undefined
					? {}
					: { purposeCeiling: parsePurposeCeiling(authority.purposeCeiling) }),
			};
		}
		case "propose":
			return { operation: "propose", expectedRevision: input.revision, requestId: input.requestId };
		case "approve":
			return {
				operation: "approve-local",
				expectedRevision: input.revision,
				requestId: input.requestId,
				digest: input.digest,
			};
		case "plan-approve":
			if (runtime.managed !== undefined)
				throw new ConfigurationError(`Run sudo ${runtime.managed.name} mission plan approve as the configured creator.`);
			return { operation: "plan-agree", revision: input.revision, digest: input.digest, requestId: input.requestId };
		default:
			return { operation: "status" };
	}
}

async function readMissionFile(file: string, runtime: Runtime): Promise<unknown> {
	const path = resolve(runtime.cwd, file);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
		throw new UsageError("Mission input must be a regular file of at most 64 KiB.");
	return JSON.parse(await readFile(path, "utf8"));
}

async function controlAttach(
	command: Extract<ControlCommand, { kind: "attach" }>,
	endpoint: string,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
	const terminal = command.options.plain ? undefined : richTerminalFor(runtime);
	if (terminal === undefined) return runServiceAttach(localServiceClient(endpoint), terminalFor(runtime), signal);
	return runRichAttach(endpoint, terminal, signal, {
		colorMode: colorModeFor(runtime),
		drafts: draftsFor(
			runtime,
			runtime.managed?.id ?? `local:${resolveDirectory(command.options.dataDir, runtime)}`,
			command.options.session,
		),
		missionSetup: (flowSignal) =>
			runMissionSetup(...missionSetupArguments(runtime, missionRequester(endpoint, flowSignal), flowSignal)),
		...(runtime.managed === undefined
			? {}
			: {
					name: runtime.managed.name,
					unavailableHint: `Configure: sudo ${runtime.managed.name} setup\nStart: sudo ${runtime.managed.name} start\nOpen: ${runtime.managed.access === "operator" ? "" : "sudo "}${runtime.managed.name}`,
				}),
	});
}

async function controlMemory(
	command: Extract<ControlCommand, { kind: "memory" }>,
	endpoint: string,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
	let request: MemoryRequest;
	if (command.request.operation === "confirm-forget") {
		if (!command.yes) {
			if (!runtime.interactive) throw new UsageError("Memory forget requires an interactive confirmation or --yes.");
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

/** Sends one prompt, status, cancel or maintenance request and prints the owner's reply. */
async function controlService(
	command: Extract<
		ControlCommand,
		{ kind: "send" | "service-status" | "cancel" | "maintenance-enter" | "maintenance-release" }
	>,
	endpoint: string,
	runtime: Runtime,
	signal: AbortSignal,
): Promise<number> {
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
		if (command.kind === "remote")
			return await runRemoteCommand(
				command.command,
				{
					directory: join(
						dataDirectory({ platform: runtime.platform, env: runtime.env, home: runtime.home }),
						"remotes",
					),
					terminal: terminalFor(runtime),
					richTerminal: richTerminalFor(runtime),
					colorMode: colorModeFor(runtime),
				},
				signal,
			);
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
				if (command.dataDir !== undefined) throw new UsageError("Operator clients cannot change their data directory.");
				return control({ kind: "service-status", options: { session: "default" } }, runtime, signal);
			}
			if (isOperatorCommand(command)) {
				if (command.options.dataDir !== undefined)
					throw new UsageError("Operator clients cannot change their data directory.");
			} else if (!(command.kind === "run" && argv.length === 0 && runtime.interactive))
				throw new ConfigurationError("This operation requires the administrator command.");
		}
		let code: number;
		if (command.kind === "web") {
			if (!runtime.interactive)
				throw new UsageError("The web workspace requires an operator terminal.");
			if (runtime.managed !== undefined && runtime.managed.access !== "operator")
				throw new ConfigurationError("Run the web command as an authorized operator without sudo.");
			const endpoint =
				runtime.managed === undefined
					? serviceEndpoint(
							resolveDirectory(command.options.dataDir, runtime),
							command.options.session,
							runtime.platform,
						)
					: operatorEndpoint(runtime.managed.id, command.options.session);
			const write = (text: string) => void runtime.stdout.write(text);
			code = await runWebWorkspace(
				endpoint,
				command.port,
				write,
				signal,
				runtime.managed?.id,
				runtime.managed === undefined ? resolveDirectory(command.options.dataDir, runtime) : undefined,
			);
		} else if (command.kind === "setup") code = await setup(command, runtime, signal);
		else if (command.kind === "run" && argv.length === 0 && runtime.managed !== undefined && runtime.interactive) {
			// The normal installed entry is a client; explicit foreground flags still run an owner in this process (owner decision pending).
			try {
				code = await control({ kind: "attach", options: { session: command.options.session } }, runtime, signal);
			} catch (error) {
				if (!(error instanceof ConfigurationError)) throw error;
				throw new ConfigurationError(
					`Cannot connect to ${runtime.managed.name}. Run sudo ${runtime.managed.name} setup or sudo ${runtime.managed.name} start, then try again.`,
				);
			}
		} else if (command.kind === "run" || command.kind === "serve") code = await run(command, runtime, signal);
		else if (isControlCommand(command)) code = await control(command, runtime, signal);
		else code = await account(command, runtime, signal);
		return signal.aborted && !serving ? 130 : code;
	} catch (error) {
		if (signal.aborted && !serving) return 130;
		if (error instanceof UsageError) {
			const local = resolveLocalCommand(argv.join(" "), "cli");
			let suggestions = local.kind === "suggestions" ? local.commands : [];
			if (
				local.kind === "unresolved" &&
				argv.length > 0 &&
				!argv[0].startsWith("-") &&
				!argv.some((argument) => /^(?:--session|--data-dir)(?:=|$)/.test(argument))
			) {
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
						suggestions = commandCatalog("cli").filter((command) => response.result.commandIds.includes(command.id));
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
		const message = describeError(error);
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
