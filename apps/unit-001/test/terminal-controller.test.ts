// #21: Rich terminal controls use the service owner, never another storage writer.
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import type { ServiceView } from "../src/service.ts";
import type { ServiceClient } from "../src/service-client.ts";
import {
	createForegroundTerminalController,
	createServiceTerminalController,
	createTerminalController,
	type TerminalState,
} from "../src/terminal-controller.ts";
import { startFakeOwner } from "./fixtures/fake-owner.ts";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "u1-control-"));
});
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	await rm(directory, { recursive: true, force: true });
});
const base: ServiceView = {
	pid: 12,
	version: "1",
	name: "bob",
	installationId: null,
	model: null,
	usage: null,
	entries: [],
	busy: false,
	text: "",
	textTruncated: false,
	tools: [],
	historyTruncated: false,
};

async function server(initial: ServiceView | null = base) {
	const owner = await startFakeOwner(join(directory, "default.sock"), {
		initial,
		missionError: "Mission formation unavailable",
	});
	cleanup.push(owner.close);
	return owner;
}

async function connect(owner: Awaited<ReturnType<typeof server>>) {
	const states: TerminalState[] = [];
	const signal = new AbortController();
	const controller = createTerminalController(owner.endpoint, (state) => states.push(state), signal.signal);
	cleanup.push(async () => {
		controller.detach();
		await controller.closed;
	});
	await expect.poll(() => controller.state.connection).toBe("attached");
	return { controller, states, signal };
}

describe.skipIf(process.platform === "win32")("owner terminal controller", () => {
	it("keeps aliases and spelling suggestions local and never sends guessed writes (#59)", async () => {
		const owner = await server();
		const { controller } = await connect(owner);
		expect(controller.submit("/memroy")).toEqual({ status: "rejected" });
		expect(controller.state.suggestions?.[0].id).toBe("memory");
		expect(owner.requests).toEqual([{ type: "watch" }]);
		controller.dismissSuggestions();
		expect(controller.state.suggestions).toBeUndefined();
		owner.respond((request, socket) => {
			if (request.type === "memory") socket.end('{"type":"error","message":"Fixture memory stats"}\n');
		});
		expect(controller.submit("/brain")).toEqual({ status: "command" });
		await expect.poll(() => owner.requests.filter((request) => request.type === "memory").length).toBe(1);
		expect(owner.requests.some((request) => request.type === "send" || request.type === "resolve-command")).toBe(
			false,
		);
	});

	it("asks only for unresolved commands and ignores a cancelled suggestion response (#59)", async () => {
		const owner = await server();
		let pending: Socket | undefined;
		owner.respond((request, socket) => {
			if (request.type === "resolve-command") pending = socket;
		});
		const { controller } = await connect(owner);
		controller.submit("/xyzzy");
		await expect.poll(() => pending !== undefined).toBe(true);
		expect(controller.state.suggesting).toBe(true);
		controller.dismissSuggestions();
		pending?.end(
			'{"type":"command-suggestions","result":{"stage":"model","commandIds":["memory.forget"],"explanation":"Try this","usage":null}}\n',
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(controller.state.suggestions).toBeUndefined();
		expect(controller.state.sending).toBe(false);
		expect(owner.requests.some((request) => request.type === "send")).toBe(false);
	});
	it("offers guided mission setup without admitting a model prompt", async () => {
		// #14: setup shares the terminal editor; status probes stay read-only and tolerate an older owner.
		const owner = await server();
		const { controller } = await connect(owner);
		await expect.poll(() => owner.missionRequests.length).toBe(1);
		expect(controller.submit("/mission setup")).toEqual({ status: "mission-setup" });
		expect(owner.requests).toEqual([{ type: "watch" }]);
	});
	it("publishes connecting state and refuses sends until initial committed state arrives", async () => {
		const owner = await server(null);
		const states: TerminalState[] = [];
		const signal = new AbortController();
		const controller = createTerminalController(owner.endpoint, (state) => states.push(state), signal.signal);
		cleanup.push(async () => {
			controller.detach();
			await controller.closed;
		});
		expect(states[0].connection).toBe("connecting");
		expect(controller.submit("not yet")).toEqual({ status: "rejected" });
		await expect.poll(() => owner.requests.length).toBe(1);
		owner.view(base);
		await expect.poll(() => controller.state.connection).toBe("attached");
		expect(controller.state.view).toEqual(base);
		expect(owner.requests).toEqual([{ type: "watch" }]);
	});

	it("submits with a stable request ID, bounds pending sends, and does not duplicate replies into views", async () => {
		const owner = await server();
		let pending: Socket | undefined;
		owner.respond((_request, socket) => {
			pending = socket;
		});
		const { controller } = await connect(owner);
		const result = controller.submit("multiline\nrequest");
		expect(result).toMatchObject({ status: "submitted", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
		expect(controller.submit("second")).toEqual({ status: "rejected" });
		await expect.poll(() => owner.requests.length).toBe(2);
		expect(owner.requests[1]).toMatchObject({
			type: "send",
			prompt: "multiline\nrequest",
			...(result.status === "submitted" ? { requestId: result.requestId } : {}),
		});
		pending?.end('{"type":"reply","reply":{"status":"answered","text":"reply is not the stream"}}\n');
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(controller.state.view).toEqual(base);
		expect(controller.state.notices.map((notice) => notice.text).join(" ")).not.toContain("reply is not the stream");
		const next = controller.submit("third");
		expect(next).toMatchObject({ status: "submitted" });
		expect(next).not.toEqual(result);
	});

	it("passes live partials, model/usage metadata, and tool progress through the bounded service view", async () => {
		const owner = await server();
		const { controller } = await connect(owner);
		const view: ServiceView = {
			...base,
			busy: true,
			text: "partial",
			model: { provider: "faux", modelId: "faux-1" },
			usage: {
				scope: "conversation-models",
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { kind: "unknown" },
			},
			tools: [{ callId: "c", name: "read", status: "running" }],
		};
		owner.view(view);
		await expect.poll(() => controller.state.view?.text).toBe("partial");
		expect(controller.state.view).toEqual(view);
	});

	it("keeps busy state authoritative until the watch confirms cancellation", async () => {
		const owner = await server({ ...base, busy: true });
		let cancelSocket: Socket | undefined;
		owner.respond((request, socket) => {
			if (request.type === "cancel") cancelSocket = socket;
		});
		const { controller } = await connect(owner);
		controller.cancel();
		controller.cancel();
		await expect.poll(() => owner.requests.length).toBe(2);
		expect(controller.state.cancelling).toBe(true);
		cancelSocket?.end('{"type":"cancelled"}\n');
		await expect.poll(() => controller.state.cancelling).toBe(false);
		expect(controller.state.view?.busy).toBe(true);
		owner.view(base);
		await expect.poll(() => controller.state.view?.busy).toBe(false);
	});

	it("defers one cancellation until a just-submitted run becomes visible", async () => {
		const owner = await server();
		owner.respond((request, socket) => {
			if (request.type === "cancel") socket.end('{"type":"cancelled"}\n');
		});
		const { controller } = await connect(owner);
		controller.submit("start");
		controller.cancel();
		await expect.poll(() => owner.requests.filter((request) => request.type === "send").length).toBe(1);
		expect(owner.requests.filter((request) => request.type === "cancel")).toHaveLength(0);
		expect(controller.state.notices.map((notice) => notice.text).join(" ")).toContain("queued until");
		owner.view({ ...base, busy: true });
		await expect.poll(() => owner.requests.filter((request) => request.type === "cancel").length).toBe(1);
		expect(controller.state.connection).toBe("attached");
	});

	it.each(["detach", "exit", "signal"] as const)(
		"%s closes only client connections while work remains busy",
		async (action) => {
			const owner = await server({ ...base, busy: true });
			const { controller, signal } = await connect(owner);
			if (action === "detach") controller.detach();
			else if (action === "exit") controller.submit("/exit");
			else signal.abort();
			expect(await controller.closed).toBe(0);
			expect(controller.state.connection).toBe("detached");
			expect(owner.requests).toEqual([{ type: "watch" }]);
		},
	);

	it("handles help/status/unknown commands locally and bounds notices", async () => {
		// #25: local help must explain that cancellation affects other operators while detaching preserves work.
		const owner = await server();
		const { controller } = await connect(owner);
		controller.submit("/help");
		expect(controller.state.notices.at(-1)?.text).toContain(
			"shared session, including other operators' queued inputs",
		);
		expect(controller.state.notices.at(-1)?.text).toContain("Detaching leaves admitted work running");
		expect(controller.submit("/unknown")).toEqual({ status: "rejected" });
		for (let count = 0; count < 20; count++) expect(controller.submit("/help")).toEqual({ status: "command" });
		controller.submit("/status");
		expect(controller.state.notices).toHaveLength(8);
		expect(controller.state.notices.at(-1)?.text).toContain("bob: ready; session default");
		expect(owner.requests).toEqual([{ type: "watch" }]);
		controller.submit("/detach");
		expect(await controller.closed).toBe(0);
	});

	it.each(["x".repeat(16_385), "\x00".repeat(12_000)])(
		"rejects oversized logical or encoded prompts without losing editor input",
		async (prompt) => {
			const owner = await server();
			const { controller } = await connect(owner);
			expect(controller.submit(prompt)).toEqual({ status: "rejected" });
			expect(controller.state.sending).toBe(false);
			expect(controller.state.notices.at(-1)?.text).toContain("not submitted");
			expect(owner.requests).toEqual([{ type: "watch" }]);
		},
	);

	it("reports failed sends and permits another input while preserving the retry ID", async () => {
		const owner = await server();
		owner.respond((_request, socket) => socket.destroy());
		const { controller } = await connect(owner);
		const result = controller.submit("try");
		if (result.status !== "submitted") throw new Error("Prompt was rejected");
		// #26: a lost delivery stays unknown and is never resent by the client.
		expect(await result.outcome).toEqual({ kind: "unknown" });
		expect(controller.state.connection).toBe("attached");
		expect(controller.state.unresolvedRequestIds).toEqual([result.requestId]);
		expect(owner.requests.filter((request) => request.type === "send")).toHaveLength(1);
		expect(controller.state.notices.map((notice) => notice.text).join(" ")).toContain(
			`retry request ${result.requestId}`,
		);
		expect(controller.submit("next").status).toBe("submitted");
	});

	// #26 review, blocker 1: the caller makes the ID durable before the request leaves this client.
	it("dispatches a send only after its beforeDispatch work has finished", async () => {
		const owner = await server();
		owner.respond(() => {});
		const { controller } = await connect(owner);
		const saved = Promise.withResolvers<"dispatch">();
		const seen: unknown[] = [];
		const result = controller.submit("durable first", {
			beforeDispatch: (send) => {
				seen.push(send);
				return saved.promise;
			},
		});
		if (result.status !== "submitted") throw new Error("expected a submitted send");
		expect(seen).toEqual([{ requestId: result.requestId, digest: result.digest }]);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(owner.requests).toEqual([{ type: "watch" }]);
		saved.resolve("dispatch");
		await expect.poll(() => owner.requests.length).toBe(2);
		expect(owner.requests[1]).toEqual({ type: "send", prompt: "durable first", requestId: result.requestId });
	});

	// #26 v2 review, blocker 1: a send whose ID could not be made durable never leaves the client.
	it("never dispatches a send its beforeDispatch work held, and does not keep its ID unresolved", async () => {
		const owner = await server();
		const { controller } = await connect(owner);
		const result = controller.submit("not durable", { beforeDispatch: async () => "hold" });
		if (result.status !== "submitted") throw new Error("expected a submitted send");
		expect(await result.outcome).toEqual({ kind: "held" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(owner.requests).toEqual([{ type: "watch" }]);
		expect(controller.state.unresolvedRequestIds).toEqual([]);
		expect(controller.state.notices.at(-1)?.text).toBe(`Request ${result.requestId} was not sent.`);
	});

	// #26 v3 review: a held retry of a send whose reply was lost dropped that send's still unresolved ID.
	it("keeps an unresolved ID unresolved when a retry under it is held", async () => {
		const owner = await server();
		owner.respond((_request, socket) => socket.destroy());
		const { controller } = await connect(owner);
		const first = controller.submit("lost reply");
		if (first.status !== "submitted") throw new Error("expected a submitted send");
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(controller.state.unresolvedRequestIds).toEqual([first.requestId]);
		const retry = controller.submit("lost reply", {
			replayRequestId: first.requestId,
			beforeDispatch: async () => "hold",
		});
		expect(retry).toMatchObject({ status: "submitted", requestId: first.requestId });
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(owner.requests.filter((request) => request.type === "send")).toHaveLength(1);
		expect(controller.state.unresolvedRequestIds).toEqual([first.requestId]);
		expect(controller.state.notices.at(-1)?.text).toBe(`Request ${first.requestId} was not sent.`);
	});

	// #26 review, blocker 2: a wire error alone never settles a send; the owner's record does.
	describe("settling a send the owner answered with an error", () => {
		const errorWithLookup = (owner: Awaited<ReturnType<typeof server>>, admission: object) =>
			owner.respond((request, socket) =>
				socket.end(
					`${JSON.stringify(request.type === "admission" ? { type: "admission", admission } : { type: "error", message: "Service response exceeds 1 MiB." })}\n`,
				),
			);

		it("acknowledges an admitted send as admitted, not refused, after a post-commit error", async () => {
			const owner = await server();
			errorWithLookup(owner, { status: "admitted", source: "model", binding: "exact", outcome: "answered" });
			const { controller } = await connect(owner);
			const result = controller.submit("big reply");
			if (result.status !== "submitted") throw new Error("expected a submitted send");
			expect(await result.outcome).toEqual({ kind: "settled" });
			expect(owner.requests[2]).toEqual({ type: "admission", requestId: result.requestId, digest: result.digest });
			expect(controller.state.unresolvedRequestIds).toEqual([]);
			expect(controller.state.notices.at(-1)?.text).toContain("admitted request");
		});

		it.each([
			[{ status: "not-found" }, "not-found"],
			[{ status: "rejected", reason: "different-prompt" }, "rejected"],
		])("returns the text of a send the owner answered %o, as %s", async (admission, reason) => {
			const owner = await server();
			errorWithLookup(owner, admission);
			const { controller } = await connect(owner);
			const result = controller.submit("refused");
			if (result.status !== "submitted") throw new Error("expected a submitted send");
			expect(await result.outcome).toEqual({ kind: "returned", reason });
			expect(controller.state.unresolvedRequestIds).toEqual([]);
			expect(controller.state.notices.at(-1)?.text).toContain("Not sent");
		});

		// #26 v2 review, blocker 3: an admitted ID does not show the admitted prompt was this text.
		it("returns the text of a send admitted with an unverified binding, settling its ID", async () => {
			const owner = await server();
			errorWithLookup(owner, { status: "admitted", source: "model", binding: "unverified", outcome: "answered" });
			const { controller } = await connect(owner);
			const result = controller.submit("evicted replay");
			if (result.status !== "submitted") throw new Error("expected a submitted send");
			expect(await result.outcome).toEqual({ kind: "returned", reason: "unverified" });
			expect(controller.state.unresolvedRequestIds).toEqual([]);
			expect(controller.state.notices.at(-1)?.text).toContain("cannot confirm it was this text");
		});

		// #26: an explicit retry of a send the owner has no record of reuses its ID, and only the retry's answer counts.
		it("reuses the request ID on an explicit retry after a refusal and settles it on the answer", async () => {
			const owner = await server();
			errorWithLookup(owner, { status: "not-found" });
			const { controller } = await connect(owner);
			const first = controller.submit("retried");
			if (first.status !== "submitted") throw new Error("expected a submitted send");
			expect(await first.outcome).toEqual({ kind: "returned", reason: "not-found" });
			owner.respond((_request, socket) =>
				socket.end(`${JSON.stringify({ type: "reply", reply: { status: "answered", text: "ok" } })}\n`),
			);
			const retry = controller.submit("retried", { replayRequestId: first.requestId });
			if (retry.status !== "submitted") throw new Error("expected a submitted retry");
			expect(retry.requestId).toBe(first.requestId);
			expect(await retry.outcome).toEqual({ kind: "settled" });
			expect(owner.requests.at(-1)).toEqual({ type: "send", prompt: "retried", requestId: first.requestId });
			expect(controller.state.unresolvedRequestIds).toEqual([]);
		});

		it("keeps the request ID unresolved when the lookup itself fails", async () => {
			const owner = await server();
			owner.respond((_request, socket) => socket.end('{"type":"error","message":"Owner busy."}\n'));
			const { controller } = await connect(owner);
			const result = controller.submit("unknown");
			if (result.status !== "submitted") throw new Error("expected a submitted send");
			expect(await result.outcome).toEqual({ kind: "unknown" });
			expect(controller.state.unresolvedRequestIds).toEqual([result.requestId]);
		});
	});

	it("reports bounded remote failures without mutating the authoritative transcript", async () => {
		const owner = await server();
		owner.respond((_request, socket) =>
			socket.end(`${JSON.stringify({ type: "error", message: "z".repeat(2000) })}\n`),
		);
		const { controller } = await connect(owner);
		controller.submit("prompt");
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(controller.state.notices.at(-1)?.text.length).toBeLessThanOrEqual(1024);
		expect(controller.state.notices.at(-1)?.text).toContain("notice truncated");
		expect(controller.state.notices.at(-1)?.kind).toBe("error");
		expect(controller.state.view).toEqual(base);
	});

	it("preserves explicit error severity for server rejection and cancellation", async () => {
		// #36: rendering must not infer severity from a provider's arbitrary text.
		const owner = await server({ ...base, busy: true });
		owner.respond((_request, socket) => socket.end('{"type":"error","message":"Provider unavailable"}\n'));
		const { controller } = await connect(owner);
		controller.submit("try");
		await expect.poll(() => controller.state.sending).toBe(false);
		expect(controller.state.notices.at(-1)).toMatchObject({
			kind: "error",
			text: expect.stringContaining("Provider unavailable"),
		});
		controller.cancel();
		await expect.poll(() => controller.state.cancelling).toBe(false);
		expect(controller.state.notices.at(-1)).toMatchObject({
			kind: "error",
			text: expect.stringContaining("Provider unavailable"),
		});
	});

	it.each(["malformed", "disconnect"] as const)("%s watch terminates with a recovery diagnostic", async (kind) => {
		const owner = await server();
		const { controller } = await connect(owner);
		if (kind === "malformed") owner.wire('{"type":"view","view":{}}\n');
		else owner.disconnect();
		expect(await controller.closed).toBe(1);
		expect(controller.state.connection).toBe("failed");
		expect(controller.state.notices.map((notice) => notice.text).join(" ")).toContain(
			"Reattach to inspect persisted work",
		);
		expect(owner.requests).toEqual([{ type: "watch" }]);
	});

	it("does not connect when the caller signal is already closed", async () => {
		const owner = await server();
		const signal = new AbortController();
		signal.abort();
		const controller = createTerminalController(owner.endpoint, () => {}, signal.signal);
		expect(await controller.closed).toBe(0);
		expect(owner.requests).toEqual([]);
	});

	it("closes a peer that never supplies an initial view", async () => {
		const owner = await server(null);
		const signal = new AbortController();
		const controller = createTerminalController(owner.endpoint, () => {}, signal.signal);
		cleanup.push(async () => {
			controller.detach();
			await controller.closed;
		});
		expect(await controller.closed).toBe(1);
		expect(controller.state.notices.map((notice) => notice.text).join(" ")).toContain("within 5 seconds");
	}, 8000);

	// omp-4: a watch client owns its first-view deadline and recovery, so the controller adds no earlier timer.
	it("is not failed by a controller timer while the client's own watch is still recovering", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const client: ServiceClient = {
				session: "recovering",
				ownerSession: "recovering",
				request: () => Promise.reject(new Error("unused")),
				async watch(listener, signal) {
					await new Promise((resolve) => setTimeout(resolve, 7_000));
					listener({ type: "view", view: base });
					await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
				},
			};
			const signal = new AbortController();
			const controller = createServiceTerminalController(client, () => {}, signal.signal);
			await vi.advanceTimersByTimeAsync(6_500);
			expect(controller.state.connection).toBe("connecting");
			await vi.advanceTimersByTimeAsync(1_000);
			expect(controller.state.connection).toBe("attached");
			signal.abort();
			expect(await controller.closed).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("foreground terminal controller", () => {
	// omp-4: the foreground adapter bounds its own first view; the shared controller has no timer.
	describe("first view bound", () => {
		function silentAgent(open: () => Promise<unknown>): Agent {
			return { name: "bob", watchConversation: open } as unknown as Agent;
		}

		it("fails a foreground watch that never supplies a first view within its bound", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const controller = createForegroundTerminalController(
					silentAgent(() => new Promise(() => {})),
					"work",
					"0.0.4",
					() => {},
					new AbortController().signal,
				);
				await vi.advanceTimersByTimeAsync(4_999);
				expect(controller.state.connection).toBe("connecting");
				await vi.advanceTimersByTimeAsync(1);
				expect(await controller.closed).toBe(1);
				expect(controller.state.connection).toBe("failed");
				expect(controller.state.notices.map((notice) => notice.text).join(" ")).toContain("within 5 seconds");
			} finally {
				vi.useRealTimers();
			}
		});

		it("stops a foreground watch that opens after its bound", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const late = Promise.withResolvers<{ value: unknown; stop: () => Promise<void> }>();
				const stop = vi.fn(async () => {});
				const controller = createForegroundTerminalController(
					silentAgent(() => late.promise),
					"work",
					"0.0.4",
					() => {},
					new AbortController().signal,
				);
				await vi.advanceTimersByTimeAsync(5_000);
				expect(await controller.closed).toBe(1);
				late.resolve({ value: undefined, stop });
				await vi.advanceTimersByTimeAsync(0);
				expect(stop).toHaveBeenCalledOnce();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	async function foreground(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = await Agent.open(
			{
				storage: await openNodeSqliteStorage(join(directory, "foreground.sqlite")),
				models,
				model: { provider: "faux", modelId: "faux-1" },
				cwd: directory,
			},
			BACKGROUND_CONTEXT,
		);
		cleanup.push(() => agent.close(BACKGROUND_CONTEXT));
		const signal = new AbortController();
		const controller = createForegroundTerminalController(agent, "work", "0.0.4", () => {}, signal.signal);
		cleanup.push(async () => {
			controller.detach();
			await controller.closed;
		});
		await expect.poll(() => controller.state.connection).toBe("attached");
		return { agent, controller, signal };
	}

	it("projects the existing owner's model and transcript through the same rich controls", async () => {
		// #36: source chat uses its already-open Agent, without a socket or second storage owner.
		const { controller } = await foreground([fauxAssistantMessage([fauxText("A local answer")])]);
		expect(controller.state.view).toMatchObject({
			model: { provider: "faux", modelId: "faux-1" },
			installationId: null,
		});
		expect(controller.submit("A question").status).toBe("submitted");
		await expect.poll(() => controller.state.sending).toBe(false);
		await expect.poll(() => controller.state.view?.entries.at(-1)?.text).toBe("A local answer");
		controller.submit("/help");
		expect(controller.state.notices.at(-1)?.text).toContain("closes this foreground session");
	});

	// #26 review: a foreground refusal settles through the owner's record, like a wire error.
	it("settles a foreground send the owner refused before admission as a reusable refusal", async () => {
		const { agent, controller } = await foreground([]);
		await agent.enterMaintenance("op-1", 0, BACKGROUND_CONTEXT);
		const result = controller.submit("While held");
		if (result.status !== "submitted") throw new Error("expected a submitted send");
		expect(await result.outcome).toEqual({ kind: "returned", reason: "not-found" });
		expect(controller.state.notices.at(-1)?.text).toContain("held for maintenance");
	});

	it("closing the view does not cancel or close its caller-owned Agent", async () => {
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { agent, controller } = await foreground([
			async () => {
				await held;
				return fauxAssistantMessage([fauxText("Completed after the view closed")]);
			},
		]);
		controller.submit("Continue independently");
		await expect.poll(() => controller.state.view?.busy).toBe(true);
		controller.detach();
		expect(await controller.closed).toBe(0);
		expect((await agent.status(BACKGROUND_CONTEXT)).busy).toBe(true);
		release?.();
		expect(await agent.idle(BACKGROUND_CONTEXT)).toBe("Completed after the view closed");
	});
});
