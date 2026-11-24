// Controls an attached terminal through the single storage owner's bounded local protocol.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Agent, Reply } from "./agent.ts";
import { ATTACH_HELP } from "./attach-help.ts";
import type { CommandDefinition } from "./commands/catalog.ts";
import type { CommandInterpretation } from "./commands/interpretation.ts";
import {
	activityLabel,
	classifySlashInput,
	confirmsForget,
	interpretedCommands,
	isEvidenceCallId,
	MAX_INTERPRETED_INPUT,
	MAX_PROMPT_BYTES,
	parseMemorySlash,
	unknownCommandNotice,
} from "./commands/slash.ts";
import { describeInspection, inspectionText } from "./introspection/command.ts";
import type { InspectionQuery, InspectionWireReport } from "./introspection/contract.ts";
import { describeMemory, type MemoryRequest, type MemoryResult } from "./memory-control.ts";
import { describeMission } from "./missions/command.ts";
import type { MissionRequest, MissionView } from "./missions/contract.ts";
import type { RuntimeFacts } from "./orientation.ts";
import { type SendAdmission, sendDigest } from "./send-receipt.ts";
import type { ServiceView } from "./service.ts";
import { localServiceClient, type ServiceClient } from "./service-client.ts";
import { serviceView } from "./service-view.ts";
import type { ToolEvidence } from "./tool-evidence.ts";

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
	readonly suggestions?: readonly CommandDefinition[];
	readonly suggesting?: boolean;
	readonly unresolvedRequestIds?: readonly string[];
	/** Sends whose text goes back to the user (newest eight); each left `unresolvedRequestIds` on its latest attempt. */
	readonly returnedSends?: readonly ReturnedSend[];
	/** The latest explicitly requested tool evidence; it never arrives in watch frames. */
	readonly evidence?: ToolEvidence;
}

/**
 * A send answered with an error whose text goes back to the user, and what the owner's record said about its ID:
 * `not-found`, no record, so the same text may go again under the ID and is still admitted at most once; `rejected`,
 * the ID belongs to another prompt or operation; `unverified`, the ID was admitted but the owner cannot show it was
 * this text. After `rejected` or `unverified` a resend needs a new ID.
 */
export interface ReturnedSend {
	readonly requestId: string;
	readonly reason: "not-found" | "rejected" | "unverified";
}

/** One send as dispatched: its request ID and the digest of the exact prompt the owner receives. */
export interface PendingSend {
	readonly requestId: string;
	readonly digest: string;
}

/** A rejected input must stay in the editor; commands and admitted sends may clear it. */
export type TerminalInputResult =
	| ({ readonly status: "submitted" } & PendingSend)
	| { readonly status: "command" }
	| { readonly status: "mission-setup" }
	| { readonly status: "rejected" };

/** How a prompt is sent; both fields are optional. */
export interface SendOptions {
	/** Resends an unconfirmed prompt under its own ID; the owner admits it at most once. */
	readonly replayRequestId?: string | undefined;
	/**
	 * Runs once the ID is chosen and before the request leaves this client, so the caller can make the ID durable: a
	 * client that crashes after the owner admits the send must still find the ID on the next attach. `hold` means it
	 * could not, and the send never leaves; the caller keeps its text. A held retry of an ID whose earlier attempt is
	 * still unresolved leaves that ID unresolved.
	 */
	readonly beforeDispatch?: (send: PendingSend) => Promise<"dispatch" | "hold">;
}

/** Owns client connections only; detaching never aborts service work. */
export interface TerminalController {
	readonly state: TerminalState;
	readonly closed: Promise<number>;
	/** Runs a command or sends a prompt; see `SendOptions` for replaying an unconfirmed send. */
	submit(text: string, options?: SendOptions): TerminalInputResult;
	/** Cancels all work in the chat, including other clients' queued inputs; it is not scoped to one send. */
	cancel(): void;
	detach(): void;
	dismissSuggestions(): void;
	/** Asks the owner whether a send was admitted, without resending or waiting for it. */
	admission(requestId: string, digest: string | undefined): Promise<SendAdmission>;
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
			ownerSession: client.ownerSession,
			ownership: "attached",
			watch: (listener, signal, connecting) =>
				client.watch((event) => {
					if (event.type === "view") listener(event.view);
					else connecting(event.message);
				}, signal),
			async send(prompt, requestId, signal) {
				const response = await client.request({ type: "send", prompt, requestId }, signal);
				if (response.type === "error") throw new OwnerRequestError(response.message);
				if (response.type !== "reply") throw new Error("The service returned an unexpected send response.");
				return response.reply;
			},
			async cancel(signal) {
				const response = await client.request({ type: "cancel" }, signal);
				if (response.type === "error") throw new Error(response.message);
			},
			async admission(requestId, digest, signal) {
				const request = { type: "admission", requestId, ...(digest === undefined ? {} : { digest }) } as const;
				const response = await client.request(request, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "admission") throw new Error("Unexpected admission response.");
				return response.admission;
			},
			async memory(request, signal) {
				const response = await client.request({ type: "memory", request }, signal);
				if (response.type === "error") throw new OwnerRequestError(response.message);
				if (response.type !== "memory") throw new Error("Unexpected memory response.");
				return response.result;
			},
			async runtime(signal) {
				const response = await client.request({ type: "status" }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "status") throw new Error("Unexpected status response.");
				return response.runtime;
			},
			async inspect(query, signal) {
				const response = await client.request({ type: "inspection", query }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "inspection") throw new Error("Unexpected inspection response.");
				return response.report;
			},
			async toolEvidence(callId, signal) {
				const response = await client.request({ type: "tool-evidence", callId }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "tool-evidence") throw new Error("Unexpected tool evidence response.");
				return response.evidence;
			},
			async mission(request, signal) {
				const response = await client.request({ type: "mission", request }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "mission") throw new Error("Unexpected mission response.");
				return response.result;
			},
			async resolveCommand(input, signal) {
				const response = await client.request({ type: "resolve-command", input, surface: "slash" }, signal);
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "command-suggestions") throw new Error("Unexpected command suggestions.");
				return response.result;
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
			ownerSession: session,
			ownership: "foreground",
			async watch(listener, signal) {
				const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
				const abort = () => cancel();
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				let watch: Awaited<ReturnType<Agent["watchConversation"]>>;
				try {
					watch = await withinFirstView(agent.watchConversation(context), cancel);
				} catch (error) {
					signal.removeEventListener("abort", abort);
					cancel();
					throw error;
				}
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
				// The owner finished handling the send, as with a wire error; its outcome is settled the same way.
				return agent.ask(prompt, BACKGROUND_CONTEXT, { requestId }).catch((error: unknown) => {
					throw new OwnerRequestError(describeError(error));
				});
			},
			async cancel(signal) {
				signal.throwIfAborted();
				await agent.abort(BACKGROUND_CONTEXT);
			},
			async admission(requestId, digest, signal) {
				signal.throwIfAborted();
				return agent.admission(requestId, digest, BACKGROUND_CONTEXT);
			},
			async memory(request, signal) {
				signal.throwIfAborted();
				return agent.memory(request, BACKGROUND_CONTEXT);
			},
			async runtime(signal) {
				signal.throwIfAborted();
				return (await agent.status(BACKGROUND_CONTEXT)).runtime;
			},
			async toolEvidence(callId, signal) {
				signal.throwIfAborted();
				return agent.toolEvidence(callId, BACKGROUND_CONTEXT);
			},
			async mission(request, signal) {
				signal.throwIfAborted();
				return agent.mission(request, BACKGROUND_CONTEXT);
			},
			resolveCommand: (input, signal) => agent.resolveCommand(input, "slash", BACKGROUND_CONTEXT, signal),
			async inspect(query, signal) {
				signal.throwIfAborted();
				return agent.inspect(query, BACKGROUND_CONTEXT);
			},
		},
		onChange,
		signal,
	);
}

interface ConversationTransport {
	readonly session: string;
	readonly ownerSession: string;
	readonly ownership: "attached" | "foreground";
	watch(
		listener: (view: ServiceView) => void,
		signal: AbortSignal,
		connecting: (message: string) => void,
	): Promise<void>;
	send(prompt: string, requestId: string, signal: AbortSignal): Promise<Reply>;
	cancel(signal: AbortSignal): Promise<void>;
	admission(requestId: string, digest: string | undefined, signal: AbortSignal): Promise<SendAdmission>;
	memory(request: MemoryRequest, signal: AbortSignal): Promise<MemoryResult>;
	runtime(signal: AbortSignal): Promise<RuntimeFacts>;
	mission(request: MissionRequest, signal: AbortSignal): Promise<MissionView>;
	inspect(query: InspectionQuery, signal: AbortSignal): Promise<InspectionWireReport>;
	toolEvidence(callId: string, signal: AbortSignal): Promise<ToolEvidence>;
	resolveCommand(input: string, signal: AbortSignal): Promise<CommandInterpretation>;
}

const HELP = `${ATTACH_HELP}\nDefault rich controls: PageUp/PageDown scroll; Ctrl+Shift+F searches the displayed transcript when forwarded by the terminal; Enter/Shift+Enter moves between matches; Esc closes search.\nUsage covers conversation-model estimates, excluding tool/subagent costs and subscription billing.`;
const FOREGROUND_HELP =
	"/help /status /evidence [CALL_ID|close] /mission [setup] /memory [stats|recall <query>|remember <text>|forget <id>|sleep] /cancel /exit. /cancel stops all work in this chat, including queued inputs, not only your latest send. Ctrl+C cancels while busy and exits when idle. Ctrl+D or /exit closes this foreground session; unfinished work resumes on the next launch. The managed agent runs independently.";

// A wire error acknowledges the request; transport failures leave its outcome unknown.
class OwnerRequestError extends Error {}

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
	#forget: { readonly id: string; readonly requestId: string } | undefined;
	#interpretation: AbortController | undefined;
	/** Sequence of the newest evidence request; a reply carrying an older number is stale. */
	#evidenceRequest = 0;

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
		void this.#observe();
	}

	get state(): TerminalState {
		return this.#state;
	}

	submit(input: string, options: SendOptions = {}): TerminalInputResult {
		if (this.#finished) return { status: "rejected" };
		if (this.#forget !== undefined) {
			const pending = this.#forget;
			this.#forget = undefined;
			if (confirmsForget(input)) void this.#memory({ operation: "forget", ...pending, confirmed: true });
			else this.#notice("Forget cancelled.");
			return { status: "command" };
		}
		this.dismissSuggestions();
		const command = classifySlashInput(input);
		switch (command.kind) {
			case "suggestions":
				this.#showSuggestions(command.commands);
				return { status: "rejected" };
			case "unresolved":
				void this.#suggest(command.text);
				return { status: "rejected" };
			case "exit":
				this.detach();
				return { status: "command" };
			case "help":
				this.#notice(this.#transport.ownership === "attached" ? HELP : FOREGROUND_HELP);
				return { status: "command" };
			case "status":
				this.#showStatus();
				return { status: "command" };
			case "mission":
				if (command.setup) return { status: "mission-setup" };
				void this.#mission();
				return { status: "command" };
			case "evidence":
				return this.#evidenceCommand(command.argument);
			case "inspect":
				try {
					void this.#inspect(inspectionText(command.text));
					return { status: "command" };
				} catch (error) {
					this.#notice(describeError(error), "error");
					return { status: "rejected" };
				}
			case "memory":
				return this.#memoryCommand(command.text);
			case "cancel":
				this.cancel();
				return { status: "command" };
			case "unknown":
				this.#notice(unknownCommandNotice(this.#transport.ownership === "attached" ? HELP : FOREGROUND_HELP));
				return { status: "rejected" };
			case "empty":
				return { status: "command" };
			case "prompt":
				return this.#submitPrompt(command.text, options);
		}
	}

	// The last observed view answers at once; the owner is then asked for its runtime facts.
	#showStatus(): void {
		if (this.#state.unresolvedRequestIds?.length)
			this.#notice(
				`Unconfirmed requests: ${this.#state.unresolvedRequestIds.join(", ")}. Inspect persisted work before retrying.`,
			);
		const view = this.#state.view;
		this.#notice(
			view === undefined
				? "Connecting to the service."
				: `${this.#state.connection === "attached" ? "" : "Last observed (disconnected): "}${view.name}: ${activityLabel(view.busy)}; session ${this.#transport.session}; PID ${view.pid}; version ${view.version}.`,
		);
		void this.#status();
	}

	#memoryCommand(text: string): TerminalInputResult {
		try {
			const request = parseMemorySlash(text);
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

	#submitPrompt(text: string, options: SendOptions): TerminalInputResult {
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
		if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
			this.#notice("Prompt exceeds 16 KiB; it was not submitted.");
			return { status: "rejected" };
		}
		const requestId = options.replayRequestId ?? randomUUID();
		if (Buffer.byteLength(`${JSON.stringify({ type: "send", prompt: text, requestId })}\n`) > 65_536) {
			this.#notice("Encoded prompt exceeds 64 KiB; it was not submitted.");
			return { status: "rejected" };
		}
		this.#evidenceRequest++;
		const unresolved = this.#state.unresolvedRequestIds ?? [];
		// A retry of a send whose outcome is still unknown must keep its ID unresolved if this attempt is held.
		const earlier = unresolved.includes(requestId) ? "unresolved" : "settled";
		this.#state = {
			...this.#state,
			sending: true,
			evidence: undefined,
			unresolvedRequestIds: [...unresolved.filter((id) => id !== requestId), requestId],
		};
		this.#notice(`Submitting request ${requestId}; retry with this --request-id after a disconnect.`);
		const send = { requestId, digest: sendDigest(text) };
		void this.#send(text, send, earlier, options.beforeDispatch);
		return { status: "submitted", ...send };
	}

	admission(requestId: string, digest: string | undefined): Promise<SendAdmission> {
		if (this.#finished || this.#state.connection !== "attached")
			return Promise.reject(new Error("Not attached; the owner was not asked."));
		return this.#transport.admission(requestId, digest, this.#local.signal);
	}

	/** Cancels only auxiliary interpretation and removes its suggestions; conversation work is unaffected. */
	dismissSuggestions(): void {
		this.#interpretation?.abort();
		this.#interpretation = undefined;
		if (this.#state.suggestions === undefined && !this.#state.suggesting) return;
		this.#state = { ...this.#state, suggestions: undefined, suggesting: false };
		this.#publish();
	}

	#showSuggestions(commands: readonly CommandDefinition[]): void {
		this.#state = { ...this.#state, suggestions: commands, suggesting: false };
		this.#publish();
	}

	async #suggest(input: string): Promise<void> {
		if (input.length > MAX_INTERPRETED_INPUT || this.#state.connection !== "attached") {
			this.#notice(unknownCommandNotice("Use /help for available commands."));
			return;
		}
		const pending = new AbortController();
		this.#interpretation = pending;
		this.#state = { ...this.#state, suggesting: true };
		this.#publish();
		try {
			const result = await this.#transport.resolveCommand(input, AbortSignal.any([pending.signal, this.#local.signal]));
			if (pending.signal.aborted || this.#finished) return;
			const commands = interpretedCommands(result);
			if (commands.length > 0) this.#showSuggestions(commands);
			else this.#notice(result.explanation);
		} catch (error) {
			if (!pending.signal.aborted && !this.#finished)
				this.#notice(`Command suggestions unavailable: ${describeError(error)}. Use /help.`);
		} finally {
			if (this.#interpretation === pending) {
				this.#interpretation = undefined;
				this.#state = { ...this.#state, suggesting: false };
				this.#publish();
			}
		}
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

	// The transport's watch owns its first-view deadline; the controller adds no timer that could pre-empt its recovery.
	async #observe(): Promise<void> {
		try {
			await this.#transport.watch(
				(view) => {
					const first = this.#state.view === undefined;
					this.#state = { ...this.#state, connection: "attached", view };
					this.#publish();
					if (this.#cancelAfterAdmission && view.busy) this.cancel();
					if (first && this.#transport.ownerSession === "default") void this.#mission(true);
				},
				this.#local.signal,
				(message) => {
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

	// A held attempt never left this client, so the ID keeps the state it had before it: an earlier attempt whose outcome
	// is unknown stays unresolved, because dropping it would let the caller forget an ID the owner may have admitted.
	async #send(
		text: string,
		send: PendingSend,
		earlier: "unresolved" | "settled",
		beforeDispatch: SendOptions["beforeDispatch"],
	): Promise<void> {
		const { requestId } = send;
		try {
			if ((await beforeDispatch?.(send)) === "hold") {
				if (earlier === "settled") this.#acknowledge(requestId);
				if (!this.#finished) this.#notice(`Request ${requestId} was not sent.`);
				return;
			}
			// A new attempt under the ID supersedes an earlier attempt's return: only the owner's latest answer counts.
			this.#state = {
				...this.#state,
				returnedSends: this.#state.returnedSends?.filter((returned) => returned.requestId !== requestId),
			};
			const reply = await this.#transport.send(text, requestId, this.#local.signal);
			this.#acknowledge(requestId);
			if (this.#finished) return;
			// The watch is authoritative for transcript output; never duplicate an answer from the send reply.
			if (reply.status === "failed")
				this.#notice(`Unanswered: ${reply.reason}${reply.detail === undefined ? "" : ` (${reply.detail})`}`, "error");
		} catch (error) {
			if (error instanceof OwnerRequestError) await this.#settleRefusal(send, error);
			else if (!this.#finished) this.#notice(`Send failed; retry request ${requestId}: ${describeError(error)}`, "error");
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
			if (!this.#finished)
				this.#notice("Cancelling all work in this chat, including queued inputs; waiting for service state.");
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
		const requestId = "requestId" in request ? request.requestId : undefined;
		if (requestId !== undefined) {
			if (this.#state.connection !== "attached") {
				this.#notice("Not attached; the memory request was not sent.");
				return;
			}
			if ((this.#state.unresolvedRequestIds?.length ?? 0) >= 8) {
				this.#notice("Eight requests have unconfirmed outcomes. Inspect persisted work before sending more.", "error");
				return;
			}
			this.#state = {
				...this.#state,
				unresolvedRequestIds: [...(this.#state.unresolvedRequestIds ?? []), requestId],
			};
			this.#publish();
		}
		try {
			const result = await this.#transport.memory(request, this.#local.signal);
			if (requestId !== undefined) this.#acknowledge(requestId);
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
			if (requestId !== undefined && error instanceof OwnerRequestError) this.#acknowledge(requestId);
			if (!this.#finished) this.#notice(`Memory: ${describeError(error)}`, "error");
		}
	}

	// A wire error ends the owner's handling of the request, yet it can follow the admission commit (a reply over 1 MiB
	// is replaced by an error), so the owner's record decides; the error alone never discards the ID. With no record the
	// ID stays reusable: an earlier client's request under it may still be in transit, and only the same ID keeps the
	// owner from admitting the text twice. An admission settles the ID, but only an exact binding shows it was this text.
	async #settleRefusal(send: PendingSend, error: OwnerRequestError): Promise<void> {
		let admission: SendAdmission;
		try {
			admission = await this.#transport.admission(send.requestId, send.digest, this.#local.signal);
		} catch (lookup) {
			if (!this.#finished)
				this.#notice(
					`Send failed: ${describeError(error)}. Request ${send.requestId} stays unconfirmed; asking the owner about it failed: ${describeError(lookup)}`,
					"error",
				);
			return;
		}
		if (admission.status === "admitted" && admission.binding === "exact") {
			this.#acknowledge(send.requestId);
			if (!this.#finished)
				this.#notice(`The owner admitted request ${send.requestId} but replied with an error: ${describeError(error)}`, "error");
			return;
		}
		if (admission.status === "admitted") {
			this.#acknowledge(send.requestId, { requestId: send.requestId, reason: "unverified" });
			if (!this.#finished)
				this.#notice(
					`The owner admitted request ${send.requestId} but cannot confirm it was this text, and replied with an error: ${describeError(error)}`,
					"error",
				);
			return;
		}
		this.#acknowledge(send.requestId, { requestId: send.requestId, reason: admission.status });
		if (!this.#finished) this.#notice(`Not sent: ${describeError(error)}`, "error");
	}

	// A returned send is recorded (newest eight) so a client can tell it from an answer and give the text back.
	#acknowledge(requestId: string, returned?: ReturnedSend): void {
		this.#state = {
			...this.#state,
			unresolvedRequestIds: this.#state.unresolvedRequestIds?.filter((id) => id !== requestId),
			...(returned === undefined ? {} : { returnedSends: [...(this.#state.returnedSends ?? []), returned].slice(-8) }),
		};
		this.#publish();
	}

	async #status(): Promise<void> {
		try {
			const facts = await this.#transport.runtime(this.#local.signal);
			if (!this.#finished)
				this.#notice(
					`${facts.name}: ${activityLabel(this.#state.view?.busy === true)}; session ${this.#transport.session}; PID ${facts.pid}; ${facts.configuration === "unconfigured" ? "provider not configured" : `${facts.provider}/${facts.modelId}`}; started ${new Date(facts.startedAt).toISOString()}; uptime ${Math.floor(facts.uptimeMs / 1000)}s; observed ${new Date(facts.observedAt).toISOString()}.`,
				);
		} catch (error) {
			if (!this.#finished) this.#notice(`Status: ${describeError(error)}`, "error");
		}
	}

	async #inspect(query: InspectionQuery): Promise<void> {
		try {
			const report = await this.#transport.inspect(query, this.#local.signal);
			if (!this.#finished) this.#notice(describeInspection(report));
		} catch (error) {
			if (!this.#finished) this.#notice(`Inspection: ${describeError(error)}`, "error");
		}
	}

	// `/evidence` names a call; with no argument it uses the newest tool card. The owner is asked only here.
	#evidenceCommand(argument: string): TerminalInputResult {
		if (argument === "close") {
			this.#evidenceRequest++;
			this.#state = { ...this.#state, evidence: undefined };
			this.#publish();
			return { status: "command" };
		}
		const callId = argument === "" ? this.#state.view?.tools.at(-1)?.callId : argument;
		if (callId === undefined || !isEvidenceCallId(callId)) {
			this.#notice(
				callId === undefined ? "No tool call to inspect yet." : "Use /evidence [CALL_ID] or /evidence close.",
				"error",
			);
			return { status: "rejected" };
		}
		void this.#evidence(callId, ++this.#evidenceRequest);
		return { status: "command" };
	}

	// A reply for a request that a newer request, `/evidence close` or a submitted prompt superseded is dropped.
	async #evidence(callId: string, request: number): Promise<void> {
		try {
			const evidence = await this.#transport.toolEvidence(callId, this.#local.signal);
			if (this.#finished || request !== this.#evidenceRequest) return;
			this.#state = { ...this.#state, evidence };
			this.#publish();
		} catch (error) {
			if (!this.#finished && request === this.#evidenceRequest)
				this.#notice(`Evidence: ${describeError(error)}`, "error");
		}
	}

	async #mission(initial = false): Promise<void> {
		try {
			const view = await this.#transport.mission({ operation: "status" }, this.#local.signal);
			if (this.#finished) return;
			if (initial) {
				if (!view.agreementValid)
					this.#notice(
						"No verified mission agreement. Use /mission setup to form a saved draft; ordinary work remains available. Autonomous execution requires an approved mission and explicit start.",
					);
			} else this.#notice(describeMission(view));
		} catch (error) {
			if (!this.#finished && !initial) this.#notice(`Mission: ${describeError(error)}`, "error");
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
		this.#signal.removeEventListener("abort", this.#onSignal);
		this.#local.abort();
		this.#state = { ...this.#state, connection, sending: false, cancelling: false };
		this.#publish();
		this.#resolveClose(code);
	}
}

const FIRST_VIEW_MS = 5_000;

// The foreground watch owns its first-view deadline like every other watch client; a watch that opens after the
// deadline is stopped rather than left running with no observer.
async function withinFirstView<T extends { stop(): Promise<unknown> }>(opening: Promise<T>, cancel: () => void): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		cancel();
		deadline.reject(new Error("Agent did not provide initial state within 5 seconds"));
	}, FIRST_VIEW_MS);
	try {
		return await Promise.race([opening, deadline.promise]);
	} catch (error) {
		void opening.then((late) => late.stop()).catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
