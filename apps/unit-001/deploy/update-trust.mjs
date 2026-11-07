// Verifies public or explicitly authenticated GitHub releases with a pinned, persistent TUF trust chain.
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Updater } from "tuf-js";
// tuf-js 5.0.1 does not export this class publicly; Updater requires its exact identity to end root rotation on 404.
import { DownloadHTTPError } from "tuf-js/dist/error.js";

const ORIGIN = "https://unit001.invalid/";
const MAX_METADATA = 4 * 1024 * 1024;
const MAX_ARCHIVE = 512 * 1024 * 1024;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

/** Refreshes trusted metadata and returns a verified archive; policy/version ordering belongs to the caller. */
export async function fetchUpdate(options, context = { fetch: globalThis.fetch, ownerUid: 0 }) {
	if ((context.platform ?? process.platform) !== "linux" || (context.arch ?? process.arch) !== "x64")
		throw new Error("Authenticated updates currently require Linux x64.");
	const { metadataDir, bootstrapRoot, tokenFile, downloadDir } = options;
	const repository =
		options.repository ?? (tokenFile === undefined ? "francman/unit-001-releases" : "francman/unit-001");
	const metadataTag = options.metadataTag ?? "unit-updates-stable";
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))
		throw new Error("Invalid update repository.");
	if (metadataTag !== "unit-updates-stable") throw new Error("Unsupported metadata channel.");
	await ownedPath(bootstrapRoot, "file", context.ownerUid);
	if ((await lstat(bootstrapRoot)).size > MAX_METADATA) throw new Error("Bootstrap root is too large.");
	let token = null;
	if (tokenFile !== undefined) {
		await ownedPath(tokenFile, "file", context.ownerUid);
		const tokenStat = await lstat(tokenFile);
		if ((tokenStat.mode & 0o077) !== 0 || tokenStat.size > 8192)
			throw new Error("Update token must be private and bounded.");
		token = (await readFile(tokenFile, "utf8")).trim();
		if (!/^[A-Za-z0-9_\-.]+$/.test(token)) throw new Error("Invalid update token.");
	}
	for (const directory of [metadataDir, downloadDir]) {
		await ownedPath(dirname(directory), "directory", context.ownerUid);
		await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
			if (error.code !== "EEXIST") throw error;
		});
		await ownedPath(directory, "directory", context.ownerUid);
	}
	for (const file of ["root.json", "timestamp.json", "snapshot.json", "targets.json"]) {
		try {
			await ownedPath(join(metadataDir, file), "file", context.ownerUid);
			if ((await lstat(join(metadataDir, file))).size > MAX_METADATA)
				throw new Error("Cached metadata is too large.");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			if (file === "root.json") await copyFile(bootstrapRoot, join(metadataDir, file));
		}
	}
	const transport = new GithubFetcher(repository, metadataTag, token, downloadDir, context.fetch);
	const updater = new Updater({
		metadataDir,
		metadataBaseUrl: `${ORIGIN}metadata/`,
		targetBaseUrl: `${ORIGIN}targets/`,
		targetDir: downloadDir,
		fetcher: transport,
		config: {
			maxRootRotations: 32,
			// 5.0.1 predates the 6.0.1 delegated-cache fix; zero permits only root targets in its <= traversal loop.
			// https://github.com/theupdateframework/tuf-js/blob/main/packages/client/CHANGELOG.md#601
			maxDelegations: 0,
			rootMaxLength: MAX_METADATA,
			timestampMaxLength: MAX_METADATA,
			snapshotMaxLength: MAX_METADATA,
			targetsMaxLength: MAX_METADATA,
		},
	});
	await updater.refresh();
	// A successful check must not forget a trusted rotation or version floor after power loss.
	// tuf-js writes its cache synchronously but does not flush files or newly created directory entries.
	for (const name of ["root", "timestamp", "snapshot", "targets"]) {
		const file = await open(join(metadataDir, `${name}.json`), "r");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
	}
	for (let directory = resolve(metadataDir); ; directory = dirname(directory)) {
		const file = await open(directory, "r");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		if (dirname(directory) === directory) break;
	}
	const descriptorInfo = await updater.getTargetInfo("linux-x64/stable.json");
	if (descriptorInfo === undefined) throw new Error("No signed linux-x64 stable descriptor.");
	if (!/^[a-f0-9]{64}$/.test(descriptorInfo.hashes.sha256) || descriptorInfo.length > 16_384)
		throw new Error("Invalid signed descriptor bounds.");
	transport.target(
		`linux-x64/${descriptorInfo.hashes.sha256}.stable.json`,
		metadataTag,
		`linux-x64-${descriptorInfo.hashes.sha256}.stable.json`,
		16_384,
	);
	const attempt = await mkdtemp(join(downloadDir, "candidate-"));
	try {
		const descriptorFile = await updater.downloadTarget(descriptorInfo, join(attempt, "stable.json"));
		const descriptor = validateDescriptor(JSON.parse(await readFile(descriptorFile, "utf8")));
		const info = await updater.getTargetInfo(descriptor.archiveTarget);
		if (info === undefined || !/^[a-f0-9]{64}$/.test(info.hashes.sha256) || info.length > MAX_ARCHIVE)
			throw new Error("Missing or oversized signed archive target.");
		const releaseTag = `unit-v${descriptor.version}`;
		const assetName = `unit-001-${descriptor.version}-linux-x64.tar.gz`;
		if (info.custom.releaseTag !== releaseTag || info.custom.assetName !== assetName)
			throw new Error("Signed archive location does not match its version.");
		if (context.acceptCandidate !== undefined && !context.acceptCandidate(descriptor)) {
			await rm(attempt, { recursive: true, force: true });
			return null;
		}
		transport.target(
			`linux-x64/releases/${info.hashes.sha256}.${descriptor.version}.tar.gz`,
			releaseTag,
			assetName,
			MAX_ARCHIVE,
		);
		const archivePath = await updater.downloadTarget(info, join(attempt, assetName));
		return {
			version: descriptor.version,
			archivePath,
			compatibility: descriptor.compatibility,
			sourceCommit: descriptor.sourceCommit,
		};
	} catch (error) {
		await rm(attempt, { recursive: true, force: true });
		throw error;
	}
}

/** Rejects remote descriptor data outside the single supported artifact and compatibility contract. */
export function validateDescriptor(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		value.schemaVersion !== 1 ||
		!VERSION.test(value.version) ||
		value.platform !== "linux-x64" ||
		!/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
		value.archiveTarget !== `linux-x64/releases/${value.version}.tar.gz`
	)
		throw new Error("Invalid signed update descriptor.");
	const compatibility = value.compatibility;
	if (
		compatibility === null ||
		typeof compatibility !== "object" ||
		!Number.isSafeInteger(compatibility.stateVersion) ||
		compatibility.stateVersion < 1 ||
		!Number.isSafeInteger(compatibility.minReaderVersion) ||
		compatibility.minReaderVersion < 1 ||
		compatibility.minReaderVersion > compatibility.stateVersion ||
		!Number.isSafeInteger(compatibility.maintenanceProtocol) ||
		compatibility.maintenanceProtocol < 1
	)
		throw new Error("Invalid signed compatibility contract.");
	return value;
}

async function ownedPath(path, kind, ownerUid) {
	const absolute = resolve(path);
	let current = absolute;
	while (true) {
		const stat = await lstat(current);
		if (stat.isSymbolicLink()) throw new Error("Update paths must not traverse symlinks.");
		if ((stat.uid !== 0 && stat.uid !== ownerUid) || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0))
			throw new Error("Update path ancestry is writable by another user.");
		if (
			current === absolute &&
			(stat.uid !== ownerUid ||
				(stat.mode & 0o022) !== 0 ||
				(kind === "file" ? !stat.isFile() : !stat.isDirectory()))
		)
			throw new Error("Update path has unsafe ownership or permissions.");
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

class GithubFetcher {
	#repository;
	#metadataTag;
	#token;
	#directory;
	#fetch;
	#releases = new Map();
	#targets = new Map();
	constructor(repository, metadataTag, token, directory, fetch) {
		this.#repository = repository;
		this.#metadataTag = metadataTag;
		this.#token = token;
		this.#directory = directory;
		this.#fetch = fetch;
	}
	target(path, tag, asset, limit) {
		this.#targets.set(path, { tag, asset, limit });
	}
	async downloadBytes(url, maxLength) {
		return this.downloadFile(url, maxLength, (file) => readFile(file));
	}
	async downloadFile(url, maxLength, handler) {
		const route = new URL(url);
		let target;
		if (route.origin !== new URL(ORIGIN).origin) throw new Error("Unexpected TUF transport origin.");
		if (route.pathname.startsWith("/metadata/")) {
			const asset = route.pathname.slice("/metadata/".length);
			if (!/^(?:[1-9][0-9]*\.root|timestamp|[1-9][0-9]*\.(?:snapshot|targets))\.json$/.test(asset))
				throw new Error("Unsupported TUF metadata path.");
			target = { tag: this.#metadataTag, asset, limit: MAX_METADATA };
		} else target = this.#targets.get(route.pathname.slice("/targets/".length));
		if (target === undefined) throw new Error("Unsigned artifact location.");
		let location = `https://github.com/${this.#repository}/releases/download/${target.tag}/${target.asset}`;
		if (this.#token !== null) {
			const release = await this.#release(target.tag);
			const asset = release.assets.find((entry) => entry.name === target.asset);
			if (asset === undefined) throw new DownloadHTTPError("Update asset unavailable.", 404);
			if (!Number.isSafeInteger(asset.id) || asset.id < 1) throw new Error("Invalid GitHub asset identifier.");
			location = `https://api.github.com/repos/${this.#repository}/releases/assets/${asset.id}`;
		}
		const response = await this.#request(
			location,
			"application/octet-stream",
			target.limit === MAX_ARCHIVE ? 15 * 60_000 : 30_000,
		);
		const temporary = await mkdtemp(join(this.#directory, ".download-"));
		const file = join(temporary, "payload");
		try {
			let count = 0;
			const limit = Math.min(maxLength, target.limit);
			try {
				await pipeline(
					Readable.fromWeb(response.body),
					new Transform({
						transform(chunk, _encoding, callback) {
							count += chunk.length;
							callback(count > limit ? new Error("Update download exceeds its size limit.") : null, chunk);
						},
					}),
					createWriteStream(file, { flags: "wx", mode: 0o600 }),
				);
			} catch {
				throw new Error("Update download failed or exceeded its size limit.");
			}
			return await handler(file);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
	async #release(tag) {
		if (this.#releases.has(tag)) return this.#releases.get(tag);
		const deadline = performance.now() + 30_000;
		const request = async (url) => {
			const remaining = Math.floor(deadline - performance.now());
			if (remaining <= 0) throw new Error("GitHub asset inventory timed out.");
			return this.#json(await this.#request(url, "application/vnd.github+json", remaining));
		};
		const release = await request(`https://api.github.com/repos/${this.#repository}/releases/tags/${tag}`);
		if (!Number.isSafeInteger(release?.id) || release.id < 1) throw new Error("Invalid GitHub release identifier.");
		const assets = [];
		// GitHub permits 1,000 assets per release; pagination avoids a lower lifetime limit on this feed.
		for (let page = 1; page <= 11; page++) {
			const entries = await request(
				`https://api.github.com/repos/${this.#repository}/releases/${release.id}/assets?per_page=100&page=${page}`,
			);
			if (!Array.isArray(entries) || entries.length > 100 || (page === 11 && entries.length !== 0))
				throw new Error("Invalid GitHub asset inventory.");
			assets.push(...entries);
			if (entries.length < 100) {
				const inventory = { assets };
				this.#releases.set(tag, inventory);
				return inventory;
			}
		}
		throw new Error("GitHub asset inventory exceeds the supported release limit.");
	}
	async #json(response) {
		const reader = response.body.getReader();
		const chunks = [];
		let count = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				count += value.length;
				if (count > MAX_METADATA) throw new Error("GitHub release response too large.");
				chunks.push(value);
			}
		} catch {
			throw new Error("GitHub release response failed or exceeded its size limit.");
		} finally {
			await reader.cancel();
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("Invalid GitHub release response.");
		}
	}
	async #request(url, accept, timeout) {
		const signal = AbortSignal.timeout(timeout);
		const requested = new URL(url);
		let authenticated = true;
		for (let redirects = 0; redirects < 5; redirects++) {
			const parsed = new URL(url);
			const api = this.#token !== null && parsed.origin === "https://api.github.com";
			const publicRelease =
				this.#token === null &&
				parsed.origin === "https://github.com" &&
				parsed.pathname.startsWith(`/${this.#repository}/releases/download/`) &&
				parsed.pathname === requested.pathname &&
				parsed.search === "" &&
				parsed.hash === "";
			if (
				!api &&
				!publicRelease &&
				(parsed.protocol !== "https:" || parsed.port !== "" || !REDIRECT_HOSTS.has(parsed.hostname))
			)
				throw new Error("Untrusted update download redirect.");
			if (parsed.username || parsed.password) throw new Error("Credential-bearing update URL rejected.");
			let response;
			try {
				response = await this.#fetch(url, {
					redirect: "manual",
					signal,
					headers: {
						Accept: accept,
						"User-Agent": "unit-001-updater",
						...(api && authenticated ? { Authorization: `Bearer ${this.#token}` } : {}),
					},
				});
			} catch {
				throw new Error("Update request failed or timed out.");
			}
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location");
				await response.body?.cancel();
				if (location === null) throw new Error("Update redirect has no destination.");
				let next;
				try {
					next = new URL(location, url);
				} catch {
					throw new Error("Invalid update redirect destination.");
				}
				if (next.origin !== parsed.origin) authenticated = false;
				url = next.href;
				continue;
			}
			if (!response.ok || response.body === null)
				throw new DownloadHTTPError("Update request rejected.", response.status);
			return response;
		}
		throw new Error("Too many update redirects.");
	}
}
