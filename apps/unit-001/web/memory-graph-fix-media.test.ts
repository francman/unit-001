// Checks that a pixel-ratio change re-arms the resolution query for the new ratio and calls resize each time (codex review, low).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPixelRatio } from "./views/memory-graph-media.ts";

interface FakeQuery {
	media: string;
	listeners: Set<() => void>;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

let ratio = 1;
let queries: FakeQuery[] = [];

function install(): void {
	queries = [];
	vi.stubGlobal("window", {
		get devicePixelRatio() {
			return ratio;
		},
	});
	vi.stubGlobal("matchMedia", (media: string): FakeQuery => {
		const query: FakeQuery = {
			media,
			listeners: new Set(),
			addEventListener: (_type, listener) => void query.listeners.add(listener),
			removeEventListener: (_type, listener) => void query.listeners.delete(listener),
		};
		queries.push(query);
		return query;
	});
}

const live = () => queries.filter((query) => query.listeners.size > 0);
const fire = (query: FakeQuery | undefined) => {
	for (const listener of [...(query?.listeners ?? [])]) listener();
};

beforeEach(() => {
	ratio = 1;
	install();
});
afterEach(() => vi.unstubAllGlobals());

describe("watchPixelRatio", () => {
	it("watches the current ratio", () => {
		watchPixelRatio(() => undefined);
		expect(live().map((query) => query.media)).toEqual(["(resolution: 1dppx)"]);
	});

	it("calls resize on a ratio change and re-arms for the new ratio, again and again", () => {
		const resize = vi.fn();
		watchPixelRatio(resize);
		ratio = 2;
		fire(live()[0]);
		expect(resize).toHaveBeenCalledTimes(1);
		expect(live().map((query) => query.media)).toEqual(["(resolution: 2dppx)"]);
		ratio = 1.5;
		fire(live()[0]);
		expect(resize).toHaveBeenCalledTimes(2);
		expect(live().map((query) => query.media)).toEqual(["(resolution: 1.5dppx)"]);
		// Only one query is ever listening, so nothing leaks per change.
		expect(live()).toHaveLength(1);
	});

	it("reads the new ratio when resize runs", () => {
		const seen: number[] = [];
		watchPixelRatio(() => seen.push(window.devicePixelRatio));
		ratio = 2;
		fire(live()[0]);
		expect(seen).toEqual([2]);
	});

	it("stops listening once stopped, including the re-armed query", () => {
		const resize = vi.fn();
		const stop = watchPixelRatio(resize);
		ratio = 2;
		fire(live()[0]);
		stop();
		expect(live()).toHaveLength(0);
		expect(resize).toHaveBeenCalledTimes(1);
	});
});
