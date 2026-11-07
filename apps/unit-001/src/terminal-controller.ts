// Controls an attached terminal through the single storage owner's bounded local protocol.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { requestService, type ServiceView, watchService } from "./service.ts";

/** Latest bounded service view and client state; presentation must sanitize all untrusted strings. */
export interface TerminalState {
	readonly connection: "connecting" | "attached" | "detached" | "failed";
	readonly view?: ServiceView;
	readonly sending: boolean;
	readonly cancelling: boolean;
	readonly notices: readonly string[];
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
	return new OwnerTerminalController(endpoint, onChange, signal);
}

const HELP = "/help /status /cancel /exit /detach. Detaching does not cancel admitted work.";
const MAX_INPUT_BYTES = 16_384;

class OwnerTerminalController implements TerminalController {
	readonly closed: Promise<number>;
	readonly #resolveClose: (code: number) => void;
	readonly #endpoint: string;
	readonly #onChange: (state: TerminalState) => void;
	readonly #signal: AbortSignal;
	readonly #local = new AbortController();
	readonly #onSignal: () => void;
	#state: TerminalState = { connection: "connecting", sending: false, cancelling: false, notices: [] };
	#cancelAfterAdmission = false;
	#finished = false;
	#startup: ReturnType<typeof setTimeout> | undefined;

	constructor(endpoint: string, onChange: (state: TerminalState) => void, signal: AbortSignal) {
		this.#endpoint = endpoint;
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
			this.#notice("Service did not provide initial state within 5 seconds.");
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
			this.#notice(HELP);
			return { status: "command" };
		}
		if (text === "/status") {
			const view = this.#state.view;
			this.#notice(
				view === undefined
					? "Connecting to the service."
					: `${view.name}: ${view.busy ? "working" : "ready"}; session ${basename(this.#endpoint, ".sock")}; PID ${view.pid}; version ${view.version}.`,
			);
			return { status: "command" };
		}
		if (text === "/cancel") {
			this.cancel();
			return { status: "command" };
		}
		if (text.startsWith("/")) {
			this.#notice(`Unknown command. ${HELP}`);
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
		this.#notice("Detached; detaching does not cancel admitted work.");
		this.#finish("detached", 0);
	}

	async #observe(): Promise<void> {
		try {
			await watchService(
				this.#endpoint,
				(view) => {
					clearTimeout(this.#startup);
					this.#state = { ...this.#state, connection: "attached", view };
					this.#publish();
					if (this.#cancelAfterAdmission && view.busy) this.cancel();
				},
				this.#local.signal,
			);
			if (!this.#finished) this.#finish("detached", 0);
		} catch (error) {
			if (this.#finished) return;
			this.#notice(`Service disconnected: ${describeError(error)}. Reattach to inspect persisted work.`);
			this.#finish("failed", 1);
		}
	}

	async #send(text: string, requestId: string): Promise<void> {
		try {
			const response = await requestService(
				this.#endpoint,
				{ type: "send", prompt: text, requestId },
				this.#local.signal,
			);
			if (this.#finished) return;
			// The watch is authoritative for transcript output; never duplicate an answer from the send reply.
			if (response.type === "error") this.#notice(response.message);
			else if (response.type === "reply" && response.reply.status === "failed")
				this.#notice(
					`Unanswered: ${response.reply.reason}${response.reply.detail === undefined ? "" : ` (${response.reply.detail})`}`,
				);
		} catch (error) {
			if (!this.#finished) this.#notice(`Send failed: ${describeError(error)}; retry request ${requestId}.`);
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
			const response = await requestService(this.#endpoint, { type: "cancel" }, this.#local.signal);
			if (!this.#finished)
				this.#notice(
					response.type === "error" ? response.message : "Cancellation requested; waiting for service state.",
				);
		} catch (error) {
			if (!this.#finished) this.#notice(`Cancel failed: ${describeError(error)}`);
		} finally {
			if (!this.#finished) {
				this.#state = { ...this.#state, cancelling: false };
				this.#publish();
			}
		}
	}

	#notice(text: string): void {
		const notice = text.length > 1024 ? `${text.slice(0, 1000)} [notice truncated]` : text;
		this.#state = { ...this.#state, notices: [...this.#state.notices.slice(-7), notice] };
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
