import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type Conversation,
	type ConversationWatch,
	createRegistry,
	defineExtension,
	type Extension,
	Harness,
	LiveDoc,
	type LiveState,
	type Report,
	type Storage,
	type Submission,
	section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools, createPowerShellTool } from "@earendil-works/pi-durable/tools";
import type { ModelChoice } from "./provider.ts";

export interface AgentOptions {
	readonly storage: Storage;
	readonly name?: string;
	readonly models: Models;
	readonly model: ModelChoice;
	/** The working directory tools run in. */
	readonly cwd: string;
	readonly platform?: NodeJS.Platform;
	/** Further extensions to install, such as memory. */
	readonly extensions?: readonly Extension[];
	readonly onReport?: (report: Report) => void;
}

export type Reply =
	| { readonly status: "answered"; readonly text: string }
	| { readonly status: "failed"; readonly reason: string; readonly detail?: string };

type Message = { readonly role?: string; readonly content?: unknown };

function textOf(message: Message | undefined): string | undefined {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return (message.content as readonly { type: string; text?: string }[])
		.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
		.join("");
}

/** The unit-001 agent: one durable root conversation on a Pi Durable harness. */
export class Agent {
	readonly #harness: Harness;
	readonly name: string;
	readonly #root: Conversation;
	/** True when a run was unfinished at open; it continues in the background, so `idle()` waits for it. */
	readonly interrupted: boolean;

	private constructor(harness: Harness, root: Conversation, interrupted: boolean, name: string) {
		this.name = name;
		this.#harness = harness;
		this.#root = root;
		this.interrupted = interrupted;
	}

	/** Opens the storage's session, resuming any run the last process left unfinished. */
	static async open(options: AgentOptions, context: Context): Promise<Agent> {
		const name = options.name ?? "agent";
		const preamble = `You are ${name}, a durable coding agent. Your conversation and unfinished work survive restarts. Be concise, and say what you changed or found.`;
		const registry = createRegistry();
		registry.install(CodingTools);
		if ((options.platform ?? process.platform) === "win32") {
			registry.install(defineExtension({ name: "powershell", tools: [createPowerShellTool()] }));
		}
		registry.install(
			defineExtension({ name: "unit-001", sections: [section("preamble", () => preamble, { tag: false })] }),
		);
		for (const extension of options.extensions ?? []) registry.install(extension);

		const harness = await Harness.open(
			options.storage,
			{
				models: options.models,
				registry,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
				...(options.onReport === undefined ? {} : { onReport: options.onReport }),
			},
			context,
		);
		try {
			const root = await harness.root(context, { agent: { model: options.model } });
			// The model is stored with the session; this launch's choice wins, so changing provider keys never strands it.
			const stored = (await root.agent(context)).model;
			if (stored?.provider !== options.model.provider || stored.modelId !== options.model.modelId) {
				await root.configure({ model: options.model }, context);
			}
			const interrupted = (await harness.snapshot(LiveDoc, root.id, context))?.run !== undefined;
			harness.resume();
			return new Agent(harness, root, interrupted, name);
		} catch (error) {
			await harness.close(context).catch(() => {});
			throw error;
		}
	}

	/**
	 * Durably admits a prompt and returns without waiting for the answer. A `requestId` makes a retry after a restart
	 * find the same submission instead of submitting twice.
	 */
	submit(text: string, context: Context, options: { readonly requestId?: string } = {}): Promise<Submission> {
		return this.#root.submit(
			{ type: "input", content: text, ...(options.requestId === undefined ? {} : { requestId: options.requestId }) },
			context,
		);
	}

	/** Submits a prompt and waits for its answer. */
	async ask(text: string, context: Context, options: { readonly requestId?: string } = {}): Promise<Reply> {
		const settled = await (await this.submit(text, context, options)).wait(context);
		if (settled.status === "done" && settled.type === "input") {
			const entry = await this.#root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			return { status: "answered", text: textOf(entry?.model?.[0] as Message | undefined) ?? "" };
		}
		const reason = settled.status === "unanswered" ? settled.reason : settled.status;
		const detail =
			settled.detail === undefined
				? undefined
				: typeof settled.detail === "string"
					? settled.detail
					: JSON.stringify(settled.detail);
		return { status: "failed", reason, ...(detail === undefined ? {} : { detail }) };
	}

	/** Waits for the conversation to go idle, and returns the answer a resumed run ended with, if it ended in one. */
	async idle(context: Context): Promise<string | undefined> {
		await this.#root.waitForIdle(context);
		const { items } = await this.#root.entries({}, 1, undefined, context);
		const newest = items[0];
		return newest !== undefined && AssistantEntry.is(newest)
			? textOf(newest.model?.[0] as Message | undefined)
			: undefined;
	}

	/** Calls `listener` with each committed live state: streamed answer text and tool rounds. Returns a stop function. */
	async watch(listener: (live: LiveState | undefined) => void, context: Context): Promise<() => Promise<void>> {
		const watch = await this.#harness.watchDoc(LiveDoc, this.#root.id, context);
		if (watch === undefined) return async () => {};
		listener(watch.value);
		watch.start(async (call) => {
			if (call.kind === "value") listener(call.value);
		});
		return async () => {
			await watch.stop();
		};
	}

	/** Watches bounded transcript and live state through this session's sole storage owner. */
	watchConversation(context: Context): Promise<ConversationWatch> {
		return this.#root.watch(context, { min: 20, max: 20 });
	}

	/** Aborts the current run and its tools; the conversation keeps its history. */
	abort(context: Context): Promise<void> {
		return this.#root.abort(context);
	}

	close(context: Context): Promise<void> {
		return this.#harness.close(context);
	}

	/** Resolves when storage closes or fails, so a host can stop advertising a failed agent. */
	get closed() {
		return this.#harness.closed;
	}

	/** Reports whether the conversation has an unfinished foreground run. */
	async status(context: Context): Promise<{ readonly busy: boolean }> {
		return { busy: (await this.#harness.snapshot(LiveDoc, this.#root.id, context))?.run !== undefined };
	}
}
