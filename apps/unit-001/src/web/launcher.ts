// Starts a browser workspace as the authorized operator.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { type BigIntStats, constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError } from "../errors.ts";
import { matchingApproval, type MissionLocation, readMissionAuthority } from "../missions/authority.ts";
import { agreementReview } from "../missions/browser-agreement.ts";
import type { MissionView } from "../missions/contract.ts";
import { matchingPlanApproval, planDigest } from "../missions/plan-authority.ts";
import { operatorEndpoint, type ServiceResponse } from "../service.ts";
import { localServiceClient, type ServiceClient } from "../service-client.ts";
import { createWebGateway, type WebGateway } from "./gateway.ts";
import { readInheritedWebListener } from "./inherited-listener.ts";
import { acquireListenerLock } from "./listener-lock.ts";
import { clearListenerResidue } from "./listener-residue.ts";
import type { ManagedMissionReview, WebPlanReview } from "./post-response.ts";

type OwnerStatus = Extract<ServiceResponse, { type: "status" }>;
type WatchedSocket = { path: string; identity: Pick<BigIntStats, "dev" | "ino"> };

/** Serves packaged browser assets until interrupted. */
export async function runWebWorkspace(
	endpoint: string,
	port: number,
	write: (text: string) => void,
	signal: AbortSignal,
	installationId?: string,
	developerDirectory?: string,
): Promise<number> {
	if (signal.aborted) return 130;
	const managed = installationId === undefined ? undefined : managedListener(installationId);
	const client = localServiceClient(endpoint);
	const status = await client.request({ type: "status" }, signal);
	if (status.type !== "status" || status.installationId !== (installationId ?? null))
		throw new ConfigurationError("The operator owner is unavailable.");
	const origin = `http://127.0.0.1:${port}`;
	const gateway = await loadWorkspaceGateway(client, endpoint, origin, { installationId, developerDirectory });
	let releaseLock: (() => Promise<void>) | undefined;
	try {
		if (managed === undefined) {
			gateway.server.listen(port, "127.0.0.1");
			await once(gateway.server, "listening");
		} else {
			const directory = await prepareManagedDirectory(managed.home, managed.uid);
			// Held until the gateway has closed, so no other launcher can take the socket path while it is in use.
			releaseLock = await acquireListenerLock(join(directory, `${managed.installationId}.lock`), managed.uid);
			await clearListenerResidue(directory, managed.path, managed.installationId, managed.uid);
			const mask = process.umask();
			process.umask(mask | 0o077);
			try {
				// A filesystem path is bound synchronously. Never hold a process-wide umask across an await.
				gateway.server.listen({ path: managed.path, exclusive: true });
			} finally {
				process.umask(mask);
			}
			await once(gateway.server, "listening");
			await chmod(managed.path, 0o600);
		}
		write(
			`Browser workspace: ${origin}\n${managed === undefined ? "" : `Managed socket: ${managed.path}\n`}Ctrl+C detaches the web workspace; agent work continues.\n`,
		);
		if (!signal.aborted)
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return 0;
	} finally {
		try {
			// Node unlinks the bound socket path when the server closes. A killed launcher leaves it for the next start.
			await gateway.close();
		} finally {
			await releaseLock?.();
		}
	}
}

const activationTimeoutMs = 5_000;
const ownerPollIntervalMs = 1_000;
const ownerProbeTimeoutMs = 1_000;

/** Attaches to the system manager's private listener without creating or removing its socket path. */
export async function runActivatedWebWorkspace(installationId: string, signal: AbortSignal): Promise<number> {
	if (signal.aborted) return 130;
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new ConfigurationError("Timed out starting the activated web workspace.")),
		activationTimeoutMs,
	);
	const startup = AbortSignal.any([signal, deadline.signal]);
	let gateway: WebGateway | undefined;
	try {
		const uid = managedOperatorUid();
		const endpoint = operatorEndpoint(installationId, "default");
		const directory = "/run/unit-001-web";
		const path = join(directory, `${installationId}.sock`);
		for (const parent of ["/run", directory]) {
			const entry = await lstat(parent);
			if (!entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) !== 0)
				throw new ConfigurationError(`The activated web socket directory must be administrator-owned: ${parent}.`);
		}
		const socket = await lstat(path, { bigint: true });
		if (!socket.isSocket() || socket.uid !== BigInt(uid) || (socket.mode & 0o7777n) !== 0o600n)
			throw new ConfigurationError("The activated web socket must belong to the selected operator with mode 0600.");
		const fd = await readInheritedWebListener(path);
		const ownerSocket = await lstat(endpoint, { bigint: true });
		if (!ownerSocket.isSocket()) throw new ConfigurationError("The operator owner socket is unavailable.");
		const sockets = [{ path, identity: socket }, { path: endpoint, identity: ownerSocket }];
		const client = localServiceClient(endpoint);
		const initial = await client.request({ type: "status" }, startup);
		if (initial.type !== "status" || initial.installationId !== installationId)
			throw new ConfigurationError("The operator owner is unavailable.");
		const origin = "http://127.0.0.1:4317";
		gateway = await loadWorkspaceGateway(client, endpoint, origin, { installationId, startup });
		const owner = await client.request({ type: "status" }, startup);
		if (!sameOwner(initial, owner) || owner.inhibited || owner.maintenance.state !== "open")
			throw new ConfigurationError("The operator owner is not open for web activation.");
		await checkActivatedSelection(installationId, uid, owner.version);
		await checkSocketIdentities(sockets);
		startup.throwIfAborted();
		gateway.server.listen({ fd, exclusive: true });
		await once(gateway.server, "listening", { signal: startup });
		startup.throwIfAborted();
		clearTimeout(timer);
		process.stdout.write(`Browser workspace: ${origin}\nManaged socket: ${path}\n`);
		await monitorActivatedOwner(client, owner, sockets, signal);
		return 0;
	} catch (error) {
		throw deadline.signal.reason ?? error;
	} finally {
		clearTimeout(timer);
		await gateway?.close();
	}
}

async function checkSocketIdentities(sockets: readonly WatchedSocket[]): Promise<void> {
	for (const { path, identity } of sockets) {
		const current = await lstat(path, { bigint: true });
		if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino)
			throw new ConfigurationError(`The activated workspace socket changed: ${path}.`);
	}
}

function sameOwner(initial: OwnerStatus, current: ServiceResponse): current is OwnerStatus {
	return (
		current.type === "status" &&
		current.installationId === initial.installationId &&
		current.pid === initial.pid &&
		current.runtime.startedAt === initial.runtime.startedAt
	);
}

async function monitorActivatedOwner(
	client: ServiceClient,
	owner: OwnerStatus,
	sockets: readonly WatchedSocket[],
	signal: AbortSignal,
): Promise<void> {
	try {
		while (!signal.aborted) {
			await delay(ownerPollIntervalMs, undefined, { signal });
			await checkSocketIdentities(sockets);
			const probe = AbortSignal.any([signal, AbortSignal.timeout(ownerProbeTimeoutMs)]);
			const current = await client.request({ type: "status" }, probe);
			// Maintenance affects owner admission. A healthy held owner still serves this workspace.
			if (!sameOwner(owner, current)) throw new ConfigurationError("The operator owner changed.");
		}
	} catch (error) {
		if (!signal.aborted) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new ConfigurationError(`Activated web workspace lost its owner or listener: ${reason}`);
		}
	}
}

async function loadWorkspaceGateway(
	client: ServiceClient,
	endpoint: string,
	origin: string,
	options: { installationId?: string; developerDirectory?: string; startup?: AbortSignal },
): Promise<WebGateway> {
	const { installationId, developerDirectory, startup } = options;
	const assets = new Map<string, { contentType: string; body: Uint8Array }>();
	for (const [path, contentType] of [
		["/", "text/html; charset=utf-8"],
		["/bootstrap.js", "text/javascript; charset=utf-8"],
		["/style.css", "text/css; charset=utf-8"],
	] as const) {
		const file = path === "/" ? "index.html" : path.slice(1);
		const body = await readFile(new URL(`../../web-dist/${file}`, import.meta.url), { signal: startup }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				throw new ConfigurationError(
					"Browser assets are missing. Build the application workspace or reinstall a complete signed release.",
				);
			},
		);
		assets.set(path, { contentType, body });
	}
	const location: MissionLocation | undefined =
		client.session !== "default"
			? undefined
			: installationId !== undefined
				? { kind: "managed", installationId, session: client.session }
				: developerDirectory !== undefined
					? { kind: "developer-local", directory: developerDirectory, session: client.session }
					: undefined;
	return createWebGateway({
		client,
		workspaceId: createHash("sha256").update(JSON.stringify([installationId ?? null, endpoint])).digest("hex"),
		origin,
		assets,
		managed: installationId !== undefined,
		...(startup === undefined ? {} : { inheritedUnixListener: true as const }),
		managedReview:
			installationId !== undefined && client.session === "default"
				? (view) => reviewManagedMission(installationId, view)
				: undefined,
		planReview: location === undefined ? undefined : (view) => reviewPlan(location, view),
	});
}

async function checkActivatedSelection(installationId: string, uid: number, version: string): Promise<void> {
	const directory = `/etc/unit-001/agents/${installationId}`;
	for (const path of ["/etc", "/etc/unit-001", "/etc/unit-001/agents", directory]) {
		const entry = await lstat(path);
		if (!entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) !== 0)
			throw new ConfigurationError("The activated web selection directory is untrusted.");
	}
	const installation = await readActivatedRecord(join(directory, "installation.json"));
	const selection = await readActivatedRecord(join(directory, "web-activation.json"));
	if (
		installation.schemaVersion !== 1 ||
		installation.id !== installationId ||
		installation.releaseVersion !== version ||
		installation.desiredState !== "running" ||
		selection.schemaVersion !== 1 ||
		selection.id !== installationId ||
		selection.state !== "configured" ||
		selection.uid !== uid
	)
		throw new ConfigurationError("The managed web selection is no longer active.");
}

async function readActivatedRecord(path: string): Promise<Record<string, unknown>> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const entry = await file.stat();
		if (!entry.isFile() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 || entry.size > 4096)
			throw new ConfigurationError("The activated web selection record is untrusted.");
		const value: unknown = JSON.parse(await file.readFile("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new ConfigurationError("The activated web selection record is invalid.");
		return value as Record<string, unknown>;
	} finally {
		await file.close();
	}
}

function managedOperatorUid(): number {
	const uid = process.getuid?.();
	if (
		uid === undefined ||
		uid === 0 ||
		uid !== process.geteuid?.() ||
		["SUDO_UID", "SUDO_USER", "SUDO_GID", "SUDO_COMMAND"].some((key) => process.env[key] !== undefined)
	)
		throw new ConfigurationError("Run the web command as an authorized operator without sudo.");
	return uid;
}

function managedListener(installationId: string): { installationId: string; home: string; uid: number; path: string } {
	const uid = managedOperatorUid();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId))
		throw new ConfigurationError("Invalid operator installation identity.");
	const { homedir: home } = userInfo();
	if (!home.startsWith("/") || home === "/" || resolve(home) !== home)
		throw new ConfigurationError("The operator requires a protected, absolute account home directory.");
	const path = join(home, ".unit-001", "web", `${installationId}.sock`);
	if (Buffer.byteLength(path) > 103) throw new ConfigurationError("The managed web socket path is too long.");
	return { installationId, home, uid, path };
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

async function reviewManagedMission(installationId: string, view: MissionView): Promise<ManagedMissionReview | undefined> {
	const authority = await readMissionAuthority({ kind: "managed", installationId, session: "default" }).catch(() => null);
	if (authority === null) return undefined;
	const active = view.formation.agreement;
	const verifiedApproval =
		active !== null && active.terms.policy.deadlineAt > Date.now()
			? matchingApproval(authority, active.approval.receiptId, active.missionId, active.revision, active.terms)
			: undefined;
	return { proposal: agreementReview(view.formation.draft, authority), verifiedApproval };
}

async function reviewPlan(location: MissionLocation, view: MissionView): Promise<WebPlanReview | undefined> {
	const authority = await readMissionAuthority(location).catch(() => null);
	if (authority === null) return undefined;
	const plan = view.plan;
	const head = plan?.head;
	const approval = plan?.missionId && head
		? matchingPlanApproval(authority, head.receiptId, plan.missionId, head.revision, head.previousDigest, head.terms)
		: undefined;
	const draft = plan?.draft;
	const draftDigest = plan?.missionId && draft?.status === "proposed"
		? planDigest(draft.terms, plan.missionId, draft.revision, head?.digest ?? null, authority)
		: null;
	const purpose = view.purpose;
	// The owner status identifies its current purpose. A protected receipt must attest to the same tuple.
	const receipt = authority.purposeApprovals?.at(-1);
	const managed = location.kind === "managed";
	const runnablePurposeBinding =
		purpose && receipt &&
		purpose.missionId === receipt.missionId &&
		purpose.revision === receipt.revision &&
		purpose.digest === receipt.digest &&
		receipt.installationId === authority.installationId &&
		receipt.session === authority.session &&
		receipt.authorityRevision === authority.revision &&
		receipt.provenance === (managed ? "managed-administrator" : "developer-local") &&
		receipt.approvedBy.kind === (managed ? "local-creator" : "developer-local") &&
		receipt.approvedBy.uid === authority.creator.uid &&
		(!managed || (authority.creator.uid !== null && authority.creator.uid !== 0)) &&
		receipt.creator.id === authority.creator.id &&
		receipt.creator.kind === authority.creator.kind &&
		receipt.creator.uid === authority.creator.uid
			? { missionId: receipt.missionId, purposeRevision: receipt.revision, purposeDigest: receipt.digest }
			: null;
	return {
		canAgree: !managed && view.planError == null,
		headValid: approval !== undefined && approval.digest === head?.digest,
		openUnderHead:
			approval !== undefined &&
			authority.operationIntent?.action === "open" &&
			authority.operationIntent.authorityRevision === authority.revision &&
			authority.operationIntent.planDigest === approval.digest,
		draftDigest: draftDigest === draft?.digest ? draftDigest : null,
		runnablePurposeBinding,
	};
}
