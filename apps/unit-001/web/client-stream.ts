// Reads bounded SSE frames from a fetch body, independent of HTTP chunk boundaries.
const MAX_EVENT_BYTES = 1_048_576;

/** Dispatches complete SSE events; cancels the body on error or abort and drops partial frames at EOF. */
export async function readEventStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	onEvent: (event: string, data: string) => void,
): Promise<void> {
	const reader = body.getReader();
	const cancel = () => void reader.cancel().catch(() => {});
	signal.addEventListener("abort", cancel, { once: true });
	// Flush at each line so malformed UTF-8 cannot span a newline. Only the stream's first BOM is special.
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let firstLine = true;
	let afterCR = false;
	let line = "";
	let event = "";
	let data: string[] = [];
	let bytes = 0;
	try {
		while (!signal.aborted) {
			const chunk = await reader.read();
			if (chunk.done || signal.aborted) break;
			const value = chunk.value;
			let start = 0;
			while (start < value.length && !signal.aborted) {
				if (afterCR) {
					afterCR = false;
					if (value[start] === 10 && ++start === value.length) break;
				}
				let end = start;
				while (end < value.length && value[end] !== 10 && value[end] !== 13) end++;
				bytes += end - start + Number(end < value.length);
				if (bytes > MAX_EVENT_BYTES) throw new Error("Event stream frame is too large.");
				if (end === value.length) {
					line += decoder.decode(value.subarray(start), { stream: true });
					break;
				}
				line += decoder.decode(value.subarray(start, end));
				afterCR = value[end] === 13;
				start = end + 1;
				if (firstLine) {
					firstLine = false;
					if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
				}
				if (line === "") {
					if (data.length > 0) onEvent(event || "message", data.join("\n"));
					event = "";
					data = [];
					bytes = 0;
				} else if (line[0] !== ":") {
					const colon = line.indexOf(":");
					const field = colon < 0 ? line : line.slice(0, colon);
					const content = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
					if (field === "event") event = content;
					else if (field === "data") data.push(content);
				}
				line = "";
			}
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}
