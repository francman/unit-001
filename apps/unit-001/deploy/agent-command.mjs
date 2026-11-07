// Dispatches a literal installation UUID through its root-owned record; app commands never run as root.
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { assertSafePath, installationPaths, readInstallation, withManagementLock } from "./installation.mjs";
import { lifecycle, recoverRename } from "./lifecycle.mjs";

const ACTIONS = new Set(["start", "stop", "kill", "uninstall", "rename"]);

/** Routes an installed command using trusted records and explicit OS identity checks. */
export async function dispatchAgent(id, expectedName, args, context) {
	const record = await readInstallation(id, context.root);
	const service = expectedName === "--service";
	if (!service && expectedName !== record.name)
		throw new Error("This agent command was renamed; use its current name.");
	const action = args[0];
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
	const appArgs = [app, id, record.name, `/var/lib/unit-001/agents/${id}`, ...(service ? ["serve"] : args)];
	// runuser establishes the recorded account before Node opens config, credentials, sockets or state.
	return context.uid === 0
		? context.run(
				"runuser",
				["-u", record.account, "--", node, ...appArgs],
				false,
				await context.applicationEnvironment(paths.environment),
			)
		: context.execApp(node, appArgs);
}

function run(command, args, capture = false, applicationEnvironment = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env:
				process.geteuid?.() === 0
					? {
							PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
							LANG: process.env.LANG ?? "C.UTF-8",
							TERM: process.env.TERM ?? "dumb",
							...applicationEnvironment,
						}
					: process.env,
			stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
		});
		let output = "";
		if (capture)
			child.stdout.setEncoding("utf8").on("data", (chunk) => {
				output += chunk;
			});
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			code === 0 ? resolve(capture ? output : 0) : reject(new Error(`${command} failed (${signal ?? code}).`)),
		);
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
