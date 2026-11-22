// #26: two attached observers share failure reasons; evidence reaches only the client that asks for it.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { requestService, runService } from "../src/service.ts";
import { createForegroundTerminalController, type TerminalState } from "../src/terminal-controller.ts";
import type { ToolEvidence } from "../src/tool-evidence.ts";

const SECRETS = ["sk-ant-api03-ABCDEFGHIJKLMNOP1234", "plain-api-value", "dXNlcjpwYXNzd29yZA=="];
const SECRET_OUTPUT = `ANTHROPIC_API_KEY=${SECRETS[0]}\nAuthorization: Basic ${SECRETS[2]}\nvisible line`;

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "u1-evidence-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) await close();
	await rm(directory, { recursive: true, force: true });
});

const probe = defineExtension({
	name: "probe",
	tools: [
		defineTool({
			name: "probe",
			description: "Returns a fixed result or fails, for evidence tests.",
			parameters: Type.Object({ mode: Type.String(), apiKey: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async (args) => {
				if (args.mode === "fail") throw new Error(`probe failed: password=${SECRETS[1]}`);
				return { output: [{ type: "text", text: SECRET_OUTPUT }], details: { diff: `+${SECRET_OUTPUT}` } };
			},
		}),
	],
});

async function owner(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "evidence.sqlite")),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
			extensions: [probe],
		},
		BACKGROUND_CONTEXT,
	);
	cleanup.push(() => agent.close(BACKGROUND_CONTEXT));
	const observer = async () => {
		const states: TerminalState[] = [];
		const signal = new AbortController();
		const controller = createForegroundTerminalController(
			agent,
			"work",
			"0.0.4",
			(state) => states.push(state),
			signal.signal,
		);
		cleanup.push(async () => {
			controller.detach();
			await controller.closed;
		});
		await expect.poll(() => controller.state.connection).toBe("attached");
		return { controller, states };
	};
	return { agent, observer };
}

describe("tool evidence and failure reasons across observers", () => {
	it("shows the same failure reason to a second observer and sends evidence only on explicit request", async () => {
		const { agent, observer } = await owner([
			fauxAssistantMessage(fauxToolCall("probe", { mode: "ok", apiKey: SECRETS[1] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("probe", { mode: "fail" }), { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const spy = vi.spyOn(agent, "toolEvidence");
		const first = await observer();
		const second = await observer();
		expect(first.controller.submit("run the probes").status).toBe("submitted");
		await expect.poll(() => first.controller.state.view?.entries.at(-1)?.text).toBe("done");
		await expect.poll(() => second.controller.state.view?.entries.at(-1)?.text).toBe("done");

		// Both observers read the failure reason from the frame; neither asked the owner for evidence.
		for (const { controller } of [first, second]) {
			const tools = controller.state.view?.tools ?? [];
			expect(tools.map((tool) => tool.status)).toEqual(["succeeded", "failed"]);
			expect(tools[0]?.reason).toBeUndefined();
			// The thrown text is not a host-generated diagnostic, so the frame carries only the generic code.
			expect(tools[1]?.reason).toEqual({ code: "unknown" });
			expect(controller.state.evidence).toBeUndefined();
		}
		expect(spy).not.toHaveBeenCalled();
		// Watch frames never carried arguments, output, diffs or any secret sample.
		const frames = JSON.stringify([...first.states, ...second.states].map((state) => state.view));
		for (const secret of [...SECRETS, "visible line", "probe failed"]) expect(frames).not.toContain(secret);

		// Only the second observer asks, for the newest tool by default; the first observer stays unchanged.
		second.controller.submit("/evidence");
		await expect.poll(() => second.controller.state.evidence?.kind).toBe("found");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(first.controller.state.evidence).toBeUndefined();
		expect(second.controller.state.evidence).toMatchObject({ status: "failed", name: "probe" });
	});

	it("returns bounded redacted arguments, output and diff for a named call", async () => {
		const { observer } = await owner([
			fauxAssistantMessage(fauxToolCall("probe", { mode: "ok", apiKey: SECRETS[1] }, { id: "toolu_probe_ok_1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { controller } = await observer();
		controller.submit("run the probe");
		await expect.poll(() => controller.state.view?.entries.at(-1)?.text).toBe("done");
		controller.submit("/evidence toolu_probe");
		await expect.poll(() => controller.state.evidence?.kind).toBe("found");
		const evidence = controller.state.evidence;
		expect(evidence).toMatchObject({ kind: "found", callId: "toolu_probe_ok_1", status: "succeeded" });
		expect(JSON.stringify(evidence)).not.toMatch(new RegExp(SECRETS.join("|")));
		expect(JSON.stringify(evidence)).toContain("visible line");
		if (evidence?.kind !== "found") return;
		expect(evidence.arguments.redacted && evidence.output?.redacted && evidence.diff?.redacted).toBe(true);
		// /evidence close hides it again.
		controller.submit("/evidence close");
		expect(controller.state.evidence).toBeUndefined();
	});

	it("reports an unknown or too-short call ID without showing anything", async () => {
		const { observer } = await owner([fauxAssistantMessage([fauxText("done")])]);
		const { controller } = await observer();
		controller.submit("/evidence");
		expect(controller.state.notices.at(-1)?.text).toBe("No tool call to inspect yet.");
		controller.submit("/evidence nonexistent-call");
		await expect.poll(() => controller.state.evidence).toEqual({ kind: "unavailable", reason: "not-found" });
	});

	it("serves evidence over the administrator and operator sockets and validates the request", async () => {
		const { agent } = await owner([
			fauxAssistantMessage(fauxToolCall("probe", { mode: "ok" }, { id: "toolu_wire_probe_1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await agent.ask("run the probe", BACKGROUND_CONTEXT);
		const runtime = join(directory, "runtime");
		await mkdir(runtime);
		await chmod(runtime, 0o750);
		const path = join(directory, "private", "default.sock");
		const operatorPath = join(runtime, "default.sock");
		const stop = new AbortController();
		const ready = Promise.withResolvers<void>();
		const running = runService(agent, path, "fixture-version", () => ready.resolve(), stop.signal, null, operatorPath);
		void running.catch(() => {});
		cleanup.push(async () => {
			stop.abort();
			await running;
		});
		await ready.promise;
		for (const endpoint of [path, operatorPath]) {
			const response = await requestService(endpoint, { type: "tool-evidence", callId: "toolu_wire" }, AbortSignal.timeout(5_000));
			expect(response).toMatchObject({ type: "tool-evidence", evidence: { kind: "found", callId: "toolu_wire_probe_1" } });
			expect(JSON.stringify(response)).not.toContain(SECRETS[0]);
		}
		const invalid = await requestService(path, { type: "tool-evidence", callId: "" }, AbortSignal.timeout(5_000));
		expect(invalid).toEqual({ type: "error", message: "Tool call ID must contain 1 to 200 characters." });
		// sec-ipc Low 3: the request is closed; an extra key is refused, not ignored.
		const widened = { type: "tool-evidence", callId: "toolu_wire", scope: "all" } as unknown as Parameters<
			typeof requestService
		>[1];
		expect(await requestService(operatorPath, widened, AbortSignal.timeout(5_000))).toEqual({
			type: "error",
			message: "Tool evidence requests accept only a call ID.",
		});
	});

	it("drops an evidence reply that a newer request, /evidence close or a submitted prompt superseded (review L7)", async () => {
		const { agent, observer } = await owner([fauxAssistantMessage([fauxText("done")])]);
		const replies = new Map<string, PromiseWithResolvers<ToolEvidence>>();
		vi.spyOn(agent, "toolEvidence").mockImplementation((callId) => {
			const reply = Promise.withResolvers<ToolEvidence>();
			replies.set(callId, reply);
			return reply.promise;
		});
		const unavailable = (reason: "not-found" | "ambiguous"): ToolEvidence => ({ kind: "unavailable", reason });
		const { controller } = await observer();
		controller.submit("/evidence call-aaaaaa");
		controller.submit("/evidence call-bbbbbb");
		replies.get("call-bbbbbb")?.resolve(unavailable("ambiguous"));
		await expect.poll(() => controller.state.evidence).toEqual(unavailable("ambiguous"));
		replies.get("call-aaaaaa")?.resolve(unavailable("not-found"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(controller.state.evidence).toEqual(unavailable("ambiguous"));

		controller.submit("/evidence call-cccccc");
		controller.submit("/evidence close");
		replies.get("call-cccccc")?.resolve(unavailable("not-found"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(controller.state.evidence).toBeUndefined();

		controller.submit("/evidence call-dddddd");
		expect(controller.submit("hello").status).toBe("submitted");
		replies.get("call-dddddd")?.resolve(unavailable("not-found"));
		await expect.poll(() => controller.state.view?.entries.at(-1)?.text).toBe("done");
		expect(controller.state.evidence).toBeUndefined();
	});

	it("shows why a failed run ended to every observer", async () => {
		const { observer } = await owner([() => fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "provider exploded: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" })]);
		const first = await observer();
		const second = await observer();
		first.controller.submit("this will fail");
		await expect.poll(() => second.controller.state.view?.failure?.reason, { timeout: 15_000 }).toBeDefined();
		for (const { controller } of [first, second])
			expect(controller.state.view?.failure).toEqual({ reason: "model_error", problem: "unknown" });
		expect(JSON.stringify(second.states.map((state) => state.view))).not.toMatch(/ghp_|provider exploded/);
	});
});
