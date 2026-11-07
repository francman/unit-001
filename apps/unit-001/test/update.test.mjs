// Exercises root policy, deferred downloads, independent locking, and hostile archive rejection offline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { accountFor, withManagementLock, writeInstallation } from "../deploy/installation.mjs";
import { extractUpdateArchive, runUpdate } from "../deploy/update.mjs";
import { updatePaths } from "../deploy/update-activation.mjs";
import { writeReleaseArchive, writeReleaseChecksums } from "../scripts/build-release.mjs";
import { generateRepositoryKeys } from "../scripts/update-repository.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const compatibility = { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 };

function fixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "unit-update-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const record = {
		schemaVersion: 1,
		id: ID,
		name: "bob",
		account: accountFor(ID),
		releaseVersion: "0.0.1",
		desiredState: "running",
	};
	writeInstallation(record, root);
	const installed = join(root, "opt/unit-001/releases/0.0.1");
	mkdirSync(installed, { recursive: true });
	writeFileSync(join(installed, "release.json"), JSON.stringify({ compatibility }));
	const paths = updatePaths(ID, root);
	const keys = join(root, "keys");
	generateRepositoryKeys(keys);
	const token = join(root, "token-source");
	writeFileSync(token, "fixture-token", { mode: 0o600 });
	const calls = [];
	const context = {
		root,
		run: async (command, args) => {
			calls.push([command, args]);
			return "";
		},
		control: async () => ({ version: "0.0.1" }),
	};
	const run = (args, extra = {}) => runUpdate([...args, "--id", ID], { ...context, ...extra });
	const configure = () => run(["configure", "--root-file", join(keys, "root.json"), "--token-file", token]);
	return { root, record, paths, keys, token, calls, context, run, configure };
}

function bundle(f, version = "0.0.2", format) {
	const name = `unit-001-${version}-linux-x64`;
	const source = join(f.root, `source-${version}-${format ?? "default"}`);
	const directory = join(source, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "VERSION"), `${version}\n`);
	writeFileSync(
		join(directory, "release.json"),
		JSON.stringify({
			version,
			platform: "linux-x64",
			source: { commit: "a".repeat(40), dirty: false },
			compatibility,
		}),
	);
	writeFileSync(join(directory, "empty"), "");
	const longPath = join(directory, "long".repeat(28), "unicode-λ.txt");
	mkdirSync(dirname(longPath), { recursive: true });
	writeFileSync(longPath, "long path evidence");
	writeReleaseChecksums(directory);
	const archive = join(f.root, `${version}-${format ?? "default"}.tar.gz`);
	if (format)
		execFileSync("tar", [`--format=${format}`, "--no-xattrs", "-czf", archive, "-C", source, name], {
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
	else writeReleaseArchive(source, name, archive);
	return { version, archivePath: archive, sourceCommit: "a".repeat(40), compatibility };
}

function supplied(candidate, onFetch) {
	return async (options, context) => {
		await onFetch?.(options, context);
		return context.acceptCandidate(candidate) ? candidate : null;
	};
}

// #18: the independent updater must actually run through the managed current-core symlink.
test("help is offline and executes through a symlinked parent", async (t) => {
	const f = fixture(t);
	assert.equal((await runUpdate(["--help"], {})).status, "help");
	symlinkSync(resolve("apps/unit-001/deploy"), join(f.root, "current"));
	const text = execFileSync(process.execPath, [join(f.root, "current/update.mjs"), "--help"], { encoding: "utf8" });
	assert.match(text, /Usage: update/);
});

test("configuration protects credentials, defaults disabled, and status never exposes token", async (t) => {
	const f = fixture(t);
	assert.deepEqual(await f.configure(), { status: "configured", enabled: false, pin: null });
	assert.equal(statSync(f.paths.token).mode & 0o777, 0o600);
	assert.equal(statSync(f.paths.config).mode & 0o777, 0o600);
	const status = await f.run(["status"]);
	assert.equal(status.configured, true);
	assert.equal(status.runningVersion, "0.0.1");
	assert(!JSON.stringify(status).includes("fixture-token"));
	assert(f.calls.some(([, args]) => args[0] === "disable"));
	rmSync(f.paths.token);
	assert.equal((await f.run(["status"])).configuration, "invalid");
});

test("#18 public configuration checks updates without any token file or user credentials", async (t) => {
	const f = fixture(t);
	await f.run(["configure", "--root-file", join(f.keys, "root.json")]);
	assert.equal(existsSync(f.paths.token), false);
	const status = await f.run(["status"]);
	assert.equal(status.configured, true);
	assert.equal(status.policy.repository, "francman/unit-001-releases");
	let fetched = false;
	const result = await f.run(["check"], {
		fetchCandidate: async (options, context) => {
			assert.equal(options.repository, "francman/unit-001-releases");
			assert.equal(Object.hasOwn(options, "tokenFile"), false);
			fetched = true;
			context.acceptCandidate({ version: "0.0.2", compatibility });
			return null;
		},
	});
	assert.equal(fetched, true);
	assert.equal(result.status, "available");
});

test("configure refuses writable inputs, token symlinks, and replacement bootstrap roots", async (t) => {
	const f = fixture(t);
	chmodSync(f.token, 0o666);
	await assert.rejects(f.configure(), /private/);
	chmodSync(f.token, 0o600);
	await f.configure();
	const other = join(f.root, "other-keys");
	generateRepositoryKeys(other);
	await assert.rejects(
		f.run(["configure", "--root-file", join(other, "root.json"), "--token-file", f.token]),
		/Preserve/,
	);
	const link = join(f.root, "token-link");
	symlinkSync(f.token, link);
	await assert.rejects(
		f.run(["configure", "--root-file", join(f.keys, "root.json"), "--token-file", link]),
		/private|regular/,
	);
});

test("disabled auto and stopped intent never contact the update feed", async (t) => {
	const f = fixture(t);
	await f.configure();
	const fetchCandidate = () => {
		throw new Error("network must not run");
	};
	assert.equal((await f.run(["auto"], { fetchCandidate })).status, "disabled");
	await f.run(["enable"]);
	writeInstallation({ ...f.record, desiredState: "stopped" }, f.root);
	assert.equal((await f.run(["auto"], { fetchCandidate })).status, "deferred");
	writeInstallation({ ...f.record, desiredState: "uninstalled" }, f.root);
	await assert.rejects(f.run(["apply"], { fetchCandidate }), /uninstalled/);
});

test("check, current, pin, incompatible, and downgrade policies avoid archive admission", async (t) => {
	const f = fixture(t);
	await f.configure();
	const candidate = { version: "0.0.2", compatibility };
	let admitted = false;
	const fetchCandidate = async (_options, context) => {
		admitted = context.acceptCandidate(candidate);
		return null;
	};
	assert.equal((await f.run(["check"], { fetchCandidate })).status, "available");
	assert(!admitted);
	candidate.version = "0.0.1";
	assert.equal((await f.run(["apply"], { fetchCandidate })).status, "current");
	assert(!admitted);
	candidate.version = "0.0.2";
	await f.run(["pin", "0.0.1"]);
	assert.equal((await f.run(["apply"], { fetchCandidate })).status, "pinned");
	assert(!admitted);
	await f.run(["unpin"]);
	candidate.compatibility = { ...compatibility, stateVersion: 2 };
	assert.equal((await f.run(["apply"], { fetchCandidate })).status, "incompatible");
	assert(!admitted);
	candidate.compatibility = compatibility;
	candidate.version = "0.0.0";
	assert.equal((await f.run(["apply"], { fetchCandidate })).status, "held");
	assert(!admitted);
});

test("fetch leaves management lock free while independent lock serializes cache users", async (t) => {
	const f = fixture(t);
	await f.configure();
	const result = await f.run(["check"], {
		fetchCandidate: async (_options, context) => {
			await withManagementLock(async () => {}, f.root);
			const second = new DatabaseSync(join(f.paths.cache, "updater.lock"), { timeout: 0 });
			try {
				assert.throws(() => second.exec("BEGIN EXCLUSIVE"), /locked/);
			} finally {
				second.close();
			}
			context.acceptCandidate({ version: "0.0.2", compatibility });
			return null;
		},
	});
	assert.equal(result.status, "available");
	const reopened = new DatabaseSync(join(f.paths.cache, "updater.lock"));
	reopened.exec("BEGIN EXCLUSIVE");
	reopened.close();
});

test("verified apply checks manifest and provenance, and preserves last success across later checks", async (t) => {
	const f = fixture(t);
	await f.configure();
	const candidate = bundle(f);
	let activations = 0;
	const activate = async (record, candidate, context) => {
		assert.equal(context.admit(record, candidate), null);
		activations++;
		return { status: "updated", version: candidate.version };
	};
	assert.equal((await f.run([], { fetchCandidate: supplied(candidate), activate })).status, "updated");
	assert.equal(activations, 1);
	await f.run(["check"], { fetchCandidate: supplied({ version: "0.0.3", compatibility }) });
	let status = await f.run(["status"]);
	assert.equal(status.lastSuccessfulUpdate.version, "0.0.2");
	assert.equal(status.offeredVersion, "0.0.3");
	await assert.rejects(
		f.run(["check"], {
			fetchCandidate: () => {
				throw new Error("offline");
			},
		}),
		/offline/,
	);
	status = await f.run(["status"]);
	assert.equal(status.lastSuccessfulUpdate.version, "0.0.2");
	assert.equal(status.lastCheck.status, "failed");
	assert(existsSync(candidate.archivePath));
});

test("policy changed during download blocks activation under its final admission callback", async (t) => {
	const f = fixture(t);
	await f.configure();
	const candidate = bundle(f);
	const activate = async (record, candidate, context) => {
		const config = JSON.parse(readFileSync(f.paths.config));
		config.pin = "0.0.1";
		writeFileSync(f.paths.config, JSON.stringify(config));
		return context.admit(record, candidate);
	};
	assert.equal((await f.run(["apply"], { fetchCandidate: supplied(candidate), activate })).status, "deferred");
});

test("recover --start is explicit and independent of update credentials", async (t) => {
	const f = fixture(t);
	let requested;
	await f.run(["recover", "--start"], {
		recover: async (_record, _context, options) => {
			requested = options;
			return { status: "recovered" };
		},
	});
	assert.deepEqual(requested, { phase: "all", start: true });
	await assert.rejects(f.run(["apply", "--start"]), /only accepted/);
	await assert.rejects(f.run(["recover", "--phase", "invalid"]), /Invalid recovery/);
});

test("old baseline is held before archive download and candidate provenance cannot be substituted", async (t) => {
	const f = fixture(t);
	await f.configure();
	const baseline = join(f.root, "opt/unit-001/releases/0.0.1/release.json");
	rmSync(baseline);
	let admitted;
	assert.equal(
		(
			await f.run(["apply"], {
				fetchCandidate: async (_options, context) => {
					admitted = context.acceptCandidate({ version: "0.0.2", compatibility });
					return null;
				},
			})
		).status,
		"incompatible",
	);
	assert.equal(admitted, false);
	writeFileSync(baseline, JSON.stringify({ compatibility }));
	const candidate = bundle(f);
	await assert.rejects(
		f.run(["apply"], {
			fetchCandidate: supplied({ ...candidate, sourceCommit: "b".repeat(40) }),
			activate: () => {
				throw new Error("activation must not run");
			},
		}),
		/provenance/,
	);
	const source = join(f.root, "source-0.0.2-default"),
		name = "unit-001-0.0.2-linux-x64";
	writeFileSync(join(source, name, "empty"), "tampered after checksumming");
	writeReleaseArchive(source, name, candidate.archivePath);
	await assert.rejects(
		f.run(["apply"], {
			fetchCandidate: supplied(candidate),
			activate: () => {
				throw new Error("activation must not run");
			},
		}),
		/checksum/,
	);
});

test("actual archive writer and PAX/GNU long paths extract including empty files", async (t) => {
	const f = fixture(t);
	const gnu = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("bsdtar") ? "gnutar" : "gnu";
	for (const format of [undefined, "pax", gnu]) {
		const candidate = bundle(f, "0.0.2", format);
		const destination = mkdtempSync(join(f.root, "extract-"));
		const directory = await extractUpdateArchive(candidate.archivePath, destination, candidate.version);
		assert.equal(readFileSync(join(directory, "empty")).length, 0);
		assert.equal(readFileSync(join(directory, "long".repeat(28), "unicode-λ.txt"), "utf8"), "long path evidence");
	}
});

function tarEntry(name, { type = "0", size = 0, link = "", data = Buffer.alloc(0) } = {}) {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100);
	header.write("0000644\0", 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.fill(32, 148, 156);
	header.write(type, 156);
	header.write(link, 157, 100);
	header.write("ustar\0", 257);
	header.write("00", 263);
	const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
	return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

test("rejects traversal, links, special files, duplicates, huge declared bodies and truncation", async (t) => {
	const f = fixture(t),
		name = "unit-001-0.0.2-linux-x64";
	const cases = [
		tarEntry(`${name}/../outside`),
		tarEntry(`${name}/link`, { type: "2", link: "/etc" }),
		tarEntry(`${name}/hard`, { type: "1", link: "/etc/passwd" }),
		tarEntry(`${name}/fifo`, { type: "6" }),
		Buffer.concat([tarEntry(`${name}/file`), tarEntry(`${name}/file`)]),
		tarEntry(`${name}/bomb`, { size: 3 * 1024 ** 3 }),
		tarEntry(`${name}/truncated`, { size: 12 }),
	];
	for (let i = 0; i < cases.length; i++) {
		const archive = join(f.root, `hostile-${i}.tgz`);
		writeFileSync(archive, gzipSync(Buffer.concat([cases[i], Buffer.alloc(i === cases.length - 1 ? 0 : 1024)])));
		await assert.rejects(extractUpdateArchive(archive, mkdtempSync(join(f.root, "reject-")), "0.0.2"));
	}
	assert(!existsSync(join(f.root, "outside")));
});

// #18: rollback closes policy admission before waiting for the independent updater lock.
test("rollback pins before contended lock and prevents in-flight and later bad-stable activation", async (t) => {
	const f = fixture(t);
	await f.configure();
	await f.run(["enable"]);
	const old = bundle(f, "0.0.0"),
		target = join(f.root, "source-0.0.0-default/unit-001-0.0.0-linux-x64");
	const releases = join(f.root, "opt/unit-001/releases");
	execFileSync("cp", ["-R", target, join(releases, "0.0.0")]);
	writeFileSync(
		f.paths.journal,
		JSON.stringify({
			schemaVersion: 1,
			id: ID,
			operationId: "fixture",
			phase: "complete",
			previousRecord: { ...f.record, releaseVersion: old.version },
		}),
	);
	const candidate = bundle(f);
	let rollbackRan = false;
	const result = await f.run(["apply"], {
		fetchCandidate: supplied(candidate, async () => {
			const rollback = await f.run(["rollback"], {
				rollback: () => {
					rollbackRan = true;
					throw new Error("lock must defer");
				},
			});
			assert.equal(rollback.status, "deferred");
			assert.equal(rollback.pin, "0.0.0");
		}),
		activate: async (record, candidate, context) => context.admit(record, candidate),
	});
	assert.equal(result.status, "deferred");
	assert.equal(rollbackRan, false);
	const rollback = await f.run(["rollback"], { rollback: async () => ({ status: "updated", version: "0.0.0" }) });
	assert.equal(rollback.pin, "0.0.0");
	assert.equal((await f.run(["auto"], { fetchCandidate: supplied(candidate) })).status, "pinned");
	await assert.rejects(
		f.run(["rollback"], {
			rollback: () => {
				throw new Error("health failed");
			},
		}),
		/0.0.0 remains pinned/,
	);
	assert.equal(JSON.parse(readFileSync(f.paths.config)).pin, "0.0.0");
});
