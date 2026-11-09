#!/usr/bin/env node
// Builds the self-contained Linux x64 unit-001 deployment archive from this checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Metadata } from "@tufjs/models";

export const NODE_RELEASE = {
	version: "24.22.2",
	filename: "node-v24.22.2-linux-x64.tar.gz",
	sha256: "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
};

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const upstreamPackages = ["telemetry", "chord", "tui", "codemode", "ai", "durable"];

/** Rejects a runtime download unless both its pinned and official checksums agree. */
export function verifyNodeDownload(contents, officialChecksums) {
	const expectedLine = `${NODE_RELEASE.sha256}  ${NODE_RELEASE.filename}`;
	if (!officialChecksums.split(/\r?\n/).includes(expectedLine)) {
		throw new Error("The official Node checksum does not match the reviewed runtime pin");
	}
	if (createHash("sha256").update(contents).digest("hex") !== NODE_RELEASE.sha256) {
		throw new Error("The downloaded Node runtime failed SHA256 verification");
	}
}

/** Lists the release's regular files in deterministic order, rejecting unsafe archive entries. */
export function releaseFiles(directory, prefix = "") {
	const files = [];
	for (const name of readdirSync(join(directory, prefix)).sort()) {
		const path = prefix === "" ? name : `${prefix}/${name}`;
		if (/[\r\n\\]/.test(path)) throw new Error(`Unsupported release path: ${path}`);
		const info = lstatSync(join(directory, path));
		if (info.isDirectory()) files.push(...releaseFiles(directory, path));
		else if (info.isFile()) files.push(path);
		else throw new Error(`Release cannot contain symlinks or special files: ${path}`);
	}
	return files;
}

/** Hashes every regular release file except the manifest itself. */
export function writeReleaseChecksums(directory) {
	const entries = releaseFiles(directory).filter((path) => path !== "SHA256SUMS");
	const lines = entries.map(
		(path) =>
			`${createHash("sha256")
				.update(readFileSync(join(directory, path)))
				.digest("hex")}  ./${path}`,
	);
	writeFileSync(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

/** Archives only payload bytes, excluding macOS metadata and AppleDouble companion files. */
export function writeReleaseArchive(directory, releaseName, archive) {
	execFileSync("tar", ["-czf", archive, "--no-xattrs", "-C", directory, releaseName], {
		env: { ...process.env, COPYFILE_DISABLE: "1" },
		stdio: "inherit",
	});
}

/** Rejects external packages whose exact version and integrity were not in the reviewed repository lock. */
export function verifyExternalResolutions(sourceLock, releaseLock, localNames) {
	const allowed = new Set(
		Object.values(sourceLock.packages)
			.filter((pkg) => pkg.integrity !== undefined)
			.map((pkg) => `${pkg.version}:${pkg.integrity}`),
	);
	for (const [path, pkg] of Object.entries(releaseLock.packages)) {
		if (path === "") continue;
		const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
		if (localNames.has(name)) continue;
		if (!allowed.has(`${pkg.version}:${pkg.integrity}`)) {
			throw new Error(`Unreviewed release dependency: ${name}@${pkg.version}; update the repository lock first`);
		}
	}
}

function npm(args, cwd = repository) {
	execFileSync("npm", args, { cwd, stdio: "inherit" });
}

function copyNodeRuntime(stage, scratch) {
	const origin = `https://nodejs.org/dist/v${NODE_RELEASE.version}`;
	const archive = join(scratch, NODE_RELEASE.filename);
	const sums = join(scratch, "NODE-SHASUMS256.txt");
	execFileSync(
		"curl",
		["--fail", "--silent", "--show-error", "--location", `${origin}/${NODE_RELEASE.filename}`, "--output", archive],
		{ stdio: "inherit" },
	);
	execFileSync(
		"curl",
		["--fail", "--silent", "--show-error", "--location", `${origin}/SHASUMS256.txt`, "--output", sums],
		{ stdio: "inherit" },
	);
	verifyNodeDownload(readFileSync(archive), readFileSync(sums, "utf8"));
	execFileSync("tar", ["-xzf", archive, "-C", scratch], { stdio: "inherit" });
	const unpacked = join(scratch, `node-v${NODE_RELEASE.version}-linux-x64`);
	mkdirSync(join(stage, "runtime", "bin"), { recursive: true });
	cpSync(join(unpacked, "bin", "node"), join(stage, "runtime", "bin", "node"));
	cpSync(join(unpacked, "LICENSE"), join(stage, "runtime", "LICENSE"));
	cpSync(sums, join(stage, "runtime", "SHASUMS256.txt"));
}

function packDependencies(app) {
	const vendor = join(app, "vendor");
	mkdirSync(vendor);
	const packages = [];
	for (const name of upstreamPackages) {
		const directory = join(repository, "packages", name);
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", vendor], {
			cwd: directory,
			encoding: "utf8",
		});
		const [packed] = JSON.parse(output);
		packages.push({ manifest, file: `vendor/${packed.filename}`, integrity: packed.integrity });
	}
	return packages;
}

function installDependencies(app, sourceManifest) {
	const packages = packDependencies(app);
	const specifiers = Object.fromEntries(packages.map(({ manifest, file }) => [manifest.name, `file:${file}`]));
	for (const name of Object.keys(sourceManifest.dependencies)) {
		if (name.startsWith("@earendil-works/") && specifiers[name] === undefined)
			throw new Error(`Release packaging has no checkout artifact for ${name}`);
	}
	const manifest = {
		name: sourceManifest.name,
		version: sourceManifest.version,
		private: true,
		type: "module",
		engines: sourceManifest.engines,
		dependencies: Object.fromEntries(
			Object.entries(sourceManifest.dependencies).map(([name, version]) => [name, specifiers[name] ?? version]),
		),
		overrides: specifiers,
	};
	// Keep reviewed external resolutions from the repository lock; replace workspace links with the packed checkout.
	const sourceLock = JSON.parse(readFileSync(join(repository, "package-lock.json"), "utf8"));
	const locked = Object.fromEntries(
		Object.entries(sourceLock.packages).filter(
			([path, value]) => path.startsWith("node_modules/") && value.link !== true,
		),
	);
	for (const { manifest: pkg, file, integrity } of packages) {
		locked[`node_modules/${pkg.name}`] = {
			version: pkg.version,
			resolved: `file:${file}`,
			integrity,
			dependencies: pkg.dependencies ?? {},
			...(pkg.engines === undefined ? {} : { engines: pkg.engines }),
			...(pkg.bin === undefined ? {} : { bin: pkg.bin }),
		};
	}
	writeFileSync(join(app, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	writeFileSync(
		join(app, "package-lock.json"),
		`${JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { "": manifest, ...locked } }, null, "\t")}\n`,
	);
	const flags = ["--ignore-scripts", "--omit=dev", "--os=linux", "--cpu=x64", "--no-audit", "--no-fund"];
	npm(["install", "--package-lock-only", ...flags], app);
	npm(["ci", ...flags], app);
	removeCommandLinks(join(app, "node_modules"));
	const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8"));
	verifyExternalResolutions(sourceLock, lock, new Set(packages.map(({ manifest: pkg }) => pkg.name)));
	for (const { manifest: pkg, file, integrity } of packages) {
		const resolved = lock.packages[`node_modules/${pkg.name}`];
		if (resolved?.resolved !== `file:${file}` || resolved.integrity !== integrity) {
			throw new Error(`${pkg.name} did not resolve from the current checkout artifact`);
		}
	}
	return packages.map(({ manifest: pkg, integrity }) => ({ name: pkg.name, version: pkg.version, integrity }));
}

function removeCommandLinks(directory) {
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (name === ".bin") rmSync(path, { recursive: true, force: true });
		else if (lstatSync(path).isDirectory()) removeCommandLinks(path);
	}
}

/** Writes the identity-free application launcher; installed names belong to the root-owned dispatcher. */
export function writeReleaseLauncher(stage) {
	mkdirSync(join(stage, "bin"));
	writeFileSync(
		join(stage, "bin/agent"),
		'#!/bin/sh\nset -eu\nrelease=$(dirname "$(dirname "$(readlink -f "$0")")")\nexport PATH="$release/runtime/bin:$PATH"\nexec "$release/runtime/bin/node" "$release/app/dist/bin.js" "$@"\n',
		{ mode: 0o755 },
	);
}

/** Bundles only explicitly approved public trust for credential-free release installation. */
export function writeUpdateBootstrap(stage, rootFile) {
	if (rootFile === undefined) return;
	const info = lstatSync(rootFile);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
		throw new Error("Update root must be a bounded regular public metadata file");
	const bytes = readFileSync(rootFile);
	if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(bytes.toString("utf8")))
		throw new Error("Private signing keys must never be bundled");
	const value = JSON.parse(bytes);
	for (const key of Object.values(value.signed?.keys ?? {})) {
		if (
			key.keytype !== "ed25519" ||
			key.scheme !== "ed25519" ||
			Object.keys(key.keyval ?? {}).length !== 1 ||
			!/^[a-f0-9]{64}$/.test(key.keyval?.public)
		)
			throw new Error("Update root must contain public Ed25519 keys only");
	}
	const metadata = Metadata.fromJSON("root", value);
	metadata.verifyDelegate("root", metadata);
	if (!metadata.signed.consistentSnapshot || metadata.signed.isExpired())
		throw new Error("Update root must be unexpired with consistent snapshots");
	mkdirSync(join(stage, "deploy"), { recursive: true });
	writeFileSync(join(stage, "deploy/update-root.json"), bytes, { flag: "wx", mode: 0o644 });
	writeFileSync(
		join(stage, "deploy/update-feed.json"),
		`${JSON.stringify({ schemaVersion: 1, repository: "francman/unit-001-releases", channel: "stable" })}\n`,
		{ flag: "wx", mode: 0o644 },
	);
}

/** Copies the operator documentation, including the setup guide linked by the terminal design. */
export function writeReleaseDocumentation(stage) {
	mkdirSync(join(stage, "docs"));
	for (const name of [
		"deployment.md",
		"operations.md",
		"lightsail.md",
		"terminal.md",
		"terminal-design.md",
		"terminal-assessment-omp.md",
		"terminal-assessment-others.md",
		"setup-experience.md",
		"updates.md",
		"distribution.md",
	]) {
		cpSync(join(repository, "apps/unit-001/docs", name), join(stage, "docs", name));
	}
}

/** Builds the archive without publishing, installing a service, or changing upstream sources. */
export function buildRelease(out, options = {}) {
	const sourceManifest = JSON.parse(readFileSync(join(repository, "apps/unit-001/package.json"), "utf8"));
	if (options.version !== undefined) sourceManifest.version = options.version;
	if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(sourceManifest.version)) throw new Error("Invalid release version");
	const output = resolve(out);
	const releaseName = `unit-001-${sourceManifest.version}-linux-x64`;
	const archive = join(output, `${releaseName}.tar.gz`);
	if (existsSync(archive) || existsSync(`${archive}.sha256`))
		throw new Error(`Release output already exists: ${archive}`);
	mkdirSync(output, { recursive: true });
	const scratch = mkdtempSync(join(output, ".build-"));
	try {
		npm(["run", "hydrate-model-data", "--workspace", "packages/ai"]);
		for (const name of upstreamPackages) {
			npm(["run", name === "ai" ? "build:offline" : "build", "--workspace", `packages/${name}`]);
		}
		npm(["run", "build", "--workspace", "apps/unit-001"]);
		const stage = join(scratch, releaseName);
		const app = join(stage, "app");
		mkdirSync(app, { recursive: true });
		cpSync(join(repository, "apps/unit-001/dist"), join(app, "dist"), { recursive: true });
		cpSync(join(repository, "LICENSE"), join(stage, "LICENSE"));
		const dependencies = installDependencies(app, sourceManifest);
		copyNodeRuntime(stage, scratch);
		cpSync(join(repository, "apps/unit-001/deploy"), join(stage, "deploy"), { recursive: true });
		writeUpdateBootstrap(stage, options.updateRoot);
		writeUpdaterCore(stage);
		writeReleaseDocumentation(stage);
		cpSync(join(stage, "deploy/install.sh"), join(stage, "install.sh"));
		chmodSync(join(stage, "install.sh"), 0o755);
		cpSync(join(repository, "apps/unit-001/scripts/check-vps.sh"), join(stage, "check-vps.sh"));
		chmodSync(join(stage, "check-vps.sh"), 0o755);
		writeReleaseLauncher(stage);
		writeFileSync(join(stage, "VERSION"), `${sourceManifest.version}\n`);
		const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim() !== "";
		const modelManifest = readFileSync(join(repository, "packages/ai/src/providers/data/.manifest.json"));
		writeFileSync(
			join(stage, "release.json"),
			`${JSON.stringify({ version: sourceManifest.version, platform: "linux-x64", node: NODE_RELEASE, source: { commit: source, dirty }, compatibility: JSON.parse(readFileSync(join(stage, "deploy/release-compatibility.json"), "utf8")), modelDataManifestSha256: createHash("sha256").update(modelManifest).digest("hex"), dependencies }, null, "\t")}\n`,
		);
		writeReleaseChecksums(stage);
		execFileSync(process.execPath, [join(app, "dist/bin.js"), "--help"], { cwd: scratch, stdio: "inherit" });
		if (process.platform === "linux" && process.arch === "x64") {
			execFileSync(join(stage, "bin/agent"), ["--version"], { cwd: scratch, stdio: "inherit" });
		}
		writeReleaseArchive(scratch, releaseName, archive);
		writeFileSync(
			`${archive}.sha256`,
			`${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${basename(archive)}\n`,
		);
		console.log(`Release archive: ${archive}`);
		return archive;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Builds an independent management runtime so a broken application cannot disable its updater. */
export function writeUpdaterCore(stage) {
	const updater = join(stage, "updater");
	mkdirSync(join(updater, "node_modules"), { recursive: true });
	cpSync(join(stage, "runtime"), join(updater, "runtime"), { recursive: true });
	cpSync(join(stage, "deploy"), join(updater, "lib"), { recursive: true });
	writeFileSync(join(updater, "package.json"), '{"private":true,"type":"module"}\n');
	const appModules = realpathSync(join(stage, "app/node_modules"));
	const copied = new Set();
	const copyDependency = (name, from) => {
		const require = createRequire(join(from, "package.json"));
		let directory = dirname(require.resolve(name));
		while (
			!existsSync(join(directory, "package.json")) ||
			JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name !== name
		) {
			const parent = dirname(directory);
			if (parent === directory) throw new Error(`Cannot locate updater dependency ${name}`);
			directory = parent;
		}
		if (!directory.startsWith(`${appModules}/`))
			throw new Error(`Updater dependency escapes packaged application: ${name}`);
		if (copied.has(directory)) return;
		copied.add(directory);
		const destination = join(updater, "node_modules", directory.slice(appModules.length + 1));
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(directory, destination, { recursive: true });
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		for (const dependency of Object.keys(manifest.dependencies ?? {})) copyDependency(dependency, directory);
	};
	for (const dependency of ["tuf-js", "@tufjs/models"]) copyDependency(dependency, join(stage, "app"));
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const { values } = parseArgs({
		options: {
			out: { type: "string", default: join(repository, ".artifacts/unit-001-release") },
			version: { type: "string" },
			"update-root": { type: "string" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help)
		console.log(
			"Usage: node apps/unit-001/scripts/build-release.mjs [--out <directory>] [--version <fixture-version>] [--update-root <public-root.json>]\nBuild prerequisites: Node/npm, curl, tar, installed checkout dependencies, and network access.\nHydrates Pi model data, builds app and Pi dependencies, then emits a Linux x64 archive with Node and a locked production install. Public production releases require an approved public update root and the source manifest version.",
		);
	else buildRelease(values.out, { version: values.version, updateRoot: values["update-root"] });
}
