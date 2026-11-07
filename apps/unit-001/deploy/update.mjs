#!/usr/bin/env node
// Root-owned update policy and timer entry point; slow verification precedes the activation lock.
import { randomUUID } from "node:crypto";
import {
	closeSync,
	createReadStream,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { Metadata } from "@tufjs/models";
import {
	assertSafePath,
	readInstallation,
	trustedFile,
	trustedParents,
	validateRelease,
	withManagementLock,
} from "./installation.mjs";
import {
	activateUpdate,
	assertUpdateSchedulingOwned,
	createUpdateContext,
	readUpdateJournal,
	recoverUpdate,
	rollbackUpdate,
	updatePaths,
	updateScheduling,
} from "./update-activation.mjs";
import { fetchUpdate } from "./update-trust.mjs";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HELP =
	"Usage: update [apply|check|auto|status|configure|enable|disable|pin VERSION|unpin|rollback|recover] --id UUID\nconfigure --root-file FILE --token-file FILE copies explicit trust/credentials; automatic updates start disabled.\nrecover [--start] --phase prepare|finalize|all; --help requires no configuration or network.\n";

/** Runs operator/timer commands with injectable host boundaries and no model calls. */
export async function runUpdate(args, context = createUpdateContext()) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			id: { type: "string" },
			help: { type: "boolean" },
			"root-file": { type: "string" },
			"token-file": { type: "string" },
			phase: { type: "string" },
			start: { type: "boolean" },
		},
	});
	if (values.help) return { status: "help", text: HELP };
	const command = positionals[0] ?? "apply";
	if (
		![
			"apply",
			"check",
			"auto",
			"status",
			"configure",
			"enable",
			"disable",
			"pin",
			"unpin",
			"rollback",
			"recover",
		].includes(command) ||
		positionals.length > (command === "pin" ? 2 : 1)
	)
		throw new Error("Invalid updater command; use --help.");
	if (command === "pin" && !VERSION.test(positionals[1] ?? ""))
		throw new Error("Pin requires an exact stable version.");
	if (command !== "configure" && (values["root-file"] !== undefined || values["token-file"] !== undefined))
		throw new Error("Trust files are only accepted by configure.");
	if (values.phase !== undefined && command !== "recover") throw new Error("--phase is only accepted by recover.");
	if (values.start && command !== "recover") throw new Error("--start is only accepted by recover.");
	if (values.phase !== undefined && !["prepare", "finalize", "all"].includes(values.phase))
		throw new Error("Invalid recovery phase.");
	if (values.start && values.phase !== undefined && values.phase !== "all")
		throw new Error("Recovery --start requires phase all.");
	const root = context.root ?? "/";
	if (resolve(root) === "/" && (process.getuid?.() !== 0 || process.platform !== "linux" || process.arch !== "x64"))
		throw new Error("Managed updates require Linux x64 root privileges.");
	const record = readInstallation(values.id, root);
	const paths = updatePaths(record.id, root);
	if (command === "recover")
		return (context.recover ?? recoverUpdate)(record, context, {
			phase: values.phase ?? "all",
			start: values.start ?? false,
		});
	if (command === "status") {
		let configuration = existsSync(paths.config) ? "valid" : "missing";
		let policy = null;
		try {
			policy = readConfig(record.id, root);
			if (configuration === "valid") requireConfigured(paths, root);
		} catch {
			configuration = "invalid";
		}
		let runningVersion = null;
		try {
			const status = await context.control(record, ["service-status"]);
			if (VERSION.test(status.version)) runningVersion = status.version;
		} catch {}
		const lastCheck = readLastCheck(paths, root);
		return {
			status: "status",
			installedVersion: record.releaseVersion,
			runningVersion,
			desiredState: record.desiredState,
			configured: configuration === "valid",
			configuration,
			policy,
			journalPhase: readUpdateJournal(record.id, root)?.phase ?? null,
			lastCheck,
			lastSuccessfulUpdate: readLastCheck(paths, root, "last-successful-update.json"),
			offeredVersion: lastCheck?.version ?? null,
			holdReason:
				lastCheck?.reason ??
				(["pinned", "held", "incompatible"].includes(lastCheck?.status) ? lastCheck.status : null),
		};
	}
	if (record.desiredState === "uninstalled")
		throw new Error("This agent is uninstalled; updates cannot reactivate it.");
	if (["configure", "enable", "disable", "pin", "unpin"].includes(command))
		return withManagementLock(async () => {
			const current = readInstallation(record.id, root);
			if (current.desiredState === "uninstalled") throw new Error("This agent is uninstalled.");
			const config = readConfig(record.id, root);
			if (command === "configure") {
				if (values["root-file"] === undefined || values["token-file"] === undefined)
					throw new Error("Configure requires --root-file and --token-file.");
				const trust = inputFile(values["root-file"], 4 * 1024 * 1024);
				const metadata = Metadata.fromJSON("root", JSON.parse(trust));
				metadata.verifyDelegate("root", metadata);
				if (!metadata.signed.consistentSnapshot || metadata.signed.isExpired())
					throw new Error("Bootstrap root is expired or lacks consistent snapshots.");
				const tokenPath = values["token-file"];
				if ((lstatSync(tokenPath).mode & 0o077) !== 0) throw new Error("Token source file must be private.");
				const token = inputFile(tokenPath, 8192).toString().trim();
				if (!/^[A-Za-z0-9_\-.]+$/.test(token)) throw new Error("Invalid repository download token.");
				if (existsSync(paths.trustRoot)) {
					trustedFile(paths.trustRoot, root);
					if (!readFileSync(paths.trustRoot).equals(trust))
						throw new Error("Preserve the existing bootstrap root; rotate trust through signed TUF metadata.");
				}
				protectedDirectory(paths.configDirectory, root, 0o755);
				atomicWrite(paths.trustRoot, trust, root);
				atomicWrite(paths.token, `${token}\n`, root);
			} else if (command !== "disable") requireConfigured(paths, root);
			if (command === "enable") config.enabled = true;
			if (command === "disable") config.enabled = false;
			if (command === "pin") config.pin = positionals[1];
			if (command === "unpin") config.pin = null;
			atomicWrite(paths.config, `${JSON.stringify(config)}\n`, root);
			if (["configure", "enable", "disable"].includes(command)) {
				const schedule = updateScheduling(current, root);
				assertUpdateSchedulingOwned(current, root);
				for (const [path, contents] of [
					[schedule.servicePath, schedule.serviceContents],
					[schedule.timerPath, schedule.timerContents],
				])
					atomicWrite(path, contents, root, 0o644);
				await context.run("systemctl", ["daemon-reload"]);
				await context.run("systemctl", [config.enabled ? "enable" : "disable", "--now", schedule.timerName]);
			}
			return { status: "configured", enabled: config.enabled, pin: config.pin };
		}, root);
	let rollbackPin;
	if (command === "rollback") {
		rollbackPin = await withManagementLock(async () => {
			const journal = readUpdateJournal(record.id, root);
			const current = readInstallation(record.id, root);
			if (current.desiredState === "uninstalled") throw new Error("This agent is uninstalled.");
			if (!journal || journal.phase !== "complete" || !VERSION.test(journal.previousRecord?.releaseVersion ?? ""))
				throw new Error("No completed update is available for rollback.");
			const version = journal.previousRecord.releaseVersion;
			const release = join(resolve(root), "opt/unit-001/releases", version);
			if (validateRelease(release, root).version !== version) throw new Error("Rollback release metadata mismatch.");
			const policy = readConfig(record.id, root);
			atomicWrite(paths.config, `${JSON.stringify({ ...policy, pin: version })}\n`, root);
			return version;
		}, root);
	}
	const policy = readConfig(record.id, root);
	if (command === "auto" && !policy.enabled) return { status: "disabled" };
	if (command !== "check" && record.desiredState !== "running")
		return { status: "deferred", reason: "Operator intent is stopped." };
	if (command !== "rollback") requireConfigured(paths, root);
	protectedDirectory(paths.cache, root);
	const lockPath = join(paths.cache, "updater.lock");
	assertSafePath(lockPath, root);
	if (existsSync(lockPath)) trustedFile(lockPath, root);
	const lock = new DatabaseSync(lockPath, { timeout: 0 });
	try {
		try {
			lock.exec("BEGIN EXCLUSIVE");
		} catch {
			return {
				status: "deferred",
				reason: "Another update check is running.",
				...(rollbackPin === undefined ? {} : { pin: rollbackPin }),
			};
		}
		if (command === "rollback") {
			const result = { ...(await (context.rollback ?? rollbackUpdate)(record, context)), pin: rollbackPin };
			recordCheck(paths, result, root);
			return result;
		}
		let result = { status: "current", version: record.releaseVersion };
		const candidate = await (context.fetchCandidate ?? fetchUpdate)(
			{
				metadataDir: join(paths.cache, "metadata"),
				bootstrapRoot: paths.trustRoot,
				tokenFile: paths.token,
				downloadDir: join(paths.cache, "downloads"),
			},
			{
				fetch: context.fetch ?? globalThis.fetch,
				ownerUid: resolve(root) === "/" ? 0 : process.getuid(),
				platform: "linux",
				arch: "x64",
				acceptCandidate(descriptor) {
					result = candidatePolicy(descriptor, policy, record.releaseVersion);
					if (result.status === "available" && !compatibleBaseline(record, root))
						result = {
							status: "incompatible",
							version: descriptor.version,
							reason: "Install the maintenance-capable baseline manually.",
						};
					return command !== "check" && result.status === "available";
				},
			},
		);
		if (candidate !== null) {
			const extract = mkdtempSync(join(paths.cache, ".extract-"));
			try {
				const releasePath = await extractUpdateArchive(candidate.archivePath, extract, candidate.version);
				if (validateRelease(releasePath, root).version !== candidate.version)
					throw new Error("Archive version does not match signed target.");
				const metadata = JSON.parse(readFileSync(join(releasePath, "release.json")));
				if (
					metadata.version !== candidate.version ||
					metadata.platform !== "linux-x64" ||
					metadata.source?.commit !== candidate.sourceCommit ||
					metadata.source?.dirty !== false ||
					["stateVersion", "minReaderVersion", "maintenanceProtocol"].some(
						(key) => metadata.compatibility?.[key] !== candidate.compatibility[key],
					)
				)
					throw new Error("Archive provenance or compatibility differs from signed descriptor.");
				result = await (context.activate ?? activateUpdate)(
					record,
					{ ...candidate, releasePath },
					{
						...context,
						admit(current) {
							const latest = readConfig(record.id, root);
							if (JSON.stringify(latest) !== JSON.stringify(policy))
								return { status: "deferred", reason: "Update policy changed during verification; retry." };
							const eligible = candidatePolicy(candidate, latest, current.releaseVersion);
							return eligible.status === "available" ? null : eligible;
						},
					},
				);
			} finally {
				rmSync(extract, { recursive: true, force: true });
				const download = relative(join(paths.cache, "downloads"), candidate.archivePath);
				if (download !== "" && !download.startsWith("..") && !download.startsWith("/"))
					rmSync(dirname(candidate.archivePath), { recursive: true, force: true });
			}
		}
		recordCheck(paths, result, root);
		return result;
	} catch (error) {
		const failure =
			rollbackPin === undefined
				? error
				: new Error(`Rollback failed; version ${rollbackPin} remains pinned. ${error.message}`, { cause: error });
		atomicWrite(
			join(paths.configDirectory, "last-check.json"),
			`${JSON.stringify({ at: new Date().toISOString(), status: "failed", reason: failure.message.slice(0, 2000) })}\n`,
			root,
		);
		throw failure;
	} finally {
		lock.close();
	}
}

function inputFile(path, max) {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || info.size > max)
		throw new Error("Expected a bounded protected regular input file.");
	return readFileSync(path);
}

function protectedDirectory(path, root, mode = 0o700) {
	assertSafePath(path, root);
	mkdirSync(path, { recursive: true, mode });
	trustedParents(join(path, ".check"), root);
}

function recordCheck(paths, result, root) {
	const data = `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`;
	atomicWrite(join(paths.configDirectory, "last-check.json"), data, root);
	if (result.status === "updated") atomicWrite(join(paths.configDirectory, "last-successful-update.json"), data, root);
}

function atomicWrite(path, data, root, mode = 0o600) {
	assertSafePath(path, root);
	if (existsSync(path)) trustedFile(path, root);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	trustedParents(path, root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", mode);
	try {
		writeFileSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function readConfig(id, root) {
	const defaults = {
		schemaVersion: 1,
		id,
		enabled: false,
		pin: null,
		repository: "francman/unit-001",
		channel: "stable",
	};
	const path = updatePaths(id, root).config;
	if (!existsSync(path)) {
		assertSafePath(path, root);
		return defaults;
	}
	trustedFile(path, root);
	if (lstatSync(path).size > 8192) throw new Error("Update configuration is too large.");
	const value = JSON.parse(readFileSync(path));
	if (
		value.schemaVersion !== 1 ||
		value.id !== id ||
		typeof value.enabled !== "boolean" ||
		(value.pin !== null && !VERSION.test(value.pin)) ||
		value.repository !== defaults.repository ||
		value.channel !== "stable" ||
		Object.keys(value).some((key) => !Object.hasOwn(defaults, key))
	)
		throw new Error("Unsupported update configuration.");
	return value;
}

function requireConfigured(paths, root) {
	for (const file of [paths.config, paths.trustRoot, paths.token]) trustedFile(file, root);
	if ((lstatSync(paths.token).mode & 0o077) !== 0) throw new Error("Download credential is not private.");
}

function readLastCheck(paths, root, filename = "last-check.json") {
	const path = join(paths.configDirectory, filename);
	if (!existsSync(path)) {
		assertSafePath(path, root);
		return null;
	}
	trustedFile(path, root);
	if (lstatSync(path).size > 8192) throw new Error("Update status is too large.");
	return JSON.parse(readFileSync(path));
}

function candidatePolicy(candidate, policy, current) {
	if (candidate.version === current) return { status: "current", version: current };
	if (policy.pin !== null && candidate.version !== policy.pin)
		return { status: "pinned", version: candidate.version, pin: policy.pin };
	const parts = candidate.version.split(".").map(Number);
	const installed = current.split(".").map(Number);
	if (
		!VERSION.test(current) ||
		!parts.some(
			(value, i) => value > installed[i] && parts.slice(0, i).every((part, index) => part === installed[index]),
		)
	)
		return { status: "held", reason: "Automatic downgrade is not allowed.", version: candidate.version };
	if (
		candidate.compatibility?.stateVersion !== 1 ||
		candidate.compatibility.minReaderVersion !== 1 ||
		candidate.compatibility.maintenanceProtocol !== 1
	)
		return { status: "incompatible", version: candidate.version };
	return { status: "available", version: candidate.version };
}

function compatibleBaseline(record, root) {
	const path = join(resolve(root), "opt/unit-001/releases", record.releaseVersion, "release.json");
	assertSafePath(path, root);
	if (!existsSync(path)) return false;
	trustedFile(path, root);
	if (lstatSync(path).size > 65536) throw new Error("Installed release metadata is too large.");
	const compatibility = JSON.parse(readFileSync(path)).compatibility;
	return (
		compatibility?.stateVersion === 1 &&
		compatibility.minReaderVersion === 1 &&
		compatibility.maintenanceProtocol === 1
	);
}

/** Streams a bounded regular-file tar archive into a fresh protected directory without following archive links. */
export async function extractUpdateArchive(archive, destination, version) {
	if (!VERSION.test(version)) throw new Error("Invalid archive version.");
	const directory = lstatSync(destination);
	if (
		!directory.isDirectory() ||
		directory.isSymbolicLink() ||
		directory.uid !== process.getuid() ||
		(directory.mode & 0o022) !== 0 ||
		realpathSync(destination) !== resolve(destination) ||
		readdirSync(destination).length !== 0
	)
		throw new Error("Extraction requires a fresh protected directory without symlink ancestry.");
	for (let path = resolve(destination); ; path = dirname(path)) {
		const info = lstatSync(path);
		if (
			(info.uid !== 0 && info.uid !== process.getuid()) ||
			((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))
		)
			throw new Error("Extraction ancestry is writable by another user.");
		if (dirname(path) === path) break;
	}
	const rootName = `unit-001-${version}-linux-x64`;
	const seen = new Set();
	let buffer = Buffer.alloc(0),
		body = null,
		padding = 0,
		expanded = 0,
		zeros = 0,
		pendingName;
	const source = createReadStream(archive);
	const unzip = createGunzip();
	source.on("error", (error) => unzip.destroy(error));
	source.pipe(unzip);
	try {
		for await (const chunk of unzip) {
			expanded += chunk.length;
			if (expanded > 2 * 1024 ** 3) throw new Error("Expanded release exceeds 2 GiB.");
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length > 0) {
				if (body !== null) {
					const count = Math.min(body.remaining, buffer.length);
					if (body.fd !== undefined) {
						let offset = 0;
						while (offset < count) offset += writeSync(body.fd, buffer, offset, count - offset);
					} else body.chunks.push(buffer.subarray(0, count));
					body.remaining -= count;
					buffer = buffer.subarray(count);
					if (body.remaining > 0) break;
					if (body.fd !== undefined) closeSync(body.fd);
					else {
						const text = Buffer.concat(body.chunks).toString("utf8");
						if (body.type === "L") pendingName = text.replace(/\0.*$/s, "");
						else {
							let rest = text;
							while (rest.length > 0) {
								const space = rest.indexOf(" "),
									length = Number(rest.slice(0, space));
								if (!Number.isSafeInteger(length) || length < space + 3 || length > Buffer.byteLength(rest))
									throw new Error("Invalid PAX record.");
								const bytes = Buffer.from(rest),
									record = bytes.subarray(space + 1, length).toString("utf8");
								if (!record.endsWith("\n")) throw new Error("Invalid PAX record terminator.");
								if (record.startsWith("path=")) pendingName = record.slice(5, -1);
								if (record.startsWith("linkpath=")) throw new Error("Archive links are forbidden.");
								rest = bytes.subarray(length).toString("utf8");
							}
						}
					}
					body = null;
				}
				if (padding > 0) {
					const count = Math.min(padding, buffer.length);
					padding -= count;
					buffer = buffer.subarray(count);
					if (padding > 0) break;
				}
				if (buffer.length < 512) break;
				const header = buffer.subarray(0, 512);
				buffer = buffer.subarray(512);
				if (header.every((byte) => byte === 0)) {
					zeros++;
					continue;
				}
				if (zeros > 0) throw new Error("Data after archive terminator.");
				const field = (start, length) =>
					header
						.subarray(start, start + length)
						.toString("utf8")
						.replace(/\0.*$/s, "");
				const octal = (start, length) => {
					const text = field(start, length).trim();
					if (!/^[0-7]+$/.test(text)) throw new Error("Unsupported tar number.");
					const number = Number.parseInt(text, 8);
					if (!Number.isSafeInteger(number)) throw new Error("Tar number too large.");
					return number;
				};
				const checksum = [...header].reduce(
					(sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
					0,
				);
				if (octal(148, 8) !== checksum) throw new Error("Tar header checksum mismatch.");
				const size = octal(124, 12),
					type = field(156, 1) || "0";
				padding = (512 - (size % 512)) % 512;
				if (size > 2 * 1024 ** 3 || expanded + size > 2 * 1024 ** 3)
					throw new Error("Expanded release exceeds 2 GiB.");
				if (["L", "x"].includes(type)) {
					if (size > 65536 || pendingName !== undefined) throw new Error("Invalid extended tar header.");
					body = { remaining: size, type, chunks: [] };
					continue;
				}
				if (!["0", "5"].includes(type) || field(157, 100) !== "")
					throw new Error("Archive links and special files are forbidden.");
				let name = pendingName ?? `${field(345, 155) ? `${field(345, 155)}/` : ""}${field(0, 100)}`;
				pendingName = undefined;
				if (name.endsWith("/")) name = name.slice(0, -1);
				if (
					name.length > 4096 ||
					/[\x00-\x1f\x7f\\]/.test(name) ||
					name.split("/").some((part) => part === "" || part === "." || part === "..") ||
					(name !== rootName && !name.startsWith(`${rootName}/`)) ||
					seen.has(name) ||
					seen.size >= 100000
				)
					throw new Error(`Unsafe or duplicate archive path: ${JSON.stringify(name)}.`);
				seen.add(name);
				const path = join(destination, name);
				if (type === "5") {
					if (size !== 0) throw new Error("Nonempty directory entry.");
					mkdirSync(path, { recursive: true, mode: 0o755 });
				} else {
					mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
					body = { remaining: size, fd: openSync(path, "wx", octal(100, 8) & 0o111 ? 0o755 : 0o644) };
				}
			}
		}
		if (body !== null || padding !== 0 || buffer.some((byte) => byte !== 0) || zeros < 2 || pendingName !== undefined)
			throw new Error("Truncated release archive.");
		return join(destination, rootName);
	} finally {
		if (body?.fd !== undefined) closeSync(body.fd);
		source.destroy();
		unzip.destroy();
	}
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	try {
		const result = await runUpdate(process.argv.slice(2));
		process.stdout.write(result.status === "help" ? result.text : `${JSON.stringify(result)}\n`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
