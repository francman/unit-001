// Pure view math for the memory map: world and screen coordinates, zoom, fit, node size on screen, hit testing, arrow-key moves.

/** The view: where world (0, 0) sits on screen and how far in it is. */
export interface View {
	x: number;
	y: number;
	k: number;
}

/** Anything with a place and a world radius. */
export interface Placed {
	x: number;
	y: number;
	radius: number;
	/** Drawn as a rounded square (episodic memories) instead of a circle. */
	square?: boolean;
}

/** The corner radius, in screen pixels, of a rounded square node of half-size `radius`. */
export function squareCorner(radius: number): number {
	return Math.min(3, radius / 2);
}

/** Least and most zoom. */
export const zoomRange = { min: 0.15, max: 4 } as const;

/** Nodes grow slower than the world: at low zoom they stay visible, at high zoom they do not become blobs. */
export function screenRadius(radius: number, k: number): number {
	return radius * Math.max(0.55, k ** 0.7);
}

/** A screen point as a world point. */
export function toWorld(view: View, px: number, py: number): { x: number; y: number } {
	return { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
}

/** The view after zooming by `factor` around a screen point, which stays where it is. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
	const k = Math.min(zoomRange.max, Math.max(zoomRange.min, view.k * factor));
	const ratio = k / view.k;
	return { k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

/** The view that shows `box` centered in a `width` x `height` area, at most `maxZoom` in. */
export function fitBox(box: { x0: number; y0: number; x1: number; y1: number }, width: number, height: number, maxZoom: number): View {
	const k = Math.min(zoomRange.max, Math.max(zoomRange.min, Math.min(width / (box.x1 - box.x0), height / (box.y1 - box.y0), maxZoom)));
	return { k, x: width / 2 - (k * (box.x0 + box.x1)) / 2, y: height / 2 - (k * (box.y0 + box.y1)) / 2 };
}

/**
 * The painted node under a screen point, or -1. A node can be hit on its screen shape (a circle or rounded square)
 * or within `slop` pixels of its center. The nearest center wins, the smaller node on a tie.
 */
export function hitTest(bodies: readonly Placed[], px: number, py: number, slop: number): number {
	let best = -1;
	let bestDistance = Infinity;
	for (let index = 0; index < bodies.length; index++) {
		const body = bodies[index];
		if (!body || body.radius <= 0) continue;
		const dx = body.x - px;
		const dy = body.y - py;
		const distance = Math.hypot(dx, dy);
		if (distance > slop && !insideShape(body, body.radius, dx, dy)) continue;
		const closer = distance < bestDistance - 0.001;
		const tie = Math.abs(distance - bestDistance) <= 0.001 && body.radius < (bodies[best]?.radius ?? Infinity);
		if (closer || tie) {
			best = index;
			bestDistance = distance;
		}
	}
	return best;
}

// Whether an offset from a node's center lies on its drawn shape: the same circle or rounded square the canvas paints.
function insideShape(body: Placed, radius: number, dx: number, dy: number): boolean {
	if (!body.square) return Math.hypot(dx, dy) <= radius;
	const corner = squareCorner(radius);
	const overX = Math.max(0, Math.abs(dx) - (radius - corner));
	const overY = Math.max(0, Math.abs(dy) - (radius - corner));
	return Math.abs(dx) <= radius && Math.abs(dy) <= radius && Math.hypot(overX, overY) <= corner;
}

/** The nearest node in the direction pressed: inside a 60 degree cone first, then anywhere ahead. -1 when nothing is ahead. */
export function nodeInDirection(bodies: readonly Placed[], from: number, dx: number, dy: number): number {
	const origin = bodies[from];
	if (!origin) return -1;
	let best = -1;
	let bestScore = Infinity;
	for (let index = 0; index < bodies.length; index++) {
		const body = bodies[index];
		if (!body || index === from) continue;
		const vx = body.x - origin.x;
		const vy = body.y - origin.y;
		const distance = Math.hypot(vx, vy);
		const along = vx * dx + vy * dy;
		if (along <= 0 || distance === 0) continue;
		const score = distance * (along / distance >= 0.5 ? 1 : 4);
		if (score < bestScore) {
			bestScore = score;
			best = index;
		}
	}
	return best;
}

/** The pan that brings a screen point at least `margin` pixels inside a `width` x `height` area; zero when it is already inside. */
export function panIntoView(px: number, py: number, width: number, height: number, margin: number): { dx: number; dy: number } {
	const insetX = Math.min(margin, width / 2);
	const insetY = Math.min(margin, height / 2);
	const dx = Math.max(insetX, Math.min(width - insetX, px)) - px;
	const dy = Math.max(insetY, Math.min(height - insetY, py)) - py;
	return { dx, dy };
}
