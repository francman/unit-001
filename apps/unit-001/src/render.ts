import type { LiveState } from "@earendil-works/pi-durable";

type AssistantContent = { readonly type: string; readonly text?: string };

/** Sanitizes a complete terminal text field/snapshot, including incomplete escape tails; never pass isolated deltas. */
export function sanitizeTerminalText(text: string): string {
	let output = "";
	for (let index = 0; index < text.length; index++) {
		let code = text.charCodeAt(index);
		if (code === 0x1b) {
			if (++index === text.length) break;
			code = text.charCodeAt(index);
			if (code === 0x5b) code = 0x9b;
			else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) code = 0x9d;
			else {
				while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index++;
				if (index < text.length && !(text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x7e)) index--;
				continue;
			}
		}
		if (code === 0x9b) {
			while (++index < text.length) {
				const next = text.charCodeAt(index);
				if (next >= 0x40 && next <= 0x7e) break;
			}
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			while (++index < text.length) {
				const next = text.charCodeAt(index);
				if (next === 0x07 || next === 0x9c) break;
				if (next === 0x1b && text[index + 1] === "\\") {
					index++;
					break;
				}
			}
			continue;
		}
		if (code === 0x09 || code === 0x0a || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) output += text[index];
	}
	return output;
}

/** The text of the answer being generated, from the newest committed partial of a live conversation. */
export function liveText(live: LiveState | undefined): string {
	const content = live?.generation?.message?.content as readonly AssistantContent[] | undefined;
	return (content ?? [])
		.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
		.join("");
}

/**
 * Turns a growing text into appended output. Partials only ever extend the answer being generated; text that does not
 * continue what was printed is the next answer (after a tool round), and starts on a new line.
 */
export class DeltaPrinter {
	readonly #write: (text: string) => void;
	#printed = "";

	constructor(write: (text: string) => void) {
		this.#write = write;
	}

	update(text: string): void {
		if (text === "" || (this.#printed.startsWith(text) && text.length <= this.#printed.length)) return;
		if (!text.startsWith(this.#printed)) {
			if (this.#printed !== "") this.#write("\n");
			this.#printed = "";
		}
		this.#write(text.slice(this.#printed.length));
		this.#printed = text;
	}

	/** Prints what the last committed partial missed, for example the tail of a finished answer. */
	finish(text: string): void {
		this.update(text);
		if (this.#printed !== "") this.#write("\n");
		this.#printed = "";
	}
}

/** The names of tool calls that started running since the last call, so each is announced once. */
export class ToolAnnouncer {
	readonly #seen = new Set<string>();

	next(live: LiveState | undefined): string[] {
		const names: string[] = [];
		for (const slot of live?.tools ?? []) {
			if (slot.status === "pending" || this.#seen.has(slot.callId)) continue;
			this.#seen.add(slot.callId);
			names.push(slot.name);
		}
		return names;
	}
}
