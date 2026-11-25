// Applies operator intent to one installation while its caller holds the management lock.
import { lstat, readdir, readFile, readlink, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assertAgentCommandOwned,
	assertNameAvailable,
	assertSafePath,
	assertWebActivationOwned,
	installationPaths,
	listInstallations,
	ownedServiceUnit,
	removeOwnedAgentCommand,
	removeUnusedRelease,
	removeWebActivation,
	validateRelease,
	writeAgentCommand,
	writeInstallation,
} from "./installation.mjs";
import {
	assertUpdateCoreOwned,
	assertUpdateLauncherOwned,
	assertUpdateSchedulingOwned,
	readUpdateJournal,
	removeUpdateCore,
	removeUpdateScheduling,
	restartUpdateScheduling,
} from "./update-activation.mjs";

/** Changes only the selected installation's known units, wrapper and root-owned software. */
export async function lifecycle(record, action, context, newName) {
	const { root, run } = context;
	const paths = installationPaths(record.id, root);
	const unit = paths.unit;
	if (record.desiredState === "uninstalled" && action !== "uninstall")
		throw new Error("This installation is uninstalled; install it again first.");
	const systemctl = (...args) => run("systemctl", args);
	if (action === "start") {
		const journal = readUpdateJournal(record.id, root);
		if (journal && journal.phase !== "complete")
			throw new Error(
				`Run sudo ${record.name} update recover --start to recover the pending update and explicitly start this agent.`,
			);
		await writeInstallation({ ...record, desiredState: "running" }, root);
		try {
			const state = await run("systemctl", ["show", "--property=ActiveState", "--value", unit], true);
			// Failed units retain crash-loop limits; cold inactive units may be unloaded before reset-failed runs.
			if (state.trim() === "failed") await systemctl("reset-failed", unit);
			await systemctl("enable", "--now", unit);
			await context.ready(record);
		} catch (error) {
			await writeInstallation({ ...record, desiredState: "stopped" }, root);
			await systemctl("disable", "--now", unit);
			throw error;
		}
		try {
			await restartUpdateScheduling(record, context);
		} catch (error) {
			const warning = `Agent is running, but automatic update scheduling failed: ${error.message}. Inspect sudo ${record.name} update status.`;
			if (context.warn) context.warn(warning);
			else process.stderr.write(`${warning}\n`);
		}
		return;
	}
	if (action === "rename") {
		await assertNameAvailable(newName, record.id, root);
		const updated = { ...record, name: newName };
		const journal = renameJournal(paths);
		if (newName !== record.name) {
			// The record decides which wrapper is authoritative even if power fails between these steps.
			await writeRenameJournal(journal, { oldName: record.name, newName });
			await writeAgentCommand(updated, root);
			await writeInstallation(updated, root);
			await removeOwnedAgentCommand(record, root);
			if (record.desiredState === "running") await writeRenameJournal(journal, { newName });
		} else {
			const pending = await lstat(journal).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
			if (pending === undefined) return;
		}
		// The journal outlives a failed restart, so retrying the same name restarts the owner under it.
		if (record.desiredState === "running") {
			await systemctl("restart", unit);
			await context.ready(updated);
		}
		await rm(journal, { force: true });
		return;
	}
	const owned = action === "uninstall" ? await uninstallOwnership(record, paths, root) : undefined;
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
	// A previous uninstall may have deleted unit files before its daemon reload failed.
	if (owned?.unitFile === false) await systemctl("daemon-reload");
	const installedUnit = await context.unitExists(unit);
	if (installedUnit) await systemctl("disable", unit);
	for (const updater of [paths.updaterTimer, paths.updaterService, paths.updaterRecovery]) {
		const exists = await context.unitExists(updater);
		if (exists) await systemctl("disable", "--now", updater);
	}
	if (installedUnit && action === "kill") {
		// Queue a stop first: systemd will not apply Restart=always to our subsequent cgroup kill.
		await systemctl("stop", "--no-block", unit);
		try {
			await systemctl("kill", "--kill-whom=all", "--signal=SIGKILL", unit);
		} catch (error) {
			// A fast graceful stop can empty the cgroup before kill reaches systemd.
			if (await context.unitRunning(unit)) throw error;
		}
		await systemctl("stop", unit);
	} else if (installedUnit) await systemctl("stop", unit);
	if (action !== "uninstall") return;
	// Keep the named dispatcher's wrapper, runtime and helpers through systemd teardown.
	await removeWebActivation(record, context);
	if (owned.unitFile) await rm(paths.unitFile);
	await systemctl("daemon-reload");
	removeUpdateCore(record, root);
	removeUpdateScheduling(record, root);
	await systemctl("daemon-reload");
	await removeOwnedAgentCommand(record, root);
	if (owned.link) await rm(paths.current);
	for (const file of MANAGEMENT_HELPERS) await rm(join(paths.management, file), { force: true });
	for (const directory of [paths.management, paths.agentRoot]) {
		const entries = await readdir(directory).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (entries?.length === 0) await rmdir(directory);
	}
	await removeUnusedRelease(record, root);
	await writeInstallation({ ...record, desiredState: "uninstalled" }, root);
}

const MANAGEMENT_HELPERS = ["agent-command.mjs", "lifecycle.mjs", "installation.mjs", "update-activation.mjs"];

// Proves ownership of every file uninstall removes or reads before it changes intent or touches the service manager.
// Only manager state (loaded web units, socket and stop state) is left to removal: the owner stop and reloads change it.
async function uninstallOwnership(record, paths, root) {
	const release = join(root, "opt/unit-001/releases", record.releaseVersion);
	const releaseInfo = await lstat(release).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	const text = await readFile(paths.unitFile, "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (text !== undefined) {
		if (releaseInfo === undefined) throw new Error("Refusing to remove an unowned service unit.");
		// This also verifies the release inventory and version, so the release is hashed once.
		ownedServiceUnit(record, root);
	} else if (releaseInfo !== undefined && validateRelease(release, root).version !== record.releaseVersion)
		throw new Error("Preserving a release with unexpected version metadata.");
	listInstallations(root);
	// Preserved data and accounts never participate in software removal.
	const link = await lstat(paths.current).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (link !== undefined) {
		if (!link.isSymbolicLink()) throw new Error(`Refusing to remove unexpected path: ${paths.current}`);
		if ((await readlink(paths.current)) !== `../../releases/${record.releaseVersion}`)
			throw new Error("Refusing to remove an unexpected release pointer.");
	}
	for (const file of MANAGEMENT_HELPERS) {
		const target = join(paths.management, file);
		assertSafePath(target, root);
		const contents = await readFile(target).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (contents === undefined) continue;
		if (releaseInfo === undefined || !contents.equals(await readFile(join(release, "deploy", file))))
			throw new Error(`Preserving unexpected management helper: ${target}`);
	}
	assertUpdateCoreOwned(record, root);
	assertUpdateLauncherOwned(record, root);
	assertUpdateSchedulingOwned(record, root);
	assertWebActivationOwned(record, root);
	assertAgentCommandOwned(record, root);
	return { unitFile: text !== undefined, link: link !== undefined };
}

/** Completes an interrupted rename using the authoritative installation record. */
export async function recoverRename(record, root) {
	const journal = renameJournal(installationPaths(record.id, root));
	const text = await readFile(journal, "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (text === undefined) return;
	const pending = JSON.parse(text);
	if ((pending.oldName !== undefined && typeof pending.oldName !== "string") || typeof pending.newName !== "string")
		throw new Error("Invalid rename journal.");
	// Without oldName the wrappers already match the record; only the owner restart may remain.
	if (pending.oldName !== undefined) {
		const staleName = record.name === pending.newName ? pending.oldName : pending.newName;
		await removeOwnedAgentCommand({ ...record, name: staleName }, root);
	}
	// A running owner may still report the previous name until a same-name rename restarts it.
	if (record.name === pending.newName && record.desiredState === "running") {
		if (pending.oldName !== undefined) await writeRenameJournal(journal, { newName: pending.newName });
		return;
	}
	await rm(journal);
}

function renameJournal(paths) {
	return join(paths.config, "rename.json");
}

async function writeRenameJournal(journal, pending) {
	await writeFile(`${journal}.tmp`, JSON.stringify(pending), { mode: 0o600 });
	await rename(`${journal}.tmp`, journal);
}
