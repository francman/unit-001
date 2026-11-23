// Regresses #65 browser-side outcome classification, gateway restart and explicit stable-ID requests.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MissionPlanMutation } from "./contract.ts";
import type { PlanTerms, PlanView, ReviewNote } from "./mission-plan-contract.ts";
import { browserWorkspacePort, parseMemoryGraph, parseWorkspaceView } from "./port.ts";

const csrfToken = "b".repeat(64);
const restartedCsrf = "c".repeat(64);
const workspaceId = "a".repeat(64);
const differentId = "d".repeat(64);
const ownerView = {
	name: "unit", version: "1", installationId: null, model: null, usage: null, busy: false,
	text: "café", textTruncated: false, historyTruncated: false, entries: [], tools: [],
};
const frame = (view = ownerView) => `event: view\ndata: ${JSON.stringify(view)}\n\n`;
const stopWatches = new Set<() => void>();

afterEach(() => {
	for (const stop of stopWatches) stop();
	stopWatches.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const createPort = () => browserWorkspacePort({ csrfToken, workspaceId });

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((finish) => { resolve = finish; });
	return { promise, resolve };
}

async function connectedPort() {
	const fetch = globalThis.fetch;
	vi.stubGlobal("fetch", () => eventResponse(new ReadableStream({
		start: (controller) => controller.enqueue(new TextEncoder().encode(frame())),
	})));
	const port = createPort();
	await new Promise<void>((resolve) => {
		stopWatches.add(port.watch((event) => { if (event.type === "view") resolve(); }));
	});
	vi.stubGlobal("fetch", fetch);
	return port;
}

function sessionResponse(token: string, id = workspaceId) {
	return Response.json({ csrfToken: token }, { headers: { "X-Unit-Workspace": id } });
}

function eventResponse(body: ReadableStream<Uint8Array> | string, id: string | null = workspaceId) {
	return new Response(body, { headers: {
		"Content-Type": "text/event-stream; charset=utf-8",
		...(id === null ? {} : { "X-Unit-Workspace": id }),
	} });
}

function completed(init: RequestInit | undefined, response: unknown) {
	const { requestId } = JSON.parse(String(init?.body));
	return Response.json({ requestId, state: "completed", response });
}

function rolloverReply(init: RequestInit | undefined, token: string, id = workspaceId) {
	const response = completed(init, { type: "sent" });
	response.headers.set("X-Unit-Next-CSRF", token);
	response.headers.set("X-Unit-Workspace", id);
	return response;
}

describe("browser operator transport", () => {
	it("reads closed history pages with an exclusive cursor, including empty continuation pages", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			completed(init, {
				type: "chat-history",
				page: { entries: [{ id: 12, role: "assistant", text: "Older answer", truncated: false, source: "host" }], nextBefore: 12 },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		await expect(port.history(20)).resolves.toEqual({
			entries: [{ id: 12, role: "assistant", text: "Older answer", truncated: false, source: "host" }],
			nextBefore: 12,
		});
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).operation).toEqual({ type: "chat-history", before: 20 });
		fetch.mockImplementation(async (_input, init) =>
			completed(init, { type: "chat-history", page: { entries: [], nextBefore: 9 } }),
		);
		await expect(port.history(12)).resolves.toEqual({ entries: [], nextBefore: 9 });
		await expect(port.history(9)).rejects.toThrow("Invalid chat history continuation.");
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it.each([400, 403, 409, 429])("#65 distinguishes pre-dispatch HTTP %s from unknown delivery", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status })),
		);
		const port = await connectedPort();
		expect(await port.send("work", "stable")).toMatchObject({ state: "failed" });
		expect(await port.forget("memory-id", "forget-stable")).toMatchObject({ state: "failed" });
	});

	it("reports 429 as not sent and leaves the verified connection available for a deliberate new action", async () => {
		const fetch = vi.fn(async (_path: string, init?: RequestInit) => completed(init, { type: "sent" }));
		fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		await expect(port.send("work", "capacity")).resolves.toEqual({
			state: "failed",
			message: "Request not sent: the gateway is at capacity. Wait for active requests to finish, then try again.",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		await expect(port.send("work", "deliberate")).resolves.toEqual({ state: "completed" });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("X-Unit-CSRF")).toBe(csrfToken);
	});

	it("adopts rollover credentials in place across 100 deliberate sends", async () => {
		let admitted = 0;
		let credential = csrfToken;
		const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
			if (new Headers(init?.headers).get("X-Unit-CSRF") !== credential) return new Response(null, { status: 403 });
			if (++admitted % 24 !== 0) return completed(init, { type: "sent" });
			credential = `generation-${admitted}`;
			return rolloverReply(init, credential);
		});
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		for (let i = 0; i < 100; i++) {
			await expect(port.send("work", `click-${i}`)).resolves.toEqual({ state: "completed" });
		}
		expect(admitted).toBe(100);
		expect(fetch).toHaveBeenCalledTimes(100);
	});

	it("keeps a matching outcome when rollover metadata cannot verify the endpoint or credential", async () => {
		const fetch = vi.fn(async (_path: string, init?: RequestInit) => rolloverReply(init, restartedCsrf, differentId));
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		await expect(port.send("work", "settled")).resolves.toEqual({ state: "completed" });
		await expect(port.send("work", "while-unverified")).resolves.toMatchObject({ state: "failed" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not adopt a hint on a mismatched reply or replay a lost rollover reply", async () => {
		const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
			const { requestId } = JSON.parse(String(init?.body));
			if (requestId === "lost") throw new Error("response lost at rollover");
			return new Response(null, { status: 403 });
		});
		fetch.mockResolvedValueOnce(rolloverReply({ body: '{"requestId":"different"}' }, "unverified-hint"));
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		await expect(port.send("work", "wrong-id")).resolves.toMatchObject({ state: "unknown" });
		await expect(port.send("work", "lost")).resolves.toMatchObject({ state: "unknown" });
		expect(fetch).toHaveBeenCalledTimes(2);
		await expect(port.send("fresh action", "after-loss")).resolves.toMatchObject({ state: "failed" });
		expect(fetch).toHaveBeenCalledTimes(3);
		for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get("X-Unit-CSRF")).toBe(csrfToken);
	});

	it("keeps the new credential through delayed old replies and another tab's stale rejection", async () => {
		const late = deferredResponse();
		const stale = deferredResponse();
		const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
			const { requestId } = JSON.parse(String(init?.body));
			switch (requestId) {
				case "late": return late.promise;
				case "stale": return stale.promise;
				case "capacity": return new Response(null, { status: 429 });
				case "settled": return rolloverReply(init, restartedCsrf);
				default: return new Headers(init?.headers).get("X-Unit-CSRF") === restartedCsrf
					? completed(init, { type: "sent" })
					: new Response(null, { status: 403 });
			}
		});
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		const otherTab = await connectedPort();
		const lateOutcome = port.send("earlier write", "late");
		const staleOutcome = port.send("delayed rejection", "stale");
		await expect(port.send("capacity", "capacity")).resolves.toMatchObject({ state: "failed" });
		await expect(port.send("settling write", "settled")).resolves.toEqual({ state: "completed" });
		late.resolve(rolloverReply(fetch.mock.calls[0]?.[1], "obsolete-hint"));
		stale.resolve(new Response(null, { status: 403 }));
		await expect(lateOutcome).resolves.toEqual({ state: "completed" });
		await expect(staleOutcome).resolves.toMatchObject({ state: "failed" });
		await expect(otherTab.send("old tab", "other-tab")).resolves.toMatchObject({ state: "failed" });
		await expect(port.send("new click", "new-click")).resolves.toEqual({ state: "completed" });
		expect(fetch).toHaveBeenCalledTimes(6);
	});

	it("#65 retains unknown delivery after gateway loss without replay", async () => {
		const fetch = vi.fn(async () => Response.json({ requestId: "stable", state: "unknown" }));
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
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
		const port = await connectedPort();
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
		const port = await connectedPort();
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
		const port = await connectedPort();
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
		const port = await connectedPort();
		expect(await port.forget("memory-id", "same-explicit-id")).toEqual({ state: "completed" });
		expect(await port.forget("memory-id", "same-explicit-id")).toEqual({ state: "completed" });
		expect(fetch).toHaveBeenCalledTimes(2);
		for (const [path, init] of fetch.mock.calls) {
			expect(path).toBe("/api/v1/requests");
			expect(init).toMatchObject({
				method: "POST",
				credentials: "omit",
				redirect: "error",
				headers: { "Content-Type": "application/json", "X-Unit-CSRF": csrfToken },
			});
			expect(JSON.parse(String(init?.body))).toMatchObject({
				requestId: "same-explicit-id",
				operation: { request: { confirmed: true, id: "memory-id" } },
			});
		}
	});

	it.each(["EOF", "CSRF rejection"])("refreshes metadata after %s without replaying the prior write", async (failure) => {
		vi.useFakeTimers();
		let attempts = 0;
		const cancel = vi.fn();
		let closeFirst!: () => void;
		const fetch = vi.fn(async (path: string, init?: RequestInit) => {
			if (path.endsWith("requests")) {
				const { requestId } = JSON.parse(String(init?.body));
				if (requestId === "stable") return failure === "EOF"
					? Response.json({ requestId, state: "unknown" })
					: new Response(null, { status: 403 });
				return completed(init, { type: "sent" });
			}
			if (path.endsWith("session")) return sessionResponse(restartedCsrf);
			const first = ++attempts === 1;
			return eventResponse(new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(frame()));
					if (first) closeFirst = () => controller.close();
				},
				cancel,
			}));
		});
		vi.stubGlobal("fetch", fetch);
		const port = createPort();
		const receive = vi.fn();
		const unwatch = port.watch(receive);
		await vi.advanceTimersByTimeAsync(0);
		const outcome = await port.send("work", "stable");
		if (failure === "EOF") expect(outcome).toMatchObject({ state: "unknown" });
		else expect(outcome).toEqual({
			state: "failed",
			message: "Request not sent. Wait for this workspace to reconnect, then try the action again.",
		});
		if (failure === "EOF") closeFirst();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2999);
		expect(attempts).toBe(1);
		await expect(port.send("during disconnect", "dropped")).resolves.toMatchObject({ state: "failed" });
		await vi.advanceTimersByTimeAsync(1);
		expect(receive.mock.calls.map(([event]) => event)).toEqual([
			{ type: "view", view: ownerView },
			{ type: "connection", state: "offline" },
			{ type: "view", view: ownerView },
		]);
		expect(fetch.mock.calls.map(([path]) => path)).toEqual([
			"/api/v1/events", "/api/v1/requests", "/api/v1/session", "/api/v1/events",
		]);
		await expect(port.send("work", "new-id")).resolves.toEqual({ state: "completed" });
		const [first, next] = fetch.mock.calls.filter(([path]) => path === "/api/v1/requests");
		expect(new Headers(first?.[1]?.headers).get("X-Unit-CSRF")).toBe(csrfToken);
		expect(new Headers(next?.[1]?.headers).get("X-Unit-CSRF")).toBe(restartedCsrf);
		expect(JSON.parse(String(next?.[1]?.body))).toEqual({ requestId: "new-id", operation: { type: "send", prompt: "work" } });
		for (const [path, init] of fetch.mock.calls) {
			expect(init?.credentials).toBe("omit");
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
			if (path.endsWith("events")) expect(new Headers(init?.headers).get("Accept")).toBe("text/event-stream");
		}
		unwatch();
		expect(cancel).toHaveBeenCalledTimes(failure === "EOF" ? 1 : 2);
		await vi.advanceTimersByTimeAsync(6000);
		expect(fetch).toHaveBeenCalledTimes(5);
	});

	it.each([200, 403])("does not let a late HTTP %s from the old connection affect the verified stream", async (status) => {
		vi.useFakeTimers();
		const late = deferredResponse();
		let closeFirst!: () => void;
		const fetch = vi.fn(async (path: string, init?: RequestInit) => {
			if (path.endsWith("session")) return sessionResponse(restartedCsrf);
			if (path.endsWith("requests")) {
				return JSON.parse(String(init?.body)).requestId === "late" ? late.promise : completed(init, { type: "sent" });
			}
			return eventResponse(new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(frame()));
					closeFirst ??= () => controller.close();
				},
			}));
		});
		vi.stubGlobal("fetch", fetch);
		const port = createPort();
		const receive = vi.fn();
		stopWatches.add(port.watch(receive));
		await vi.advanceTimersByTimeAsync(0);
		const pending = port.send("work", "late");
		closeFirst();
		await vi.advanceTimersByTimeAsync(3000);
		expect(receive).toHaveBeenLastCalledWith({ type: "view", view: ownerView });
		late.resolve(status === 200
			? Response.json({ requestId: "late", state: "completed", response: { type: "sent" } })
			: new Response(null, { status }));
		await expect(pending).resolves.toMatchObject({ state: status === 200 ? "unknown" : "failed" });
		await vi.advanceTimersByTimeAsync(3000);
		expect(receive).toHaveBeenCalledTimes(3);
		expect(fetch).toHaveBeenCalledTimes(4);
		await expect(port.send("work", "deliberate")).resolves.toEqual({ state: "completed" });
	});

	it("stays offline without dispatching when reconnect metadata is malformed", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async (path: string) => path.endsWith("events")
			? eventResponse("")
			: Response.json({ csrfToken: restartedCsrf, expiresAt: Date.now() }, { headers: { "X-Unit-Workspace": workspaceId } }));
		vi.stubGlobal("fetch", fetch);
		const receive = vi.fn();
		const port = createPort();
		const unwatch = port.watch(receive);
		await vi.advanceTimersByTimeAsync(6000);
		await expect(port.send("work", "not-dispatched")).resolves.toMatchObject({ state: "failed" });
		expect(receive).toHaveBeenLastCalledWith({ type: "connection", state: "offline" });
		expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/v1/events", "/api/v1/session", "/api/v1/session"]);
		unwatch();
	});

	it.each(["session", "events"] as const)("latches a different identity at %s without accepting its views or token", async (mismatchAt) => {
		vi.useFakeTimers();
		let streamCount = 0;
		const fetch = vi.fn(async (path: string) => {
			if (path.endsWith("session")) return sessionResponse(restartedCsrf, mismatchAt === "session" ? differentId : workspaceId);
			const first = ++streamCount === 1;
			return eventResponse(frame(first ? ownerView : { ...ownerView, name: "different owner" }), first ? workspaceId : differentId);
		});
		vi.stubGlobal("fetch", fetch);
		const port = createPort();
		const receive = vi.fn();
		const unwatch = port.watch(receive);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(port.send("old draft", "blocked")).resolves.toMatchObject({ state: "failed" });
		expect(receive.mock.calls.map(([event]) => event)).toEqual([
			{ type: "view", view: ownerView },
			{ type: "connection", state: "offline" },
			{ type: "connection", state: "workspace-changed" },
		]);
		expect(fetch.mock.calls.map(([path]) => path)).toEqual([
			"/api/v1/events", "/api/v1/session", ...(mismatchAt === "events" ? ["/api/v1/events"] : []),
		]);
		unwatch();
	});

	it("does not release requests before a matching view, and ignores a stream with no identity", async () => {
		vi.useFakeTimers();
		let emit!: () => void;
		const stream = new ReadableStream({
			start: (controller) => { emit = () => controller.enqueue(new TextEncoder().encode(frame())); },
		});
		const fetch = vi.fn(async (path: string, init?: RequestInit) => path.endsWith("requests")
			? completed(init, { type: "sent" })
			: path.endsWith("session") ? sessionResponse(restartedCsrf) : eventResponse(stream));
		fetch.mockResolvedValueOnce(eventResponse(frame({ ...ownerView, name: "unidentified view" }), null));
		vi.stubGlobal("fetch", fetch);
		const port = createPort();
		const receive = vi.fn();
		const unwatch = port.watch(receive);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(port.send("old draft", "blocked")).resolves.toMatchObject({ state: "failed" });
		expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "connection", state: "offline" });
		expect(fetch.mock.calls.some(([path]) => path.endsWith("requests"))).toBe(false);
		emit();
		await vi.advanceTimersByTimeAsync(0);
		await expect(port.send("old draft", "deliberate")).resolves.toEqual({ state: "completed" });
		expect(receive).toHaveBeenLastCalledWith({ type: "view", view: ownerView });
		unwatch();
	});

	it("ignores a late metadata response after stopping the watch", async () => {
		vi.useFakeTimers();
		let finishProbe!: (response: Response) => void;
		const probe = new Promise<Response>((resolve) => { finishProbe = resolve; });
		const fetch = vi.fn(async (path: string) => path.endsWith("events") ? eventResponse("") : probe);
		vi.stubGlobal("fetch", fetch);
		const receive = vi.fn();
		const port = createPort();
		const unwatch = port.watch(receive);
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetch).toHaveBeenCalledTimes(2);
		unwatch();
		finishProbe(sessionResponse(restartedCsrf));
		await vi.advanceTimersByTimeAsync(6000);
		await expect(port.send("work", "not-dispatched")).resolves.toMatchObject({ state: "failed" });
		expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "connection", state: "offline" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("does not carry a pending Agree click across a same-workspace reconnect", async () => {
		vi.useFakeTimers();
		let finishRead!: () => void;
		let closeFirst!: () => void;
		let streams = 0;
		const change = { operation: "agree", revision: 3, digest: "d".repeat(64), confirmed: true } as const;
		const fetch = vi.fn(async (path: string, init?: RequestInit) => {
			if (path.endsWith("session")) return sessionResponse(restartedCsrf);
			if (path.endsWith("events")) {
				const first = ++streams === 1;
				return eventResponse(new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(frame()));
						if (first) closeFirst = () => controller.close();
					},
				}));
			}
			return new Promise<Response>((resolve) => {
				finishRead = () => resolve(completed(init, {
					type: "mission", result: {
						stage: "awaiting_approval", authority: "developer-local", canAgree: true, agreementValid: false,
						authorityError: null, creator: null, missing: [], execution: "not-started", tools: [],
						formation: { agreement: null, draft: { missionId: "m", revision: 3, digest: change.digest, status: "proposed", terms: agreement.terms } },
					},
				}));
			});
		});
		vi.stubGlobal("fetch", fetch);
		const port = createPort();
		const receive = vi.fn();
		const unwatch = port.watch(receive);
		await vi.advanceTimersByTimeAsync(0);
		const outcome = port.mutateMission(change, "old-click");
		expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).operation.request.operation).toBe("status");
		closeFirst();
		await vi.advanceTimersByTimeAsync(3000);
		expect(receive).toHaveBeenLastCalledWith({ type: "view", view: ownerView });
		finishRead();
		await expect(outcome).resolves.toEqual({ state: "rejected" });
		expect(fetch.mock.calls.filter(([path]) => path.endsWith("requests"))).toHaveLength(1);
		unwatch();
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
		usage: null,
		text: "",
		textTruncated: false,
		historyTruncated: false,
		entries: [],
		tools: [],
	};
	it("requires positive strictly ascending live row IDs while allowing gaps", () => {
		const entries = (ids: number[]) => ids.map((id) => ({ id, role: "user", text: "message", truncated: false }));
		for (const ids of [[0], [-1], [3, 3], [7, 4], [1.2]])
			expect(() => parseWorkspaceView({ ...base, entries: entries(ids) })).toThrow();
		expect(parseWorkspaceView({ ...base, entries: entries([1, 9]) }).entries.map((row) => row.id)).toEqual([1, 9]);
	});
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
		expect((await (await connectedPort()).details()).owner).toEqual({
			uptimeMs: 1234,
			held: false,
			inhibited: true,
			configured: true,
		});
		stubOwner({ status: status("held", "unconfigured") });
		expect((await (await connectedPort()).details()).owner).toMatchObject({ held: true, configured: false });
	});
	it("leaves owner null when status fails without failing details", async () => {
		stubOwner({ status: { type: "error", message: "x" } });
		const details = await (await connectedPort()).details();
		expect(details.owner).toBeNull();
		expect(details.mission.stage).toBe("agreed");
	});
	it("parses agreement, run, tools and memory stats", async () => {
		stubOwner({ agreement, run });
		const details = await (await connectedPort()).details();
		expect(details.mission.tools).toEqual(["read"]);
		expect(details.mission.agreement).toEqual({
			revision: 3,
			successCriteria: ["tests pass"],
			approvalBoundary: ["no deploy"],
			reviewEveryMs: 60000,
			approvedAt: 1000,
			approvedBy: "local-creator",
			allowedTools: ["read"],
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
		expect((await (await connectedPort()).details()).mission.tools).toEqual(tools);
		stubOwner({ mission: { tools: [...tools, "extra"] } });
		await expect((await connectedPort()).details()).rejects.toThrow("Invalid owner list.");
	});
	it("returns null agreement and run when absent", async () => {
		stubOwner({});
		const details = await (await connectedPort()).details();
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
			await expect((await connectedPort()).details()).rejects.toThrow();
		}
	});
	it("maps channel health, failure and awaiting step and never exposes the confirmation url", async () => {
		stubOwner({});
		const details = await (await connectedPort()).details();
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
		const { mission } = await (await connectedPort()).details();
		expect(mission.creator).toEqual({ kind: "human", id: "owner" });
		expect(mission.authority).toBe("developer-local");
		expect(mission.agreementValid).toBe(true);
		expect(mission.authorityError).toBeNull();
		expect(mission.draft).toEqual({ revision: 4, status: "proposed", digest: "d".repeat(64) });
		stubOwner({ mission: { creator: null, authority: "invalid", authorityError: "invalid-authority" } });
		expect((await (await connectedPort()).details()).mission).toMatchObject({
			creator: null,
			authority: "invalid",
			authorityError: "invalid-authority",
			draft: null,
		});
	});
	it("retains exact proposal terms and fails closed on an inconsistent review or missing capability", async () => {
		const terms = { ...agreement.terms, objective: "exact\r\n\u202E" };
		const digest = "a".repeat(64);
		const draft = { missionId: "m1", revision: 4, status: "proposed", digest, terms };
		const review = { missionId: "m1", revision: 4, digest, authorityRevision: 9, previousReceipt: "receipt-3" };
		stubOwner({ draft, mission: { authority: "managed-administrator", canAgree: true, previousReceipt: "receipt-3", review } });
		await expect((await connectedPort()).mission()).resolves.toMatchObject({ draft, review, canAgree: false, formationAvailable: true });
		stubOwner({ draft, mission: { authority: "managed-administrator", canAgree: false, previousReceipt: "receipt-3", review } });
		await expect((await connectedPort()).mission()).resolves.toMatchObject({ draft, review, canAgree: false, formationAvailable: true });
		stubOwner({ draft, mission: { authority: "managed-administrator", canAgree: true, previousReceipt: "receipt-4", review } });
		await expect((await connectedPort()).mission()).resolves.toMatchObject({ review: null, canAgree: false, formationAvailable: false });
		stubOwner({ draft });
		await expect((await connectedPort()).mission()).resolves.toMatchObject({ draft, canAgree: false, formationAvailable: false });
		stubOwner({ draft: { ...draft, digest: null }, mission: { authority: "managed-administrator", canAgree: false } });
		await expect((await connectedPort()).mission()).resolves.toMatchObject({ draft: { digest: null, terms }, canAgree: false, formationAvailable: true });
	});
	it("only dispatches legacy Agree for affirmative developer-local status and checks the recorded approver", async () => {
		const change = { operation: "agree", revision: 3, digest: "d".repeat(64), confirmed: true } as const;
		const draft = { missionId: "m", revision: change.revision, digest: change.digest, status: "proposed", terms: agreement.terms };
		const recorded = { ...agreement, approval: { ...agreement.approval, approvedBy: { kind: "developer-local" } } };
		for (const [authority, canAgree, approved] of [
			["managed-administrator", true, recorded],
			["developer-local", false, recorded],
			["developer-local", undefined, recorded],
			["developer-local", true, agreement],
			["developer-local", true, recorded],
		] as const) {
			const sent: string[] = [];
			vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
				const { operation } = JSON.parse(String(init?.body));
				sent.push(operation.request.operation);
				return completed(init, { type: "mission", result: {
					stage: "awaiting_approval", formation: operation.request.operation === "status"
						? { draft, agreement: null } : { draft: null, agreement: approved },
					authority, canAgree, agreementValid: true, authorityError: null,
					creator: null, missing: [], execution: "not-started", tools: [],
				} });
			}));
			const port = await connectedPort();
			const allowed = authority === "developer-local" && canAgree === true;
			expect(await port.mutateMission(change, "agree")).toMatchObject({
				state: !allowed ? "rejected" : approved === recorded ? "completed" : "unknown",
			});
			expect(sent).toEqual(allowed ? ["status", "agree"] : ["status"]);
		}
	});
	it("rejects malformed mission authority fields", async () => {
		for (const bad of [
			{ authority: "root" },
			{ agreementValid: "yes" },
			{ authority: "invalid", authorityError: "unexpected internal path" },
			{ creator: { kind: "robot", id: "x" } },
		]) {
			stubOwner({ mission: bad });
			await expect((await connectedPort()).details()).rejects.toThrow();
		}
		stubOwner({ draft: { revision: 1, status: "agreed", digest: null } });
		await expect((await connectedPort()).details()).rejects.toThrow();
	});
	it("recall returns null stats", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				completed(init, { type: "memory", result: { operation: "recall", records: [] } }),
			),
		);
		expect(await (await connectedPort()).recall("q")).toEqual({ count: null, stats: null, records: [] });
	});
});

const charter: PlanTerms = {
	overall: {
		purpose: "Ship café", scope: "Repository", askFirst: ["deploy"], reviewEveryMs: 500,
		reviewAllowance: { maxRequests: 8, maxRequestsPerReview: 3, maxEstimatedCost: 1.25 },
	},
	strategics: [],
	tacticals: [],
};
const exactDigest = "b".repeat(64);
const charterDraft = {
	revision: 2, baseRevision: 0, status: "editing", terms: charter, digest: null, savedBy: "owner",
	fromReview: null, missing: [],
} as const;
const proposedCharter: PlanView = {
	missionId: "m1",
	adopted: false,
	head: null,
	headValid: false,
	previous: null,
	history: [],
	draft: { ...charterDraft, status: "proposed", digest: exactDigest },
	gate: { state: "not-adopted", reason: null },
	runs: { used: 0, limit: 32 },
	allowance: null,
	turns: [],
	blocker: null,
	due: [],
	preview: null,
	reviews: [],
};
const approvedCharter: PlanView = {
	...proposedCharter,
	adopted: true,
	head: { revision: 2, digest: exactDigest, previousDigest: null, terms: charter, agreedAt: 100, receiptId: "receipt-2" },
	headValid: true,
	history: [{ revision: 2, digest: exactDigest, agreedAt: 100 }],
	draft: null,
	gate: { state: "closed", reason: "binding" },
};
const recordedReview: ReviewNote = {
	reviewId: "review-a",
	key: "2:owner:click",
	trigger: { kind: "owner", key: "2:owner:click", subject: "click" },
	planRevision: 2,
	planDigest: exactDigest,
	window: { from: 100, to: 200 },
	createdAt: 200,
	outcome: "no-change",
	items: [],
	facts: { runsUsed: 0, runsLimit: 32, cycles: 0, maxCycles: 0, requests: 0, maxRequests: 0, estimatedCost: 0, maxEstimatedCost: null },
	uncertainty: [],
	disposition: null,
};
const agreeCharter = { operation: "plan-agree", revision: 2, digest: exactDigest, confirmed: true } as const;

function missionReply(fields: Record<string, unknown>) {
	return {
		type: "mission",
		result: {
			stage: "agreed", formation: { agreement: null, draft: null }, creator: null,
			authority: "developer-local", agreementValid: false, authorityError: null, missing: [], execution: "not-started",
			tools: [], plan: proposedCharter, planError: null, canAgreePlan: true, runnablePurposeBinding: null, ...fields,
		},
	};
}

describe("browser plan transport", () => {
	it("reads plan status through the existing mission status operation and projects only the exact binding", async () => {
		const binding = { missionId: "m1", purposeRevision: 7, purposeDigest: "c".repeat(64) };
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			completed(init, missionReply({ runnablePurposeBinding: binding })),
		);
		vi.stubGlobal("fetch", fetch);
		await expect((await connectedPort()).mission()).resolves.toMatchObject({
			plan: proposedCharter, planError: null, canAgreePlan: true, runnablePurposeBinding: binding,
		});
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).operation).toEqual({
			type: "mission", request: { operation: "status" },
		});
		fetch.mockImplementationOnce(async (_input, init) =>
			completed(init, missionReply({ plan: undefined, planError: undefined, canAgreePlan: undefined, runnablePurposeBinding: undefined })),
		);
		const older = await (await connectedPort()).mission();
		expect(older).not.toHaveProperty("plan");
		expect(older).not.toHaveProperty("runnablePurposeBinding");
		fetch.mockImplementationOnce(async (_input, init) =>
			completed(init, missionReply({ plan: null, planError: "invalid-plan" })),
		);
		await expect((await connectedPort()).mission()).resolves.toMatchObject({ plan: null, planError: "invalid-plan", canAgreePlan: false });
		fetch.mockImplementationOnce(async (_input, init) =>
			completed(init, missionReply({ runnablePurposeBinding: { ...binding, uid: 501 } })),
		);
		await expect((await connectedPort()).mission()).rejects.toThrow("Invalid mission plan projection.");
	});

	it("sends each exact DTO with the supplied stable ID and reads the matching completed view", async () => {
		const changes: MissionPlanMutation[] = [
			{ operation: "plan-draft", expectedRevision: 1, terms: charter },
			{ operation: "plan-propose", expectedRevision: 2 },
			agreeCharter,
			{ operation: "review-now" },
			{ operation: "review-dismiss", reviewId: recordedReview.reviewId },
		];
		const replies = [
			{ ...proposedCharter, draft: charterDraft },
			proposedCharter,
			approvedCharter,
			{ ...approvedCharter, reviews: [recordedReview] },
			{ ...approvedCharter, reviews: [{ ...recordedReview, disposition: { kind: "dismissed", at: 250, draftRevision: null } }] },
		];
		let next = 0;
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			completed(init, missionReply({ plan: replies[next++] })),
		);
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		for (const [index, change] of changes.entries()) {
			// A wider same-host object must not send protected or operation-irrelevant keys.
			const wider = { ...change, claim: "administrator", requestId: "payload-id" };
			await expect(port.mutateMissionPlan(wider, `click-${index}`)).resolves.toMatchObject({
				state: "completed", mission: { plan: replies[index] },
			});
			expect(JSON.parse(String(fetch.mock.calls[index]?.[1]?.body))).toEqual({
				requestId: `click-${index}`, operation: { type: "mission", request: change },
			});
		}
		expect(fetch).toHaveBeenCalledTimes(5);
	});

	it.each([
		["no capability", { canAgreePlan: undefined, canAgree: true }],
		["negative capability", { canAgreePlan: false }],
		["string capability", { canAgreePlan: "true" }],
		["managed authority despite affirmative capability", { authority: "managed-administrator", canAgreePlan: true }],
		["withheld proposal digest", { plan: { ...proposedCharter, draft: { ...proposedCharter.draft, digest: null } } }],
		["projected stale bindings", { plan: { ...proposedCharter, draft: { ...proposedCharter.draft, missing: ["Stale binding"] } } }],
	])("does not dispatch Agree with %s", async (_name, fields) => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => completed(init, missionReply(fields)));
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		await expect(port.mutateMissionPlan(agreeCharter, "without-read")).resolves.toEqual({ state: "rejected" });
		await port.mission();
		await expect(port.mutateMissionPlan(agreeCharter, "click")).resolves.toEqual({ state: "rejected" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps plan agreement exact, distinct from issuance and never retries after an unknown result", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => completed(init, missionReply({})));
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		await port.mission();
		await expect(port.mutateMissionPlan({ ...agreeCharter, digest: "c".repeat(64) }, "wrong")).resolves.toEqual({ state: "rejected" });
		expect(fetch).toHaveBeenCalledTimes(1);
		fetch.mockImplementationOnce(async () => Response.json({ requestId: "click", state: "issued", receiptId: "receipt-2", reconciled: false }));
		await expect(port.mutateMissionPlan(agreeCharter, "click")).resolves.toEqual({ state: "issued", receiptId: "receipt-2", reconciled: false });
		await expect(port.mutateMissionPlan(agreeCharter, "without-refresh")).resolves.toEqual({ state: "rejected" });
		await port.mission();
		fetch.mockImplementationOnce(async (_input, init) =>
			completed(init, missionReply({
				plan: { ...approvedCharter, head: { ...approvedCharter.head, digest: "c".repeat(64) },
					history: [{ revision: 2, digest: "c".repeat(64), agreedAt: 100 }] },
			})),
		);
		await expect(port.mutateMissionPlan(agreeCharter, "wrong-digest")).resolves.toEqual({ state: "unknown" });
		expect(fetch).toHaveBeenCalledTimes(4);
		fetch.mockImplementationOnce(async (_input, init) => completed(init, missionReply({ plan: approvedCharter })));
		await expect(port.mission()).resolves.toMatchObject({ plan: { head: { digest: exactDigest } } });
		expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).operation.request.operation)).toEqual([
			"status", "plan-agree", "status", "plan-agree", "status",
		]);
	});

	it("distinguishes closed refusal codes, pre-dispatch rejection and malformed or mismatched replies without replay", async () => {
		const change = { operation: "review-dismiss", reviewId: recordedReview.reviewId } as const;
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			completed(init, missionReply({ plan: { ...approvedCharter, reviews: [recordedReview] } })),
		);
		vi.stubGlobal("fetch", fetch);
		const port = await connectedPort();
		fetch.mockImplementationOnce(async () => Response.json({ requestId: "refused", state: "refused", code: "stale-revision" }));
		await expect(port.mutateMissionPlan(change, "refused")).resolves.toEqual({ state: "refused", code: "stale-revision" });
		fetch.mockImplementationOnce(async () => Response.json({ requestId: "other", state: "refused", code: "stale-revision" }));
		await expect(port.mutateMissionPlan(change, "other-id")).resolves.toEqual({ state: "unknown" });
		fetch.mockImplementationOnce(async () => Response.json({ requestId: "bad-code", state: "refused", code: "superseded" }));
		await expect(port.mutateMissionPlan(change, "bad-code")).resolves.toEqual({ state: "unknown" });
		fetch.mockImplementationOnce(async () => Response.json({ requestId: "wrong-result", state: "issued", receiptId: "unused", reconciled: true }));
		await expect(port.mutateMissionPlan(change, "wrong-result")).resolves.toEqual({ state: "unknown" });
		await expect(port.mutateMissionPlan(change, "not-dismissed")).resolves.toEqual({ state: "unknown" });
		fetch.mockImplementationOnce(async (_input, init) =>
			completed(init, missionReply({ plan: { ...approvedCharter, reviews: [{ ...recordedReview, facts: null }] } })),
		);
		await expect(port.mutateMissionPlan(change, "malformed-review")).resolves.toEqual({ state: "unknown" });
		fetch.mockImplementationOnce(async () => new Response(null, { status: 403 }));
		await expect(port.mutateMissionPlan(change, "denied")).resolves.toEqual({ state: "rejected" });
		await expect(port.mutateMissionPlan(change, "after-denial")).resolves.toEqual({ state: "rejected" });
		expect(fetch).toHaveBeenCalledTimes(7);
	});

	it.each([workspaceId, differentId])("does not carry plan actions across an unverified stream (%s)", async (nextId) => {
		vi.useFakeTimers();
		let closeFirst!: () => void;
		let streams = 0;
		const posts = vi.fn(async (init?: RequestInit) => {
			const { operation } = JSON.parse(String(init?.body));
			return completed(init, missionReply(operation.request.operation === "plan-agree" ? { plan: approvedCharter } : {}));
		});
		vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
			if (path.endsWith("session")) return sessionResponse(csrfToken);
			if (path.endsWith("requests")) return posts(init);
			const first = ++streams === 1;
			return eventResponse(new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(frame()));
					if (first) closeFirst = () => controller.close();
				},
			}), first ? workspaceId : nextId);
		});
		const port = createPort();
		const receive = vi.fn();
		stopWatches.add(port.watch(receive));
		await vi.advanceTimersByTimeAsync(0);
		await port.mission();
		closeFirst();
		await vi.advanceTimersByTimeAsync(0);
		await expect(port.mutateMissionPlan({ operation: "review-now" }, "offline")).resolves.toEqual({ state: "rejected" });
		await vi.advanceTimersByTimeAsync(3000);
		await expect(port.mutateMissionPlan(agreeCharter, "retired-proposal")).resolves.toEqual({ state: "rejected" });
		if (nextId === differentId) {
			expect(receive).toHaveBeenLastCalledWith({ type: "connection", state: "workspace-changed" });
			await expect(port.mutateMissionPlan({ operation: "review-now" }, "other-workspace")).resolves.toEqual({ state: "rejected" });
			expect(posts).toHaveBeenCalledTimes(1);
		} else {
			expect(receive).toHaveBeenLastCalledWith({ type: "view", view: ownerView });
			expect(posts).toHaveBeenCalledTimes(1);
			await port.mission();
			await expect(port.mutateMissionPlan(agreeCharter, "new-click")).resolves.toMatchObject({ state: "completed" });
			expect(posts).toHaveBeenCalledTimes(3);
		}
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
		const view = await (await connectedPort()).memoryGraph();
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
		await expect((await connectedPort()).memoryGraph()).rejects.toThrow();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ state: "unknown", message: "x" })),
		);
		await expect((await connectedPort()).memoryGraph()).rejects.toThrow();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				completed(init, { type: "memory", result: { operation: "recall", records: [] } }),
			),
		);
		await expect(createPort().memoryGraph()).rejects.toThrow();
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
