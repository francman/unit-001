import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	createRegistry,
	defineEntry,
	Harness,
	ResetEntry,
	ROOT_CONVERSATION_ID,
	ToolResultEntry,
	UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { parseArguments } from "../src/args.ts";
import { HostFactEntry } from "../src/commands/facts.ts";
import { acquireSessionLock } from "../src/lock.ts";
import { sendDigest } from "../src/send-receipt.ts";
import {
	parseServiceResponse,
	requestService,
	runService,
	type ServiceView,
	serviceEndpoint,
	watchService,
} from "../src/service.ts";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
const children: ChildProcess[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "u1-svc-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		children.splice(0).map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
					child.kill("SIGKILL");
				}),
		),
	);
	for (const close of cleanup.splice(0).reverse()) await close();
	await rm(directory, { recursive: true, force: true });
});

async function launch(
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
	identity?: { id: string; name: string },
	operatorDirectory?: string,
) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const release = await acquireSessionLock(join(directory, "session.sqlite.lock"));
	const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
	const agent = await Agent.open(
		{
			storage,
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
			...(identity === undefined ? {} : { name: identity.name }),
		},
		BACKGROUND_CONTEXT,
	);
	const controller = new AbortController();
	const path = serviceEndpoint(directory, "default", process.platform);
	const operatorPath = operatorDirectory === undefined ? undefined : join(operatorDirectory, "default.sock");
	if (operatorDirectory !== undefined) {
		await mkdir(operatorDirectory, { mode: 0o750 });
		await chmod(operatorDirectory, 0o750);
	}
	let ready!: () => void;
	const listening = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const running = runService(
		agent,
		path,
		"fixture-version",
		ready,
		controller.signal,
		identity?.id ?? null,
		operatorPath,
	);
	void running.catch(() => {});
	const close = async () => {
		controller.abort();
		try {
			await running;
		} finally {
			try {
				await agent.close(BACKGROUND_CONTEXT);
			} finally {
				await release();
			}
		}
	};
	cleanup.push(close);
	await Promise.race([listening, running]);
	return { agent, faux, storage, path, operatorPath, controller, running, close };
}

const signal = () => new AbortController().signal;
const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

describe.skipIf(process.platform === "win32")("headless local service", () => {
	it("cancels disposable command inference when its client disconnects (#59)", async () => {
		const service = await launch([]);
		let started = () => {};
		let cancelled = false;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		vi.spyOn(service.agent, "resolveCommand").mockImplementation(async (_input, _surface, _context, signal) => {
			started();
			await new Promise<void>((resolve) =>
				signal.addEventListener(
					"abort",
					() => {
						cancelled = true;
						resolve();
					},
					{ once: true },
				),
			);
			return { stage: "unavailable", commandIds: [], explanation: "Cancelled", usage: null };
		});
		const controller = new AbortController();
		const request = requestService(
			service.path,
			{ type: "resolve-command", input: "xyzzy", surface: "cli" },
			controller.signal,
		);
		const rejection = expect(request).rejects.toThrow();
		await entered;
		controller.abort();
		await rejection;
		await expect.poll(() => cancelled, { timeout: 1000 }).toBe(true);
		expect(service.faux.state.callCount).toBe(0);
	});
	it.each([
		{ configuration: undefined, provider: "faux", modelId: "faux-1", valid: true },
		{ configuration: "configured", provider: "faux", modelId: "faux-1", valid: true },
		{ configuration: "unconfigured", provider: null, modelId: null, valid: true },
		{ configuration: undefined, provider: null, modelId: null, valid: false },
		{ configuration: undefined, provider: "faux", modelId: 4, valid: false },
		{ configuration: "configured", provider: null, modelId: null, valid: false },
		{ configuration: "unconfigured", provider: "faux", modelId: "faux-1", valid: false },
		{ configuration: null, provider: "faux", modelId: "faux-1", valid: false },
	])("#14 validates current and published 0.0.7 status configuration: $configuration/$valid", async (input) => {
		const path = join(directory, "status.sock");
		const runtime = {
			application: "unit-001",
			name: "agent",
			...(input.configuration === undefined ? {} : { configuration: input.configuration }),
			provider: input.provider,
			modelId: input.modelId,
			pid: 1,
			startedAt: 1,
			uptimeMs: 0,
			observedAt: 1,
		};
		const server = createServer((socket) =>
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						type: "status",
						pid: 1,
						version: "0.0.7",
						name: "agent",
						installationId: null,
						busy: false,
						inhibited: false,
						maintenance: { protocol: 1, state: "open", operationId: null },
						runtime,
					})}\n`,
				),
			),
		);
		await new Promise<void>((resolve) => server.listen(path, resolve));
		try {
			const response = requestService(path, { type: "status" }, signal());
			if (!input.valid) await expect(response).rejects.toThrow("Invalid service response");
			else
				await expect(response).resolves.toMatchObject({
					type: "status",
					runtime: {
						configuration: input.configuration ?? "configured",
						provider: input.provider,
						modelId: input.modelId,
					},
				});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	it("#33 keeps the private owner healthy when an old systemd unit lacks the operator directory", async () => {
		const service = await launch([reply("still available")]);
		const controller = new AbortController();
		const privatePath = join(directory, "legacy-private", "default.sock");
		const operatorPath = join(directory, "missing-runtime", "default.sock");
		const logs: string[] = [];
		const running = runService(
			service.agent,
			privatePath,
			"fixture-version",
			(text) => logs.push(text),
			controller.signal,
			null,
			operatorPath,
		);
		void running.catch(() => {});
		try {
			await expect.poll(() => logs.some((text) => text.includes("service ready:"))).toBe(true);
			expect(logs[0]).toContain("Operator access is not configured");
			expect(await requestService(privatePath, { type: "send", prompt: "still available" }, signal())).toMatchObject(
				{ type: "reply", reply: { text: "still available" } },
			);
			await expect(stat(operatorPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			controller.abort();
			await running;
		}
	});
	it.each(["mode", "symlink"])(
		"#33 rejects an invalid operator runtime directory (%s) without unlinking existing contents",
		async (kind) => {
			const service = await launch([]);
			const actual = join(directory, "actual-runtime");
			const runtime = join(directory, "invalid-runtime");
			await mkdir(actual, { mode: kind === "mode" ? 0o700 : 0o750 });
			await chmod(actual, kind === "mode" ? 0o700 : 0o750);
			if (kind === "symlink") await symlink(actual, runtime);
			const operatorPath = join(kind === "mode" ? actual : runtime, "default.sock");
			await writeFile(join(actual, "default.sock"), "preserve this preexisting file");
			const privatePath = join(directory, "rejected-private", "default.sock");
			await expect(
				runService(
					service.agent,
					privatePath,
					"fixture-version",
					() => {
						throw new Error("An invalid endpoint cannot be ready");
					},
					signal(),
					null,
					operatorPath,
				),
			).rejects.toThrow("mode 0750");
			expect(await readFile(join(actual, "default.sock"), "utf8")).toBe("preserve this preexisting file");
			await expect(stat(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
	it("#33 allows routine operator memory commands while keeping maintenance private", async () => {
		const service = await launch([], undefined, join(directory, "operator"));
		const operatorPath = service.operatorPath!;
		expect((await stat(operatorPath)).mode & 0o777).toBe(0o660);
		expect((await stat(service.path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, "control"))).mode & 0o777).toBe(0o700);
		expect(await requestService(operatorPath, { type: "status" }, signal())).toMatchObject({
			name: "agent",
			busy: false,
		});
		await requestService(
			operatorPath,
			{ type: "memory", request: { operation: "remember", content: "violet approval", requestId: "admin" } },
			signal(),
		);
		expect(
			await requestService(
				operatorPath,
				{ type: "memory", request: { operation: "recall", query: "violet" } },
				signal(),
			),
		).toMatchObject({ result: { records: [{ content: "violet approval" }] } });
		const linked = parseArguments([
			"memory",
			"remember",
			"The revised approval",
			"--relation",
			"updates:memory:operator:admin",
			"--request-id",
			"operator-linked",
		]);
		if (linked.kind !== "memory" || linked.request.operation !== "remember")
			throw new Error("Expected operator remember command");
		const remembered = await requestService(operatorPath, { type: "memory", request: linked.request }, signal());
		expect(remembered).toMatchObject({ type: "memory", result: { operation: "remember" } });
		expect(await requestService(operatorPath, { type: "memory", request: linked.request }, signal())).toEqual(
			remembered,
		);
		expect(
			await requestService(operatorPath, { type: "memory", request: { operation: "graph" } }, signal()),
		).toMatchObject({
			result: {
				edges: [
					{
						from: "memory:operator:operator-linked",
						to: "memory:operator:admin",
						kind: "updates",
						derivation: "explicit",
					},
				],
			},
		});
		for (const request of [
			{ type: "maintenance-enter", operationId: "operator-denied", timeoutMs: 0 },
			{ type: "maintenance-release", operationId: "operator-denied" },
		] as const)
			expect(await requestService(operatorPath, request, signal())).toMatchObject({
				type: "error",
				message: "This operation requires the administrator endpoint.",
			});
		expect(
			await requestService(operatorPath, { type: "memory", request: { operation: "stats" } }, signal()),
		).toMatchObject({ result: { working: 2, relations: 1 } });
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({
			maintenance: { state: "open" },
		});
		expect(
			await requestService(operatorPath, { type: "memory", request: { operation: "sleep" } }, signal()),
		).toMatchObject({ type: "memory", result: { operation: "sleep" } });
		expect(
			await requestService(
				operatorPath,
				{
					type: "memory",
					request: { operation: "forget", id: "memory:operator:admin", requestId: "operator", confirmed: true },
				},
				signal(),
			),
		).toMatchObject({ type: "memory", result: { operation: "forget", removed: true } });
		expect(
			await requestService(operatorPath, { type: "memory", request: { operation: "stats" } }, signal()),
		).toMatchObject({
			result: { relations: 0 },
		});
		expect(service.faux.state.callCount).toBe(0);
	});
	it("unit-hn1 refuses operator operations outside the allowlist before dispatch", async () => {
		const service = await launch([], undefined, join(directory, "operator"));
		const operatorPath = service.operatorPath!;
		const view = await service.agent.mission({ operation: "status" }, BACKGROUND_CONTEXT);
		const mission = vi.spyOn(service.agent, "mission").mockResolvedValue(view);
		const channels = vi.spyOn(service.agent, "channels");
		const refused = { type: "error", message: "This operation requires the administrator endpoint." };
		// Allowed: an operator drafts the one-shot mission, as attach /mission setup does.
		const draft = {
			type: "mission",
			request: { operation: "draft", expectedRevision: 0, requestId: "operator-draft", terms: { objective: "x" } },
		} as const;
		expect(await requestService(operatorPath, draft, signal())).toMatchObject({ type: "mission" });
		expect(mission).toHaveBeenCalledTimes(1);
		// Each other multiplexed allowlist key has one positive case; watch is gated like every other operation.
		expect(
			await requestService(operatorPath, { type: "mission", request: { operation: "propose", expectedRevision: 1, requestId: "operator-propose" } }, signal()),
		).toMatchObject({ type: "mission" });
		expect(mission).toHaveBeenCalledTimes(2);
		expect(await requestService(operatorPath, { type: "channels", request: { operation: "status" } }, signal())).not.toEqual(refused);
		channels.mockClear();
		const watched = new AbortController();
		let firstView = false;
		await watchService(
			operatorPath,
			() => {
				firstView = true;
				watched.abort();
			},
			watched.signal,
		);
		expect(firstView).toBe(true);
		// Proposing purpose terms grants nothing (approval needs the root-owned receipt), so operators may send it.
		const purpose = {
			type: "mission",
			request: {
				operation: "purpose-propose",
				expectedRevision: 0,
				requestId: "operator-purpose",
				terms: {
					purpose: "Keep the report current",
					scope: "reports",
					reviewEveryMs: 60_000,
					works: [
						{
							kind: "artifact-digest",
							path: "reports/summary.md",
							sha256: "a".repeat(64),
							instructions: "Refresh the summary",
							maxCycles: 1,
							maxRequests: 1,
							maxRetries: 0,
							maxConsecutiveNoProgress: 1,
						},
					],
					lifetime: { maxWorkItems: 1, maxCycles: 1, maxRequests: 1, deadlineAt: Date.now() + 86_400_000 },
				},
			},
		};
		expect(await requestService(operatorPath, purpose as never, signal())).toMatchObject({ type: "mission" });
		expect(mission).toHaveBeenCalledTimes(3);
		for (const request of [
			{ operation: "configure-local", creator: {}, ceiling: {} },
			{ operation: "purpose-approve-local", revision: 1, digest: "b".repeat(64), requestId: "operator" },
			{ operation: "reconcile-purpose", receiptId: "operator" },
			{ operation: "operate-local", action: "open", expectedOperationRevision: 0, requestId: "operator" },
			{ operation: "reconcile-operation", requestId: "operator" },
		])
			expect(await requestService(operatorPath, { type: "mission", request } as never, signal())).toEqual(refused);
		expect(mission).toHaveBeenCalledTimes(3);
		expect(
			await requestService(
				operatorPath,
				{ type: "channels", request: { operation: "setup", channelId: "telegram" } } as never,
				signal(),
			),
		).toEqual(refused);
		expect(channels).not.toHaveBeenCalled();
		// Unknown operations, top-level or multiplexed, get the same refusal instead of a parser error.
		for (const request of [
			{ type: "shutdown" },
			{ type: "mission", request: { operation: "self-destruct" } },
			{ type: "memory", request: {} },
			{ type: "mission" },
		])
			expect(await requestService(operatorPath, request as never, signal())).toEqual(refused);
		// The administrator endpoint is unchanged: the same purpose request still reaches its handler.
		expect(await requestService(service.path, purpose as never, signal())).toMatchObject({ type: "mission" });
		expect(mission).toHaveBeenCalledTimes(4);
		expect(mission.mock.calls[3]?.[0]).toMatchObject({ operation: "purpose-propose" });
	});
	it("#33 retains coding tools for trusted operator chat", async () => {
		const service = await launch(
			[
				fauxAssistantMessage(
					fauxToolCall("write", { path: "operator-proof.txt", content: "operator coding tools retained" }),
					{ stopReason: "toolUse" },
				),
				reply("operator faux reply"),
			],
			undefined,
			join(directory, "operator"),
		);
		expect(
			await requestService(
				service.operatorPath!,
				{ type: "send", prompt: "Write the operator proof", requestId: "operator-chat" },
				signal(),
			),
		).toMatchObject({ type: "reply", reply: { status: "answered", text: "operator faux reply" } });
		expect(await readFile(join(directory, "operator-proof.txt"), "utf8")).toBe("operator coding tools retained");
		expect(await requestService(service.operatorPath!, { type: "cancel" }, signal())).toEqual({ type: "cancelled" });
	});
	it("#8 inspects and changes memory through the existing owner without another SQLite writer or model call", async () => {
		const service = await launch([]);
		const remembered = await requestService(
			service.path,
			{ type: "memory", request: { operation: "remember", content: "Violet dashboard", requestId: "wire-memory" } },
			signal(),
		);
		if (remembered.type !== "memory" || remembered.result.operation !== "remember")
			throw new Error("Unexpected memory response");
		expect(
			await requestService(service.path, { type: "memory", request: { operation: "stats" } }, signal()),
		).toMatchObject({ type: "memory", result: { working: 1 } });
		expect(
			await requestService(
				service.path,
				{ type: "memory", request: { operation: "recall", query: "violet" } },
				signal(),
			),
		).toMatchObject({ result: { records: [{ id: remembered.result.id, origin: "user" }] } });
		expect(
			await requestService(
				service.path,
				{
					type: "memory",
					request: { operation: "forget", id: remembered.result.id, requestId: "wire-forget", confirmed: true },
				},
				signal(),
			),
		).toEqual({ type: "memory", result: { operation: "forget", removed: true } });
		expect(service.faux.state.callCount).toBe(0);
		await expect(acquireSessionLock(join(directory, "session.sqlite.lock"))).rejects.toThrow("already running");
	});
	it("exposes durable maintenance controls while rejecting new admissions", async () => {
		// #18: Only the owner changes the session gate; clients never open a second SQLite writer.
		const service = await launch([reply("Allowed")]);
		expect(
			await requestService(
				service.path,
				{ type: "maintenance-enter", operationId: "update", timeoutMs: 0 },
				signal(),
			),
		).toEqual({ type: "maintenance", protocol: 1, state: "held", operationId: "update", result: "drained" });
		expect(await requestService(service.path, { type: "send", prompt: "Blocked" }, signal())).toMatchObject({
			type: "error",
		});
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({
			maintenance: { state: "held", operationId: "update" },
		});
		expect(
			await requestService(service.path, { type: "maintenance-release", operationId: "wrong" }, signal()),
		).toMatchObject({ type: "error" });
		expect(
			await requestService(service.path, { type: "maintenance-release", operationId: "update" }, signal()),
		).toEqual({ type: "maintenance", protocol: 1, state: "open", operationId: null });
		expect(await requestService(service.path, { type: "send", prompt: "Allowed" }, signal())).toMatchObject({
			type: "reply",
		});
		expect(service.faux.state.callCount).toBe(1);
	});

	it("pages retained chat history on the root across hidden entries, maintenance, and reopen", async () => {
		const context = BACKGROUND_CONTEXT;
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "session.sqlite")),
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		const hiddenEntry = defineEntry<{ text: string }>("test.chat.hidden");
		const escapedText = "\u0001".repeat(4097);
		const seeded = await (async () => {
			try {
				const root = await harness.root(context);
				const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
				return await harness.commit(async (tx) => {
					const appendHidden = () => tx.appendEntry(hiddenEntry, root.id, { data: { text: "hidden detail" } });
					const oldest = await tx.appendEntry(UserEntry, root.id, {
						model: [{ role: "user", content: "Oldest input", timestamp: 1 }],
					});
					for (let i = 0; i < 9; i++) await appendHidden();
					const sixth = await tx.appendEntry(AssistantEntry, root.id, { model: [reply("Sixth visible row")] });
					const emitted = [];
					const between = [];
					for (let i = 0; i < 5; i++) {
						between.push(await appendHidden());
						emitted.push(
							i === 0
								? await tx.appendEntry(HostFactEntry, root.id, {
										data: { role: "user", text: escapedText, input: "private host input", facts: null },
									})
								: await tx.appendEntry(AssistantEntry, root.id, { model: [reply(escapedText)] }),
						);
					}
					const foreign = await tx.appendEntry(AssistantEntry, other.id, { model: [reply("Foreign chat")] });
					const hiddenBoundary = await tx.appendEntry(ResetEntry, root.id, { head: "self" });
					for (let i = 0; i < 18; i++) await appendHidden();
					await tx.appendEntry(ToolResultEntry, root.id, {
						data: { diagnostics: [] },
						model: [
							{
								role: "toolResult",
								toolCallId: "hidden-call",
								toolName: "read",
								content: [fauxText("private tool output")],
								isError: false,
								timestamp: 1,
							},
						],
					});
					return { oldest, sixth, emitted, between, foreign, hiddenBoundary };
				}, context);
			} finally {
				await harness.close(context);
			}
		})();
		const service = await launch([], undefined, join(directory, "operator"));
		const operator = service.operatorPath!;
		const read = (before: number | null, path = operator) =>
			requestService(path, { type: "chat-history", before }, signal());
		const watcher = new AbortController();
		let initialView: ServiceView | undefined;
		await watchService(
			operator,
			(view) => {
				initialView = view;
				watcher.abort();
			},
			watcher.signal,
		);
		expect(initialView).toMatchObject({ entries: [], historyTruncated: true });
		const hiddenPage = { type: "chat-history", page: { entries: [], nextBefore: seeded.hiddenBoundary.id } };
		expect(await read(null)).toEqual(hiddenPage);
		expect(await read(Number.MAX_SAFE_INTEGER, service.path)).toEqual(hiddenPage);
		const lastPage = {
			type: "chat-history",
			page: {
				entries: [
					{ id: seeded.oldest.id, role: "user", text: "Oldest input", truncated: false },
					{ id: seeded.sixth.id, role: "assistant", text: "Sixth visible row", truncated: false },
				],
				nextBefore: null,
			},
		};
		const firstVisible = await read(seeded.hiddenBoundary.id);
		expect(firstVisible).toEqual({
			type: "chat-history",
			page: {
				entries: seeded.emitted.map(({ id }, index) => ({
					id,
					role: index === 0 ? "user" : "assistant",
					text: escapedText.slice(0, 4096),
					truncated: true,
					...(index === 0 ? { source: "host" } : {}),
				})),
				nextBefore: seeded.between[0]!.id,
			},
		});
		expect(await read(seeded.foreign.id)).toEqual(firstVisible);
		const empty = { type: "chat-history", page: { entries: [], nextBefore: null } };
		expect(await read(1)).toEqual(empty);
		expect(await read(seeded.oldest.id)).toEqual(empty);
		expect(await read(seeded.between[0]!.id)).toEqual(lastPage);

		expect(
			await requestService(
				service.path,
				{ type: "maintenance-enter", operationId: "history-hold", timeoutMs: 0 },
				signal(),
			),
		).toMatchObject({ state: "held" });
		const scanRoot = () =>
			service.storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, context);
		const before = await scanRoot();
		const commit = vi.spyOn(service.storage, "commit");
		const scan = vi.spyOn(service.storage, "scanEntries");
		expect(await read(seeded.hiddenBoundary.id)).toEqual(firstVisible);
		expect(scan).toHaveBeenCalledExactlyOnceWith(
			{ conversationId: ROOT_CONVERSATION_ID, order: "descending", maxEntryId: seeded.hiddenBoundary.id - 1 },
			20,
			undefined,
			context,
		);
		expect(commit).not.toHaveBeenCalled();
		expect(await scanRoot()).toEqual(before);
		expect(service.faux.state.callCount).toBe(0);
		await service.close();

		const reopened = await launch([], undefined, join(directory, "reopened"));
		const reopenedOperator = reopened.operatorPath!;
		expect(await requestService(reopenedOperator, { type: "status" }, signal())).toMatchObject({
			inhibited: true,
			maintenance: { state: "held" },
		});
		const reopenedCommit = vi.spyOn(reopened.storage, "commit");
		expect(await read(null, reopenedOperator)).toEqual(hiddenPage);
		expect(await read(seeded.between[0]!.id, reopenedOperator)).toEqual(lastPage);
		expect(reopenedCommit).not.toHaveBeenCalled();
		expect(
			await reopened.storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, context),
		).toEqual(before);
		expect(
			await requestService(reopenedOperator, { type: "send", prompt: "Held input", requestId: "held" }, signal()),
		).toMatchObject({ type: "error" });
		expect(await requestService(reopenedOperator, { type: "admission", requestId: "held" }, signal())).toEqual({
			type: "admission",
			admission: { status: "not-found" },
		});
		expect(reopened.faux.state.callCount).toBe(0);
	});

	it("rejects invalid chat history requests before dispatch on either socket", async () => {
		const service = await launch([], undefined, join(directory, "operator"));
		const read = vi.spyOn(service.agent, "chatHistory");
		for (const fields of [
			{},
			{ before: 0 },
			{ before: -1 },
			{ before: 1.5 },
			{ before: Number.MAX_SAFE_INTEGER + 1 },
			{ before: "1" },
			{ before: null, conversationId: 1 },
			{ before: 20, limit: 5 },
		]) {
			for (const path of [service.path, service.operatorPath!]) {
				expect(await requestService(path, { type: "chat-history", ...fields } as never, signal())).toEqual({
					type: "error",
					message: "Invalid chat history request.",
				});
			}
		}
		expect(read).not.toHaveBeenCalled();
	});

	it("decodes only closed chat history replies that respect the exclusive request bound", () => {
		const row = { id: 10, role: "assistant", text: "Retained reply", truncated: false, source: "host" };
		const response = { type: "chat-history", page: { entries: [row], nextBefore: 10 } };
		expect(parseServiceResponse(JSON.stringify(response), 11)).toEqual(response);
		for (const value of [
			{ ...response, diagnostics: {} },
			{ ...response, page: { ...response.page, tools: [] } },
			...[
				{ ...response.page, nextBefore: undefined },
				{ ...response.page, nextBefore: 11 },
				{ ...response.page, nextBefore: 0 },
				{ entries: [], nextBefore: 11 },
				{ entries: [], nextBefore: Number.MAX_SAFE_INTEGER + 1 },
				{ entries: [{ ...row, id: 9 }], nextBefore: 10 },
				{ entries: [{ ...row, id: 11 }], nextBefore: null },
				{ entries: [row, row], nextBefore: null },
				{ entries: [row, { ...row, id: 9 }], nextBefore: null },
				{ entries: Array.from({ length: 6 }, (_, id) => ({ ...row, id: id + 1 })), nextBefore: null },
				{ entries: [{ ...row, text: "x".repeat(4097) }], nextBefore: null },
				{ entries: [{ ...row, source: "tool" }], nextBefore: null },
				{ entries: [{ ...row, model: [] }], nextBefore: null },
			].map((page) => ({ type: "chat-history", page })),
		])
			expect(() => parseServiceResponse(JSON.stringify(value), 11)).toThrow();
		expect(() => parseServiceResponse(JSON.stringify(response), 10)).toThrow();
	});

	it("keeps the second watcher alive through queued prompts and a tool round after the first detaches", async () => {
		// #21: structural snapshots retain committed answers even when intermediate updates fold.
		let resume!: () => void;
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const service = await launch([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" }, { id: "read-1" })], {
					stopReason: "toolUse",
				});
			},
			reply("First complete tail."),
			reply("Second complete tail."),
		]);
		const submit = service.agent.submit.bind(service.agent);
		let admitted = 0;
		vi.spyOn(service.agent, "submit").mockImplementation(async (...args) => {
			const submission = await submit(...args);
			admitted++;
			return submission;
		});
		const first = new AbortController();
		const second = new AbortController();
		let firstReady = false;
		const views: ServiceView[] = [];
		const watchingFirst = watchService(
			service.path,
			() => {
				firstReady = true;
			},
			first.signal,
		);
		const watchingSecond = watchService(
			service.path,
			(view) => {
				views.push(view);
			},
			second.signal,
		);
		try {
			await expect.poll(() => firstReady && views.length > 0).toBe(true);
			first.abort();
			await watchingFirst;
			const one = requestService(service.path, { type: "send", prompt: "First" }, signal());
			await expect.poll(() => views.at(-1)?.busy).toBe(true);
			const two = requestService(service.path, { type: "send", prompt: "Second" }, signal());
			await expect.poll(() => admitted).toBe(2);
			resume();
			await Promise.all([one, two]);
			await expect
				.poll(() =>
					views
						.at(-1)
						?.entries.filter(({ role }) => role === "assistant")
						.map(({ text }) => text),
				)
				.toEqual(["First complete tail.", "Second complete tail."]);
		} finally {
			resume();
			first.abort();
			second.abort();
			await Promise.all([watchingFirst, watchingSecond]);
		}
	});

	it("stops a watch acquired after its socket has already disconnected", async () => {
		// #21: terminal loss during subscription acquisition cannot retain an orphaned watch.
		const service = await launch([]);
		const original = service.agent.watchConversation.bind(service.agent);
		let subscription: Awaited<ReturnType<typeof original>> | undefined;
		let resume!: () => void;
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		vi.spyOn(service.agent, "watchConversation").mockImplementation(async (context) => {
			subscription = await original(context);
			await gate;
			return subscription;
		});
		const controller = new AbortController();
		const watching = watchService(service.path, () => {}, controller.signal);
		await expect.poll(() => subscription !== undefined).toBe(true);
		controller.abort();
		await watching;
		resume();
		await expect(subscription?.closed).resolves.toMatchObject({ kind: "stopped" });
	});
	it("streams initial and committed final transcript without acquiring another session owner", async () => {
		// #21: attaching observes the service's owner instead of opening its database again.
		const service = await launch([reply("A final answer with its complete tail.")]);
		const controller = new AbortController();
		const views: ServiceView[] = [];
		const watching = watchService(
			service.path,
			(view) => {
				views.push(view);
			},
			controller.signal,
		);
		try {
			await expect.poll(() => views.length).toBeGreaterThan(0);
			await expect(acquireSessionLock(join(directory, "session.sqlite.lock"))).rejects.toThrow("already running");
			await requestService(service.path, { type: "send", prompt: "Answer." }, signal());
			await expect.poll(() => views.at(-1)?.entries.at(-1)?.text).toBe("A final answer with its complete tail.");
			expect(views.at(-1)?.entries.map(({ role }) => role)).toEqual(["user", "assistant"]);
		} finally {
			controller.abort();
			await watching;
		}
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
	});

	it("detaching a mid-run watcher preserves work and separate cancel remains effective", async () => {
		// #21: losing an SSH terminal must never abort autonomous work.
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const service = await launch([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
		]);
		const original = service.agent.watchConversation.bind(service.agent);
		let subscription: Awaited<ReturnType<typeof original>> | undefined;
		vi.spyOn(service.agent, "watchConversation").mockImplementation(async (context) => {
			subscription = await original(context);
			return subscription;
		});
		const sending = requestService(service.path, { type: "send", prompt: "Wait." }, signal());
		await started;
		const controller = new AbortController();
		const views: ServiceView[] = [];
		const watching = watchService(
			service.path,
			(view) => {
				views.push(view);
			},
			controller.signal,
		);
		await expect.poll(() => views[0]?.busy).toBe(true);
		controller.abort();
		await watching;
		await expect(subscription?.closed).resolves.toMatchObject({ kind: "stopped" });
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: true });
		await requestService(service.path, { type: "cancel" }, signal());
		expect(await sending).toMatchObject({ type: "reply", reply: { status: "failed" } });
	});

	it("drops a backed-up terminal without preventing controls", async () => {
		// #21: socket backpressure cannot make the durable agent wait for a terminal.
		const service = await launch([]);
		const queued = vi.spyOn(Socket.prototype, "writableLength", "get").mockReturnValue(2 * 1_048_576);
		try {
			await expect(watchService(service.path, () => {}, signal())).rejects.toThrow("disconnected");
		} finally {
			queued.mockRestore();
		}
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
	});

	it.each(['{"type":"view","view":{}}\n', "x".repeat(1_048_577), ""])(
		"rejects invalid, oversized, and disconnected watch streams",
		async (wire) => {
			const path = join(directory, "wire.sock");
			const server = createServer((socket) => socket.once("data", () => socket.end(wire)));
			await new Promise<void>((resolve) => server.listen(path, resolve));
			try {
				await expect(watchService(path, () => {}, signal())).rejects.toThrow();
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);
	it("reports cached installed identity without reading manifests on each status", async () => {
		// #19: readiness must identify the selected installation, not merely an available socket.
		const identity = { id: "11111111-1111-1111-1111-111111111111", name: "bob" };
		const service = await launch([], identity);
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({
			name: "bob",
			installationId: identity.id,
		});
	});
	it("answers without terminal input and protects its socket", async () => {
		const service = await launch([reply("Paris.")]);
		expect((await stat(join(directory, "control"))).mode & 0o777).toBe(0o700);
		expect((await stat(service.path)).mode & 0o777).toBe(0o600);
		expect(await requestService(service.path, { type: "status" }, signal())).toEqual({
			type: "status",
			pid: process.pid,
			version: "fixture-version",
			name: "agent",
			installationId: null,
			busy: false,
			inhibited: false,
			maintenance: { protocol: 1, state: "open", operationId: null },
			runtime: {
				application: "unit-001",
				configuration: "configured",
				name: "agent",
				provider: "faux",
				modelId: "faux-1",
				pid: process.pid,
				startedAt: expect.any(Number),
				uptimeMs: expect.any(Number),
				observedAt: expect.any(Number),
			},
		});
		expect(
			await requestService(service.path, { type: "send", prompt: "Capital of France?", requestId: "q1" }, signal()),
		).toEqual({ type: "reply", reply: { status: "answered", text: "Paris." } });
		expect(
			await requestService(service.path, { type: "send", prompt: "Capital of France?", requestId: "q1" }, signal()),
		).toEqual({ type: "reply", reply: { status: "answered", text: "Paris." } });
		expect(service.faux.state.callCount).toBe(1);
	});

	it("shutdown preserves an admitted run for reopening", async () => {
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const service = await launch([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("closing")), { once: true });
				}),
		]);
		const sending = requestService(
			service.path,
			{ type: "send", prompt: "Capital?", requestId: "pending" },
			signal(),
		);
		void sending.catch(() => {});
		await started;
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: true });
		await service.close();
		await expect(sending).rejects.toThrow(/disconnected/);
		const reopened = await launch([reply("Paris.")]);
		expect(reopened.agent.interrupted).toBe(true);
		expect(await reopened.agent.idle(BACKGROUND_CONTEXT)).toBe("Paris.");
		expect(
			await requestService(reopened.path, { type: "send", prompt: "Capital?", requestId: "pending" }, signal()),
		).toEqual({ type: "reply", reply: { status: "answered", text: "Paris." } });
		expect(reopened.faux.state.callCount).toBe(1);
	});

	it("client disconnect does not abort durable work; cancel does", async () => {
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const service = await launch([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
		]);
		const client = new AbortController();
		const sending = requestService(service.path, { type: "send", prompt: "Wait." }, client.signal);
		void sending.catch(() => {});
		await started;
		client.abort();
		await expect(sending).rejects.toBeDefined();
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: true });
		expect(await requestService(service.path, { type: "cancel" }, signal())).toEqual({ type: "cancelled" });
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
	});

	it("rejects malformed local wire input without invoking the model", async () => {
		const service = await launch([]);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = createConnection(service.path, () => socket.write('{"type":"send","prompt":4}\n'));
			let text = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				text += chunk;
			});
			socket.once("end", () => resolve(text));
			socket.once("error", reject);
		});
		expect(JSON.parse(response)).toEqual({ type: "error", message: "Invalid service prompt." });
		expect(service.faux.state.callCount).toBe(0);
	});

	// #26: the lookup is a read over the socket; it must never admit, and a same-ID send with new text is refused.
	it("answers send admission by request ID without admitting, and refuses a conflicting replay", async () => {
		const service = await launch([reply("Paris.")]);
		const lookup = (digest?: string) =>
			requestService(
				service.path,
				{ type: "admission", requestId: "r1", ...(digest === undefined ? {} : { digest }) },
				signal(),
			);
		expect(await lookup(sendDigest("Capital?"))).toEqual({ type: "admission", admission: { status: "not-found" } });
		expect(service.faux.state.callCount).toBe(0);
		await requestService(service.path, { type: "send", prompt: "Capital?", requestId: "r1" }, signal());
		expect(await lookup(sendDigest("Capital?"))).toEqual({
			type: "admission",
			admission: { status: "admitted", source: "model", binding: "exact", outcome: "answered" },
		});
		expect(await requestService(service.path, { type: "send", prompt: "Other?", requestId: "r1" }, signal())).toEqual({
			type: "error",
			message: "Request ID already identifies a send with a different prompt; use a new request ID.",
		});
		const raw = (line: string) =>
			new Promise<unknown>((resolve, reject) => {
				const socket = createConnection(service.path, () => socket.write(`${line}\n`));
				let text = "";
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => {
					text += chunk;
				});
				socket.once("end", () => resolve(JSON.parse(text)));
				socket.once("error", reject);
			});
		expect(await raw('{"type":"admission","requestId":"r1","prompt":"Capital?"}')).toMatchObject({ type: "error" });
		expect(await raw('{"type":"admission","requestId":"r1","digest":"nope"}')).toEqual({
			type: "error",
			message: "Invalid prompt digest.",
		});
		expect(service.faux.state.callCount).toBe(1);
	});

	// #26 review: a held owner refuses sends before admission, yet operators can still settle earlier ones.
	it("answers admission lookups over the operator socket while held for maintenance", async () => {
		const service = await launch([reply("Paris.")], undefined, join(directory, "operator"));
		const operatorPath = service.operatorPath!;
		await requestService(operatorPath, { type: "send", prompt: "Capital?", requestId: "before" }, signal());
		expect(
			await requestService(service.path, { type: "maintenance-enter", operationId: "hold", timeoutMs: 0 }, signal()),
		).toMatchObject({ state: "held" });
		expect(await requestService(operatorPath, { type: "send", prompt: "Held?", requestId: "during" }, signal())).toEqual({
			type: "error",
			message: "Service is held for maintenance.",
		});
		const lookup = (requestId: string, prompt: string) =>
			requestService(operatorPath, { type: "admission", requestId, digest: sendDigest(prompt) }, signal());
		expect(await lookup("before", "Capital?")).toEqual({
			type: "admission",
			admission: { status: "admitted", source: "model", binding: "exact", outcome: "answered" },
		});
		expect(await lookup("during", "Held?")).toEqual({ type: "admission", admission: { status: "not-found" } });
		expect(service.faux.state.callCount).toBe(1);
	});

	// #26 review, blocker 2: the owner replaces a reply over 1 MiB with an error after the send was admitted.
	it("reports a send admitted even when its reply was replaced by an oversize error", async () => {
		const service = await launch([reply("x".repeat(1_100_000))]);
		expect(await requestService(service.path, { type: "send", prompt: "Long?", requestId: "big" }, signal())).toEqual({
			type: "error",
			message: "Service response exceeds 1 MiB.",
		});
		expect(
			await requestService(service.path, { type: "admission", requestId: "big", digest: sendDigest("Long?") }, signal()),
		).toEqual({
			type: "admission",
			admission: { status: "admitted", source: "model", binding: "exact", outcome: "answered" },
		});
	});

	it("rejects oversized wire input and continues serving valid controls", async () => {
		const service = await launch([]);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = createConnection(service.path, () => socket.write("x".repeat(65_537)));
			let text = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				text += chunk;
			});
			socket.once("end", () => resolve(text));
			socket.once("error", reject);
		});
		expect(JSON.parse(response)).toEqual({ type: "error", message: "Service request exceeds 64 KiB." });
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
		expect(service.faux.state.callCount).toBe(0);
	});

	it("propagates a storage failure and removes its endpoint", async () => {
		const service = await launch([reply("unused")]);
		const failure = new Error("disk failed");
		vi.spyOn(service.storage, "commit").mockRejectedValueOnce(failure);
		const sending = requestService(service.path, { type: "send", prompt: "hi" }, signal());
		void sending.catch(() => {});
		await expect(service.running).rejects.toBe(failure);
		await Promise.allSettled([sending]);
		expect(await service.agent.closed).toMatchObject({ kind: "failed", error: failure });
		cleanup.pop();
		await expect(service.close()).rejects.toBe(failure);
		await expect(stat(service.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		{ stopSignal: "SIGTERM", exitCode: 0 },
		{ stopSignal: "SIGKILL", exitCode: null },
	] as const)("$stopSignal during a model request preserves it for reopening", async ({ stopSignal, exitCode }) => {
		const fixture = fileURLToPath(new URL("./fixtures/service-owner.ts", import.meta.url));
		const child = spawn(process.execPath, [fixture, directory], { stdio: ["ignore", "pipe", "pipe"] });
		children.push(child);
		let output = "";
		let errors = "";
		const waiters: { marker: string; resolve: () => void; reject: (error: Error) => void }[] = [];
		child.stderr?.on("data", (chunk) => {
			errors += String(chunk);
		});
		child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			for (const waiter of waiters) if (output.includes(waiter.marker)) waiter.resolve();
		});
		child.once("exit", () => {
			for (const waiter of waiters) if (!output.includes(waiter.marker)) waiter.reject(new Error(errors));
		});
		const until = (marker: string) =>
			new Promise<void>((resolve, reject) => {
				if (output.includes(marker)) resolve();
				else waiters.push({ marker, resolve, reject });
			});
		await until("READY");
		const path = serviceEndpoint(directory, "default", process.platform);
		const sending = requestService(path, { type: "send", prompt: "Capital?", requestId: "signal" }, signal());
		void sending.catch(() => {});
		await until("REQUESTED");
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		child.kill(stopSignal);
		expect(await exited).toBe(exitCode);
		await expect(sending).rejects.toThrow(/disconnected/);
		const service = await launch([reply("Paris.")]);
		expect(service.agent.interrupted).toBe(true);
		expect(await service.agent.idle(BACKGROUND_CONTEXT)).toBe("Paris.");
		expect(
			await requestService(service.path, { type: "send", prompt: "Capital?", requestId: "signal" }, signal()),
		).toMatchObject({ type: "reply", reply: { text: "Paris." } });
		expect(service.faux.state.callCount).toBe(1);
	});

	it("stops advertising readiness when the harness closes unexpectedly", async () => {
		const service = await launch([]);
		await service.agent.close(BACKGROUND_CONTEXT);
		await expect(service.running).rejects.toThrow("Agent closed unexpectedly.");
		cleanup.pop();
		await expect(service.close()).rejects.toThrow("Agent closed unexpectedly.");
		await expect(stat(service.path)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
