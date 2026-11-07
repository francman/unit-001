// Checks the presentation boundary independently of providers and socket transport.
import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { parseServiceEvent, serviceView } from "../src/service-view.ts";

const identity = { pid: 42, version: "1.0.0", name: "bob", installationId: null };

describe("service view", () => {
	it("retains committed tool outcomes without reading result contents or private diagnostics", () => {
		// #21: finished tools remain visible after live slots disappear, including failures.
		const result = (id: number, isError: boolean, kind = "pi.tool-result") => ({
			id,
			kind,
			model: [
				{
					role: "toolResult",
					toolCallId: `call-${id}`,
					toolName: "read",
					isError,
					get content() {
						throw new Error("Read private output");
					},
					get details() {
						throw new Error("Read private details");
					},
				},
			],
			get data() {
				throw new Error("Read private diagnostics");
			},
		});
		const source = {
			entries: [result(1, false), result(2, true), result(3, true, "custom")],
			docs: {},
		} as unknown as ConversationView;
		const projected = serviceView(source, identity);
		expect(projected.tools).toEqual([
			{ callId: "call-1", name: "read", status: "succeeded" },
			{ callId: "call-2", name: "read", status: "failed" },
		]);
		expect(projected.entries).toEqual([]);
		expect(parseServiceEvent(JSON.stringify({ type: "view", view: projected })).view.tools).toEqual(projected.tools);
	});

	it("matches live done slots by result entry and does not reuse old outcomes for a reused call ID", () => {
		const entries = [
			{
				id: 10,
				kind: "pi.tool-result",
				model: [{ role: "toolResult", toolCallId: "same", toolName: "read", isError: true }],
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
