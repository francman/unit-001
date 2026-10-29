import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Report } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "./agent.ts";
import { parseArguments, type RunOptions, USAGE } from "./args.ts";
import { ConfigurationError, UsageError } from "./errors.ts";
import { acquireSessionLock } from "./lock.ts";
import { dataDirectory, sessionFile } from "./paths.ts";
import { createConfiguredModels } from "./provider.ts";
import { runPrint, runRepl, type Terminal } from "./repl.ts";

/** What the CLI reads from its process, so tests can run it against fakes. */
export interface Runtime {
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

async function run(options: RunOptions, runtime: Runtime, signal: AbortSignal): Promise<number> {
	const directory =
		options.dataDir === undefined
			? dataDirectory({ platform: runtime.platform, env: runtime.env, home: runtime.home })
			: resolve(runtime.cwd, options.dataDir);
	const file = sessionFile(directory, options.session, runtime.platform);
	const { models, choice } = await createConfiguredModels(runtime.env, options.model);

	let prompt = options.print;
	if (prompt === "-") prompt = (await readAll(runtime.stdin)).trim();
	if (prompt === "") throw new UsageError("The prompt is empty.");

	const terminal: Terminal = {
		input: runtime.stdin,
		...(runtime.interactive ? { output: runtime.stdout } : {}),
		out: (text) => void runtime.stdout.write(text),
		err: (text) => void runtime.stderr.write(text),
	};

	const release = await acquireSessionLock(`${file}.lock`);
	let agent: Agent | undefined;
	try {
		agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(file),
				models,
				model: choice,
				cwd: runtime.cwd,
				platform: runtime.platform,
				onReport: (report) => terminal.err(describeReport(report)),
			},
			BACKGROUND_CONTEXT,
		);
		const opened = agent;
		signal.addEventListener("abort", () => void opened.abort(BACKGROUND_CONTEXT).catch(() => {}), { once: true });
		return prompt === undefined
			? await runRepl(agent, terminal, signal)
			: await runPrint(agent, prompt, terminal, signal);
	} finally {
		await agent?.close(BACKGROUND_CONTEXT).catch(() => {});
		await release();
	}
}

/**
 * Runs the CLI and returns its exit code: 0 on success, 1 on a failed run or a configuration problem, 2 on a usage
 * error, and 130 when stopped by a signal.
 */
export async function main(argv: readonly string[], runtime: Runtime, signal: AbortSignal): Promise<number> {
	try {
		const command = parseArguments(argv);
		if (command.kind === "help") {
			runtime.stdout.write(`${USAGE}\n`);
			return 0;
		}
		if (command.kind === "version") {
			runtime.stdout.write(`${await version()}\n`);
			return 0;
		}
		const code = await run(command.options, runtime, signal);
		return signal.aborted ? 130 : code;
	} catch (error) {
		if (signal.aborted) return 130;
		if (error instanceof UsageError) {
			runtime.stderr.write(`unit-001: ${error.message}\nRun u1 --help for usage.\n`);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		runtime.stderr.write(error instanceof ConfigurationError ? `${message}\n` : `unit-001: ${message}\n`);
		return 1;
	}
}
