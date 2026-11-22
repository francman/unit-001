// Starts a browser workspace as the authorized operator.
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigurationError } from "../errors.ts";
import { matchingApproval, readMissionAuthority } from "../missions/authority.ts";
import { agreementReview } from "../missions/browser-agreement.ts";
import type { MissionView } from "../missions/contract.ts";
import { localServiceClient } from "../service-client.ts";
import { createWebGateway } from "./gateway.ts";
import type { ManagedMissionReview } from "./post-response.ts";

/** Serves packaged browser assets until interrupted. */
export async function runWebWorkspace(
	endpoint: string,
	port: number,
	write: (text: string) => void,
	signal: AbortSignal,
	installationId?: string,
): Promise<number> {
	if (signal.aborted) return 130;
	const managed = installationId === undefined ? undefined : managedListener(installationId);
	const client = localServiceClient(endpoint);
	const status = await client.request({ type: "status" }, signal);
	if (status.type !== "status" || status.installationId !== (installationId ?? null))
		throw new ConfigurationError("The operator owner is unavailable.");
	const assets = new Map<string, { contentType: string; body: Uint8Array }>();
	for (const [path, contentType] of [
		["/", "text/html; charset=utf-8"],
		["/bootstrap.js", "text/javascript; charset=utf-8"],
		["/style.css", "text/css; charset=utf-8"],
	] as const) {
		const file = path === "/" ? "index.html" : path.slice(1);
		const body = await readFile(new URL(`../../web-dist/${file}`, import.meta.url)).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				throw new ConfigurationError(
					"Browser assets are missing. Build the application workspace or reinstall a complete signed release.",
				);
			},
		);
		assets.set(path, { contentType, body });
	}
	const origin = `http://127.0.0.1:${port}`;
	const gateway = createWebGateway({
		client,
		workspaceId: createHash("sha256").update(JSON.stringify([installationId ?? null, endpoint])).digest("hex"),
		origin,
		assets,
		managed: managed !== undefined,
		managedReview:
			installationId !== undefined && client.session === "default"
				? (view) => reviewManagedMission(installationId, view)
				: undefined,
	});
	let staging: string | undefined;
	let published: BigIntStats | undefined;
	try {
		if (managed === undefined) {
			gateway.server.listen(port, "127.0.0.1");
			await once(gateway.server, "listening");
		} else {
			const directory = await prepareManagedDirectory(managed.home, managed.uid);
			staging = await mkdtemp(join(directory, ".listener-"));
			const bindPath = join(staging, "s");
			// Node unlinks its bound path on close. Give it a separate name so cleanup cannot unlink a replacement at the public path.
			const mask = process.umask();
			process.umask(mask | 0o077);
			try {
				// A filesystem path is bound synchronously. Never hold a process-wide umask across an await.
				gateway.server.listen({ path: bindPath, exclusive: true });
			} finally {
				process.umask(mask);
			}
			await once(gateway.server, "listening");
			await chmod(bindPath, 0o600);
			const socket = await lstat(bindPath, { bigint: true });
			await link(bindPath, managed.path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
				throw new ConfigurationError(
					`Managed web socket path already exists: ${managed.path}. Stop its launcher, or confirm the path is stale before removing it.`,
				);
			});
			published = socket;
		}
		write(
			`Browser workspace: ${origin}\n${managed === undefined ? "" : `Managed socket: ${managed.path}\n`}Ctrl+C detaches the web workspace; agent work continues.\n`,
		);
		if (!signal.aborted)
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return 0;
	} finally {
		try {
			// Keep the staging link until after this identity check so the inode cannot be reused.
			if (managed !== undefined && published !== undefined) await removePublishedSocket(managed.path, published);
		} finally {
			try {
				await gateway.close();
			} finally {
				if (staging !== undefined) await rmdir(staging);
			}
		}
	}
}

function managedListener(installationId: string): { home: string; uid: number; path: string } {
	const uid = process.getuid?.();
	if (
		uid === undefined ||
		uid === 0 ||
		uid !== process.geteuid?.() ||
		["SUDO_UID", "SUDO_USER", "SUDO_GID", "SUDO_COMMAND"].some((key) => process.env[key] !== undefined)
	)
		throw new ConfigurationError("Run the web command as an authorized operator without sudo.");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId))
		throw new ConfigurationError("Invalid operator installation identity.");
	const { homedir: home } = userInfo();
	if (!home.startsWith("/") || home === "/" || resolve(home) !== home)
		throw new ConfigurationError("The operator requires a protected, absolute account home directory.");
	const path = join(home, ".unit-001", "web", `${installationId}.sock`);
	if (Buffer.byteLength(path) > 103) throw new ConfigurationError("The managed web socket path is too long.");
	return { home, uid, path };
}

async function prepareManagedDirectory(home: string, uid: number): Promise<string> {
	let directory = "/";
	for (const component of ["", ...home.slice(1).split("/")]) {
		directory = join(directory, component);
		const entry = await lstat(directory);
		if (
			!entry.isDirectory() ||
			(entry.mode & 0o022) !== 0 ||
			(entry.uid !== uid && (directory === home || entry.uid !== 0))
		)
			throw new ConfigurationError(`The operator home path is not protected: ${directory}.`);
	}
	for (const component of [".unit-001", "web"]) {
		directory = join(directory, component);
		await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const entry = await lstat(directory);
		if (!entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o7777) !== 0o700)
			throw new ConfigurationError(`The web socket directory must be operator-owned with mode 0700: ${directory}.`);
	}
	return directory;
}

async function removePublishedSocket(path: string, published: BigIntStats): Promise<void> {
	try {
		const entry = await lstat(path, { bigint: true });
		if (entry.isSocket() && entry.dev === published.dev && entry.ino === published.ino) await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function reviewManagedMission(installationId: string, view: MissionView): Promise<ManagedMissionReview | undefined> {
	const authority = await readMissionAuthority({ kind: "managed", installationId, session: "default" }).catch(() => null);
	if (authority === null) return undefined;
	const active = view.formation.agreement;
	const verifiedApproval =
		active !== null && active.terms.policy.deadlineAt > Date.now()
			? matchingApproval(authority, active.approval.receiptId, active.missionId, active.revision, active.terms)
			: undefined;
	return { armed: false, proposal: agreementReview(view.formation.draft, authority), verifiedApproval };
}
