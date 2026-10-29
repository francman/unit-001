import type { LiveState } from "@earendil-works/pi-durable";

type AssistantContent = { readonly type: string; readonly text?: string };

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
