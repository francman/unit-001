// Turns pointer, wheel and key events on the map into the few intents the map understands: hover, click, drag a node, pan, zoom, move between nodes.

/** What the map does in response; the input only decides which one an event means. */
export interface InputTarget {
	/** The node under a screen point (pixels from the frame's top-left), or -1. `slop` is the extra reach for fingers. */
	hit(px: number, py: number, slop: number): number;
	hover(index: number): void;
	/** A press and release that did not move: a node was clicked, or empty space (-1). */
	click(index: number): void;
	/** A node is being dragged to a screen point; `start` is true for the first call of a drag. */
	dragNode(index: number, px: number, py: number, start: boolean): void;
	/** A node drag ended, by release, cancel, lost pointer capture or `cancel()`. */
	dropNode(index: number): void;
	pan(dx: number, dy: number): void;
	/** Whether a pan or a node drag is in progress, for the cursor. */
	grabbing(on: boolean): void;
	zoom(factor: number, px: number, py: number): void;
	/** Arrow keys: move between nodes when the keyboard is on one, otherwise pan. */
	arrow(dx: number, dy: number, pan: boolean): void;
	/** Enter or Space. */
	activate(): void;
	/** Escape; returns true when it did something, so the page does not also act on it. */
	escape(): boolean;
	zoomStep(factor: number): void;
	fit(): void;
	/** Focus left the map. */
	leave(): void;
}

/** What the wired input offers its owner. */
export interface Input {
	/** Ends a press in progress as if it was cancelled: a dragged node is dropped, nothing is clicked. */
	cancel(): void;
	/** Cancels a press in progress and removes every listener. */
	dispose(): void;
}

const dragThreshold = 5;
const arrows: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Hit slop in pixels: a mouse can aim, a finger cannot. */
export function slopFor(pointerType: string): number {
	return pointerType === "touch" ? 22 : 8;
}

/** Listens on the frame and calls the target. */
export function wireInput(frame: HTMLElement, target: InputTarget): Input {
	const listeners = new AbortController();
	const { signal } = listeners;
	let press: { id: number; x: number; y: number; node: number; moved: boolean; slop: number } | null = null;
	const local = (event: PointerEvent | WheelEvent) => {
		const box = frame.getBoundingClientRect();
		return { px: event.clientX - box.left, py: event.clientY - box.top };
	};
	frame.addEventListener(
		"pointerdown",
		(event) => {
			if (event.button !== 0 || press) return;
			const { px, py } = local(event);
			const slop = slopFor(event.pointerType);
			press = { id: event.pointerId, x: event.clientX, y: event.clientY, node: target.hit(px, py, slop), moved: false, slop };
			frame.setPointerCapture(event.pointerId);
		},
		{ signal },
	);
	frame.addEventListener(
		"pointermove",
		(event) => {
			const { px, py } = local(event);
			if (!press) {
				if (event.pointerType !== "touch") target.hover(target.hit(px, py, slopFor(event.pointerType)));
				return;
			}
			if (press.id !== event.pointerId) return;
			if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < dragThreshold) return;
			const first = !press.moved;
			const dx = event.clientX - press.x;
			const dy = event.clientY - press.y;
			press = { ...press, x: event.clientX, y: event.clientY, moved: true };
			target.grabbing(true);
			if (press.node >= 0) target.dragNode(press.node, px, py, first);
			// The first move only crosses the threshold; panning starts from there so the map does not jump.
			else if (!first) target.pan(dx, dy);
		},
		{ signal },
	);
	// The one way a press ends, whatever ended it: pointer up, cancel, lost capture (the frame was moved in the page), or the owner.
	const finish = (cancelled: boolean) => {
		if (!press) return;
		const done = press;
		press = null;
		if (frame.hasPointerCapture(done.id)) frame.releasePointerCapture(done.id);
		target.grabbing(false);
		if (done.moved && done.node >= 0) target.dropNode(done.node);
		else if (!done.moved && !cancelled) target.click(done.node);
	};
	const forPress = (event: PointerEvent, cancelled: boolean) => {
		if (press?.id === event.pointerId) finish(cancelled);
	};
	frame.addEventListener("pointerup", (event) => forPress(event, false), { signal });
	frame.addEventListener("pointercancel", (event) => forPress(event, true), { signal });
	// Moving the frame to another parent drops pointer capture without a pointerup; the press must not outlive it.
	frame.addEventListener("lostpointercapture", (event) => forPress(event, true), { signal });
	frame.addEventListener(
		"pointerleave",
		() => {
			if (!press) target.hover(-1);
		},
		{ signal },
	);
	frame.addEventListener(
		"wheel",
		(event) => {
			event.preventDefault();
			const { px, py } = local(event);
			target.zoom(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), px, py);
		},
		{ passive: false, signal },
	);
	frame.addEventListener("blur", () => target.leave(), { signal });
	frame.addEventListener(
		"keydown",
		(event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const arrow = arrows[event.key];
			if (arrow) {
				target.arrow(arrow[0], arrow[1], event.shiftKey);
				event.preventDefault();
			} else if (event.key === "Enter" || event.key === " ") {
				target.activate();
				event.preventDefault();
			} else if (event.key === "Escape") {
				if (target.escape()) event.stopPropagation();
			} else if (event.key === "+" || event.key === "=") target.zoomStep(1.25);
			else if (event.key === "-" || event.key === "_") target.zoomStep(0.8);
			else if (event.key === "0") target.fit();
		},
		{ signal },
	);
	return {
		cancel: () => finish(true),
		dispose() {
			finish(true);
			listeners.abort();
		},
	};
}
