// Journals bounded setup attempts and checks fresh creator grants before every external step.
import { randomUUID } from "node:crypto";
import type { MissionAuthority } from "../missions/contract.ts";
import { type ChannelAuthority, matchingChannelGrant } from "./authority.ts";
import type { ChannelOutcome, ChannelRequest, ChannelState } from "./contract.ts";

export type ChannelStore = {
	read(): Promise<ChannelState | undefined>;
	commit<T>(change: (state: ChannelState) => T): Promise<T>;
};

export type ChannelSetupAdapter = {
	id: string;
	/** Read-only reconciliation may repeat; adapters must never blindly repeat a creation effect. */
	prepare(request: ChannelRequest, authorized: () => Promise<void>, signal?: AbortSignal): Promise<ChannelOutcome>;
};

export type ChannelAuthorityReader = () => Promise<{
	creator: MissionAuthority;
	channels: ChannelAuthority | null;
} | null>;

type SetupAdmission =
	| { kind: "observed"; outcome: ChannelOutcome }
	| { kind: "admitted"; attemptId: string; grantId: string; adapter: ChannelSetupAdapter };

/** Runs one journaled attempt; a restart preserves unknown outcomes until an explicit reconciliation. */
export async function runChannelSetup(
	channelId: string,
	store: ChannelStore,
	readAuthority: ChannelAuthorityReader,
	adapters: readonly ChannelSetupAdapter[],
	now: () => number,
	options: { reconcile?: boolean; signal?: AbortSignal } = {},
): Promise<ChannelOutcome> {
	const record = (await store.read())?.channels[channelId];
	if (!record) throw new Error("Unknown channel setup request.");
	const request = record.request;
	const authority = await readAuthority();
	if (authority?.channels?.disabled.includes(channelId)) return { kind: "disabled" };
	// Missing permission is a current observation, not a new result of the journaled attempt.
	if (!authority || !matchingChannelGrant(request, authority, now())) return { kind: "awaiting_creator", step: "grant" };
	if (record.outcome.kind === "disabled") return record.outcome;
	if (record.outcome.kind === "ready" && !record.attempt) return record.outcome;
	if (record.attempt && !options.reconcile) return { kind: "unknown", attemptId: record.attempt.id };
	const admission = await store.commit((state): SetupAdmission => {
		const current = state.channels[channelId];
		if (current?.request.digest !== request.digest) throw new Error("Channel setup changed.");
		const startedAt = now();
		const grant = matchingChannelGrant(current.request, authority, startedAt);
		if (!grant) return { kind: "observed", outcome: { kind: "awaiting_creator", step: "grant" } };
		// A competing caller can finish and clear its attempt after our snapshot.
		if (current.outcome.kind === "disabled" || (current.outcome.kind === "ready" && !current.attempt))
			return { kind: "observed", outcome: { ...current.outcome } };
		if (current.attempt?.id !== record.attempt?.id) throw new Error("Channel setup changed.");
		const adapter = adapters.find((value) => value.id === request.adapter);
		if (!adapter) throw new Error("Channel setup adapter is unavailable.");
		const attemptId = randomUUID();
		current.attempt = { id: attemptId, grantId: grant.id, startedAt };
		current.outcome = { kind: "unknown", attemptId };
		state.revision++;
		return { kind: "admitted", attemptId, grantId: grant.id, adapter };
	});
	if (admission.kind === "observed") return admission.outcome;
	const { adapter, attemptId, grantId } = admission;
	const authorized = async () => {
		options.signal?.throwIfAborted();
		const fresh = await readAuthority();
		if (!fresh || matchingChannelGrant(request, fresh, now())?.id !== grantId)
			throw new Error("Channel permission changed.");
		const current = (await store.read())?.channels[channelId];
		if (current?.request.digest !== request.digest || current.attempt?.id !== attemptId)
			throw new Error("Channel setup superseded.");
	};
	let outcome: ChannelOutcome;
	try {
		await authorized();
		outcome = await adapter.prepare(request, authorized, options.signal);
		await authorized();
	} catch {
		// Adapter exceptions may contain tokens or remote text; only a fixed operational code is persisted.
		outcome = { kind: "unknown", attemptId };
	}
	return store.commit((state) => {
		const current = state.channels[channelId];
		if (current?.request.digest !== request.digest || current.attempt?.id !== attemptId)
			throw new Error("Channel setup superseded.");
		current.outcome = outcome;
		if (outcome.kind !== "unknown") current.attempt = null;
		if (outcome.kind === "ready") current.lastHealth = { observedAt: outcome.observedAt, healthy: true };
		else if (outcome.kind === "failed") current.lastHealth = { observedAt: now(), healthy: false };
		state.revision++;
		return outcome;
	});
}
