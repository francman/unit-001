// Attaches a terminal to the service owner without opening storage or tying work to the client lifetime.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { ATTACH_HELP as HELP } from "./attach-help.ts";
import { describeMemory, type MemoryRequest, memoryCommand } from "./memory-control.ts";
import { describeMission } from "./missions/command.ts";
import { sanitizeTerminalText } from "./render.ts";
import type { Terminal } from "./repl.ts";
import { requestService, type ServiceView, watchService } from "./service.ts";

const MAX_INPUT_BYTES = 16_384;

/** Runs a service terminal client; exit, EOF, signals, or connection loss never abort admitted service work. */
export async function runAttach(endpoint: string, terminal: Terminal, signal: AbortSignal): Promise<number> {
	if (signal.aborted) return 0;
	const local = new AbortController();
	const renderer = new AttachedOutput(terminal);
	let reader: Interface | undefined;
	let view: ServiceView | undefined;
	let sending = false;
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
			pendingNotice =
				combined.length > 8192 ? `[Earlier client notices omitted.]\n${combined.slice(-8000)}` : combined;
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
	const onSignal = () => detach();
	signal.addEventListener("abort", onSignal, { once: true });
	const cancel = () => {
		if (cancelling || local.signal.aborted) return;
		if (sending && view?.busy !== true) {
			cancelAfterAdmission = true;
			err("Cancellation queued until the submitted work is visible.\n");
			return;
		}
		cancelAfterAdmission = false;
		cancelling = true;
		void Promise.resolve()
			.then(() => requestService(endpoint, { type: "cancel" }, local.signal))
			.then(
				(response) => {
					if (!local.signal.aborted)
						err(
							response.type === "error"
								? `${response.message}\n`
								: "Cancellation requested; waiting for service state.\n",
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
		const text = line.trim();
		const runMemory = (request: MemoryRequest) => {
			void requestService(endpoint, { type: "memory", request }, local.signal).then(
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
			if (text.toLowerCase() === "yes") runMemory({ operation: "forget", ...pending, confirmed: true });
			else err("Forget cancelled.\n");
			return;
		}
		if (text === "/exit" || text === "/detach") {
			detach();
			return;
		}
		if (text === "/help") err(`${HELP}\n`);
		else if (text === "/status") {
			if (view !== undefined)
				err(
					`${view.name}: ${view.busy ? "working" : "ready"}; PID ${view.pid}; version ${view.version}; session ${basename(endpoint, ".sock")}\n`,
				);
			void requestService(endpoint, { type: "status" }, local.signal).then(
				(response) => {
					if (response.type === "status")
						err(
							`${response.name}: ${response.busy ? "working" : "ready"}; PID ${response.pid}; version ${response.version}; session ${basename(endpoint, ".sock")}; started ${new Date(response.runtime.startedAt).toISOString()}; uptime ${Math.floor(response.runtime.uptimeMs / 1000)}s; observed ${new Date(response.runtime.observedAt).toISOString()}\n`,
						);
					else if (response.type === "error") err(`${response.message}\n`);
				},
				(error: unknown) => {
					if (!local.signal.aborted) err(`Status: ${describeError(error)}\n`);
				},
			);
		} else if (text === "/mission" || text === "/mission status" || text === "/mission setup") {
			void requestService(endpoint, { type: "mission", request: { operation: "status" } }, local.signal).then(
				(response) => {
					if (local.signal.aborted) return;
					err(
						`${response.type === "mission" ? describeMission(response.result) : response.type === "error" ? response.message : "Unexpected mission response."}\n`,
					);
					if (text === "/mission setup")
						err(
							"Use NAME mission setup in a separate interactive terminal, or mission draft --file for headless formation.\n",
						);
				},
				(error: unknown) => {
					if (!local.signal.aborted) err(`Mission: ${describeError(error)}\n`);
				},
			);
		} else if (text === "/memory" || text.startsWith("/memory ")) {
			try {
				const match = /^\/memory(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(text);
				const request = memoryCommand(match?.[1], match?.[2]);
				if (request.operation === "confirm-forget") {
					forget = { id: request.id, requestId: request.requestId };
					err(`Forget ${request.id}? Type yes; any other input cancels. History remains. [No]\n`);
				} else runMemory(request);
			} catch (error) {
				err(`Memory: ${describeError(error)}\n`);
			}
		} else if (text === "/cancel") cancel();
		else if (text.startsWith("/")) err(`Unknown command. ${HELP}\n`);
		else if (text !== "") {
			if (sending) {
				err(
					"A submission is pending. Wait, /cancel, or /detach; additional prompts are not queued by this client.\n",
				);
				return;
			}
			if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
				err("Prompt exceeds 16 KiB.\n");
				return;
			}
			const requestId = randomUUID();
			err(`Submitting request ${requestId}; retry with this --request-id if disconnected.\n`);
			sending = true;
			// Committed watch events own answer output; the send result supplies only failure diagnostics.
			void Promise.resolve()
				.then(() => requestService(endpoint, { type: "send", prompt: text, requestId }, local.signal))
				.then(
					(response) => {
						if (local.signal.aborted) return;
						if (response.type === "error") err(`${response.message}\n`);
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
		err("Input exceeds 16 KiB; detaching without cancelling service work.\n");
		code = 2;
		detach();
	};
	const onData = (chunk: string | Buffer) => {
		if (Buffer.byteLength(chunk) > MAX_INPUT_BYTES) oversizedInput();
	};
	const onKeypress = () => {
		if (reader !== undefined && Buffer.byteLength(reader.line) > MAX_INPUT_BYTES) oversizedInput();
		if (!flushQueued && (pendingView !== undefined || pendingNotice !== "")) {
			flushQueued = true;
			queueMicrotask(() => {
				flushQueued = false;
				flush();
			});
		}
	};
	const startup = setTimeout(() => {
		if (view !== undefined) return;
		code = 1;
		err("Service did not provide initial state within 5 seconds.\n");
		detach();
	}, 5_000);
	try {
		await watchService(
			endpoint,
			(next) => {
				const first = view === undefined;
				view = next;
				if (first) {
					clearTimeout(startup);
					err(
						`Attached to ${next.name}; session ${basename(endpoint, ".sock")}; PID ${next.pid}; version ${next.version}.\n${HELP}\n`,
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
			},
			local.signal,
		);
	} catch (error) {
		if (!local.signal.aborted) {
			code = 1;
			err(`Service disconnected: ${describeError(error)}. Reattach to inspect persisted work.\n`);
		}
	} finally {
		clearTimeout(startup);
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
				this.#terminal.out(`${entry.role}> ${text}\n`);
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
			this.#terminal.err(`[${sanitizeTerminalText(tool.name)}: ${tool.status}]\n`);
		}
		this.#tools = tools;
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

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
