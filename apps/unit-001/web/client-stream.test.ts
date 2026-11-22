// Covers browser fetch SSE framing and cancellation with real byte streams.
import { describe, expect, it, vi } from "vitest";
import { readEventStream } from "./client-stream.ts";

const encode = new TextEncoder();

function closedStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("fetch SSE framing", () => {
	it("parses split UTF-8, BOM, CR/LF/CRLF, comments and multiline data at every cut", async () => {
		const bytes = encode.encode(
			"\uFEFF: heartbeat\r\n\r\n" +
			"event: view\r\ndata: café 🦊\rdata:  space\nignore: no\r\n\r\n" +
			"event: ignored\n\nevent: connecting\ndata: {}\n\n" +
			"data\n\n" +
			"event: view\ndata: undelimited\n",
		);
		for (let cut = 0; cut <= bytes.length; cut++) {
			const receive = vi.fn();
			await readEventStream(closedStream(bytes.subarray(0, cut), bytes.subarray(cut)), new AbortController().signal, receive);
			expect(receive.mock.calls).toEqual([
				["view", "café 🦊\n space"],
				["connecting", "{}"],
				["message", ""],
			]);
		}
	});

	it.each([
		["an unterminated line", "data: ", "é".repeat(530_000)],
		["an unterminated event with many lines", "data: start\n", "data: split\n".repeat(90_000)],
	])("rejects %s before dispatch and cancels the body", async (_name, start, data) => {
		const bytes = encode.encode(data);
		const receive = vi.fn();
		const cancel = vi.fn();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encode.encode(start));
				for (let offset = 0; offset < bytes.length; offset += 4096)
					controller.enqueue(bytes.subarray(offset, offset + 4096));
			},
			cancel,
		});
		await expect(readEventStream(stream, new AbortController().signal, receive)).rejects.toThrow("too large");
		expect(receive).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(stream.locked).toBe(false);
	});

	it("resets the byte bound per frame rather than per HTTP chunk", async () => {
		const payload = "x".repeat(600_000);
		const bytes = encode.encode(`event: a\ndata: ${payload}\n\nevent: b\ndata: ${payload}\n\n`);
		const receive = vi.fn();
		await readEventStream(closedStream(bytes), new AbortController().signal, receive);
		expect(receive.mock.calls).toEqual([["a", payload], ["b", payload]]);
	});

	it("releases a stalled reader on abort without dispatching a partial event", async () => {
		const abort = new AbortController();
		const receive = vi.fn();
		const cancel = vi.fn();
		const stream = new ReadableStream({ start: (controller) => controller.enqueue(encode.encode("data: partial")), cancel });
		const reading = readEventStream(stream, abort.signal, receive);
		await Promise.resolve();
		abort.abort();
		await reading;
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(receive).not.toHaveBeenCalled();
		expect(stream.locked).toBe(false);
	});
});
