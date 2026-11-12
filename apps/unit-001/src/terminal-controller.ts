// Controls an attached terminal through the single storage owner's bounded local protocol.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Agent, Reply } from "./agent.ts";
import { ATTACH_HELP } from "./attach-help.ts";
import { describeMemory, type MemoryRequest, type MemoryResult, memoryCommand } from "./memory-control.ts";
import type { RuntimeFacts } from "./orientation.ts";
import type { ServiceView } from "./service.ts";
import { localServiceClient, type ServiceClient } from "./service-client.ts";
import { serviceView } from "./service-view.ts";

export interface TerminalNotice {
	readonly kind: "info" | "error";
	readonly text: string;
}

/** Latest bounded service view and client state; presentation must sanitize all untrusted strings. */
export interface TerminalState {
	readonly connection: "connecting" | "attached" | "detached" | "failed";
	readonly view?: ServiceView;
	readonly sending: boolean;
	readonly cancelling: boolean;
	readonly notices: readonly TerminalNotice[];
	readonly unresolvedRequestIds?: readonly string[];
}

/** A rejected input must stay in the editor; commands and admitted sends may clear it. */
export type TerminalInputResult =
	| { readonly status: "submitted"; readonly requestId: string }
	| { readonly status: "command" }
	| { readonly status: "rejected" };

/** Owns client connections only; detaching never aborts service work. */
export interface TerminalController {
	readonly state: TerminalState;
	readonly closed: Promise<number>;
	submit(text: string): TerminalInputResult;
	cancel(): void;
	detach(): void;
}

/** Connects a terminal controller without opening storage or creating another agent owner. */
export function createTerminalController(
	endpoint: string,
	onChange: (state: TerminalState) => void,
	signal: AbortSignal,
): TerminalController {
	return createServiceTerminalController(localServiceClient(endpoint), onChange, signal);
}

/** Attaches the same terminal controller to a local or authenticated remote owner. */
export function createServiceTerminalController(
	client: ServiceClient,
	onChange: (state: TerminalState) => void,
	signal: AbortSignal,
): TerminalController {
	return new OwnerTerminalController(
		{
			session: client.session,
			ownership: "attached",
			watch: (listener, signal, connecting) =>
				client.watch((event) => {
					if (event.type === "view") listener(event.view);
					else connecting(event.message);
				}, signal),
			async send(prompt, requestId, signal) {
				const response = await client.request({ type: "send", prompt, requestId }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "reply") throw new Error("The service returned an unexpected send response.");
				return response.reply;
			},
			async cancel(signal) {
				const response = await client.request({ type: "cancel" }, signal);
				if (response.type === "error") throw new Error(response.message);
			},
			async memory(request, signal) {
				const response = await client.request({ type: "memory", request }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "memory") throw new Error("Unexpected memory response.");
				return response.result;
			},
			async runtime(signal) {
				const response = await client.request({ type: "status" }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "status") throw new Error("Unexpected status response.");
				return response.runtime;
			},
		},
		onChange,
		signal,
	);
}

/** Uses the already-open foreground owner with the same view, admission and cancellation controls. */
export function createForegroundTerminalController(
	agent: Agent,
	session: string,
	version: string,
	onChange: (state: TerminalState) => void,
	signal: AbortSignal,
): TerminalController {
	return new OwnerTerminalController(
		{
			session,
			ownership: "foreground",
			async watch(listener, signal) {
				const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
				const abort = () => cancel();
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				const watch = await agent.watchConversation(context);
				try {
					const identity = { pid: process.pid, version, name: agent.name, installationId: null };
					listener(serviceView(watch.value, identity));
					watch.start(async (call) => {
						if (call.kind === "value") listener(serviceView(call.value, identity));
						else throw call.error;
					});
					const end = await watch.closed;
					if (end.kind === "failed" || end.kind === "listener_error") throw end.error;
				} finally {
					signal.removeEventListener("abort", abort);
					await watch.stop();
					cancel();
				}
			},
			async send(prompt, requestId, signal) {
				signal.throwIfAborted();
				return agent.ask(prompt, BACKGROUND_CONTEXT, { requestId });
			},
			async cancel(signal) {
				signal.throwIfAborted();
				await agent.abort(BACKGROUND_CONTEXT);
			},
			async memory(request, signal) {
				signal.throwIfAborted();
				return agent.memory(request, BACKGROUND_CONTEXT);
			},
			async runtime(signal) {
				signal.throwIfAborted();
				return (await agent.status(BACKGROUND_CONTEXT)).runtime;
			},
		},
		onChange,
		signal,
	);
}

interface ConversationTransport {
	readonly session: string;
	readonly ownership: "attached" | "foreground";
	watch(
		listener: (view: ServiceView) => void,
		signal: AbortSignal,
		connecting: (message: string) => void,
	): Promise<void>;
	send(prompt: string, requestId: string, signal: AbortSignal): Promise<Reply>;
	cancel(signal: AbortSignal): Promise<void>;
	memory(request: MemoryRequest, signal: AbortSignal): Promise<MemoryResult>;
	runtime(signal: AbortSignal): Promise<RuntimeFacts>;
}

const HELP = `${ATTACH_HELP}\nDefault rich controls: PageUp/PageDown scroll; Ctrl+Shift+F searches the displayed transcript when forwarded by the terminal; Enter/Shift+Enter moves between matches; Esc closes search.\nUsage covers conversation-model estimates, excluding tool/subagent costs and subscription billing.`;
const FOREGROUND_HELP =
	"/help /status /memory [stats|recall <query>|remember <text>|forget <id>|sleep] /cancel /exit. Ctrl+C cancels while busy and exits when idle. Ctrl+D or /exit closes this foreground session; unfinished work resumes on the next launch. The managed agent runs independently.";
const MAX_INPUT_BYTES = 16_384;

class OwnerTerminalController implements TerminalController {
	readonly closed: Promise<number>;
	readonly #resolveClose: (code: number) => void;
	readonly #transport: ConversationTransport;
	readonly #onChange: (state: TerminalState) => void;
	readonly #signal: AbortSignal;
	readonly #local = new AbortController();
	readonly #onSignal: () => void;
	#state: TerminalState = { connection: "connecting", sending: false, cancelling: false, notices: [] };
	#cancelAfterAdmission = false;
	#finished = false;
	#startup: ReturnType<typeof setTimeout> | undefined;
	#forget: { readonly id: string; readonly requestId: string } | undefined;

	constructor(transport: ConversationTransport, onChange: (state: TerminalState) => void, signal: AbortSignal) {
		this.#transport = transport;
		this.#onChange = onChange;
		this.#signal = signal;
		this.#onSignal = () => this.detach();
		const closed = Promise.withResolvers<number>();
		this.closed = closed.promise;
		this.#resolveClose = closed.resolve;
		this.#publish();
		if (signal.aborted) {
			this.detach();
			return;
		}
		signal.addEventListener("abort", this.#onSignal, { once: true });
		this.#startup = setTimeout(() => {
			this.#notice("Agent did not provide initial state within 5 seconds.", "error");
			this.#finish("failed", 1);
		}, 5_000);
		void this.#observe();
	}

	get state(): TerminalState {
		return this.#state;
	}

	submit(input: string): TerminalInputResult {
		if (this.#finished) return { status: "rejected" };
		const text = input.trim();
		if (this.#forget !== undefined) {
			const pending = this.#forget;
			this.#forget = undefined;
			if (text.toLowerCase() === "yes") void this.#memory({ operation: "forget", ...pending, confirmed: true });
			else this.#notice("Forget cancelled.");
			return { status: "command" };
		}
		if (text === "/exit" || text === "/detach") {
			this.detach();
			return { status: "command" };
		}
		if (text === "/help") {
			this.#notice(this.#transport.ownership === "attached" ? HELP : FOREGROUND_HELP);
			return { status: "command" };
		}
		if (text === "/status") {
			if (this.#state.unresolvedRequestIds?.length)
				this.#notice(
					`Unconfirmed requests: ${this.#state.unresolvedRequestIds.join(", ")}. Inspect persisted work before retrying.`,
				);
			const view = this.#state.view;
			this.#notice(
				view === undefined
					? "Connecting to the service."
					: `${this.#state.connection === "attached" ? "" : "Last observed (disconnected): "}${view.name}: ${view.busy ? "working" : "ready"}; session ${this.#transport.session}; PID ${view.pid}; version ${view.version}.`,
			);
			void this.#status();
			return { status: "command" };
		}
		if (text === "/memory" || text.startsWith("/memory ")) {
			try {
				const match = /^\/memory(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(text);
				const request = memoryCommand(match?.[1], match?.[2]);
				if (request.operation === "confirm-forget") {
					this.#forget = { id: request.id, requestId: request.requestId };
					this.#notice(
						`Forget ${request.id}? Type yes to confirm; any other input cancels. Conversation history remains. [No]`,
					);
				} else void this.#memory(request);
				return { status: "command" };
			} catch (error) {
				this.#notice(describeError(error), "error");
				return { status: "rejected" };
			}
		}
		if (text === "/cancel") {
			this.cancel();
			return { status: "command" };
		}
		if (text.startsWith("/")) {
			this.#notice(`Unknown command. ${this.#transport.ownership === "attached" ? HELP : FOREGROUND_HELP}`);
			return { status: "rejected" };
		}
		if (text === "") return { status: "command" };
		if (this.#state.connection !== "attached") {
			this.#notice("Still connecting; the prompt was not submitted.");
			return { status: "rejected" };
		}
		if (this.#state.sending) {
			this.#notice(
				"A submission is pending. Wait, cancel, or detach; additional prompts are not queued by this client.",
			);
			return { status: "rejected" };
		}
		if ((this.#state.unresolvedRequestIds?.length ?? 0) >= 8) {
			this.#notice(
				"Eight requests have unconfirmed outcomes. Detach to retain their IDs and inspect the owner before submitting more.",
				"error",
			);
			return { status: "rejected" };
		}
		if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
			this.#notice("Prompt exceeds 16 KiB; it was not submitted.");
			return { status: "rejected" };
		}
		const requestId = randomUUID();
		if (Buffer.byteLength(`${JSON.stringify({ type: "send", prompt: text, requestId })}\n`) > 65_536) {
			this.#notice("Encoded prompt exceeds 64 KiB; it was not submitted.");
			return { status: "rejected" };
		}
		this.#state = {
			...this.#state,
			sending: true,
			unresolvedRequestIds: [...(this.#state.unresolvedRequestIds ?? []), requestId],
		};
		this.#notice(`Submitting request ${requestId}; retry with this --request-id after a disconnect.`);
		void this.#send(text, requestId);
		return { status: "submitted", requestId };
	}

	cancel(): void {
		if (this.#finished || this.#state.cancelling) return;
		if (this.#state.connection !== "attached") {
			this.#notice("Not attached; no cancellation was sent.");
			return;
		}
		if (this.#state.sending && !this.#state.view?.busy) {
			this.#cancelAfterAdmission = true;
			this.#notice("Cancellation queued until the submitted work is visible.");
			return;
		}
		this.#cancelAfterAdmission = false;
		this.#state = { ...this.#state, cancelling: true };
		this.#publish();
		void this.#cancel();
	}

	detach(): void {
		if (this.#finished) return;
		this.#notice(
			this.#transport.ownership === "attached"
				? "Detached; detaching does not cancel admitted work."
				: "Closing the foreground session; unfinished work can resume on the next launch.",
		);
		this.#finish("detached", 0);
	}

	async #observe(): Promise<void> {
		try {
			await this.#transport.watch(
				(view) => {
					clearTimeout(this.#startup);
					this.#state = { ...this.#state, connection: "attached", view };
					this.#publish();
					if (this.#cancelAfterAdmission && view.busy) this.cancel();
				},
				this.#local.signal,
				(message) => {
					clearTimeout(this.#startup);
					this.#cancelAfterAdmission = false;
					this.#forget = undefined;
					this.#state = { ...this.#state, connection: "connecting" };
					this.#notice(message);
				},
			);
			if (!this.#finished) this.#finish("detached", 0);
		} catch (error) {
			if (this.#finished) return;
			this.#notice(`Service disconnected: ${describeError(error)}. Reattach to inspect persisted work.`, "error");
			this.#finish("failed", 1);
		}
	}

	async #send(text: string, requestId: string): Promise<void> {
		try {
			const reply = await this.#transport.send(text, requestId, this.#local.signal);
			this.#state = {
				...this.#state,
				unresolvedRequestIds: this.#state.unresolvedRequestIds?.filter((id) => id !== requestId),
			};
			if (this.#finished) return;
			// The watch is authoritative for transcript output; never duplicate an answer from the send reply.
			if (reply.status === "failed")
				this.#notice(`Unanswered: ${reply.reason}${reply.detail === undefined ? "" : ` (${reply.detail})`}`, "error");
		} catch (error) {
			if (!this.#finished) this.#notice(`Send failed; retry request ${requestId}: ${describeError(error)}`, "error");
		} finally {
			this.#cancelAfterAdmission = false;
			if (!this.#finished) {
				this.#state = { ...this.#state, sending: false };
				this.#publish();
			}
		}
	}

	async #cancel(): Promise<void> {
		try {
			await this.#transport.cancel(this.#local.signal);
			if (!this.#finished) this.#notice("Cancellation requested; waiting for service state.");
		} catch (error) {
			if (!this.#finished) this.#notice(`Cancel failed: ${describeError(error)}`, "error");
		} finally {
			if (!this.#finished) {
				this.#state = { ...this.#state, cancelling: false };
				this.#publish();
			}
		}
	}

	async #memory(request: MemoryRequest): Promise<void> {
		try {
			const result = await this.#transport.memory(request, this.#local.signal);
			if (!this.#finished) {
				if (result.operation === "recall") {
					if (result.records.length === 0) this.#notice(describeMemory(result));
					for (const record of result.records) {
						const points = Array.from(record.content);
						const content =
							points.length > 700
								? `${points.slice(0, 700).join("")}… [preview truncated; use memory recall in the terminal]`
								: record.content;
						this.#notice(describeMemory({ operation: "recall", records: [{ ...record, content }] }));
					}
				} else this.#notice(describeMemory(result));
			}
		} catch (error) {
			if (!this.#finished) this.#notice(`Memory: ${describeError(error)}`, "error");
		}
	}

	async #status(): Promise<void> {
		try {
			const facts = await this.#transport.runtime(this.#local.signal);
			if (!this.#finished)
				this.#notice(
					`${facts.name}: ${this.#state.view?.busy ? "working" : "ready"}; session ${this.#transport.session}; PID ${facts.pid}; ${facts.provider}/${facts.modelId}; started ${new Date(facts.startedAt).toISOString()}; uptime ${Math.floor(facts.uptimeMs / 1000)}s; observed ${new Date(facts.observedAt).toISOString()}.`,
				);
		} catch (error) {
			if (!this.#finished) this.#notice(`Status: ${describeError(error)}`, "error");
		}
	}

	#notice(text: string, kind: TerminalNotice["kind"] = "info"): void {
		const notice = text.length > 1024 ? `${text.slice(0, 1000)} [notice truncated]` : text;
		this.#state = { ...this.#state, notices: [...this.#state.notices.slice(-7), { kind, text: notice }] };
		this.#publish();
	}

	#publish(): void {
		this.#onChange(this.#state);
	}

	#finish(connection: "detached" | "failed", code: number): void {
		if (this.#finished) return;
		this.#finished = true;
		clearTimeout(this.#startup);
		this.#signal.removeEventListener("abort", this.#onSignal);
		this.#local.abort();
		this.#state = { ...this.#state, connection, sending: false, cancelling: false };
		this.#publish();
		this.#resolveClose(code);
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
