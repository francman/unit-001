import { describe, expect, it } from "vitest";
import { type ChatEntries, mergeChatEntries } from "./history.ts";

function entry(id: number, text = `Message ${id}`): ChatEntries[number] {
	return { id, role: "assistant", text, truncated: false };
}

describe("chat transcript merge", () => {
	it("keeps paged and previously watched rows across a shorter reconnect window, including gaps", () => {
		const initial = [entry(30), entry(41)];
		const paged = mergeChatEntries(initial, [entry(4), entry(23)], "page");
		const movedWindow = mergeChatEntries(paged, [entry(41), entry(59)], "live");
		const reconnected = mergeChatEntries(movedWindow, [entry(80)], "live");
		expect(reconnected.map((row) => row.id)).toEqual([4, 23, 30, 41, 59, 80]);
	});

	it("does not replace an overlapping live row when an unbounded page settles", () => {
		const live = [entry(41, "Live projection"), entry(46)];
		const paged = mergeChatEntries(live, [entry(23), entry(41, "Page projection"), entry(44)], "page");
		expect(paged.map(({ id, text }) => [id, text])).toEqual([[23, "Message 23"], [41, "Live projection"], [44, "Message 44"], [46, "Message 46"]]);
		expect(mergeChatEntries(paged, [entry(23), entry(41, "Page projection")], "page")).toBe(paged);
	});

	it("uses an updated live projection and leaves identical closed rows alone on token frames", () => {
		const current = [entry(4), entry(17), entry(41, "old")];
		const fresh = [entry(17), entry(41, "new")];
		const merged = mergeChatEntries(current, fresh, "live");
		expect(merged).toEqual([entry(4), entry(17), entry(41, "new")]);
		expect(mergeChatEntries(merged, fresh, "live")).toBe(merged);
	});
});
