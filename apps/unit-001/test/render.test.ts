import type { LiveState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { DeltaPrinter, liveText, ToolAnnouncer } from "../src/render.ts";

function collect() {
	const chunks: string[] = [];
	return { write: (text: string) => void chunks.push(text), output: () => chunks.join("") };
}

describe("DeltaPrinter", () => {
	it("prints only what each partial adds", () => {
		const sink = collect();
		const printer = new DeltaPrinter(sink.write);
		printer.update("Hel");
		printer.update("Hello");
		printer.update("Hello, world");
		expect(sink.output()).toBe("Hello, world");
	});

	it("ignores empty and stale partials", () => {
		const sink = collect();
		const printer = new DeltaPrinter(sink.write);
		printer.update("");
		printer.update("Hello");
		printer.update("Hel");
		printer.update("Hello");
		expect(sink.output()).toBe("Hello");
	});

	it("starts the next answer, after a tool round, on a new line", () => {
		const sink = collect();
		const printer = new DeltaPrinter(sink.write);
		printer.update("Let me look.");
		printer.update("Found it.");
		expect(sink.output()).toBe("Let me look.\nFound it.");
	});

	it("prints the missed tail of a finished answer and ends the line", () => {
		const sink = collect();
		const printer = new DeltaPrinter(sink.write);
		printer.update("Hello");
		printer.finish("Hello, world");
		expect(sink.output()).toBe("Hello, world\n");
	});

	it("prints nothing for an answer with no text", () => {
		const sink = collect();
		new DeltaPrinter(sink.write).finish("");
		expect(sink.output()).toBe("");
	});

	it("is reusable after finishing", () => {
		const sink = collect();
		const printer = new DeltaPrinter(sink.write);
		printer.finish("one");
		printer.finish("two");
		expect(sink.output()).toBe("one\ntwo\n");
	});
});

describe("liveText", () => {
	it("joins the text blocks of the partial message and skips other blocks", () => {
		const live = {
			generation: {
				attempt: 1,
				message: {
					content: [
						{ type: "thinking", thinking: "hm" },
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			},
		} as unknown as LiveState;
		expect(liveText(live)).toBe("ab");
	});

	it("is empty without a generation", () => {
		expect(liveText(undefined)).toBe("");
		expect(liveText({} as LiveState)).toBe("");
	});
});

describe("ToolAnnouncer", () => {
	const slot = (callId: string, name: string, status: "pending" | "running" | "done") => ({ callId, name, status });

	it("announces each call once, when it is no longer pending", () => {
		const announcer = new ToolAnnouncer();
		const live = (...slots: ReturnType<typeof slot>[]) => ({ tools: slots }) as unknown as LiveState;
		expect(announcer.next(live(slot("1", "read", "pending")))).toEqual([]);
		expect(announcer.next(live(slot("1", "read", "running")))).toEqual(["read"]);
		expect(announcer.next(live(slot("1", "read", "done"), slot("2", "bash", "running")))).toEqual(["bash"]);
		expect(announcer.next(live(slot("1", "read", "done"), slot("2", "bash", "done")))).toEqual([]);
		expect(announcer.next(undefined)).toEqual([]);
	});
});
