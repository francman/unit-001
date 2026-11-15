// Regresses #65 browser-side outcome classification, expiry and explicit stable-ID requests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWorkspacePort } from "./port.ts";

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
	it("#65 distinguishes a known owner failure from a transport exception", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ state: "completed", response: { type: "error", message: "sanitized failure" } }),
			),
		);
		expect(await browserWorkspacePort("csrf").send("work", "id")).toMatchObject({ state: "failed" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network lost");
			}),
		);
		expect(await browserWorkspacePort("csrf").send("work", "id")).toMatchObject({ state: "unknown" });
	});
	it("#65 preserves explicitly supplied forget identities and never retries them automatically", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				state: "completed",
				response: { type: "memory", result: { operation: "forget", removed: true } },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		const port = browserWorkspacePort("csrf");
		await port.forget("memory-id", "same-explicit-id");
		await port.forget("memory-id", "same-explicit-id");
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
