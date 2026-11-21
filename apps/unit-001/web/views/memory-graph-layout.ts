// Force-directed layout for the memory graph on d3-force: long links, Barnes-Hut repulsion, a weak center pull, a seeded start.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

/** What the layout needs to know about a node. */
export interface LayoutNode {
	id: string;
	/** Drawn as a rounded square, which only matters for hit testing. */
	square?: boolean;
	/** Drawn radius in world units; nodes keep this much space around them. */
	radius: number;
	/** How many relations the memory has; hubs push harder so they open space around themselves. */
	degree: number;
}

/** A link between two node ids. Typed relations (supports, updates, ...) sit farther apart than summary links. */
export interface LayoutEdge {
	from: string;
	to: string;
	typed: boolean;
}

/** One node of a running layout; `x` and `y` are its current place in world units. */
export interface Body extends SimulationNodeDatum, LayoutNode {
	x: number;
	y: number;
}

/** A running layout. `bodies` is indexed like the nodes it was created with. */
export interface Simulation {
	readonly bodies: readonly Body[];
	/** True while the layout still moves: until it cools down, and for as long as a drag holds it warm. */
	readonly active: boolean;
	/** Advances one tick; returns false once the layout has settled and will not move again. */
	step(): boolean;
	/** Fixes a node at a place, as a drag does; the others react only after `reheat`. */
	pin(index: number, x: number, y: number): void;
	/** Keeps the layout warm (alpha target 0.3) so neighbours follow a dragged node. */
	reheat(): void;
	/** Lets a node go and lets the layout cool down to rest. */
	release(index: number): void;
}

const typedDistance = 120;
const summaryDistance = 90;
const centerStrength = 0.04;
const dragAlpha = 0.3;
const settledAlpha = 0.001;
const ticksLimit = 500;

/**
 * Creates a layout whose starting positions come only from the input order, so equal input gives equal output.
 * Nodes found in `previous` start where they were and the layout starts warm instead of hot; a node that is new but
 * linked to a kept one starts beside it. A small change (a filter, one forgotten memory) does not reshuffle the map.
 */
export function createSimulation(
	nodes: readonly LayoutNode[],
	edges: readonly LayoutEdge[],
	previous: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): Simulation {
	const random = seeded(nodes.length * 7919 + 17);
	const spread = 30 + 22 * Math.sqrt(nodes.length);
	let kept = 0;
	const bodies: Body[] = nodes.map((node) => {
		const before = previous.get(node.id);
		if (before) kept += 1;
		const angle = random() * Math.PI * 2;
		const distance = Math.sqrt(random()) * spread;
		return { ...node, x: before ? before.x : Math.cos(angle) * distance, y: before ? before.y : Math.sin(angle) * distance };
	});
	if (kept > 0) placeNewNextToKept(bodies, edges, previous, random);
	const byId = new Map(bodies.map((body) => [body.id, body]));
	const links: SimulationLinkDatum<Body>[] = [];
	// d3 numbers the links itself (`index`), so which ones are typed is kept on the side.
	const typed = new Set<SimulationLinkDatum<Body>>();
	for (const edge of edges) {
		const source = byId.get(edge.from);
		const target = byId.get(edge.to);
		if (!source || !target || source === target) continue;
		const link = { source, target };
		links.push(link);
		if (edge.typed) typed.add(link);
	}
	const simulation = forceSimulation(bodies)
		.randomSource(seeded(nodes.length * 104729 + 3))
		.alphaMin(settledAlpha)
		.velocityDecay(0.55)
		.force(
			"link",
			forceLink<Body, SimulationLinkDatum<Body>>(links)
				.id((body) => body.id)
				.distance((link) => (typed.has(link) ? typedDistance : summaryDistance)),
		)
		.force(
			"charge",
			forceManyBody<Body>()
				.strength((body) => -(120 + 24 * Math.sqrt(body.degree)))
				.theta(0.9)
				.distanceMax(520),
		)
		.force("x", forceX<Body>(0).strength(centerStrength))
		.force("y", forceY<Body>(0).strength(centerStrength))
		.force(
			"collide",
			forceCollide<Body>()
				.radius((body) => body.radius + 5)
				.strength(0.8),
		)
		.alpha(kept > 0 ? 0.3 : 1)
		.stop();
	let ticks = 0;
	let active = bodies.length > 0;

	function step(): boolean {
		if (!active) return false;
		simulation.tick();
		ticks += 1;
		const cooling = simulation.alphaTarget() === 0;
		if (cooling && (simulation.alpha() < settledAlpha || ticks >= ticksLimit)) active = false;
		return active;
	}
	return {
		bodies,
		get active() {
			return active;
		},
		step,
		pin(index, x, y) {
			const body = bodies[index];
			if (!body) return;
			body.fx = x;
			body.fy = y;
			body.x = x;
			body.y = y;
		},
		reheat() {
			simulation.alphaTarget(dragAlpha);
			simulation.alpha(Math.max(simulation.alpha(), dragAlpha));
			ticks = 0;
			active = true;
		},
		release(index) {
			const body = bodies[index];
			if (body) {
				body.fx = null;
				body.fy = null;
			}
			simulation.alphaTarget(0);
			ticks = 0;
			active = bodies.length > 0;
		},
	};
}

/**
 * Runs a layout for at most `budgetMs`, as many ticks as fit; true once it has settled. When it returns false the caller
 * lets the page breathe and calls again, so a large layout never holds the main thread for its whole settle time.
 */
export function settleWithin(simulation: Simulation, budgetMs: number, now: () => number = () => performance.now()): boolean {
	const deadline = now() + budgetMs;
	while (simulation.step()) if (now() >= deadline) return false;
	return true;
}

/** The smallest box around all bodies, with `margin` added on every side. */
export function bounds(simulation: Simulation, margin: number): { x0: number; y0: number; x1: number; y1: number } {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const body of simulation.bodies) {
		const reach = body.radius + margin;
		x0 = Math.min(x0, body.x - reach);
		y0 = Math.min(y0, body.y - reach);
		x1 = Math.max(x1, body.x + reach);
		y1 = Math.max(y1, body.y + reach);
	}
	return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: -100, y0: -100, x1: 100, y1: 100 };
}

// A node without a previous place starts a little way from a linked node that has one.
function placeNewNextToKept(bodies: readonly Body[], edges: readonly LayoutEdge[], previous: ReadonlyMap<string, { x: number; y: number }>, random: () => number): void {
	const byId = new Map(bodies.map((body) => [body.id, body]));
	for (const edge of edges) {
		for (const [fresh, anchor] of [
			[edge.from, edge.to],
			[edge.to, edge.from],
		] as const) {
			const body = byId.get(fresh);
			const near = byId.get(anchor);
			if (!body || !near || previous.has(fresh) || !previous.has(anchor)) continue;
			const angle = random() * Math.PI * 2;
			body.x = near.x + Math.cos(angle) * 60;
			body.y = near.y + Math.sin(angle) * 60;
		}
	}
}

// A small seeded generator (mulberry32) so the starting positions are the same on every run.
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}
