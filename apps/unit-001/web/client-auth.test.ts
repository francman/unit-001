// Exercises pairing, same-origin bearer restoration and stale response cleanup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairBrowserSession, restoreBrowserSession } from "./client-auth.ts";

const sessionToken = "a".repeat(64);
const csrfToken = "b".repeat(64);
const expiresAt = Date.now() + 1_800_000;
const credentials = { sessionToken, csrfToken, expiresAt };
const valid = { authenticated: true, csrfToken, expiresAt };
const storageKey = "unit-001.session";

afterEach(() => vi.unstubAllGlobals());

function storage(initial?: string) {
	const values = new Map<string, string>(initial ? [[storageKey, initial]] : []);
	vi.stubGlobal("navigator", { locks: { request: async (_name: string, update: () => void) => update() } });
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	});
	return values;
}

describe("browser bearer session", () => {
	it("redeems the code once, stores only the bearer and restores from another tab's auth call", async () => {
		const values = storage();
		const fetch = vi.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(Response.json({ ...valid, sessionToken }))
			.mockResolvedValueOnce(Response.json(valid));
		vi.stubGlobal("fetch", fetch);
		expect(await pairBrowserSession("once")).toEqual({ state: "paired", session: credentials });
		expect([...values]).toEqual([[storageKey, sessionToken]]);
		expect(await restoreBrowserSession()).toEqual(credentials);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenNthCalledWith(1, "/api/v1/session", expect.objectContaining({
			method: "POST", credentials: "omit", redirect: "error", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret: "once" }),
		}));
		expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/session", expect.objectContaining({
			credentials: "omit", headers: { Authorization: `Bearer ${sessionToken}` },
		}));
	});

	it("starts unauthenticated without sending a bearer when storage is empty", async () => {
		storage();
		const fetch = vi.fn(async () => Response.json({ authenticated: false }));
		vi.stubGlobal("fetch", fetch);
		expect(await restoreBrowserSession()).toBeNull();
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v1/session", expect.objectContaining({
			credentials: "omit", headers: undefined,
		}));
	});

	it.each([false, true])("clears only the bearer the delayed false response rejected (newer token: %s)", async (replace) => {
		const values = storage(sessionToken);
		let finishRequest!: (response: Response) => void;
		const reply = new Promise<Response>((resolve) => { finishRequest = resolve; });
		vi.stubGlobal("fetch", vi.fn(() => reply));
		const restoring = restoreBrowserSession();
		const newer = "c".repeat(64);
		if (replace) values.set(storageKey, newer);
		finishRequest(Response.json({ authenticated: false }));
		expect(await restoring).toBeNull();
		expect(values.get(storageKey)).toBe(replace ? newer : undefined);
	});

	it("discards a returned expiry in the past but keeps the bearer on an inconclusive check", async () => {
		const values = storage(sessionToken);
		const fetch = vi.fn<typeof globalThis.fetch>()
			.mockRejectedValueOnce(new Error("Offline"))
			.mockResolvedValueOnce(Response.json({ ...valid, expiresAt: 1 }));
		vi.stubGlobal("fetch", fetch);
		await expect(restoreBrowserSession()).rejects.toThrow("Offline");
		expect(values.get(storageKey)).toBe(sessionToken);
		expect(await restoreBrowserSession()).toBeNull();
		expect(values.has(storageKey)).toBe(false);
	});

	it.each([[401, "wrong"], [429, "limited"], [503, "unreachable"]])("reports a pairing failure without changing storage (%s)", async (status, state) => {
		const values = storage(sessionToken);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
		expect(await pairBrowserSession("code")).toEqual({ state });
		expect(values.get(storageKey)).toBe(sessionToken);
	});
});
