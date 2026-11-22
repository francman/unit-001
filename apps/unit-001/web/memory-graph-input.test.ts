// Checks how the map's input ends a press: pointer up, cancel, lost pointer capture (the page moved the frame), the owner's cancel and dispose.
import { describe, expect, it } from "vitest";
import { type InputTarget, wireInput } from "./views/memory-graph-input.ts";

// A frame with just what the input uses: events, a box, and pointer capture.
class FakeFrame extends EventTarget {
	captured = new Set<number>();
	getBoundingClientRect() {
		return { left: 0, top: 0 };
	}
	setPointerCapture(id: number) {
		this.captured.add(id);
	}
	hasPointerCapture(id: number) {
		return this.captured.has(id);
	}
	releasePointerCapture(id: number) {
		this.captured.delete(id);
		// A browser fires this after any release, ours included.
		this.pointer("lostpointercapture", 0, 0);
	}
	pointer(type: string, x: number, y: number, pointerType = "mouse") {
		const event = Object.assign(new Event(type), { pointerId: 1, pointerType, button: 0, clientX: x, clientY: y });
		this.dispatchEvent(event);
	}
	// What a browser does when the captured element leaves the document: capture is gone, then lostpointercapture fires.
	removeFromPage() {
		this.captured.delete(1);
		this.pointer("lostpointercapture", 0, 0);
	}
}

function setup(nodeAt = 0, gestures = true) {
	const frame = new FakeFrame();
	const calls: string[] = [];
	const target: InputTarget = {
		hit: () => nodeAt,
		hover: (index) => calls.push(`hover ${index}`),
		click: (index) => calls.push(`click ${index}`),
		dragNode: (index, _x, _y, start) => calls.push(`drag ${index}${start ? " start" : ""}`),
		dropNode: (index) => calls.push(`drop ${index}`),
		pan: () => calls.push("pan"),
		grabbing: (on) => calls.push(`grabbing ${on}`),
		zoom: () => calls.push("zoom"),
		arrow: () => calls.push("arrow"),
		activate: () => calls.push("activate"),
		escape: () => false,
		zoomStep: () => calls.push("zoomStep"),
		fit: () => calls.push("fit"),
		leave: () => calls.push("leave"),
	};
	const input = wireInput(frame as unknown as HTMLElement, target, () => gestures);
	return { frame, calls, input, aimAt: (index: number) => { nodeAt = index; } };
}

const drag = (frame: FakeFrame) => {
	frame.pointer("pointerdown", 10, 10);
	frame.pointer("pointermove", 30, 30);
	frame.pointer("pointermove", 40, 40);
};

describe("memory graph gesture mode", () => {
	it("does not capture a native touch scroll or turn movement into a tap", () => {
		const { frame, calls } = setup(0, false);
		frame.pointer("pointerdown", 10, 10, "touch");
		expect(frame.captured.size).toBe(0);
		frame.pointer("pointermove", 10, 60, "touch");
		frame.pointer("pointercancel", 10, 60, "touch");
		expect(calls).toEqual([]);
		frame.pointer("pointerdown", 10, 10, "touch");
		frame.pointer("pointerup", 10, 60, "touch");
		expect(calls).toEqual([]);
	});

	it("inspects the painted target from the start of a tap even if the map moves under it", () => {
		const { frame, calls, aimAt } = setup(2, false);
		frame.pointer("pointerdown", 10, 10, "touch");
		aimAt(3);
		frame.pointer("pointerup", 10, 10, "touch");
		expect(calls).toEqual(["click 2"]);
	});

	it("drags a touch target only after opting in", () => {
		const { frame, calls } = setup();
		frame.pointer("pointerdown", 10, 10, "touch");
		frame.pointer("pointermove", 10, 60, "touch");
		frame.pointer("pointerup", 10, 60, "touch");
		expect(calls).toEqual(["grabbing true", "drag 0 start", "grabbing false", "drop 0"]);
	});
});

describe("memory graph input presses", () => {
	// Codex review (high): a state redraw reparented the frame during a drag; the press survived and blocked every later gesture.
	it("ends a drag when pointer capture is lost, drops the node once, and allows the next gesture", () => {
		const { frame, calls } = setup();
		drag(frame);
		expect(calls).toContain("drag 0 start");
		frame.removeFromPage();
		expect(calls.filter((call) => call === "drop 0")).toHaveLength(1);
		expect(calls.slice(-2)).toEqual(["grabbing false", "drop 0"]);
		// The pointer is released after the frame came back; nothing ends twice.
		frame.pointer("pointerup", 40, 40);
		expect(calls.filter((call) => call === "drop 0")).toHaveLength(1);
		// A second gesture works: a plain click on the node.
		calls.length = 0;
		frame.pointer("pointerdown", 10, 10);
		frame.pointer("pointerup", 10, 10);
		expect(calls).toEqual(["grabbing false", "click 0"]);
	});

	it("does not click when capture is lost before the pointer moved", () => {
		const { frame, calls } = setup();
		frame.pointer("pointerdown", 10, 10);
		frame.removeFromPage();
		expect(calls).toEqual(["grabbing false"]);
		frame.pointer("pointerdown", 10, 10);
		frame.pointer("pointerup", 10, 10);
		expect(calls).toContain("click 0");
	});

	it("ends once for a normal release, although releasing capture fires lostpointercapture", () => {
		const { frame, calls } = setup();
		drag(frame);
		frame.pointer("pointerup", 40, 40);
		expect(calls.filter((call) => call === "drop 0")).toHaveLength(1);
	});

	it("cancel() by the owner drops the dragged node and clears the press", () => {
		const { frame, calls, input } = setup();
		drag(frame);
		input.cancel();
		expect(calls.filter((call) => call === "drop 0")).toHaveLength(1);
		expect(frame.captured.size).toBe(0);
		frame.pointer("pointerup", 40, 40);
		expect(calls.filter((call) => call === "drop 0")).toHaveLength(1);
		calls.length = 0;
		frame.pointer("pointerdown", 10, 10);
		frame.pointer("pointerup", 10, 10);
		expect(calls).toContain("click 0");
	});

	it("dispose() cancels a press in progress and removes every listener", () => {
		const { frame, calls, input } = setup();
		drag(frame);
		input.dispose();
		expect(calls.filter((call) => call === "drop 0")).toHaveLength(1);
		calls.length = 0;
		frame.pointer("pointerdown", 10, 10);
		frame.pointer("pointermove", 50, 50);
		frame.pointer("pointerup", 50, 50);
		frame.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }));
		expect(calls).toEqual([]);
	});

	it("pans on empty space and keeps panning through a capture loss without a stuck cursor", () => {
		const { frame, calls } = setup(-1);
		drag(frame);
		expect(calls).toContain("pan");
		frame.removeFromPage();
		expect(calls.at(-1)).toBe("grabbing false");
		expect(calls).not.toContain("drop -1");
	});
});
