// Checks the presentation boundary independently of providers and socket transport.
import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { parseServiceEvent, runFailureSummary, serviceView, toolFailureSummary } from "../src/service-view.ts";

const identity = { pid: 42, version: "1.0.0", name: "bob", installationId: null };

describe("service view", () => {
	it("retains committed tool outcomes without reading result contents or private diagnostics", () => {
		// #21: finished tools remain visible after live slots disappear, including failures.
		// No call's content or details are read; a failure exposes only its host-classified diagnostic code.
		const result = (id: number, isError: boolean, kind = "pi.tool-result") => {
			const message = { role: "toolResult", toolCallId: `call-${id}`, toolName: "read", isError };
			return isError
				? {
						id,
						kind,
						model: [
							Object.defineProperty({ ...message }, "content", {
								get() {
									throw new Error("Read private error output");
								},
							}),
						],
						data: { diagnostics: [] },
					}
				: {
						id,
						kind,
						model: [
							Object.defineProperties(
								{ ...message },
								{
									content: {
										get() {
											throw new Error("Read private output");
										},
									},
									details: {
										get() {
											throw new Error("Read private details");
										},
									},
								},
							),
						],
						get data() {
							throw new Error("Read private diagnostics");
						},
					};
		};
		const source = {
			entries: [result(1, false), result(2, true), result(3, true, "custom")],
			docs: {},
		} as unknown as ConversationView;
		const projected = serviceView(source, identity);
		expect(projected.tools).toEqual([
			{ callId: "call-1", name: "read", status: "succeeded" },
			{ callId: "call-2", name: "read", status: "failed", reason: { code: "unknown" } },
		]);
		expect(projected.entries).toEqual([]);
		expect(parseServiceEvent(JSON.stringify({ type: "view", view: projected })).view.tools).toEqual(projected.tools);
	});

	it("matches live done slots by result entry and does not reuse old outcomes for a reused call ID", () => {
		const entries = [
			{
				id: 10,
				kind: "pi.tool-result",
				model: [{ role: "toolResult", toolCallId: "same", toolName: "read", isError: true, content: [] }],
			},
		];
		const source = (slot: object) =>
			({ entries, docs: { "pi.live": { tools: [slot] } } }) as unknown as ConversationView;
		const slot = { callId: "same", name: "read", status: "done" };
		expect(serviceView(source({ ...slot, entry: 10 }), identity).tools[0].status).toBe("failed");
		expect(serviceView(source(slot), identity).tools[0].status).toBe("done");
		expect(serviceView(source({ ...slot, entry: 99 }), identity).tools[0].status).toBe("done");
		expect(serviceView(source({ ...slot, status: "running" }), identity).tools[0].status).toBe("running");
	});

	const failed = (id: number, diagnostics: object[], content = "private error output") => ({
		id,
		kind: "pi.tool-result",
		model: [{ role: "toolResult", toolCallId: `call-${id}`, toolName: "bash", isError: true, content: [{ type: "text", text: content }] }],
		data: { diagnostics },
	});

	it("classifies a failed call from Durable's diagnostic codes and never copies its text (#26, sec-redaction High)", () => {
		const error = (code: string, message: string) => [{ severity: "warn", message: "only a warning" }, { severity: "error", code, message }];
		const source = {
			entries: [
				failed(1, error("exit_code", "Command exited with code 2")),
				failed(2, error("tool_error", "Command timed out after 30 seconds")),
				failed(3, error("tool_error", "Command aborted")),
				failed(4, error("tool_error", "ENOENT: no such file or directory, open '/srv/.env'")),
				failed(5, error("tool_error", "EACCES: permission denied, open '/etc/unit-001/x'")),
				failed(6, error("tool_unavailable", "Tool probe is not available")),
				failed(7, error("blocked", "Tool call blocked: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789")),
				failed(8, error("invalid_arguments", "Invalid arguments")),
				failed(9, error("tool_error", "permission denied, token=ghp_abcdefghijklmnopqrstuvwxyz0123456789")),
				// A foreign tool cannot smuggle text through a host code: an unparsable exit message is unknown.
				failed(10, error("exit_code", "Command exited with code 2; SECRET=Zx9qQ8vL2mN4pR6s")),
				failed(11, [], "Authorization: Basic dXNlcjpwYXNzd29yZA=="),
			],
			docs: {},
		} as unknown as ConversationView;
		const view = serviceView(source, identity);
		expect(view.tools.map((tool) => tool.reason)).toEqual([
			{ code: "exit_code", exitCode: 2 },
			{ code: "timeout", seconds: 30 },
			{ code: "aborted" },
			{ code: "not_found" },
			{ code: "permission_denied" },
			{ code: "unavailable" },
			{ code: "blocked" },
			{ code: "invalid_arguments" },
			{ code: "unknown" },
			{ code: "unknown" },
			{ code: "unknown" },
		]);
		expect(JSON.stringify(view)).not.toMatch(/ghp_|dXNlcjpw|Zx9qQ8|srv|etc\/unit|private error/);
		expect(parseServiceEvent(JSON.stringify({ type: "view", view })).view.tools).toEqual(view.tools);
		expect(view.tools.map((tool) => toolFailureSummary(tool.reason ?? { code: "unknown" }, tool.callId))).toEqual([
			"Exited with code 2.",
			"Timed out after 30 seconds.",
			"Aborted.",
			"File or directory not found.",
			"Permission denied.",
			"Tool is not available.",
			"Blocked by a tool policy.",
			"The model sent invalid arguments.",
			"Tool failed; run /evidence call-9 for details.",
			"Tool failed; run /evidence call-10 for details.",
			"Tool failed; run /evidence call-11 for details.",
		]);
	});

	// #26 second review, finding 6: Durable's shell tool accepts fractional seconds and prints them as a JS number.
	it("classifies fractional timeouts and validates their seconds at the wire", () => {
		const timeout = (seconds: string) => [{ severity: "error", code: "tool_error", message: `Command timed out after ${seconds} seconds` }];
		const source = {
			entries: ["0.5", "1.25", "1e-7", "0", "9999999"].map((seconds, index) => failed(index + 1, timeout(seconds))),
			docs: {},
		} as unknown as ConversationView;
		const view = serviceView(source, identity);
		expect(view.tools.map((tool) => tool.reason)).toEqual([
			{ code: "timeout", seconds: 0.5 },
			{ code: "timeout", seconds: 1.25 },
			{ code: "timeout", seconds: 1e-7 },
			{ code: "timeout" },
			{ code: "timeout" },
		]);
		expect(toolFailureSummary({ code: "timeout", seconds: 0.5 }, "call-1")).toBe("Timed out after 0.5 seconds.");
		expect(parseServiceEvent(JSON.stringify({ type: "view", view })).view.tools).toEqual(view.tools);
		for (const seconds of [-1, 0, 3e6, "30"]) {
			const tools = [{ ...view.tools[0], reason: { code: "timeout", seconds } }];
			expect(() => parseServiceEvent(JSON.stringify({ type: "view", view: { ...view, tools } }))).toThrow();
		}
	});

	it("keeps escape, OSC and bidi characters of a failed call's error out of the frame (sec-ipc)", () => {
		const hostile = "\x1b]0;owned\x07‮fdp.exe\x1b[31m";
		const source = {
			entries: [failed(1, [{ severity: "error", code: "tool_error", message: hostile }], hostile)],
			docs: { "pi.live": { runFailure: { taskId: 1, inputs: [], reason: "model_error", detail: hostile } } },
		} as unknown as ConversationView;
		const wire = JSON.stringify({ type: "view", view: serviceView(source, identity) });
		expect(wire).not.toMatch(/\\u001b|\\u0007|‮|owned|fdp/);
		expect(parseServiceEvent(wire).view.tools[0].reason).toEqual({ code: "unknown" });
	});

	it("classifies each committed failure once, not on every frame (review M3)", () => {
		let reads = 0;
		const entry = {
			...failed(1, []),
			get data() {
				reads++;
				return { diagnostics: [{ severity: "error", code: "exit_code", message: "Command exited with code 1" }] };
			},
		};
		const source = { entries: [entry], docs: {} } as unknown as ConversationView;
		for (let frame = 0; frame < 50; frame++) serviceView(source, identity);
		expect(reads).toBe(1);
		expect(serviceView(source, identity).tools[0].reason).toEqual({ code: "exit_code", exitCode: 1 });
	});

	it("projects why the newest run failed and any waiting provider retry as typed values (#26)", () => {
		const source = (live: object) => ({ entries: [], docs: { "pi.live": live } }) as unknown as ConversationView;
		expect(serviceView(source({}), identity)).not.toHaveProperty("failure");
		expect(serviceView(source({}), identity)).not.toHaveProperty("retry");
		const view = serviceView(
			source({
				runFailure: { taskId: 1, inputs: [], reason: "model_error", detail: `503 overloaded sk-ant-api03-ABCDEFGHIJKLMNOP1234\n${"y".repeat(400)}` },
				generation: { attempt: 3, retry: { at: 1_700_000_000_000, error: "429 rate limited: key sk-ant-api03-ABCDEFGHIJKLMNOP1234" } },
			}),
			identity,
		);
		expect(view.failure).toEqual({ reason: "model_error", problem: "overloaded" });
		expect(view.retry).toEqual({ attempt: 3, at: 1_700_000_000_000, problem: "rate_limited" });
		expect(JSON.stringify(view)).not.toContain("sk-ant");
		expect(parseServiceEvent(JSON.stringify({ type: "view", view })).view).toEqual(view);
		const problem = (detail: string) =>
			serviceView(source({ runFailure: { taskId: 1, inputs: [], reason: "model_error", detail } }), identity).failure;
		expect(problem("401 invalid x-api-key")).toEqual({ reason: "model_error", problem: "auth" });
		expect(problem("fetch failed: ECONNRESET")).toEqual({ reason: "model_error", problem: "network" });
		expect(problem("something odd")).toEqual({ reason: "model_error", problem: "unknown" });
		const bare = serviceView(source({ runFailure: { taskId: 1, inputs: [], reason: "aborted" } }), identity);
		expect(bare.failure).toEqual({ reason: "aborted" });
		const turns = serviceView(source({ runFailure: { taskId: 1, inputs: [], reason: "turn_limit", detail: "12 turns" } }), identity);
		expect(turns.failure).toEqual({ reason: "turn_limit", turns: 12 });
		expect(runFailureSummary(turns.failure ?? bare.failure ?? { reason: "aborted" })).toBe(
			"the run reached its tool round limit (12 turns)",
		);
		const faulted = serviceView(source({ runFailure: { taskId: 1, inputs: [], reason: "faulted", detail: "boom at /srv/x" } }), identity);
		expect(faulted.failure).toEqual({ reason: "faulted" });
	});

	it("rejects free-form and malformed reasons, failures and retries at the socket boundary (#26)", () => {
		const baseline = serviceView({ entries: [], docs: {} } as unknown as ConversationView, identity);
		const tool = { callId: "c", name: "bash", status: "failed" };
		for (const patch of [
			{ tools: [{ ...tool, reason: 7 }] },
			{ tools: [{ ...tool, reason: "exit 2: make failed" }] },
			{ tools: [{ ...tool, reason: { code: "other" } }] },
			{ tools: [{ ...tool, reason: { code: "unknown", text: "leak" } }] },
			{ tools: [{ ...tool, reason: { code: "exit_code", exitCode: 1.5 } }] },
			{ tools: [{ ...tool, reason: { code: "timeout", seconds: -1 } }] },
			{ failure: "model_error" },
			{ failure: { reason: "other" } },
			{ failure: { reason: "model_error", detail: "503 overloaded" } },
			{ failure: { reason: "model_error", problem: "melted" } },
			{ failure: { reason: "turn_limit", turns: "12" } },
			{ retry: { attempt: 1.5, at: 1, problem: "unknown" } },
			{ retry: { attempt: 1, at: 1, error: "429 rate limited" } },
			{ retry: { attempt: 1, at: 1, problem: "unknown", error: "e" } },
		])
			expect(() => parseServiceEvent(JSON.stringify({ type: "view", view: { ...baseline, ...patch } }))).toThrow();
	});

	it("projects model and recorded conversation-model usage without exposing other agent configuration", () => {
		// #21: status distinguishes estimates from subscription billing and avoids treating missing prices as free.
		const usage = (cost: number) => ({
			input: 10,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 17,
			reasoning: 3,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		});
		const source = {
			entries: [],
			docs: {
				"pi.agent": { model: { provider: "example", modelId: "model" }, instructions: "private instructions" },
				"pi.usage": {
					models: { "example/model": usage(0.25), "other/model": usage(0.5) },
					tools: { privateTool: usage(100) },
				},
			},
		} as unknown as ConversationView;
		const projected = serviceView(source, identity);
		expect(projected.model).toEqual({ provider: "example", modelId: "model" });
		expect(projected.usage).toEqual({
			scope: "conversation-models",
			input: 20,
			output: 8,
			cacheRead: 4,
			cacheWrite: 2,
			totalTokens: 34,
			cost: { kind: "estimate", usd: 0.75 },
		});
		expect(JSON.stringify(projected)).not.toContain("private");
		expect(parseServiceEvent(JSON.stringify({ type: "view", view: projected })).view).toEqual(projected);
		const unpriced = {
			...source,
			docs: {
				...source.docs,
				"pi.usage": { models: { "example/model": usage(0), "other/model": usage(0.5) }, tools: {} },
			},
		} as unknown as ConversationView;
		expect(serviceView(unpriced, identity).usage?.cost).toEqual({ kind: "unknown" });
		expect(serviceView({ ...source, docs: {} }, identity)).toMatchObject({ model: null, usage: null });
		expect(serviceView({ ...source, docs: { "pi.usage": { models: {}, tools: {} } } }, identity).usage).toBeNull();
	});

	it("reuses unchanged ledger summaries across live revisions and recomputes changed buckets", () => {
		// #21: streaming partials must not rescan historical model usage on every frame.
		let reads = 0;
		const models = {
			get "example/model"() {
				reads++;
				return {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
				};
			},
		};
		const source = { entries: [], docs: { "pi.usage": { models, tools: {} } } } as unknown as ConversationView;
		serviceView(source, identity);
		serviceView({ ...source, docs: { ...source.docs, "pi.live": {} } }, identity);
		expect(reads).toBe(1);
		const changed = {
			...source,
			docs: {
				"pi.usage": { models: { "example/model": { ...models["example/model"], totalTokens: 99 } }, tools: {} },
			},
		} as unknown as ConversationView;
		expect(serviceView(changed, identity).usage?.totalTokens).toBe(99);
	});

	it("rejects malformed and oversized model/usage fields at the socket boundary", () => {
		const baseline = serviceView({ entries: [], docs: {} } as unknown as ConversationView, identity);
		for (const patch of [
			{ model: { provider: "x".repeat(129), modelId: "ok" } },
			{ usage: { scope: "conversation-models", cost: { kind: "unknown" } } },
			{
				usage: {
					scope: "conversation-models",
					input: -1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { kind: "estimate", usd: 0 },
				},
			},
			{
				usage: {
					scope: "conversation-models",
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { kind: "estimate", usd: 0 },
				},
			},
		]) {
			expect(() => parseServiceEvent(JSON.stringify({ type: "view", view: { ...baseline, ...patch } }))).toThrow();
		}
	});
	it("stops reading large text tails once each presentation prefix is full", () => {
		// #21: bounded attach frames also bound text copying on every live update.
		const tail = {
			type: "text",
			get text(): string {
				throw new Error("Read omitted tail");
			},
		};
		const nontext = {
			type: "thinking",
			get text(): string {
				throw new Error("Read private nontext");
			},
		};
		const source = {
			entries: [
				{
					id: 1,
					model: [{ role: "assistant", content: [nontext, { type: "text", text: "a".repeat(1_000_000) }, tail] }],
				},
			],
			docs: {
				"pi.live": { generation: { message: { content: [{ type: "text", text: "b".repeat(1_000_000) }, tail] } } },
			},
		} as unknown as ConversationView;
		const view = serviceView(source, identity);
		expect(view.entries[0].text).toHaveLength(4096);
		expect(view.entries[0].truncated).toBe(true);
		expect(view.text).toHaveLength(8192);
		expect(view.textTruncated).toBe(true);
	});
	it("bounds transcript, partials, and tools without publishing internal documents", () => {
		// #21: attach frames expose bounded presentation instead of raw provider documents.
		const source = {
			before: 1,
			entries: Array.from({ length: 30 }, (_, id) => ({
				id,
				model: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(10_000) }] }],
			})),
			docs: {
				"pi.provider": { secret: "private-provider-state" },
				"pi.live": {
					run: {},
					generation: { message: { content: [{ type: "text", text: "y".repeat(20_000) }] } },
					tools: Array.from({ length: 40 }, (_, id) => ({
						callId: String(id),
						name: "read",
						status: "running",
						arguments: "private",
					})),
				},
			},
		} as unknown as ConversationView;
		const view = serviceView(source, identity);
		expect(view.entries).toHaveLength(20);
		expect(view.entries[0]).toMatchObject({ id: 10, truncated: true });
		expect(view.entries[0].text).toHaveLength(4096);
		expect(view.text).toHaveLength(8192);
		expect(view.textTruncated).toBe(true);
		expect(view.tools).toHaveLength(32);
		const wire = JSON.stringify({ type: "view", view });
		expect(Buffer.byteLength(wire)).toBeLessThan(1_048_576);
		expect(wire).not.toContain("private");
		expect(parseServiceEvent(wire).view).toEqual(view);
	});
	it("retains a complete committed answer after generation partials disappear", () => {
		const source = {
			entries: [{ id: 2, model: [{ role: "assistant", content: [{ type: "text", text: "complete tail" }] }] }],
			docs: {},
		} as unknown as ConversationView;
		expect(serviceView(source, identity)).toMatchObject({
			busy: false,
			text: "",
			entries: [{ id: 2, text: "complete tail", truncated: false }],
		});
	});
	it("projects multiple model messages as one stable transcript entry", () => {
		const source = {
			entries: [
				{
					id: 2,
					model: [
						{ role: "assistant", content: [{ type: "text", text: "one" }] },
						{ role: "assistant", content: [{ type: "text", text: "two" }] },
					],
				},
			],
			docs: {},
		} as unknown as ConversationView;
		expect(serviceView(source, identity).entries).toEqual([
			{ id: 2, role: "assistant", text: "one\ntwo", truncated: false },
		]);
	});
});
