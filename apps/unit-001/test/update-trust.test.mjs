// #18: signed offline release fixtures exercise real TUF verification before any archive is returned.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test as nodeTest } from "node:test";
import { Key, Metadata, MetaFile, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models";
import { fetchUpdate } from "../deploy/update-trust.mjs";

const directories = [];
const test = (name, run) => nodeTest(name, { skip: process.platform === "win32" }, run);
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoded = (metadata) => Buffer.from(JSON.stringify(metadata.toJSON()));

async function fixture(access = "private") {
	const directory = await mkdtemp(join(await realpath(tmpdir()), "unit-trust-"));
	directories.push(directory);
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const key = new Key({
		keyID: "fixture",
		keyType: "ed25519",
		scheme: "ed25519",
		keyVal: { public: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex") },
	});
	const expires = new Date(Date.now() + 86_400_000).toISOString();
	const signed = (value) => {
		const metadata = new Metadata(value);
		metadata.sign((data) => new Signature({ keyID: key.keyID, sig: sign(null, data, privateKey).toString("hex") }));
		return encoded(metadata);
	};
	const root = new Root({ version: 1, expires, consistentSnapshot: true });
	for (const role of ["root", "timestamp", "snapshot", "targets"]) root.addKey(key, role);
	const bootstrap = signed(root);
	const archive = Buffer.from("verified archive fixture; never extracted");
	const descriptor = {
		schemaVersion: 1,
		version: "0.0.2",
		platform: "linux-x64",
		sourceCommit: "a".repeat(40),
		compatibility: { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 },
		archiveTarget: "linux-x64/releases/0.0.2.tar.gz",
	};
	const assets = new Map();
	let nextId = 1;
	const byId = new Map();
	const requests = [];
	const put = (tag, name, body) => {
		const id = nextId++;
		assets.set(`${tag}/${name}`, { id, name, body });
		byId.set(id, body);
	};
	const publish = (version = 1, changes = {}, changeTargets = () => {}) => {
		const body = Buffer.from(JSON.stringify({ ...descriptor, ...changes }));
		const targets = new Targets({
			version,
			expires,
			targets: {
				"linux-x64/stable.json": new TargetFile({
					path: "linux-x64/stable.json",
					length: body.length,
					hashes: { sha256: digest(body) },
				}),
				[descriptor.archiveTarget]: new TargetFile({
					path: descriptor.archiveTarget,
					length: archive.length,
					hashes: { sha256: digest(archive) },
					unrecognizedFields: {
						custom: { releaseTag: "unit-v0.0.2", assetName: "unit-001-0.0.2-linux-x64.tar.gz" },
					},
				}),
			},
		});
		changeTargets(targets);
		const targetBytes = signed(targets);
		const snapshot = signed(
			new Snapshot({
				version,
				expires,
				meta: {
					"targets.json": new MetaFile({
						version,
						length: targetBytes.length,
						hashes: { sha256: digest(targetBytes) },
					}),
				},
			}),
		);
		const timestamp = signed(
			new Timestamp({
				version,
				expires,
				snapshotMeta: new MetaFile({ version, length: snapshot.length, hashes: { sha256: digest(snapshot) } }),
			}),
		);
		put("unit-updates-stable", "timestamp.json", timestamp);
		put("unit-updates-stable", `${version}.snapshot.json`, snapshot);
		put("unit-updates-stable", `${version}.targets.json`, targetBytes);
		put("unit-updates-stable", `linux-x64-${digest(body)}.stable.json`, body);
		put("unit-v0.0.2", "unit-001-0.0.2-linux-x64.tar.gz", archive);
	};
	publish();
	const bootstrapRoot = join(directory, "bootstrap.json");
	const tokenFile = join(directory, "token");
	await writeFile(bootstrapRoot, bootstrap, { mode: 0o644 });
	await writeFile(tokenFile, "fixture-secret", { mode: 0o600 });
	const fetch = async (url, init) => {
		requests.push({ url, headers: init.headers });
		const parsed = new URL(url);
		if (parsed.origin === "https://github.com") {
			const route = parsed.pathname.match(/^\/francman\/unit-001-releases\/releases\/download\/([^/]+)\/([^/]+)$/);
			const body = route === null ? undefined : assets.get(`${route[1]}/${route[2]}`)?.body;
			return new Response(body, { status: body === undefined ? 404 : 200 });
		}
		if (parsed.pathname.includes("/releases/tags/")) {
			const tag = parsed.pathname.split("/").at(-1);
			return Response.json({ id: tag === "unit-updates-stable" ? 100 : 101 });
		}
		if (/\/releases\/(100|101)\/assets$/.test(parsed.pathname)) {
			const tag = parsed.pathname.includes("/100/") ? "unit-updates-stable" : "unit-v0.0.2";
			const page = Number(parsed.searchParams.get("page"));
			return Response.json(
				[...assets.entries()]
					.filter(([name]) => name.startsWith(`${tag}/`))
					.map(([, value]) => ({ id: value.id, name: value.name }))
					.slice((page - 1) * 100, page * 100),
			);
		}
		const body = byId.get(Number(parsed.pathname.split("/").at(-1)));
		return new Response(body, { status: body === undefined ? 404 : 200 });
	};
	const options = {
		metadataDir: join(directory, "metadata"),
		bootstrapRoot,
		...(access === "private" ? { tokenFile } : {}),
		downloadDir: join(directory, "downloads"),
	};
	return {
		directory,
		options,
		context: { fetch, ownerUid: process.getuid(), platform: "linux", arch: "x64" },
		assets,
		byId,
		requests,
		publish,
		put,
		signed,
		root,
		key,
		archive,
		descriptor,
	};
}

test("public downloads verify the full chain without a token file, account, or API request", async () => {
	const f = await fixture("public");
	await rm(join(f.directory, "token"));
	const candidate = await fetchUpdate(f.options, f.context);
	assert.equal(candidate.version, "0.0.2");
	assert.deepEqual(await readFile(candidate.archivePath), f.archive);
	assert.ok(
		f.requests.every(
			({ url, headers }) =>
				url.startsWith("https://github.com/francman/unit-001-releases/releases/download/") &&
				headers.Authorization === undefined,
		),
	);
	assert.ok(f.requests.some(({ url }) => url.endsWith("/2.root.json")));
});

test("public CDN redirects stay credential-free and reject API or unrelated download hosts", async () => {
	const f = await fixture("public");
	const original = f.context.fetch;
	const requests = [];
	f.context.fetch = async (url, init) => {
		requests.push({ url, headers: init.headers });
		if (url.startsWith("https://release-assets.githubusercontent.com/")) return new Response(f.archive);
		if (url.endsWith(".tar.gz"))
			return new Response(null, {
				status: 302,
				headers: { location: "https://release-assets.githubusercontent.com/archive?signature=opaque" },
			});
		return original(url, init);
	};
	await fetchUpdate(f.options, f.context);
	assert.ok(requests.every(({ headers }) => headers.Authorization === undefined));
	for (const location of [
		"https://api.github.com/repos/francman/unit-001-releases/releases/assets/1",
		"https://attacker.example/archive",
		"https://github.com/attacker/repository/releases/download/tag/asset",
		"https://github.com/francman/unit-001-releases/releases/download/other/asset",
		"https://github.com/francman/unit-001-releases/releases/download/unit-v0.0.2/unit-001-0.0.2-linux-x64.tar.gz?token=secret",
		"https://release-assets.githubusercontent.com:444/archive",
		"https://user:secret@release-assets.githubusercontent.com/archive",
	]) {
		f.context.fetch = async (url, init) =>
			url.endsWith(".tar.gz") ? new Response(null, { status: 302, headers: { location } }) : original(url, init);
		await assert.rejects(fetchUpdate(f.options, f.context), /Untrusted.*redirect|Credential-bearing/);
	}
});

test("public signed metadata tampering and archive substitution fail closed", async () => {
	const f = await fixture("public");
	const archive = f.assets.get("unit-v0.0.2/unit-001-0.0.2-linux-x64.tar.gz");
	archive.body = Buffer.from("substituted archive");
	await assert.rejects(fetchUpdate(f.options, f.context), /length|hash/);
	const item = f.assets.get("unit-updates-stable/timestamp.json");
	const value = JSON.parse(item.body);
	value.signatures[0].sig = "00".repeat(64);
	item.body = Buffer.from(JSON.stringify(value));
	await assert.rejects(fetchUpdate(f.options, f.context), /signed by 0\/1 keys/i);
});

test("public checks rotate trusted roots, avoid held archives, and reject metadata replay", async () => {
	const f = await fixture("public");
	const old = f.assets.get("unit-updates-stable/timestamp.json").body;
	f.root.version = 2;
	f.put("unit-updates-stable", "2.root.json", f.signed(f.root));
	f.publish(2);
	let offered;
	assert.equal(
		await fetchUpdate(f.options, {
			...f.context,
			acceptCandidate(descriptor) {
				offered = descriptor;
				return false;
			},
		}),
		null,
	);
	assert.equal(offered.version, "0.0.2");
	assert.equal(JSON.parse(await readFile(join(f.options.metadataDir, "root.json"), "utf8")).signed.version, 2);
	assert.ok(f.requests.every(({ url }) => !url.includes("/unit-v0.0.2/")));
	f.put("unit-updates-stable", "timestamp.json", old);
	await assert.rejects(fetchUpdate(f.options, f.context), /less than|version/i);
});

test("verifies the full chain, root-404 termination and immutable archive without executing it", async () => {
	const f = await fixture();
	const candidate = await fetchUpdate(f.options, f.context);
	assert.equal(candidate.version, "0.0.2");
	assert.deepEqual(await readFile(candidate.archivePath), f.archive);
	assert.equal(candidate.compatibility.maintenanceProtocol, 1);
	assert.ok(f.requests.every((request) => request.headers.Authorization === "Bearer fixture-secret"));
});

test("paginates beyond 256 assets once per release and still verifies the exact signed targets", async () => {
	const f = await fixture();
	for (let index = 0; index < 400; index++) f.put("unit-updates-stable", `unknown-${index}`, Buffer.from("unknown"));
	f.publish(2, { sourceCommit: "b".repeat(40) });
	const candidate = await fetchUpdate(f.options, f.context);
	assert.equal(candidate.sourceCommit, "b".repeat(40));
	assert.ok(f.requests.some(({ url }) => url.includes("/releases/100/assets?per_page=100&page=5")));
	assert.equal(f.requests.filter(({ url }) => url.endsWith("/tags/unit-updates-stable")).length, 1);
});

test("allows policy to skip a verified current or held candidate before archive requests/download", async () => {
	const f = await fixture();
	let offered;
	assert.equal(
		await fetchUpdate(f.options, {
			...f.context,
			acceptCandidate(descriptor) {
				offered = descriptor;
				return false;
			},
		}),
		null,
	);
	assert.equal(offered.version, "0.0.2");
	assert.deepEqual(offered.compatibility, f.descriptor.compatibility);
	assert.ok(f.requests.every((request) => !request.url.includes("unit-v0.0.2")));
	assert.deepEqual(await readdir(f.options.downloadDir), []);
	const timestamp = f.assets.get("unit-updates-stable/timestamp.json");
	const forged = JSON.parse(timestamp.body);
	forged.signatures[0].sig = "00".repeat(64);
	f.byId.set(timestamp.id, Buffer.from(JSON.stringify(forged)));
	offered = undefined;
	await assert.rejects(
		fetchUpdate(f.options, {
			...f.context,
			acceptCandidate(descriptor) {
				offered = descriptor;
				return false;
			},
		}),
		/signed by/,
	);
	assert.equal(offered, undefined);
});

test("accepts sequential signed root rotation and preserves it in the TUF cache", async () => {
	const f = await fixture();
	f.root.version = 2;
	f.put("unit-updates-stable", "2.root.json", f.signed(f.root));
	await fetchUpdate(f.options, f.context);
	assert.equal(JSON.parse(await readFile(join(f.options.metadataDir, "root.json"), "utf8")).signed.version, 2);
});

test("checks signed archive binding before policy and lets policy hold a future maintenance protocol", async () => {
	const f = await fixture();
	let offered;
	f.publish(2, { compatibility: { stateVersion: 2, minReaderVersion: 1, maintenanceProtocol: 2 } });
	assert.equal(
		await fetchUpdate(f.options, {
			...f.context,
			acceptCandidate(descriptor) {
				offered = descriptor;
				return false;
			},
		}),
		null,
	);
	assert.equal(offered.compatibility.maintenanceProtocol, 2);
	f.publish(3, {}, (targets) => {
		targets.targets[f.descriptor.archiveTarget].unrecognizedFields.custom.assetName = "wrong.tar.gz";
	});
	offered = undefined;
	await assert.rejects(
		fetchUpdate(f.options, {
			...f.context,
			acceptCandidate(descriptor) {
				offered = descriptor;
				return false;
			},
		}),
		/location does not match/,
	);
	assert.equal(offered, undefined);
	assert.ok(f.requests.every((request) => !request.url.includes("unit-v0.0.2")));
});

test("rejects a bad timestamp signature", async () => {
	const f = await fixture();
	const item = f.assets.get("unit-updates-stable/timestamp.json");
	const value = JSON.parse(item.body);
	value.signatures[0].sig = "00".repeat(64);
	f.byId.set(item.id, Buffer.from(JSON.stringify(value)));
	await assert.rejects(fetchUpdate(f.options, f.context), /signed by 0\/1 keys/i);
});

test("rejects expired metadata and replay after a newer timestamp was trusted", async () => {
	const f = await fixture();
	const old = f.assets.get("unit-updates-stable/timestamp.json").body;
	f.publish(2);
	await fetchUpdate(f.options, f.context);
	f.put("unit-updates-stable", "timestamp.json", old);
	await assert.rejects(fetchUpdate(f.options, f.context), /less than|version/i);
	const expired = new Timestamp({
		version: 3,
		expires: new Date(0).toISOString(),
		snapshotMeta: new MetaFile({ version: 2 }),
	});
	f.put("unit-updates-stable", "timestamp.json", f.signed(expired));
	await assert.rejects(fetchUpdate(f.options, f.context), /expired/i);
});

for (const changes of [
	{ platform: "darwin-arm64" },
	{ archiveTarget: "../../evil" },
	{ compatibility: { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 0 } },
]) {
	test(`rejects signed unsupported descriptor ${JSON.stringify(changes)}`, async () => {
		const f = await fixture();
		f.publish(2, changes);
		await assert.rejects(fetchUpdate(f.options, f.context), /descriptor|compatibility/);
	});
}

test("rejects archive hash or length mismatch", async () => {
	const f = await fixture();
	const item = f.assets.get("unit-v0.0.2/unit-001-0.0.2-linux-x64.tar.gz");
	f.byId.set(item.id, Buffer.from("corrupt"));
	await assert.rejects(fetchUpdate(f.options, f.context), /length|hash/i);
});

test("strips authentication across signed CDN redirects and rejects arbitrary hosts", async () => {
	const f = await fixture();
	const original = f.context.fetch;
	const requests = [];
	f.context.fetch = async (url, init) => {
		requests.push({ url, headers: init.headers });
		if (url.startsWith("https://release-assets.githubusercontent.com/"))
			return new Response(f.byId.get(Number(new URL(url).pathname.slice(1))));
		if (url.includes("/releases/assets/"))
			return new Response(null, {
				status: 302,
				headers: {
					location: `https://release-assets.githubusercontent.com/${url.split("/").at(-1)}?signature=opaque`,
				},
			});
		return original(url, init);
	};
	await fetchUpdate(f.options, f.context);
	assert.ok(
		requests
			.filter((request) => request.url.startsWith("https://release-assets."))
			.every((request) => request.headers.Authorization === undefined),
	);
	f.context.fetch = async (url, init) =>
		url.includes("/releases/assets/")
			? new Response(null, { status: 302, headers: { location: "https://attacker.example/secret" } })
			: original(url, init);
	await assert.rejects(fetchUpdate(f.options, f.context), /Untrusted.*redirect/);
});

test("rejects unsafe token permissions and symlinked cache before network activity", async () => {
	const f = await fixture();
	await chmod(f.options.tokenFile, 0o644);
	await assert.rejects(fetchUpdate(f.options, f.context), /private/);
	assert.equal(f.requests.length, 0);
	await chmod(f.options.tokenFile, 0o600);
	await symlink(f.directory, f.options.metadataDir);
	await assert.rejects(fetchUpdate(f.options, f.context), /symlink/);
	assert.equal(f.requests.length, 0);
});

test("rejects unsupported hosts and unsafe ancestry without making requests", async () => {
	const f = await fixture();
	await assert.rejects(fetchUpdate(f.options, { ...f.context, arch: "arm64" }), /Linux x64/);
	await chmod(f.directory, 0o777);
	await assert.rejects(fetchUpdate(f.options, f.context), /ancestry/);
	assert.equal(f.requests.length, 0);
});

test("does not expose a private token or signed URL in request failures", async () => {
	const f = await fixture();
	f.context.fetch = async () => {
		throw new Error("fixture-secret https://api.github.com/?token=private");
	};
	await assert.rejects(fetchUpdate(f.options, f.context), (error) => {
		assert.match(error.message, /request failed/);
		assert.doesNotMatch(error.message, /fixture-secret|token=|https:/);
		return true;
	});
});

test("rejects overflow while streaming and removes the unverified candidate", async () => {
	const f = await fixture();
	const asset = f.assets.get("unit-v0.0.2/unit-001-0.0.2-linux-x64.tar.gz");
	f.byId.set(asset.id, Buffer.alloc(f.archive.length + 1));
	await assert.rejects(fetchUpdate(f.options, f.context), /size limit/);
	assert.deepEqual(await readdir(f.options.downloadDir), []);
});

test("never reads cached delegated targets or follows a signed delegation for a missing top-level target", async () => {
	const f = await fixture();
	await fetchUpdate(f.options, f.context);
	await writeFile(
		join(f.options.metadataDir, "untrusted.json"),
		'{"signed":{"_type":"targets","version":999,"targets":{"linux-x64/stable.json":{}}},"signatures":[]}',
	);
	f.publish(2, {}, (targets) => {
		delete targets.targets["linux-x64/stable.json"];
		targets.delegations = Targets.fromJSON({
			...targets.toJSON(),
			delegations: {
				keys: { [f.key.keyID]: f.key.toJSON() },
				roles: [{ name: "untrusted", terminating: true, keyids: [f.key.keyID], threshold: 1, paths: ["*"] }],
			},
		}).delegations;
	});
	await assert.rejects(fetchUpdate(f.options, f.context), /No signed linux-x64 stable descriptor/);
	assert.ok(f.requests.every((request) => !request.url.includes("untrusted")));
});
