// Applies operator intent to one installation while its caller holds the management lock.
import { lstat, readdir, readFile, readlink, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assertNameAvailable,
	assertSafePath,
	installationPaths,
	listInstallations,
	removeOwnedAgentCommand,
	removeUnusedRelease,
	validateRelease,
	writeAgentCommand,
	writeInstallation,
} from "./installation.mjs";
import {
	assertUpdateCoreOwned,
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
			await restartUpdateScheduling(record, context);
		} catch (error) {
			await writeInstallation({ ...record, desiredState: "stopped" }, root);
			await systemctl("disable", "--now", unit);
			throw error;
		}
		return;
	}
	if (action === "rename") {
		await assertNameAvailable(newName, record.id, root);
		if (newName === record.name) return;
		const updated = { ...record, name: newName };
		// The record decides which wrapper is authoritative even if power fails between these steps.
		const journal = join(paths.config, "rename.json");
		await writeFile(`${journal}.tmp`, JSON.stringify({ oldName: record.name, newName }), { mode: 0o600 });
		await rename(`${journal}.tmp`, journal);
		await writeAgentCommand(updated, root);
		await writeInstallation(updated, root);
		await removeOwnedAgentCommand(record, root);
		await rm(journal, { force: true });
		if (record.desiredState === "running") {
			await systemctl("restart", unit);
			await context.ready(updated);
		}
		return;
	}
	await writeInstallation({ ...record, desiredState: "stopped" }, root);
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
	const release = join(root, "opt/unit-001/releases", record.releaseVersion);
	const releaseInfo = await lstat(release).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (releaseInfo !== undefined && validateRelease(release, root).version !== record.releaseVersion)
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
	const text = await readFile(paths.unitFile, "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (text !== undefined) {
		const template =
			releaseInfo === undefined
				? undefined
				: (await readFile(join(release, "deploy/unit-001.service"), "utf8"))
						.replaceAll("@ID@", record.id)
						.replaceAll("@ACCOUNT@", record.account);
		if (text !== template) throw new Error("Refusing to remove an unowned service unit.");
	}
	const helpers = ["agent-command.mjs", "lifecycle.mjs", "installation.mjs", "update-activation.mjs"];
	for (const file of helpers) {
		const target = join(paths.management, file);
		assertSafePath(target, root);
		const contents = await readFile(target).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (contents === undefined) continue;
		if (releaseInfo === undefined || !contents.equals(await readFile(join(release, "deploy", file))))
			throw new Error(`Preserving unexpected management helper: ${target}`);
	}
	// Complete ownership checks before removing any path used to retry this command.
	assertUpdateCoreOwned(record, root);
	assertUpdateSchedulingOwned(record, root);
	await removeOwnedAgentCommand(record, root);
	if (link !== undefined) await rm(paths.current);
	if (text !== undefined) await rm(paths.unitFile);
	await systemctl("daemon-reload");
	for (const file of helpers) await rm(join(paths.management, file), { force: true });
	removeUpdateCore(record, root);
	removeUpdateScheduling(record, root);
	await systemctl("daemon-reload");
	for (const directory of [paths.management, paths.agentRoot]) {
		const entries = await readdir(directory).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (entries?.length === 0) await rmdir(directory);
	}
	await removeUnusedRelease(record, root);
	await writeInstallation({ ...record, desiredState: "uninstalled" }, root);
}

/** Completes an interrupted rename using the authoritative installation record. */
export async function recoverRename(record, root) {
	const journal = join(installationPaths(record.id, root).config, "rename.json");
	const text = await readFile(journal, "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (text === undefined) return;
	const pending = JSON.parse(text);
	if (typeof pending.oldName !== "string" || typeof pending.newName !== "string")
		throw new Error("Invalid rename journal.");
	const staleName = record.name === pending.newName ? pending.oldName : pending.newName;
	await removeOwnedAgentCommand({ ...record, name: staleName }, root);
	await rm(journal);
}
