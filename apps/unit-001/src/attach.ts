// Attaches a terminal to the service owner without opening storage or tying work to the client lifetime.
import { randomUUID } from "node:crypto";
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { ATTACH_HELP as HELP } from "./attach-help.ts";
import { describeCommandSuggestions } from "./commands/resolution.ts";
import {
	activityLabel,
	classifySlashInput,
	confirmsForget,
	describeInterpretation,
	isEvidenceCallId,
	MAX_INTERPRETED_INPUT,
	MAX_PROMPT_BYTES,
	MAX_PROMPT_LABEL,
	parseMemorySlash,
	unknownCommandNotice,
} from "./commands/slash.ts";
import { describeError } from "./errors.ts";
import { describeInspection, inspectionText } from "./introspection/command.ts";
import { describeMemory, type MemoryRequest } from "./memory-control.ts";
import { describeMission } from "./missions/command.ts";
import { sanitizeTerminalText } from "./render.ts";
import type { Terminal } from "./repl.ts";
import { sendDigest } from "./send-receipt.ts";
import type { ServiceView } from "./service.ts";
import { localServiceClient, type ServiceClient } from "./service-client.ts";
import { providerProblemSummary, runFailureSummary, toolFailureSummary } from "./service-view.ts";
import { evidenceLines } from "./tool-evidence.ts";

/** Runs a service terminal client; exit, EOF, signals, or connection loss never abort admitted service work. */
export async function runAttach(endpoint: string, terminal: Terminal, signal: AbortSignal): Promise<number> {
	return runServiceAttach(localServiceClient(endpoint), terminal, signal);
}

/** Uses the existing plain terminal for a local or authenticated remote service client. */
export async function runServiceAttach(
	client: ServiceClient,
	terminal: Terminal,
	signal: AbortSignal,
): Promise<number> {
	if (signal.aborted) return 0;
	const local = new AbortController();
	const renderer = new AttachedOutput(terminal);
	let reader: Interface | undefined;
	let view: ServiceView | undefined;
	let sending = false;
	let connected = false;
	let cancelling = false;
	let code = 0;
	let cancelAfterAdmission = false;
	let pendingView: ServiceView | undefined;
	let pendingNotice = "";
	let flushQueued = false;
	let forget: { readonly id: string; readonly requestId: string } | undefined;
	const paint = (write: () => void) => {
		if (reader !== undefined && terminal.output !== undefined) {
			cursorTo(terminal.output, 0);
			clearLine(terminal.output, 0);
		}
		write();
		if (reader !== undefined && terminal.output !== undefined && !local.signal.aborted) reader.prompt(true);
	};
	const flush = () => {
		if (reader?.line !== undefined && reader.line !== "" && !local.signal.aborted) return;
		paint(() => {
			if (pendingView !== undefined) {
				renderer.update(pendingView);
				pendingView = undefined;
			}
			if (pendingNotice !== "") {
				renderer.finish();
				terminal.err(pendingNotice);
				pendingNotice = "";
			}
		});
	};
	const err = (text: string) => {
		const safe = sanitizeTerminalText(text);
		if (reader?.line !== undefined && reader.line !== "" && !local.signal.aborted) {
			const combined = pendingNotice + safe;
			pendingNotice = combined.length > 8192 ? `[Earlier client notices omitted.]\n${combined.slice(-8000)}` : combined;
			return;
		}
		paint(() => {
			renderer.finish();
			terminal.err(safe);
		});
	};
	const detach = () => {
		local.abort();
		reader?.close();
	};
	// A wire error can follow the admission commit (a reply over 1 MiB becomes an error), so only the owner's record
	// says whether the send ran; until it answers, the ID must be kept for an explicit retry.
	const settleRefusal = async (requestId: string, prompt: string): Promise<string> => {
		const answer = await client
			.request({ type: "admission", requestId, digest: sendDigest(prompt) }, local.signal)
			.catch(() => undefined);
		if (answer?.type !== "admission")
			return `request ${requestId} may have been admitted; retry only with --request-id ${requestId}.`;
		const { admission } = answer;
		// Not-found is absence at the read only: the request can still commit, so only the same ID retries it safely.
		if (admission.status === "not-found")
			return `the owner has no record of request ${requestId} as of now; retry only with --request-id ${requestId}.`;
		if (admission.status === "rejected") return `request ${requestId} belongs to another prompt or operation; this prompt was not admitted under it.`;
		return admission.binding === "exact"
			? `the owner admitted request ${requestId} anyway; do not send it again.`
			: `the owner admitted request ${requestId} but cannot confirm it was this prompt; send it again only under a new request ID.`;
	};
	const onSignal = () => detach();
	signal.addEventListener("abort", onSignal, { once: true });
	const cancel = () => {
		if (cancelling || local.signal.aborted) return;
		if (!connected) {
			err("Not connected; no cancellation was sent.\n");
			return;
		}
		if (sending && view?.busy !== true) {
			cancelAfterAdmission = true;
			err("Cancellation queued until the submitted work is visible.\n");
			return;
		}
		cancelAfterAdmission = false;
		cancelling = true;
		void Promise.resolve()
			.then(() => client.request({ type: "cancel" }, local.signal))
			.then(
				(response) => {
					if (!local.signal.aborted)
						err(
							response.type === "error"
								? `${response.message}\n`
								: "Cancellation requested for all work in this chat, including queued inputs; waiting for service state.\n",
						);
				},
				(error: unknown) => {
					if (!local.signal.aborted) err(`Cancel failed: ${describeError(error)}\n`);
				},
			)
			.finally(() => {
				cancelling = false;
			});
	};
	const onLine = (line: string) => {
		if (local.signal.aborted) return;
		flush();
		const runMemory = (request: MemoryRequest) => {
			if ("requestId" in request)
				err(`Submitting memory request ${request.requestId}; retain this ID if disconnected.\n`);
			void client.request({ type: "memory", request }, local.signal).then(
				(response) => {
					if (!local.signal.aborted)
						err(
							`${response.type === "memory" ? describeMemory(response.result) : response.type === "error" ? response.message : "Unexpected memory response."}\n`,
						);
				},
				(error: unknown) => {
					if (!local.signal.aborted) err(`Memory: ${describeError(error)}\n`);
				},
			);
		};
		if (forget !== undefined) {
			const pending = forget;
			forget = undefined;
			if (confirmsForget(line)) runMemory({ operation: "forget", ...pending, confirmed: true });
			else err("Forget cancelled.\n");
			return;
		}
		const input = classifySlashInput(line);
		if (input.kind === "suggestions") {
			err(`${describeCommandSuggestions(input.commands, "slash")}\n`);
			return;
		}
		if (input.kind === "unresolved") {
			if (input.text.length <= MAX_INTERPRETED_INPUT)
				void client.request({ type: "resolve-command", input: input.text, surface: "slash" }, local.signal).then(
					(response) => {
						if (local.signal.aborted) return;
						if (response.type !== "command-suggestions") {
							err("Command suggestions unavailable. Use /help.\n");
							return;
						}
						err(`${describeInterpretation(response.result)}\n`);
					},
					() => {
						if (!local.signal.aborted) err("Command suggestions unavailable. Use /help.\n");
					},
				);
			else err(`${unknownCommandNotice("Use /help.")}\n`);
			return;
		}
		if (input.kind === "exit") {
			detach();
			return;
		}
		if (input.kind === "help") err(`${HELP}\n`);
		else if (input.kind === "status") {
			if (view !== undefined)
				err(
					`${connected ? "" : "Last observed (disconnected): "}${view.name}: ${activityLabel(view.busy)}; PID ${view.pid}; version ${view.version}; session ${client.session}\n`,
				);
			void client.request({ type: "status" }, local.signal).then(
				(response) => {
					if (response.type === "status")
						err(
							`${response.name}: ${activityLabel(response.busy)}; PID ${response.pid}; version ${response.version}; session ${client.session}; started ${new Date(response.runtime.startedAt).toISOString()}; uptime ${Math.floor(response.runtime.uptimeMs / 1000)}s; observed ${new Date(response.runtime.observedAt).toISOString()}\n`,
						);
					else if (response.type === "error") err(`${response.message}\n`);
				},
				(error: unknown) => {
					if (!local.signal.aborted) err(`Status: ${describeError(error)}\n`);
				},
			);
		} else if (input.kind === "mission") {
			void client.request({ type: "mission", request: { operation: "status" } }, local.signal).then(
				(response) => {
					if (local.signal.aborted) return;
					err(
						`${response.type === "mission" ? describeMission(response.result) : response.type === "error" ? response.message : "Unexpected mission response."}\n`,
					);
					if (input.setup)
						err(
							"Use NAME mission setup in a separate interactive terminal, or mission draft --file for headless formation.\n",
						);
				},
				(error: unknown) => {
					if (!local.signal.aborted) err(`Mission: ${describeError(error)}\n`);
				},
			);
		} else if (input.kind === "inspect") {
			try {
				void client.request({ type: "inspection", query: inspectionText(input.text) }, local.signal).then(
					(response) => {
						if (!local.signal.aborted)
							err(
								`${response.type === "inspection" ? describeInspection(response.report) : response.type === "error" ? response.message : "Unexpected inspection response."}\n`,
							);
					},
					(error: unknown) => {
						if (!local.signal.aborted) err(`Inspection: ${describeError(error)}\n`);
					},
				);
			} catch (error) {
				err(`Inspection: ${describeError(error)}\n`);
			}
		} else if (input.kind === "evidence") {
			const callId = input.argument || view?.tools.at(-1)?.callId;
			if (callId === undefined || !isEvidenceCallId(callId))
				err("Use /evidence CALL_ID after a tool has run.\n");
			else
				void client.request({ type: "tool-evidence", callId }, local.signal).then(
					(response) => {
						if (!local.signal.aborted)
							err(
								`${response.type === "tool-evidence" ? evidenceLines(response.evidence).join("\n") : response.type === "error" ? response.message : "Unexpected evidence response."}\n`,
							);
					},
					(error: unknown) => {
						if (!local.signal.aborted) err(`Evidence: ${describeError(error)}\n`);
					},
				);
		} else if (input.kind === "memory") {
			try {
				const request = parseMemorySlash(input.text);
				if (request.operation === "confirm-forget") {
					forget = { id: request.id, requestId: request.requestId };
					err(`Forget ${request.id}? Type yes; any other input cancels. History remains. [No]\n`);
				} else runMemory(request);
			} catch (error) {
				err(`Memory: ${describeError(error)}\n`);
			}
		} else if (input.kind === "cancel") cancel();
		else if (input.kind === "unknown") err(`${unknownCommandNotice(HELP)}\n`);
		else if (input.kind === "prompt") {
			const { text } = input;
			if (!connected) {
				err("Remote is reconnecting; prompt was not submitted.\n");
				return;
			}
			if (sending) {
				err("A submission is pending. Wait, /cancel, or /detach; additional prompts are not queued by this client.\n");
				return;
			}
			if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
				err(`Prompt exceeds ${MAX_PROMPT_LABEL}.\n`);
				return;
			}
			const requestId = randomUUID();
			err(`Submitting request ${requestId}; retry with this --request-id if disconnected.\n`);
			sending = true;
			// Committed watch events own answer output; the send result supplies only failure diagnostics.
			void Promise.resolve()
				.then(() => client.request({ type: "send", prompt: text, requestId }, local.signal))
				.then(
					async (response) => {
						if (local.signal.aborted) return;
						if (response.type === "error") err(`${response.message}; ${await settleRefusal(requestId, text)}\n`);
						else if (response.type === "reply" && response.reply.status === "failed")
							err(
								`Unanswered: ${response.reply.reason}${response.reply.detail === undefined ? "" : ` (${response.reply.detail})`}\n`,
							);
					},
					(error: unknown) => {
						if (!local.signal.aborted) err(`Send failed: ${describeError(error)}; retry request ${requestId}.\n`);
					},
				)
				.finally(() => {
					sending = false;
					cancelAfterAdmission = false;
				});
		}
		if (!local.signal.aborted) paint(() => {});
	};
	const oversizedInput = () => {
		// Readline cannot drop a half-typed or half-piped line, so plain attach ends the session instead of rejecting it;
		// the rich terminal rejects the input and keeps the draft.
		err(`Input exceeds ${MAX_PROMPT_LABEL}; detaching without cancelling service work.\n`);
		code = 2;
		detach();
	};
	const onData = (chunk: string | Buffer) => {
		if (Buffer.byteLength(chunk) > MAX_PROMPT_BYTES) oversizedInput();
	};
	const onKeypress = () => {
		if (reader !== undefined && Buffer.byteLength(reader.line) > MAX_PROMPT_BYTES) oversizedInput();
		if (!flushQueued && (pendingView !== undefined || pendingNotice !== "")) {
			flushQueued = true;
			queueMicrotask(() => {
				flushQueued = false;
				flush();
			});
		}
	};
	try {
		// The client owns its first-view deadline and any recovery from missing it; no timer here can abort that.
		await client.watch((event) => {
			if (event.type === "connecting") {
				connected = false;
				cancelAfterAdmission = false;
				forget = undefined;
				err(`${event.message}\n`);
				return;
			}
			const next = event.view;
			connected = true;
			const first = view === undefined;
			view = next;
			if (first) {
				err(
					`Attached to ${next.name}; session ${client.session}; PID ${next.pid}; version ${next.version}.\n${HELP}\n`,
				);
			}
			if (reader?.line !== undefined && reader.line !== "") pendingView = next;
			else {
				pendingView = undefined;
				paint(() => renderer.update(next));
			}
			if (cancelAfterAdmission && next.busy) cancel();
			if (first) {
				terminal.input.on("data", onData);
				reader = createInterface({
					input: terminal.input,
					output: terminal.output,
					terminal: terminal.output !== undefined,
				});
				reader.on("line", onLine);
				reader.on("close", detach);
				reader.on("SIGINT", () => (view?.busy === true || sending ? cancel() : detach()));
				terminal.input.on("keypress", onKeypress);
				reader.setPrompt("> ");
				paint(() => {});
			}
		}, local.signal);
	} catch (error) {
		if (!local.signal.aborted) {
			code = 1;
			err(`Service disconnected: ${describeError(error)}. Reattach to inspect persisted work.\n`);
		}
	} finally {
		signal.removeEventListener("abort", onSignal);
		terminal.input.off("data", onData);
		terminal.input.off("keypress", onKeypress);
		detach();
		paint(() => {
			if (pendingView !== undefined) renderer.update(pendingView);
			renderer.finish();
			if (pendingNotice !== "") terminal.err(pendingNotice);
			if (view !== undefined) terminal.err("Detached; detaching does not cancel admitted work.\n");
		});
	}
	return code;
}

class AttachedOutput {
	readonly #terminal: Terminal;
	#lastEntryId = -1;
	#livePrinted = "";
	#lineOpen = false;
	#committedText = "";
	#busy: boolean | undefined;
	#tools = new Map<string, string>();
	#problem = "";
	#historyNotice = false;
	#liveNotice = false;

	constructor(terminal: Terminal) {
		this.#terminal = terminal;
	}

	update(view: ServiceView): void {
		if (view.busy && view.busy !== this.#busy) {
			this.finish();
			this.#terminal.err("[working]\n");
			this.#busy = true;
		}
		if (view.historyTruncated && !this.#historyNotice) {
			this.#terminal.err("[Showing bounded recent history; earlier entries omitted.]\n");
			this.#historyNotice = true;
		}
		for (const entry of view.entries) {
			if (entry.id <= this.#lastEntryId) continue;
			const text = sanitizeTerminalText(entry.text);
			if (
				entry.role === "assistant" &&
				this.#livePrinted !== "" &&
				(text.startsWith(this.#livePrinted) || (entry.truncated && this.#livePrinted.startsWith(text)))
			) {
				const tail = text.slice(this.#livePrinted.length);
				if (tail !== "") {
					if (!this.#lineOpen) this.#terminal.out("assistant> ");
					this.#terminal.out(tail);
					this.#lineOpen = !tail.endsWith("\n");
				}
				this.finish();
			} else {
				this.finish();
				this.#terminal.out(`${entry.role}${entry.source === "host" ? " (host)" : ""}> ${text}\n`);
			}
			if (entry.truncated) this.#terminal.err("[Entry truncated; this view is not the complete answer.]\n");
			this.#lastEntryId = entry.id;
			if (entry.role === "assistant") {
				this.#committedText = text;
				this.#livePrinted = "";
			} else {
				this.#committedText = "";
				this.#livePrinted = "";
			}
		}
		const live = sanitizeTerminalText(view.text);
		// Emit complete lines while working; a bounded partial is flushed by a committed answer or truncation.
		const text = view.textTruncated ? live : live.slice(0, live.lastIndexOf("\n") + 1);
		if (text !== "" && text !== this.#committedText) {
			if (!text.startsWith(this.#livePrinted)) {
				this.finish();
				this.#livePrinted = "";
			}
			const delta = text.slice(this.#livePrinted.length);
			if (delta !== "") {
				if (!this.#lineOpen) this.#terminal.out("assistant> ");
				this.#terminal.out(delta);
				this.#lineOpen = !delta.endsWith("\n");
			}
			this.#livePrinted = text;
		}
		if (view.textTruncated && !this.#liveNotice) {
			this.finish();
			this.#terminal.err("[Live text truncated; this view is not the complete answer.]\n");
			this.#liveNotice = true;
		}
		if (view.text === "") this.#liveNotice = false;
		const tools = new Map<string, string>();
		for (const tool of view.tools) {
			tools.set(tool.callId, tool.status);
			if (this.#tools.get(tool.callId) === tool.status) continue;
			this.finish();
			this.#terminal.err(
				`[${sanitizeTerminalText(tool.name)}: ${tool.status}${tool.reason === undefined ? "" : ` - ${sanitizeTerminalText(toolFailureSummary(tool.reason, tool.callId))}`}]\n`,
			);
		}
		this.#tools = tools;
		// A failed run or a waiting provider retry is shown once per change, for every attached observer.
		const problem =
			view.retry !== undefined
				? `[retrying, attempt ${view.retry.attempt}: ${providerProblemSummary(view.retry.problem)}]`
				: view.failure !== undefined && !view.busy
					? `[request failed: ${view.failure.reason} - ${runFailureSummary(view.failure)}]`
					: "";
		if (problem !== "" && problem !== this.#problem) {
			this.finish();
			this.#terminal.err(`${problem}\n`);
		}
		this.#problem = problem;
		if (view.busy !== this.#busy) {
			this.finish();
			this.#terminal.err(view.busy ? "[working]\n" : "[ready]\n");
			this.#busy = view.busy;
		}
	}

	finish(): void {
		if (this.#lineOpen) this.#terminal.out("\n");
		this.#lineOpen = false;
	}
}
