// Connects the channel foundation to one owner and drains external setup before maintenance or close.
import type { Context } from "@earendil-works/chord/context";
import type { Extension, Harness } from "@earendil-works/pi-durable";
import type { MissionLocation } from "../missions/authority.ts";
import { readChannelAuthority } from "./authority.ts";
import type { ChannelAdapter } from "./contract.ts";
import { type ChannelCommand, type ChannelResult, handleChannelCommand } from "./control.ts";
import { ChannelCredentials } from "./credentials.ts";
import { channelExtension } from "./extension.ts";
import { ChannelDoc, changeChannels } from "./registry.ts";
import type { ChannelAuthorityReader, ChannelSetupAdapter } from "./setup.ts";
import { TELEGRAM_ADAPTER, TelegramClient } from "./telegram.ts";
import { telegramSetupAdapter } from "./telegram-setup.ts";

export type ChannelHost = {
	extension: Extension;
	/** The one adapter catalog both the model tools and direct owner commands admit requests against. */
	adapters: readonly ChannelAdapter[];
	readAuthority: ChannelAuthorityReader;
	setupAdapters: readonly ChannelSetupAdapter[];
};

/** Assembles only implemented adapters; no credentials are read and no network call occurs at owner startup. */
export function defaultChannelHost(location: MissionLocation, credentialDirectory: string): ChannelHost {
	const adapters = [TELEGRAM_ADAPTER];
	const readAuthority = () => readChannelAuthority(location);
	const setupAdapters = [
		telegramSetupAdapter(new ChannelCredentials(credentialDirectory), new TelegramClient(), Date.now),
	];
	return {
		adapters,
		readAuthority,
		setupAdapters,
		extension: channelExtension(adapters, readAuthority, setupAdapters),
	};
}

export class ChannelOwner {
	readonly #harness: Harness;
	readonly #host: ChannelHost;
	readonly #pending = new Map<AbortController, Promise<void>>();

	constructor(harness: Harness, host: ChannelHost) {
		this.#harness = harness;
		this.#host = host;
	}

	/** Reports direct setup calls which must settle before storage can be backed up or closed. */
	get pending(): number {
		return this.#pending.size;
	}

	/** Cancels only setup transport; persisted unknown outcomes remain available for explicit reconciliation. */
	abort(): void {
		for (const controller of this.#pending.keys()) controller.abort();
	}

	/** Joins all direct setup calls; it never runs a new setup or replays an external effect. */
	async drain(): Promise<void> {
		this.abort();
		await Promise.all(this.#pending.values());
	}

	/** Runs bounded host-granted channel operations through the same store as model tools; callers pass parsed commands. */
	async request(input: ChannelCommand, context: Context): Promise<ChannelResult> {
		if (input.operation !== "setup" && input.operation !== "reconcile")
			return this.execute(input, context, context.abortSignal);
		const controller = new AbortController();
		let finish = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.#pending.set(controller, done);
		try {
			return await this.execute(
				input,
				context,
				context.abortSignal ? AbortSignal.any([controller.signal, context.abortSignal]) : controller.signal,
			);
		} finally {
			this.#pending.delete(controller);
			finish();
		}
	}

	private execute(input: ChannelCommand, context: Context, signal: AbortSignal | undefined): Promise<ChannelResult> {
		return handleChannelCommand(
			input,
			{
				read: () => this.#harness.snapshot(ChannelDoc, context),
				commit: (change) => this.#harness.commit((tx) => changeChannels(tx, change), context),
			},
			this.#host.readAuthority,
			this.#host.adapters,
			this.#host.setupAdapters,
			Date.now,
			{ signal },
		);
	}
}
