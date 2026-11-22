// Exercises gateway metadata validation without browser credentials.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGatewaySession, WorkspaceChanged } from "./client-auth.ts";

afterEach(() => vi.unstubAllGlobals());

const workspaceId = "ae12".repeat(16);
const headers = { "X-Unit-Workspace": workspaceId };

describe("gateway metadata", () => {
	it("reads the identity and token with a credential-free same-origin GET", async () => {
		const csrfToken = "b".repeat(64);
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ csrfToken }, { headers }));
		vi.stubGlobal("fetch", fetch);
		await expect(readGatewaySession()).resolves.toEqual({ workspaceId, csrfToken });
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v1/session", {
			cache: "no-store", credentials: "omit", mode: "same-origin", redirect: "error", signal: expect.any(AbortSignal),
		});
	});

	it.each([null, [], {}, { csrfToken: "" }, { csrfToken: 42 }, { csrfToken: "a\n" }, { csrfToken: "a", authenticated: true }].map((body) => ({ body })))(
		"rejects malformed metadata $body",
		async ({ body }) => {
			vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { headers })));
			await expect(readGatewaySession()).rejects.toThrow("Invalid gateway metadata.");
		},
	);

	it.each([undefined, "", "a".repeat(63), "A".repeat(64), `${workspaceId}, ${workspaceId}`])(
		"rejects a missing, malformed or repeated identity: %s",
		async (id) => {
			vi.stubGlobal("fetch", vi.fn(async () => Response.json({ csrfToken: "token" }, {
				headers: id === undefined ? {} : { "X-Unit-Workspace": id },
			})));
			await expect(readGatewaySession()).rejects.toThrow("Invalid workspace identity.");
		},
	);

	it("reports a changed identity without trusting the new session body", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { headers })));
		await expect(readGatewaySession(undefined, "f".repeat(64))).rejects.toBeInstanceOf(WorkspaceChanged);
	});

	it("rejects a non-success response even if its body has a token", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ csrfToken: "token" }, { status: 503 })));
		await expect(readGatewaySession()).rejects.toThrow("Gateway metadata is unavailable.");
	});
});
