// Dispatches a literal installation UUID through its root-owned record; app commands never run as root.
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { assertSafePath, installationPaths, readInstallation, withManagementLock } from "./installation.mjs";
import { lifecycle, recoverRename } from "./lifecycle.mjs";
import { readUpdateJournal, updatePaths } from "./update-activation.mjs";

const ACTIONS = new Set(["start", "stop", "kill", "uninstall", "rename"]);

/** Routes an installed command using trusted records and explicit OS identity checks. */
export async function dispatchAgent(id, expectedName, args, context) {
	const record = await readInstallation(id, context.root);
	const service = expectedName === "--service";
	if (!service && expectedName !== record.name)
		throw new Error("This agent command was renamed; use its current name.");
	const action = args[0];
	if (!service && action === "setup") {
		if (context.uid !== 0)
			throw new Error(`Run sudo ${record.name} setup; this command does not elevate itself.`);
		if (args.length !== 1) throw new Error("Invalid setup arguments.");
		if (context.interactive !== true) throw new Error("Setup requires an interactive terminal.");
		// Update rollback can restore account state, so configuration writes must share its full transaction lock.
		return withManagementLock(async () => {
			const current = await readInstallation(id, context.root);
			if (current.name !== expectedName)
				throw new Error("The installation name changed; retry its current command.");
			const journal = readUpdateJournal(id, context.root);
			if (journal && journal.phase !== "complete")
				throw new Error(`Run sudo ${current.name} update recover before setup; an update is incomplete.`);
			await recoverRename(current, context.root);
			return dispatchApplication(current, expectedName, args, context);
		}, context.root);
	}
	if (!service && ["maintenance-enter", "maintenance-release"].includes(action))
		throw new Error("Managed maintenance controls belong to the independent updater.");
	if (!service && action === "update") {
		if (context.uid !== 0) throw new Error("Update commands require root; this command does not elevate itself.");
		const core = updatePaths(id, context.root).currentCore;
		return context.run(join(core, "runtime/bin/node"), [join(core, "lib/update.mjs"), "--id", id, ...args.slice(1)]);
	}
	if (!service && ACTIONS.has(action)) {
		if (context.uid !== 0)
			throw new Error(`Run sudo ${record.name} ${action}; this command does not elevate itself.`);
		const yes = args.includes("--yes");
		const rest = args.slice(1).filter((arg) => arg !== "--yes");
		if (action === "rename" ? rest.length !== 1 : rest.length !== 0) throw new Error(`Invalid ${action} arguments.`);
		if (!yes && !(await context.confirm(`${action} ${record.name}? [y/N] `)))
			throw new Error("Action cancelled; use --yes for noninteractive confirmation.");
		await withManagementLock(async () => {
			const current = await readInstallation(id, context.root);
			if (current.name !== expectedName)
				throw new Error("The installation name changed; retry its current command.");
			await recoverRename(current, context.root);
			await lifecycle(current, action, context, rest[0]);
		}, context.root);
		return 0;
	}
	return dispatchApplication(record, expectedName, args, context);
}

async function dispatchApplication(record, expectedName, args, context) {
	const id = record.id;
	const service = expectedName === "--service";
	const action = args[0];
	if (record.desiredState === "uninstalled") throw new Error("This agent is uninstalled.");
	const account = await context.account(record.account);
	if (
		service &&
		(args.length !== 0 || context.uid !== account.uid || context.uid === 0 || record.desiredState !== "running")
	)
		throw new Error("Service startup requires the installation account and running operator intent.");
	if (context.uid !== 0 && context.uid !== account.uid)
		throw new Error("Run this command as root or the installation account.");
	const paths = installationPaths(id, context.root);
	const release = await context.release(paths.current);
	const node = join(release, "runtime/bin/node");
	const app = join(release, "app/dist/named.js");
	const journal = service ? readUpdateJournal(id, context.root) : null;
	const appArgs = [
		app,
		id,
		record.name,
		`/var/lib/unit-001/agents/${id}`,
		...(service ? ["serve", ...(journal && journal.phase !== "complete" ? ["--inhibited"] : [])] : args),
	];
	const environment = context.uid === 0 ? await context.applicationEnvironment(paths.environment) : {};
	// runuser establishes the recorded account before Node opens config, credentials, sockets or state.
	let result;
	try {
		result = context.uid === 0
			? await context.run(
				"runuser",
				["-u", record.account, "--", node, ...appArgs],
				false,
				environment,
				...(action === "setup" ? [{ forwardSignals: true }] : []),
			)
			: await context.execApp(node, appArgs);
	} catch (error) {
		if (action === "setup" && Number.isInteger(error.exitCode) && error.exitCode > 0) return error.exitCode;
		throw error;
	}
	if (action !== "setup" || result !== 0) return result;
	if (await context.unitRunning(paths.unit)) {
		context.notice(`Settings are saved. To apply changes, stop and start ${record.name}.\n`);
		return 0;
	}
	const override = environment.UNIT_001_MODEL;
	const prompt = override
		? `Start ${record.name} now using UNIT_001_MODEL (overrides the saved setup model)? [y/N] `
		: `Start ${record.name} now? [y/N] `;
	if (!(await context.confirm(prompt))) return 0;
	await lifecycle(record, "start", context);
	return 0;
}

/** Runs a child with protected environment; setup waits for signalled children before releasing its lock. */
export function run(command, args, capture = false, applicationEnvironment = {}, options = {}) {
	return new Promise((resolve, reject) => {
		let child;
		let interrupted;
		const forward = (signal) => {
			interrupted ??= signal;
			child?.kill(signal);
		};
		const onInterrupt = () => forward("SIGINT");
		const onTerminate = () => forward("SIGTERM");
		const onHangup = () => forward("SIGHUP");
		const cleanup = () => {
			if (!options.forwardSignals) return;
			process.removeListener("SIGINT", onInterrupt);
			process.removeListener("SIGTERM", onTerminate);
			process.removeListener("SIGHUP", onHangup);
		};
		if (options.forwardSignals) {
			process.on("SIGINT", onInterrupt);
			process.on("SIGTERM", onTerminate);
			process.on("SIGHUP", onHangup);
		}
		try {
			child = spawn(command, args, {
				env:
					process.geteuid?.() === 0
						? {
								PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
								LANG: process.env.LANG ?? "C.UTF-8",
								TERM: process.env.TERM ?? "dumb",
								...(process.env.NO_COLOR === undefined ? {} : { NO_COLOR: "1" }),
								...applicationEnvironment,
							}
						: process.env,
				stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
			});
		} catch (error) {
			cleanup();
			reject(error);
			return;
		}
		let output = "";
		if (capture)
			child.stdout.setEncoding("utf8").on("data", (chunk) => {
				output += chunk;
			});
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once(options.forwardSignals ? "close" : "exit", (code, signal) => {
			cleanup();
			if (code === 0 && interrupted === undefined) resolve(capture ? output : 0);
			else
				reject(
					Object.assign(new Error(`${command} failed (${interrupted ?? signal ?? code}).`), {
						exitCode: interrupted === undefined ? code ?? 128 + (constants.signals[signal] ?? 1) : 128 + constants.signals[interrupted],
					}),
				);
		});
	});
}

/** Asks once with default No; nonterminals and EOF never imply consent. */
export async function confirmAction(prompt, input, output) {
	if (input.isTTY !== true || output.isTTY !== true) return false;
	const reader = createInterface({ input, output });
	try {
		const answer = await Promise.race([
			reader.question(prompt),
			new Promise((resolve) => reader.once("close", () => resolve(""))),
		]);
		return /^(y|yes)$/i.test(answer.trim());
	} catch {
		return false;
	} finally {
		reader.close();
	}
}

/** Reads only provider configuration from an administrator-owned dotenv file, without executing shell text. */
export async function configuredEnvironment(path, root = "/") {
	assertSafePath(path, root);
	const info = await lstat(path).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (info === undefined) return {};
	const owner = resolve(root) === "/" ? 0 : process.getuid();
	if (!info.isFile() || info.uid !== owner || (info.mode & 0o022) !== 0)
		throw new Error("Provider environment must be an administrator-owned protected regular file.");
	const values = parseEnv(await readFile(path, "utf8"));
	return Object.fromEntries(
		[
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"ANTHROPIC_AUTH_TOKEN",
			"OPENAI_API_KEY",
			"GEMINI_API_KEY",
			"OPENROUTER_API_KEY",
			"UNIT_001_MODEL",
		]
			.filter((key) => values[key] !== undefined)
			.map((key) => [key, values[key]]),
	);
}

const context = {
	root: "/",
	uid: process.geteuid?.(),
	interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
	run,
	applicationEnvironment: configuredEnvironment,
	execApp(node, args) {
		process.execve(node, [node, ...args], process.env);
		throw new Error("Could not replace the service process.");
	},
	async account(name) {
		const fields = (await run("getent", ["passwd", name], true)).trim().split(":");
		const uid = Number(fields[2]);
		if (fields[0] !== name || !Number.isSafeInteger(uid) || uid <= 0)
			throw new Error("Invalid installation account.");
		return { uid };
	},
	async release(current) {
		return realpath(current);
	},
	async ready(record) {
		const release = await realpath(installationPaths(record.id).current);
		await run(join(release, "runtime/bin/node"), [
			join(release, "deploy/check-ready.mjs"),
			"/",
			record.id,
			record.releaseVersion,
			"30000",
		]);
	},
	async unitRunning(unit) {
		const state = (await run("systemctl", ["show", "--property=ActiveState", "--value", unit], true)).trim();
		return state !== "inactive" && state !== "failed";
	},
	async unitExists(unit) {
		const output = await run("systemctl", ["show", "--property=LoadState", "--value", unit], true);
		return output.trim() !== "not-found";
	},
	confirm: (prompt) => confirmAction(prompt, process.stdin, process.stdout),
	notice: (message) => process.stdout.write(message),
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [id, name, ...args] = process.argv.slice(2);
	try {
		process.exitCode = await dispatchAgent(id, name, args, context);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
