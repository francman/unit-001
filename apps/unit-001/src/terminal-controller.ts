// Controls an attached terminal through the single storage owner's bounded local protocol.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Agent, Reply } from "./agent.ts";
import { ATTACH_HELP } from "./attach-help.ts";
import { requestService, type ServiceView, watchService } from "./service.ts";
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
	return new OwnerTerminalController(
		{
			session: basename(endpoint, ".sock"),
			ownership: "attached",
			watch: (listener, signal) => watchService(endpoint, listener, signal),
			async send(prompt, requestId, signal) {
				const response = await requestService(endpoint, { type: "send", prompt, requestId }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "reply") throw new Error("The service returned an unexpected send response.");
				return response.reply;
			},
			async cancel(signal) {
				const response = await requestService(endpoint, { type: "cancel" }, signal);
				if (response.type === "error") throw new Error(response.message);
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
		},
		onChange,
		signal,
	);
}

interface ConversationTransport {
	readonly session: string;
	readonly ownership: "attached" | "foreground";
	watch(listener: (view: ServiceView) => void, signal: AbortSignal): Promise<void>;
	send(prompt: string, requestId: string, signal: AbortSignal): Promise<Reply>;
	cancel(signal: AbortSignal): Promise<void>;
}

const HELP = `${ATTACH_HELP}\nDefault rich controls: PageUp/PageDown scroll; Ctrl+Shift+F searches the displayed transcript when forwarded by the terminal; Enter/Shift+Enter moves between matches; Esc closes search.\nUsage covers conversation-model estimates, excluding tool/subagent costs and subscription billing.`;
const FOREGROUND_HELP =
	"/help /status /cancel /exit. Ctrl+C cancels while busy and exits when idle. Ctrl+D or /exit closes this foreground session; unfinished work resumes on the next launch. The managed agent runs independently.";
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
		if (text === "/exit" || text === "/detach") {
			this.detach();
			return { status: "command" };
		}
		if (text === "/help") {
			this.#notice(this.#transport.ownership === "attached" ? HELP : FOREGROUND_HELP);
			return { status: "command" };
		}
		if (text === "/status") {
			const view = this.#state.view;
			this.#notice(
				view === undefined
					? "Connecting to the service."
					: `${view.name}: ${view.busy ? "working" : "ready"}; session ${this.#transport.session}; PID ${view.pid}; version ${view.version}.`,
			);
			return { status: "command" };
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
		if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
			this.#notice("Prompt exceeds 16 KiB; it was not submitted.");
			return { status: "rejected" };
		}
		const requestId = randomUUID();
		if (Buffer.byteLength(`${JSON.stringify({ type: "send", prompt: text, requestId })}\n`) > 65_536) {
			this.#notice("Encoded prompt exceeds 64 KiB; it was not submitted.");
			return { status: "rejected" };
		}
		this.#state = { ...this.#state, sending: true };
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
			await this.#transport.watch((view) => {
				clearTimeout(this.#startup);
				this.#state = { ...this.#state, connection: "attached", view };
				this.#publish();
				if (this.#cancelAfterAdmission && view.busy) this.cancel();
			}, this.#local.signal);
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
			if (this.#finished) return;
			// The watch is authoritative for transcript output; never duplicate an answer from the send reply.
			if (reply.status === "failed")
				this.#notice(`Unanswered: ${reply.reason}${reply.detail === undefined ? "" : ` (${reply.detail})`}`, "error");
		} catch (error) {
			if (!this.#finished) this.#notice(`Send failed: ${describeError(error)}; retry request ${requestId}.`, "error");
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
