// Memory graph replies and whether the gateway and the page must each accept them; plain data both test suites read.
import { MEMORY_GRAPH_LIMITS } from "../../src/web/payload.ts";

type Json = Record<string, any>;

const node = (id: string, overrides: Json = {}): Json => ({
	id,
	content: "A fact",
	truncated: false,
	kind: "fact",
	tier: "working",
	origin: "user",
	importance: 0.5,
	createdAt: 1,
	conversation: "0123456789ab",
	...overrides,
});

const graph = (overrides: Json = {}): Json => ({
	operation: "graph",
	nodes: [node("a"), node("b")],
	edges: [],
	total: 2,
	limited: false,
	...overrides,
});

/** Each row is a case name, a reply, and whether a correct reader accepts it. */
export const memoryGraphCases: readonly (readonly [string, Json, boolean])[] = [
	["a plain graph", graph(), true],
	["content at the code point limit", graph({ nodes: [node("a", { content: "😀".repeat(MEMORY_GRAPH_LIMITS.contentPoints) })], total: 1 }), true],
	["content past the code point limit", graph({ nodes: [node("a", { content: "😀".repeat(MEMORY_GRAPH_LIMITS.contentPoints + 1) })], total: 1 }), false],
	["empty content", graph({ nodes: [node("a", { content: "" })], total: 1 }), false],
	["a duplicate id", graph({ nodes: [node("a"), node("a")] }), false],
	// The page once accepted a blank id that the gateway refused; one rule now serves both.
	["a blank id", graph({ nodes: [node("   ")], total: 1 }), false],
	["an id past the limit", graph({ nodes: [node("x".repeat(MEMORY_GRAPH_LIMITS.idText + 1))], total: 1 }), false],
	["importance past one", graph({ nodes: [node("a", { importance: 1.5 })], total: 1 }), false],
	["a malformed conversation key", graph({ nodes: [node("a", { conversation: "XYZ" })], total: 1 }), false],
	["a relation between present nodes", graph({ edges: [{ from: "a", to: "b", kind: "supports", derivation: "explicit" }] }), true],
	["an edge to an absent node", graph({ edges: [{ from: "a", to: "z", kind: "summary" }] }), false],
	["a self relation", graph({ edges: [{ from: "a", to: "a", kind: "relates", derivation: "explicit" }] }), false],
	["a summary link onto itself", graph({ edges: [{ from: "a", to: "a", kind: "summary" }] }), true],
	["a total below the node count", graph({ total: 1 }), false],
	["a limited flag that disagrees", graph({ limited: true }), false],
	["a limited graph", graph({ total: 5, limited: true }), true],
	[
		"too many nodes",
		graph({
			nodes: Array.from({ length: MEMORY_GRAPH_LIMITS.nodes + 1 }, (_, index) => node(`n${index}`)),
			total: MEMORY_GRAPH_LIMITS.nodes + 1,
		}),
		false,
	],
];
