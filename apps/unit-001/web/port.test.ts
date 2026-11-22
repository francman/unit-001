// Regresses #65 browser-side outcome classification, expiry and explicit stable-ID requests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWorkspacePort, parseMemoryGraph, parseWorkspaceView } from "./port.ts";

class Events {
	static current: Events;
	closed = false;
	onerror: (() => void) | null = null;
	constructor() {
		Events.current = this;
	}
	addEventListener() {}
	close() {
		this.closed = true;
	}
}
afterEach(() => vi.unstubAllGlobals());

function completed(init: RequestInit | undefined, response: unknown) {
	const { requestId } = JSON.parse(String(init?.body));
	return Response.json({ requestId, state: "completed", response });
}

describe("browser operator transport", () => {
	it.each([400, 401, 403, 409, 429])("#65 distinguishes pre-dispatch HTTP %s from unknown delivery", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status })),
		);
		const port = browserWorkspacePort("csrf");
		expect(await port.send("work", "stable")).toMatchObject({ state: "failed" });
		expect(await port.forget("memory-id", "forget-stable")).toMatchObject({ state: "failed" });
	});
	it("#65 retains unknown delivery after post-dispatch session loss without replay", async () => {
		const fetch = vi.fn(async () => Response.json({ requestId: "stable", state: "unknown", message: "session ended" }));
		vi.stubGlobal("fetch", fetch);
		const port = browserWorkspacePort("csrf");
		expect(await port.send("work", "stable")).toMatchObject({ state: "unknown" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await port.forget("memory-id", "forget-stable")).toMatchObject({ state: "unknown" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("distinguishes an admitted send that ended without an answer from generic owner and transport failures", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			completed(init, { type: "send-failed" }),
		);
		vi.stubGlobal("fetch", fetch);
		const port = browserWorkspacePort("csrf");
		expect(await port.send("work", "id")).toEqual({
			state: "failed-after-admission",
			message: "The owner could not complete this request. Your message was sent.",
		});
		expect(await port.forget("memory-id", "forget-id")).toMatchObject({ state: "unknown" });
		fetch.mockImplementation(async (_input, init) => completed(init, { type: "error", message: "sample" }));
		expect(await port.send("work", "id")).toMatchObject({ state: "unknown" });
		expect(await port.forget("memory-id", "forget-id")).toMatchObject({ state: "unknown" });
		await expect(port.cancel("cancel-id")).rejects.toThrow();
		fetch.mockImplementation(async () => {
			throw new Error("network lost");
		});
		expect(await port.send("work", "id")).toMatchObject({ state: "unknown" });
		expect(fetch).toHaveBeenCalledTimes(6);
	});
	it("only accepts a matching operation acknowledgement for a mutation", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => completed(init, { type: "sent" }));
		vi.stubGlobal("fetch", fetch);
		const port = browserWorkspacePort("csrf");
		expect(await port.send("work", "send")).toEqual({ state: "completed" });
		expect(await port.forget("memory-id", "forget")).toMatchObject({ state: "unknown" });
		await expect(port.cancel("cancel")).rejects.toThrow("Unexpected operation response.");
		fetch.mockImplementation(async (_input, init) =>
			completed(init, { type: "memory", result: { operation: "stats" } }),
		);
		expect(await port.forget("memory-id", "forget")).toMatchObject({ state: "unknown" });
		fetch.mockImplementation(async (_input, init) =>
			completed(init, { type: "memory", result: { operation: "forget", removed: "no" } }),
		);
		expect(await port.forget("memory-id", "forget")).toMatchObject({ state: "unknown" });
		fetch.mockImplementation(async (_input, init) =>
			completed(init, { type: "memory", result: { operation: "forget", removed: false } }),
		);
		expect(await port.forget("memory-id", "forget")).toEqual({ state: "completed" });
		expect(fetch).toHaveBeenCalledTimes(6);
	});
	it("keeps mismatched request IDs and unexpected HTTP failures unknown", async () => {
		const fetch = vi.fn(async () =>
			Response.json({ requestId: "other", state: "completed", response: { type: "error", message: "sample" } }),
		);
		vi.stubGlobal("fetch", fetch);
		const port = browserWorkspacePort("csrf");
		expect(await port.send("work", "send")).toMatchObject({ state: "unknown" });
		fetch.mockImplementation(async () => new Response("{}", { status: 502 }));
		expect(await port.send("work", "send")).toMatchObject({ state: "unknown" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("#65 preserves explicitly supplied forget identities and never retries them automatically", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			completed(init, { type: "memory", result: { operation: "forget", removed: true } }),
		);
		vi.stubGlobal("fetch", fetch);
		const port = browserWorkspacePort("csrf");
		expect(await port.forget("memory-id", "same-explicit-id")).toEqual({ state: "completed" });
		expect(await port.forget("memory-id", "same-explicit-id")).toEqual({ state: "completed" });
		expect(fetch).toHaveBeenCalledTimes(2);
		for (const call of fetch.mock.calls)
			expect(JSON.parse(String(call[1]?.body))).toMatchObject({
				requestId: "same-explicit-id",
				operation: { request: { confirmed: true, id: "memory-id" } },
			});
	});
	it("#65 observes expired sessions, closes the stream and treats already-revoked logout as success", async () => {
		vi.stubGlobal("EventSource", Events);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (path: string) =>
				path.endsWith("session") ? Response.json({ authenticated: false }) : new Response("{}", { status: 401 }),
			),
		);
		const port = browserWorkspacePort("csrf");
		const events: unknown[] = [];
		port.watch((event) => events.push(event));
		Events.current.onerror?.();
		await expect.poll(() => events).toContainEqual({ type: "connection", state: "expired" });
		expect(Events.current.closed).toBe(true);
		await expect(port.logout()).resolves.toBeUndefined();
	});
});

const agreement = {
	missionId: "m1",
	revision: 3,
	digest: "d",
	terms: {
		objective: "Ship",
		scope: "repo",
		successCriteria: ["tests pass"],
		approvalBoundary: ["no deploy"],
		reviewEveryMs: 60000,
		policy: {
			allowedTools: ["read"],
			maxCycles: 5,
			maxRequests: 50,
			maxRetries: 2,
			maxConsecutiveNoProgress: 3,
			deadlineAt: 2000,
		},
	},
	approval: { approvedAt: 1000, approvedBy: { kind: "local-creator", uid: 501 } },
};
const run = {
	status: "waiting",
	blocker: "rate limit",
	nextWakeAt: 5000,
	cycles: 1,
	requests: 2,
	retries: 0,
	noProgress: 0,
	estimatedCost: 0.5,
	reservedCost: 0,
	unknownRequests: 0,
	unpricedResponses: 0,
	uncertainTools: 0,
	evidence: [{ criterion: "tests pass", accepted: true, detail: "ok", observedAt: 900 }],
	observedAt: 1500,
};
const status = (state: "open" | "held", configuration: "configured" | "unconfigured") => ({
	type: "status",
	inhibited: true,
	maintenance: { protocol: 1, state },
	runtime: { configuration, uptimeMs: 1234 },
});

function stubOwner(replies: {
	status?: unknown;
	run?: unknown;
	agreement?: unknown;
	channels?: unknown[];
	mission?: Record<string, unknown>;
	draft?: unknown;
}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const operation = JSON.parse(String(init?.body)).operation;
			const reply = (response: unknown) => completed(init, response);
			if (operation.type === "status") return reply(replies.status ?? status("open", "configured"));
			if (operation.type === "mission")
				return reply({
					type: "mission",
					result: {
						stage: "agreed",
						formation: { agreement: replies.agreement ?? null, draft: replies.draft ?? null },
						creator: { kind: "human", id: "owner", uid: 501 },
						authority: "developer-local",
						agreementValid: true,
						authorityError: null,
						missing: [],
						execution: "running",
						tools: ["read"],
						...(replies.run === undefined ? {} : { runtime: replies.run }),
						...replies.mission,
					},
				});
			if (operation.type === "memory")
				return reply({
					type: "memory",
					result: {
						operation: "stats",
						working: 1,
						episodic: 2,
						tombstones: 3,
						pendingCaptures: 4,
						failedCaptures: 5,
						consolidation: "idle",
					},
				});
			return reply({
				type: "channels",
				result: {
					operation: "status",
					view: {
						channels: replies.channels ?? [
							{
								request: { channelId: "c", adapter: "telegram" },
								outcome: { kind: "awaiting_creator", step: "telegram-confirmation", url: "https://secret.example/token" },
								lastHealth: { observedAt: 7, healthy: false },
							},
							{ request: { channelId: "d", adapter: "x" }, outcome: { kind: "failed", reason: "transport" }, lastHealth: null },
						],
					},
				},
			});
		}),
	);
}

describe("browser operator details", () => {
	const base = {
		name: "u",
		version: "1",
		installationId: null,
		busy: false,
		model: null,
		text: "",
		textTruncated: false,
		historyTruncated: false,
		entries: [],
		tools: [],
	};
	it("parses usage, null usage and rejects negative or non-finite numbers", () => {
		const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { kind: "estimate", usd: 0.25 } };
		expect(parseWorkspaceView({ ...base, usage }).usage).toEqual(usage);
		expect(parseWorkspaceView({ ...base, usage: { ...usage, cost: { kind: "unknown" } } }).usage?.cost).toEqual({
			kind: "unknown",
		});
		expect(parseWorkspaceView({ ...base, usage: null }).usage).toBeNull();
		expect(() => parseWorkspaceView({ ...base, usage: { ...usage, input: -1 } })).toThrow();
		expect(() => parseWorkspaceView({ ...base, usage: { ...usage, output: null } })).toThrow();
		expect(() => parseWorkspaceView({ ...base, usage: { ...usage, cost: { kind: "billed" } } })).toThrow();
	});
	it("#26 accepts the gateway's closed tool shape and rejects owner-only failure fields", () => {
		const tool = { callId: "toolu_1", name: "bash", status: "failed" };
		expect(parseWorkspaceView({ ...base, usage: null, tools: [tool] }).tools).toEqual([tool]);
		for (const patch of [
			{ tools: [{ ...tool, reason: { code: "exit_code", exitCode: 2 } }] },
			{ tools: [{ ...tool, reason: "exit 2: make failed" }] },
			{ failure: { reason: "model_error", problem: "overloaded" } },
			{ failure: { reason: "model_error", detail: "503 overloaded" } },
			{ retry: { attempt: 1, at: 1, problem: "rate_limited" } },
			{ retry: { attempt: 1, at: 1, error: "429 rate limited" } },
		])
			expect(() => parseWorkspaceView({ ...base, usage: null, ...patch })).toThrow();
	});
	it("maps status to owner including held and unconfigured", async () => {
		stubOwner({});
		expect((await browserWorkspacePort("csrf").details()).owner).toEqual({
			uptimeMs: 1234,
			held: false,
			inhibited: true,
			configured: true,
		});
		stubOwner({ status: status("held", "unconfigured") });
		expect((await browserWorkspacePort("csrf").details()).owner).toMatchObject({ held: true, configured: false });
	});
	it("leaves owner null when status fails without failing details", async () => {
		stubOwner({ status: { type: "error", message: "x" } });
		const details = await browserWorkspacePort("csrf").details();
		expect(details.owner).toBeNull();
		expect(details.mission.stage).toBe("agreed");
	});
	it("parses agreement, run, tools and memory stats", async () => {
		stubOwner({ agreement, run });
		const details = await browserWorkspacePort("csrf").details();
		expect(details.mission.tools).toEqual(["read"]);
		expect(details.mission.agreement).toEqual({
			revision: 3,
			successCriteria: ["tests pass"],
			approvalBoundary: ["no deploy"],
			reviewEveryMs: 60000,
			approvedAt: 1000,
			approvedBy: "local-creator",
			limits: { maxCycles: 5, maxRequests: 50, maxRetries: 2, maxNoProgress: 3, deadlineAt: 2000, maxEstimatedCost: null },
		});
		expect(details.mission.run).toEqual(run);
		expect(details.memory.count).toBe(3);
		expect(details.memory.stats).toEqual({
			working: 1,
			episodic: 2,
			tombstones: 3,
			pendingCaptures: 4,
			failedCaptures: 5,
			consolidation: "idle",
		});
	});
	it("keeps all mission tools in a full owner list and rejects an over-limit reply", async () => {
		const tools = Array.from({ length: 128 }, (_, index) => `tool-${index}`);
		stubOwner({ mission: { tools } });
		expect((await browserWorkspacePort("csrf").details()).mission.tools).toEqual(tools);
		stubOwner({ mission: { tools: [...tools, "extra"] } });
		await expect(browserWorkspacePort("csrf").details()).rejects.toThrow("Invalid owner list.");
	});
	it("returns null agreement and run when absent", async () => {
		stubOwner({});
		const details = await browserWorkspacePort("csrf").details();
		expect(details.mission.agreement).toBeNull();
		expect(details.mission.run).toBeNull();
	});
	it("rejects malformed runs", async () => {
		for (const bad of [
			{ ...run, status: "exploding" },
			{ ...run, cycles: -1 },
			{ ...run, evidence: Array.from({ length: 33 }, () => run.evidence[0]) },
			{ ...run, evidence: [{ criterion: "c", accepted: "yes", detail: "d", observedAt: 1 }] },
		]) {
			stubOwner({ run: bad });
			await expect(browserWorkspacePort("csrf").details()).rejects.toThrow();
		}
	});
	it("maps channel health, failure and awaiting step and never exposes the confirmation url", async () => {
		stubOwner({});
		const details = await browserWorkspacePort("csrf").details();
		expect(details.channels[0]).toMatchObject({
			awaiting: "telegram-confirmation",
			failure: null,
			lastHealth: { observedAt: 7, healthy: false },
		});
		expect(details.channels[1]).toMatchObject({ failure: "transport", awaiting: null, lastHealth: null });
		expect(JSON.stringify(details)).not.toContain("secret.example");
	});
	it("keeps the creator, authority, agreement validity, and draft the page needs", async () => {
		stubOwner({ draft: { revision: 4, status: "proposed", digest: "d".repeat(64), terms: {} } });
		const { mission } = await browserWorkspacePort("csrf").details();
		expect(mission.creator).toEqual({ kind: "human", id: "owner" });
		expect(mission.authority).toBe("developer-local");
		expect(mission.agreementValid).toBe(true);
		expect(mission.authorityError).toBeNull();
		expect(mission.draft).toEqual({ revision: 4, status: "proposed", digest: "d".repeat(64) });
		stubOwner({ mission: { creator: null, authority: "unconfigured", authorityError: "bad file" } });
		expect((await browserWorkspacePort("csrf").details()).mission).toMatchObject({
			creator: null,
			authority: "unconfigured",
			authorityError: "bad file",
			draft: null,
		});
	});
	it("rejects malformed mission authority fields", async () => {
		for (const bad of [
			{ authority: "root" },
			{ agreementValid: "yes" },
			{ creator: { kind: "robot", id: "x" } },
		]) {
			stubOwner({ mission: bad });
			await expect(browserWorkspacePort("csrf").details()).rejects.toThrow();
		}
		stubOwner({ draft: { revision: 1, status: "agreed", digest: null } });
		await expect(browserWorkspacePort("csrf").details()).rejects.toThrow();
	});
	it("recall returns null stats", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				completed(init, { type: "memory", result: { operation: "recall", records: [] } }),
			),
		);
		expect(await browserWorkspacePort("csrf").recall("q")).toEqual({ count: null, stats: null, records: [] });
	});
});

describe("browser memory graph", () => {
	const node = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		content: `memory ${id}`,
		truncated: false,
		kind: "fact",
		tier: "working",
		origin: "user",
		importance: 0.5,
		createdAt: 10,
		conversation: "0123456789ab",
		...extra,
	});
	const graph = {
		operation: "graph",
		nodes: [node("digest", { tier: "episodic", origin: "agent" }), node("source")],
		edges: [
			{ from: "digest", to: "source", kind: "summary" },
			{ from: "source", to: "digest", kind: "contradicts", derivation: "explicit" },
			{ from: "digest", to: "source", kind: "relates", derivation: "consolidation" },
		],
		total: 2,
		limited: false,
	};
	it("requests the read-only graph operation and returns the parsed view", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			completed(init, { type: "memory", result: graph }),
		);
		vi.stubGlobal("fetch", fetch);
		const view = await browserWorkspacePort("csrf").memoryGraph();
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).operation).toEqual({
			type: "memory",
			request: { operation: "graph" },
		});
		expect(view).toEqual({
			nodes: graph.nodes,
			edges: graph.edges,
			total: 2,
			limited: false,
		});
	});
	it("rejects owner errors and unknown outcomes like details", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				completed(init, { type: "error", message: "x" }),
			),
		);
		await expect(browserWorkspacePort("csrf").memoryGraph()).rejects.toThrow();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ state: "unknown", message: "x" })),
		);
		await expect(browserWorkspacePort("csrf").memoryGraph()).rejects.toThrow();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				completed(init, { type: "memory", result: { operation: "recall", records: [] } }),
			),
		);
		await expect(browserWorkspacePort("csrf").memoryGraph()).rejects.toThrow();
	});
	it("accepts the limits and a limited graph", () => {
		const nodes = Array.from({ length: 300 }, (_, index) => node(`m${index}`, { content: "語".repeat(280), truncated: true }));
		expect(parseMemoryGraph({ operation: "graph", nodes, edges: [], total: 900, limited: true }).nodes).toHaveLength(300);
	});
	it.each([
		["too many nodes", { nodes: Array.from({ length: 301 }, (_, index) => node(`m${index}`)), total: 301 }],
		["too many edges", { edges: Array.from({ length: 1001 }, () => graph.edges[0]) }],
		["oversize content", { nodes: [node("a", { content: "x".repeat(281) })], edges: [], total: 1 }],
		["empty content", { nodes: [node("a", { content: "" })], edges: [], total: 1 }],
		["duplicate ids", { nodes: [node("a"), node("a")], edges: [] }],
		["unknown kind", { nodes: [node("a", { kind: "secret" })], edges: [], total: 1 }],
		["unknown tier", { nodes: [node("a", { tier: "forgotten" })], edges: [], total: 1 }],
		["unknown origin", { nodes: [node("a", { origin: "creator" })], edges: [], total: 1 }],
		["importance above one", { nodes: [node("a", { importance: 1.5 })], edges: [], total: 1 }],
		["negative createdAt", { nodes: [node("a", { createdAt: -1 })], edges: [], total: 1 }],
		["raw conversation id", { nodes: [node("a", { conversation: "7" })], edges: [], total: 1 }],
		["non-boolean truncated", { nodes: [node("a", { truncated: "no" })], edges: [], total: 1 }],
		["edge to absent node", { edges: [{ from: "digest", to: "missing", kind: "summary" }] }],
		["unknown edge kind", { edges: [{ from: "digest", to: "source", kind: "derived" }] }],
		["relation without derivation", { edges: [{ from: "digest", to: "source", kind: "supports" }] }],
		["unknown derivation", { edges: [{ from: "digest", to: "source", kind: "updates", derivation: "guessed" }] }],
		["self relation", { edges: [{ from: "source", to: "source", kind: "relates", derivation: "explicit" }] }],
		["relation to absent node", { edges: [{ from: "source", to: "missing", kind: "relates", derivation: "explicit" }] }],
		["total below nodes", { total: 1 }],
		["fractional total", { total: 2.5, limited: true }],
		["limited mismatch", { limited: true }],
		["wrong operation", { operation: "stats" }],
		["missing edges", { edges: undefined }],
	])("rejects %s", (_name, patch) => {
		expect(() => parseMemoryGraph({ ...graph, ...patch })).toThrow();
	});
});
