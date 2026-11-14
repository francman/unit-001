// Reconnects observations only; writes always remain single attempts with explicit uncertainty.
import { setTimeout as delay } from "node:timers/promises";
import { requestService, type ServiceRequest, type ServiceResponse, watchService } from "../service.ts";
import type { ServiceClient, ServiceClientEvent } from "../service-client.ts";
import type { RemoteProfile } from "./profiles.ts";
import { openRemoteTunnel, type RemoteTunnel } from "./ssh.ts";

export interface RemoteServiceClient extends ServiceClient {
	close(): Promise<void>;
}

class RemoteIdentityError extends Error {}

/** Verifies the pinned installation before exposing a client capable of submitting work. */
export async function connectRemoteClient(
	profile: RemoteProfile,
	session: string,
	signal: AbortSignal,
): Promise<RemoteServiceClient> {
	const client = new SshServiceClient(profile, session, signal);
	try {
		await client.connect();
		return client;
	} catch (error) {
		await client.close();
		throw error;
	}
}

class SshServiceClient implements RemoteServiceClient {
	readonly session: string;
	readonly ownerSession: string;
	readonly #profile: RemoteProfile;
	readonly #remoteSession: string;
	readonly #local = new AbortController();
	readonly #signal: AbortSignal;
	readonly #abort: () => void;
	#tunnel: RemoteTunnel | undefined;
	#watching = false;
	#stopped = false;
	#ready = false;
	#cleanup: Promise<void> | undefined;

	constructor(profile: RemoteProfile, session: string, signal: AbortSignal) {
		this.#profile = profile;
		this.#remoteSession = session;
		this.session = `${session}@${profile.name}`;
		this.ownerSession = session;
		this.#signal = signal;
		this.#abort = () => {
			void this.close();
		};
		signal.addEventListener("abort", this.#abort, { once: true });
		if (signal.aborted) this.#abort();
	}

	async connect(): Promise<void> {
		this.#local.signal.throwIfAborted();
		const tunnel = await openRemoteTunnel(this.#profile, this.#remoteSession, this.#local.signal);
		try {
			const response = await requestService(
				tunnel.endpoint,
				{ type: "status" },
				AbortSignal.any([this.#local.signal, AbortSignal.timeout(5_000)]),
			);
			if (response.type !== "status" || response.installationId !== this.#profile.installationId)
				throw new RemoteIdentityError(
					"Remote installation identity does not match the saved profile; no work was submitted.",
				);
			this.#local.signal.throwIfAborted();
			this.#tunnel = tunnel;
			this.#ready = !this.#watching;
		} catch (error) {
			await tunnel.close();
			throw error;
		}
	}

	async request(request: ServiceRequest, signal: AbortSignal): Promise<ServiceResponse> {
		const tunnel = this.#tunnel;
		if (tunnel === undefined || !this.#ready || this.#stopped)
			throw new Error("Remote is disconnected; this request was not sent. Wait for a fresh view before retrying.");
		try {
			return await requestService(tunnel.endpoint, request, AbortSignal.any([signal, this.#local.signal]));
		} catch (error) {
			const id =
				request.type === "send"
					? request.requestId
					: request.type === "memory" && "requestId" in request.request
						? request.request.requestId
						: undefined;
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${id === undefined ? "" : `Retain request ID ${id}; inspect persisted state before an explicit retry. `}No request was replayed. ${message}`,
			);
		}
	}

	async watch(listener: (event: ServiceClientEvent) => void, signal: AbortSignal): Promise<void> {
		if (this.#watching) throw new Error("This remote client already has a terminal watch.");
		this.#watching = true;
		const combined = AbortSignal.any([signal, this.#local.signal]);
		let failures = 0;
		try {
			while (!combined.aborted) {
				try {
					const tunnel = this.#tunnel;
					if (tunnel === undefined) throw new Error("Remote is disconnected.");
					const initial = new AbortController();
					const deadline = setTimeout(() => initial.abort(), 5_000);
					try {
						await watchService(
							tunnel.endpoint,
							(view) => {
								if (view.installationId !== this.#profile.installationId)
									throw new RemoteIdentityError("Remote installation identity changed; reconnect refused.");
								clearTimeout(deadline);
								this.#ready = true;
								failures = 0;
								listener({ type: "view", view });
							},
							AbortSignal.any([combined, initial.signal]),
						);
					} finally {
						clearTimeout(deadline);
					}
					if (combined.aborted) return;
					throw new Error("Remote watch ended.");
				} catch (error) {
					if (combined.aborted) return;
					const previous = this.#tunnel;
					this.#tunnel = undefined;
					this.#ready = false;
					await previous?.close();
					if (error instanceof RemoteIdentityError) throw error;
					if (++failures > 5)
						throw new Error("Remote reconnect limit reached. Reopen the profile to inspect persisted work.", {
							cause: error,
						});
					listener({
						type: "connecting",
						message: `Remote disconnected. Reconnecting view (${failures}/5); drafts retained and requests never replayed.`,
					});
					await delay(Math.min(250 * 2 ** (failures - 1), 4_000), undefined, { signal: combined });
					try {
						await this.connect();
					} catch (reconnectError) {
						if (combined.aborted) return;
						if (reconnectError instanceof RemoteIdentityError) throw reconnectError;
						if (failures === 5) throw reconnectError;
					}
				}
			}
		} finally {
			this.#watching = false;
		}
	}

	close(): Promise<void> {
		this.#cleanup ??= (async () => {
			this.#stopped = true;
			this.#local.abort();
			this.#signal.removeEventListener("abort", this.#abort);
			const tunnel = this.#tunnel;
			this.#tunnel = undefined;
			await tunnel?.close();
		})();
		return this.#cleanup;
	}
}
