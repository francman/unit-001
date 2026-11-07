// Exercises signed publisher output through the real TUF client and a fake GitHub asset store.
import assert from "node:assert/strict";
import { once } from "node:events";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Updater } from "tuf-js";
import { fetchUpdate } from "../deploy/update-trust.mjs";
import {
	fetchRepository,
	generateRepositoryKeys,
	METADATA_RELEASE,
	prepareRepository,
	pruneRepository,
	publishRepository,
	renewRepository,
	rotateRepositoryRoot,
} from "../scripts/update-repository.mjs";

function fixture(t) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "unit-publisher-")));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const keys = join(directory, "keys");
	const rootBytes = generateRepositoryKeys(keys);
	const archive = join(directory, "unit-001-0.0.1-linux-x64.tar.gz");
	writeFileSync(archive, "fixture archive bytes");
	const release = {
		version: "0.0.1",
		platform: "linux-x64",
		source: { commit: "a".repeat(40), dirty: false },
		compatibility: { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 },
	};
	const prepare = (name, extra = {}) => {
		const out = join(directory, name);
		const result = prepareRepository({ archive, release, rootBytes, keys, out, ...extra });
		return { ...result, out };
	};
	return { directory, keys, rootBytes, archive, release, prepare };
}

function fakeGithub() {
	const releases = new Map();
	const operations = [];
	const commits = new Map();
	let id = 0;
	return {
		releases,
		operations,
		assets(tag) {
			return releases.has(tag) ? [...releases.get(tag).values()] : null;
		},
		read(asset) {
			return asset.bytes;
		},
		create(tag, commit) {
			assert(!releases.has(tag));
			releases.set(tag, new Map());
			commits.set(tag, commit);
			operations.push(`create:${tag}`);
		},
		commit(tag) {
			return commits.get(tag);
		},
		upload(tag, path, replace = false) {
			const name = path.split("/").at(-1);
			const entries = releases.get(tag);
			assert(replace || !entries.has(name));
			entries.set(name, { id: ++id, name, bytes: readFileSync(path) });
			operations.push(`${tag}:${name}`);
		},
		remove(tag, asset) {
			assert.equal(releases.get(tag).get(asset.name).id, asset.id);
			releases.get(tag).delete(asset.name);
			operations.push(`remove:${tag}:${asset.name}`);
		},
	};
}

async function client(t, f, publications, rootBytes = f.rootBytes, existingCache) {
	const server = createServer((request, response) => {
		const path = decodeURIComponent(request.url.slice(1));
		let bytes;
		if (path.startsWith("metadata/")) {
			for (const publication of publications) bytes = publication.files[path.slice(9)] ?? bytes;
		} else if (path.startsWith("targets/linux-x64/") && path.endsWith(".stable.json")) {
			const name = `linux-x64-${path.split("/").at(-1)}`;
			for (const publication of publications) bytes = publication.files[name] ?? bytes;
		} else if (path.startsWith("targets/linux-x64/releases/")) bytes = readFileSync(f.archive);
		if (bytes === undefined) {
			response.writeHead(404);
			response.end();
		} else response.end(bytes);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const cache = existingCache ?? join(f.directory, `cache-${Math.random()}`);
	if (!existsSync(cache)) {
		mkdirSync(cache);
		writeFileSync(join(cache, "root.json"), rootBytes);
	}
	const url = `http://127.0.0.1:${server.address().port}`;
	return new Updater({
		metadataDir: cache,
		targetDir: cache,
		metadataBaseUrl: `${url}/metadata`,
		targetBaseUrl: `${url}/targets`,
		config: { fetchRetries: 0 },
	});
}

// #18: bootstrap must never silently overwrite signing material.
test("explicit key generation protects keys and refuses overwrite", (t) => {
	const f = fixture(t);
	assert.equal(statSync(f.keys).mode & 0o777, 0o700);
	assert.equal(statSync(join(f.keys, "root.pem")).mode & 0o777, 0o600);
	assert.throws(() => generateRepositoryKeys(f.keys), /EEXIST/);
});

// #18: exercise standard TUF signature, hash, expiry, and root rotation verification.
test("real TUF client downloads authenticated descriptor and archive", async (t) => {
	const f = fixture(t);
	const publication = f.prepare("first");
	const updater = await client(t, f, [publication]);
	await updater.refresh();
	const info = await updater.getTargetInfo("linux-x64/stable.json");
	const descriptor = JSON.parse(readFileSync(await updater.downloadTarget(info)));
	assert.deepEqual(descriptor, publication.descriptor);
	const archive = await updater.getTargetInfo(descriptor.archiveTarget);
	assert.equal(archive.custom.releaseTag, "unit-v0.0.1");
	assert.deepEqual(readFileSync(await updater.downloadTarget(archive)), readFileSync(f.archive));
});

test("real TUF client refuses expired publication", async (t) => {
	const f = fixture(t);
	const old = new Date(Date.now() - 3 * 86400000);
	const updater = await client(t, f, [f.prepare("expired", { now: old })]);
	await assert.rejects(updater.refresh(), /expired/i);
});

test("real TUF client rejects metadata tampering and rollback after an accepted renewal", async (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const second = f.prepare("second", { previous: first.out });
	const publications = [first];
	const cache = join(f.directory, "reopen-cache");
	const updater = await client(t, f, publications, f.rootBytes, cache);
	await updater.refresh();
	publications.push(second);
	await (await client(t, f, publications, f.rootBytes, cache)).refresh();
	publications.pop();
	await assert.rejects((await client(t, f, publications, f.rootBytes, cache)).refresh(), /version|rollback/i);
	const corrupted = { ...first, files: { ...first.files, "1.targets.json": Buffer.from("tampered") } };
	const refused = await client(t, f, [corrupted]);
	await assert.rejects(refused.refresh(), /hash|length/i);
});

test("real TUF client accepts cross-signed root rotation and rejects missing old signature", async (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const newKeys = join(f.directory, "new-keys");
	generateRepositoryKeys(newKeys);
	const rootBytes = rotateRepositoryRoot(f.rootBytes, f.keys, newKeys);
	const second = f.prepare("second", {
		rootBytes,
		keys: newKeys,
		previous: first.out,
		previousRootBytes: f.rootBytes,
	});
	const updater = await client(t, f, [first, second]);
	await updater.refresh();
	assert(await updater.getTargetInfo("linux-x64/stable.json"));
	const broken = JSON.parse(rootBytes);
	broken.signatures = broken.signatures.slice(1);
	second.files["2.root.json"] = Buffer.from(JSON.stringify(broken));
	const refused = await client(t, f, [first, second]);
	await assert.rejects(refused.refresh(), /signed|signature/i);
});

// #18: interrupted publication is retryable without rewriting immutable assets.
test("publishes archive and immutable metadata before freshness; repeat is idempotent", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const remote = fakeGithub();
	publishRepository(first.out, f.rootBytes, remote);
	assert.equal(remote.operations.at(-1), `${METADATA_RELEASE}:timestamp.json`);
	assert(
		remote.operations.indexOf("unit-v0.0.1:unit-001-0.0.1-linux-x64.tar.gz") <
			remote.operations.indexOf(`${METADATA_RELEASE}:timestamp.json`),
	);
	publishRepository(first.out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const second = f.prepare("second", { previous });
	publishRepository(second.out, f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 2);
});

test("stale publisher and changed immutable release cannot advance timestamp", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const stale = f.prepare("stale");
	const remote = fakeGithub();
	publishRepository(first.out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	publishRepository(f.prepare("second", { previous }).out, f.rootBytes, remote);
	assert.throws(() => publishRepository(stale.out, f.rootBytes, remote), /state changed/);
	writeFileSync(f.archive, "changed archive");
	assert.throws(() => f.prepare("changed", { previous }), /different archive/);
});

test("interruption before timestamp leaves old freshness and can retry the same plan", (t) => {
	const f = fixture(t);
	const first = f.prepare("first");
	const remote = fakeGithub();
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("timestamp.json")) throw new Error("interrupted");
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(first.out, f.rootBytes, remote), /interrupted/);
	assert(!remote.releases.get(METADATA_RELEASE).has("timestamp.json"));
	remote.upload = upload;
	publishRepository(first.out, f.rootBytes, remote);
	assert(remote.releases.get(METADATA_RELEASE).has("timestamp.json"));
});

test("rejects unsupported compatibility, dirty source, and stable downgrade", (t) => {
	const f = fixture(t);
	assert.throws(
		() => f.prepare("dirty", { release: { ...f.release, source: { ...f.release.source, dirty: true } } }),
		/clean/,
	);
	assert.throws(
		() => f.prepare("compatibility", { release: { ...f.release, compatibility: { stateVersion: 2 } } }),
		/reviewed/,
	);
	assert.throws(
		() =>
			f.prepare("oversized", {
				release: { ...f.release, compatibility: { ...f.release.compatibility, extra: "x".repeat(16384) } },
			}),
		/descriptor exceeds/,
	);
	const first = f.prepare("first");
	const archive = join(f.directory, "unit-001-0.0.0-linux-x64.tar.gz");
	copyFileSync(f.archive, archive);
	assert.throws(
		() => f.prepare("downgrade", { previous: first.out, archive, release: { ...f.release, version: "0.0.0" } }),
		/downgrade/,
	);
});

test("scheduled renewal reuses authenticated immutable archive bytes", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const out = join(f.directory, "renewal");
	const renewed = renewRepository({ out, rootBytes: f.rootBytes, keys: f.keys }, remote);
	assert.equal(renewed.descriptor.version, "0.0.1");
	assert.deepEqual(readFileSync(join(out, "unit-001-0.0.1-linux-x64.tar.gz")), readFileSync(f.archive));
	publishRepository(join(out, "publication"), f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 2);
	assert.equal(remote.operations.filter((item) => item === "unit-v0.0.1:unit-001-0.0.1-linux-x64.tar.gz").length, 1);
	remote.releases.get("unit-v0.0.1").get("unit-001-0.0.1-linux-x64.tar.gz").bytes = Buffer.from("tampered");
	assert.throws(
		() =>
			renewRepository({ out: join(f.directory, "tampered-renewal"), rootBytes: f.rootBytes, keys: f.keys }, remote),
		/Archive hash/,
	);
});

test("publication validates root rotation chain and release source tag before freshness", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	const first = f.prepare("first");
	publishRepository(first.out, f.rootBytes, remote);
	const newKeys = join(f.directory, "rotated-keys");
	generateRepositoryKeys(newKeys);
	const rootBytes = rotateRepositoryRoot(f.rootBytes, f.keys, newKeys);
	const second = f.prepare("rotated", {
		rootBytes,
		keys: newKeys,
		previous: first.out,
		previousRootBytes: f.rootBytes,
	});
	publishRepository(second.out, rootBytes, remote);
	assert(remote.releases.get(METADATA_RELEASE).has("2.root.json"));
	const timestampBefore = remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes;
	remote.commit = () => "b".repeat(40);
	assert.throws(() => publishRepository(second.out, rootBytes, remote), /source commit/);
	assert.deepEqual(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes, timestampBefore);
});

test("changed existing remote archive is not clobbered and no timestamp is published", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	remote.create("unit-v0.0.1", f.release.source.commit);
	remote.releases.get("unit-v0.0.1").set("unit-001-0.0.1-linux-x64.tar.gz", {
		name: "unit-001-0.0.1-linux-x64.tar.gz",
		bytes: Buffer.from("foreign bytes"),
	});
	assert.throws(
		() => publishRepository(f.prepare("first").out, f.rootBytes, remote),
		/Immutable release asset differs/,
	);
	assert.equal(remote.assets(METADATA_RELEASE), null);
});

test("publisher assets interoperate with the actual private-GitHub trust transport", async (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const base = join(f.directory, "transport");
	mkdirSync(base, { mode: 0o700 });
	const bootstrapRoot = join(base, "bootstrap.json");
	const tokenFile = join(base, "token");
	writeFileSync(bootstrapRoot, f.rootBytes, { mode: 0o600 });
	writeFileSync(tokenFile, "fixture-token", { mode: 0o600 });
	const fetch = async (url) => {
		const parsed = new URL(url);
		const tag = parsed.pathname.match(/\/releases\/tags\/(.+)$/)?.[1];
		if (tag !== undefined) {
			const assets = remote.assets(tag);
			return new Response(JSON.stringify({ id: tag === METADATA_RELEASE ? 100 : 101 }), {
				status: assets === null ? 404 : 200,
			});
		}
		if (/\/releases\/(100|101)\/assets$/.test(parsed.pathname)) {
			const name = parsed.pathname.includes("/100/") ? METADATA_RELEASE : "unit-v0.0.1";
			const page = Number(parsed.searchParams.get("page"));
			return Response.json(
				remote
					.assets(name)
					.map(({ id, name }) => ({ id, name }))
					.slice((page - 1) * 100, page * 100),
			);
		}
		const id = Number(parsed.pathname.split("/").at(-1));
		for (const assets of remote.releases.values())
			for (const asset of assets.values()) if (asset.id === id) return new Response(asset.bytes);
		return new Response("missing", { status: 404 });
	};
	const result = await fetchUpdate(
		{ metadataDir: join(base, "metadata"), downloadDir: join(base, "downloads"), bootstrapRoot, tokenFile },
		{ fetch, ownerUid: process.getuid(), platform: "linux", arch: "x64" },
	);
	assert.equal(result.version, "0.0.1");
	assert.deepEqual(readFileSync(result.archivePath), readFileSync(f.archive));
	assert.equal(result.sourceCommit, f.release.source.commit);
});

test("recovers a failed timestamp replacement after GitHub deleted old freshness", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const second = f.prepare("second", { previous });
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("/timestamp.json")) {
			remote.releases.get(tag).delete("timestamp.json");
			throw new Error("upload failed after delete");
		}
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(second.out, f.rootBytes, remote), /after delete/);
	remote.upload = upload;
	publishRepository(second.out, f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 2);
	remote.releases.get(METADATA_RELEASE).delete("timestamp.json");
	const recovered = join(f.directory, "recovered");
	fetchRepository(recovered, remote);
	const third = f.prepare("third", { previous: recovered });
	publishRepository(third.out, f.rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 3);
});

test("retry preparation skips orphaned numbered metadata instead of clobbering it", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const previous = join(f.directory, "previous");
	fetchRepository(previous, remote);
	const second = f.prepare("second", { previous });
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("/2.snapshot.json")) throw new Error("interrupted snapshot upload");
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(second.out, f.rootBytes, remote), /interrupted snapshot/);
	const orphan = remote.releases.get(METADATA_RELEASE).get("2.targets.json").bytes;
	remote.upload = upload;
	const recovered = join(f.directory, "recovered");
	fetchRepository(recovered, remote);
	const third = f.prepare("third", { previous: recovered });
	publishRepository(third.out, f.rootBytes, remote);
	assert(third.files["3.targets.json"]);
	assert.deepEqual(remote.releases.get(METADATA_RELEASE).get("2.targets.json").bytes, orphan);
});

// #18: rotation must work for scheduled renewal and remain usable after the first rotated publication.
test("renewal accepts a cross-signed previous root only when current credentials cannot verify prior metadata", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	publishRepository(f.prepare("first").out, f.rootBytes, remote);
	const keys = join(f.directory, "rotated-online");
	generateRepositoryKeys(keys);
	const rootBytes = rotateRepositoryRoot(f.rootBytes, f.keys, keys);
	const options = { rootBytes, keys, previousRootBytes: f.rootBytes };
	renewRepository({ ...options, out: join(f.directory, "rotation-renew") }, remote);
	publishRepository(join(f.directory, "rotation-renew/publication"), rootBytes, remote);
	renewRepository({ ...options, out: join(f.directory, "normal-renew") }, remote);
	publishRepository(join(f.directory, "normal-renew/publication"), rootBytes, remote);
	assert.equal(JSON.parse(remote.releases.get(METADATA_RELEASE).get("timestamp.json").bytes).signed.version, 3);
	assert(remote.releases.get(METADATA_RELEASE).has("1.root.json"));
	assert(remote.releases.get(METADATA_RELEASE).has("2.root.json"));
});

// #18: a client that already fetched a still-valid old timestamp must retain its authenticated dependencies.
test("retention preserves an old valid timestamp's snapshot, targets, and descriptor for an in-flight client", async (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	const now = new Date();
	const firstTime = new Date(now.getTime() - 86400000);
	const first = f.prepare("old-client", { now: firstTime });
	publishRepository(first.out, f.rootBytes, remote, firstTime);
	publishRepository(f.prepare("current-client", { previous: first.out, now }).out, f.rootBytes, remote, now);
	const files = Object.fromEntries(remote.assets(METADATA_RELEASE).map(({ name, bytes }) => [name, bytes]));
	files["timestamp.json"] = first.files["timestamp.json"];
	const updater = await client(t, f, [{ files }]);
	await updater.refresh();
	const info = await updater.getTargetInfo("linux-x64/stable.json");
	assert.deepEqual(JSON.parse(readFileSync(await updater.downloadTarget(info))), first.descriptor);
});

// #18: pruning is tied to successful freshness publication, never merely to preparing or staging assets.
test("failed freshness leaves old metadata intact; successful publication prunes aged metadata but preserves unknowns", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	const now = new Date();
	const oldTime = new Date(now.getTime() - 40 * 86400000);
	const first = f.prepare("aged", { now: oldTime });
	publishRepository(first.out, f.rootBytes, remote, oldTime);
	const entries = remote.releases.get(METADATA_RELEASE);
	entries.set("operator-notes.txt", { id: 9999, name: "operator-notes.txt", bytes: Buffer.from("preserve") });
	const second = f.prepare("fresh", { previous: first.out, now });
	const upload = remote.upload.bind(remote);
	remote.upload = (tag, path, replace) => {
		if (path.endsWith("/timestamp.json")) throw new Error("freshness interrupted");
		upload(tag, path, replace);
	};
	assert.throws(() => publishRepository(second.out, f.rootBytes, remote, now), /freshness interrupted/);
	assert(entries.has("1.snapshot.json"));
	assert(!remote.operations.some((operation) => operation.startsWith("remove:")));
	remote.upload = upload;
	publishRepository(second.out, f.rootBytes, remote, now);
	for (const name of ["1.timestamp.json", "1.snapshot.json", "1.targets.json"]) assert(!entries.has(name));
	assert(entries.has("operator-notes.txt"));
	assert(entries.has("1.root.json"));
	assert(remote.releases.get("unit-v0.0.1").has("unit-001-0.0.1-linux-x64.tar.gz"));
	entries.set("999.targets.json", { id: 9998, name: "999.targets.json", bytes: Buffer.from("not signed") });
	const before = [...entries.keys()];
	assert.throws(() => pruneRepository(f.rootBytes, remote, now));
	assert.deepEqual([...entries.keys()], before);
});

// #18: six-hour renewal must not exhaust GitHub's 1,000-assets-per-release limit over the service's lifetime.
test("authenticated seven-day retention bounds assets across more than 1000 six-hour renewals", (t) => {
	const f = fixture(t);
	const remote = fakeGithub();
	remote.create(METADATA_RELEASE);
	remote.create("unit-v0.0.1", f.release.source.commit);
	remote.upload("unit-v0.0.1", f.archive);
	const start = Date.now() - 1200 * 6 * 3600000;
	let previous;
	let now;
	for (let index = 0; index < 1200; index++) {
		now = new Date(start + index * 6 * 3600000);
		const publication = f.prepare(`renewal-${index}`, { previous, now });
		for (const name of Object.keys(publication.files)) {
			if (name !== "timestamp.json" && remote.releases.get(METADATA_RELEASE).has(name)) continue;
			remote.upload(METADATA_RELEASE, join(publication.out, name), name === "timestamp.json");
		}
		previous = publication.out;
		// Even a backlog of twenty successful renewals fits; production prunes after every successful publication.
		if (index % 20 === 0) pruneRepository(f.rootBytes, remote, now);
		assert(remote.assets(METADATA_RELEASE).length < 1000);
	}
	const result = pruneRepository(f.rootBytes, remote, now);
	assert(result.retained < 300);
	assert(remote.releases.get(METADATA_RELEASE).has("1200.timestamp.json"));
	assert(remote.releases.get(METADATA_RELEASE).has("1.root.json"));
	assert.equal(remote.releases.get("unit-v0.0.1").size, 1);
});
