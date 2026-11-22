// #26 (sec-ipc Low 1): the browser receives only the closed workspace projection of each owner frame.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceView } from "../src/service.ts";
import type { ServiceClient } from "../src/service-client.ts";
import { parseWebRequest } from "../src/web/contract.ts";
import { createWebGateway } from "../src/web/gateway.ts";
import { projectWebResponse } from "../src/web/post-response.ts";

const servers: ReturnType<typeof createWebGateway>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((gateway) => gateway.close()));
});

const ownerFrame: ServiceView = {
	pid: 4242,
	version: "1.0.0",
	name: "bob",
	installationId: null,
	model: { provider: "faux", modelId: "faux-1" },
	usage: null,
	entries: [{ id: 1, role: "assistant", text: "hello", truncated: false }],
	busy: false,
	text: "",
	textTruncated: false,
	tools: [{ callId: "toolu_1", name: "bash", status: "failed", reason: { code: "exit_code", exitCode: 2 } }],
	historyTruncated: false,
	failure: { reason: "model_error", problem: "overloaded" },
	retry: { attempt: 2, at: 1_700_000_000_000, problem: "rate_limited" },
};

async function gateway(view: ServiceView) {
	const client: ServiceClient = {
		session: "default",
		ownerSession: "default",
		request: async () => ({ type: "cancelled" }),
		watch: async (listener, signal) => {
			listener({ type: "view", view });
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	};
	// Reserve an ephemeral port first so the gateway can enforce its exact configured origin.
	const reservation = createWebGateway({
		client,
		origin: "http://127.0.0.1:1",
		assets: new Map(),
	});
	reservation.server.listen(0, "127.0.0.1");
	await once(reservation.server, "listening");
	const port = (reservation.server.address() as AddressInfo).port;
	await reservation.close();
	const origin = `http://127.0.0.1:${port}`;
	const server = createWebGateway({ client, origin, assets: new Map() });
	servers.push(server);
	server.server.listen(port, "127.0.0.1");
	await once(server.server, "listening");
	return origin;
}

async function firstViewFrame(origin: string): Promise<string> {
	const abort = new AbortController();
	const response = await fetch(`${origin}/api/v1/events`, {
		headers: { Origin: origin },
		signal: abort.signal,
	});
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let stream = "";
	try {
		while (!stream.includes("\n\n")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			stream += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		abort.abort();
	}
	const frame = stream.split("\n\n")[0];
	expect(frame.startsWith("event: view\n")).toBe(true);
	return frame.slice(frame.indexOf("data: ") + 6);
}

describe("browser frame projection", () => {
	it("forwards only workspace fields: no failure, retry, tool reason or owner PID", async () => {
		const origin = await gateway(ownerFrame);
		const data = JSON.parse(await firstViewFrame(origin)) as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(
			[
				"busy",
				"entries",
				"historyTruncated",
				"installationId",
				"model",
				"name",
				"text",
				"textTruncated",
				"tools",
				"usage",
				"version",
			].sort(),
		);
		expect(data.tools).toEqual([{ callId: "toolu_1", name: "bash", status: "failed" }]);
	});

	it("never exposes the tool-evidence operation to the browser", () => {
		expect(() =>
			parseWebRequest({ requestId: "e", operation: { type: "tool-evidence", callId: "toolu_1" } }),
		).toThrow();
		expect(() => parseWebRequest({ requestId: "e", operation: { type: "tool-evidence" } })).toThrow(
			"Operation is unavailable on the browser surface.",
		);
	});
});

describe("browser operation response projection", () => {
	it("B5 projects only bounded chat history rows and a progressing continuation", () => {
		const operation = { type: "chat-history", before: 12 } as const;
		const entry = { id: 10, role: "assistant", text: "Earlier reply", truncated: false, source: "host" };
		expect(
			projectWebResponse(operation, {
				type: "chat-history",
				page: { entries: [entry], nextBefore: 9 },
				unprojected: "Private owner diagnostic",
			}),
		).toEqual({ type: "chat-history", page: { entries: [entry], nextBefore: 9 } });
		expect(projectWebResponse(operation, { type: "chat-history", page: { entries: [], nextBefore: 9 } })).toEqual({
			type: "chat-history",
			page: { entries: [], nextBefore: 9 },
		});
		expect(() =>
			projectWebResponse(operation, {
				type: "chat-history",
				page: { entries: [{ ...entry, detail: "Private owner diagnostic" }], nextBefore: null },
			}),
		).toThrow();
		expect(() =>
			projectWebResponse(operation, { type: "chat-history", page: { entries: [], nextBefore: 12 } }),
		).toThrow();
	});

	it.each([
		{
			authority: "invalid",
			authorityError: "Unable to read /private/owner/mission.json",
			expected: "invalid-authority",
		},
		{ authority: "developer-local", authorityError: null, expected: null },
	])("projects a stable authority error for $authority", ({ authority, authorityError, expected }) => {
		const response = projectWebResponse(
			{ type: "mission", request: { operation: "status" } },
			{
				type: "mission",
				result: {
					stage: "awaiting_creator",
					formation: { agreement: null, draft: null },
					creator: null,
					authority,
					authorityError,
					agreementValid: false,
					missing: [],
					execution: "not-implemented",
					tools: [],
				},
			},
		);
		expect(response).toMatchObject({ type: "mission", result: { authority, authorityError: expected } });
		expect(JSON.stringify(response)).not.toContain("/private/owner/mission.json");
	});

	it("shows a protected terminal review without arming agreement and ignores the owner's digest", () => {
		const operation = { type: "mission", request: { operation: "status" } } as const;
		const terms = { objective: "Ship", scope: "Unit", policy: { allowedTools: ["read"], maxCycles: 3 } };
		const draft = { missionId: "mission-one", revision: 2, status: "proposed", digest: "a".repeat(64), terms };
		const view = {
			stage: "awaiting_approval",
			formation: { agreement: null, draft },
			creator: null,
			authority: "managed-administrator",
			agreementValid: true,
			missing: [],
			execution: "not-implemented",
			tools: [],
		};
		const proposal = {
			missionId: draft.missionId,
			revision: draft.revision,
			digest: "b".repeat(64),
			authorityRevision: 1,
			previousReceipt: null,
		};
		expect(
			projectWebResponse(operation, { type: "mission", result: view }, { review: { armed: false, proposal } }),
		).toMatchObject({
			result: {
				canAgree: false,
				previousReceipt: null,
				review: proposal,
				agreementValid: false,
				formation: { draft: { ...draft, digest: proposal.digest } },
			},
		});
		expect(
			projectWebResponse(operation, { type: "mission", result: { ...view, authority: "developer-local" } }, {}),
		).toMatchObject({
			result: {
				canAgree: false,
				authority: "invalid",
				agreementValid: false,
				formation: { draft: { digest: null } },
			},
		});
	});
});
