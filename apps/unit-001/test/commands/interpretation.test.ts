// Verifies command inference gates, bounded public model requests and untrusted response rejection.
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { interpretCommand, parseCommandInterpretation } from "../../src/commands/interpretation.ts";

const choice = { provider: "faux", modelId: "faux-1" };
const signal = new AbortController().signal;

function configured() {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	return { models, faux };
}

describe("bounded command interpretation", () => {
	it.each(["/", "/Users/me/private.md", "/sk-private-secret", "/ "])(
		"keeps non-command input local: %s (#59)",
		async (input) => {
			const { models, faux } = configured();
			expect((await interpretCommand(input, "cli", models, choice, signal)).stage).not.toBe("model");
			expect(faux.state.callCount).toBe(0);
		},
	);
	it("never calls a model for exact aliases or local spelling/semantic matches (#59)", async () => {
		const { models, faux } = configured();
		for (const input of ["brain", "memroy", "memories", "status"])
			expect((await interpretCommand(input, "cli", models, choice, signal)).stage).toBe("local");
		expect(faux.state.callCount).toBe(0);
	});

	it("never calls a model before setup or without actual auth readiness (#59)", async () => {
		const { models, faux } = configured();
		expect((await interpretCommand("xyzzy", "cli", models, null, signal)).stage).toBe("unavailable");
		models.checkAuth = async () => undefined;
		expect((await interpretCommand("xyzzy", "cli", models, choice, signal)).stage).toBe("unavailable");
		expect(faux.state.callCount).toBe(0);
	});

	it("makes exactly one tool-free request with a bounded catalog and returns IDs only (#59)", async () => {
		const { models, faux } = configured();
		let prompt = "";
		faux.setResponses([
			(context, options) => {
				prompt = JSON.stringify(context);
				expect(options).toMatchObject({ maxTokens: 192, maxRetries: 0, timeoutMs: 8000, toolChoice: "none" });
				return fauxAssistantMessage(fauxText('{"commandIds":["status"],"explanation":"Inspect the owner"}'));
			},
		]);
		const result = await interpretCommand("xyzzy private-file", "cli", models, choice, signal);
		expect(result).toMatchObject({ stage: "model", commandIds: ["status"], usage: { cost: { kind: "unknown" } } });
		expect(faux.state.callCount).toBe(1);
		expect(prompt.length).toBeLessThan(5000);
		expect(prompt).not.toContain("private-file");
		expect(prompt).not.toContain('"tools"');
	});

	it("stops at auth failure or cancellation without a provider request (#59)", async () => {
		const { models, faux } = configured();
		models.checkAuth = async () => {
			throw new Error("Auth unavailable");
		};
		expect((await interpretCommand("xyzzy", "cli", models, choice, signal)).stage).toBe("unavailable");
		const cancelled = new AbortController();
		cancelled.abort();
		expect((await interpretCommand("xyzzy", "cli", models, choice, cancelled.signal)).stage).toBe("unavailable");
		expect(faux.state.callCount).toBe(0);
	});

	it.each([
		{ stage: "execute", commandIds: ["status"], explanation: "", usage: null },
		{ stage: "model", commandIds: ["shell"], explanation: "", usage: null },
		{ stage: "model", commandIds: ["status"], explanation: "\u001b[2J", usage: null },
		{ stage: "model", commandIds: ["status"], explanation: "\u202eSpoof", usage: null },
		{ stage: "model", commandIds: [], explanation: "", usage: { observedAt: -1 } },
	])("rejects malformed owner suggestion frames (#59)", (frame) => {
		expect(() => parseCommandInterpretation(frame)).toThrow();
	});

	it.each([
		fauxAssistantMessage(fauxText("not JSON")),
		fauxAssistantMessage(fauxText('{"commandIds":["rm -rf /"],"explanation":"execute"}')),
		fauxAssistantMessage(fauxText('{"commandIds":["status"],"explanation":null}')),
		fauxAssistantMessage(fauxText('{"commandIds":["status"],"explanation":"\u202eSpoof"}')),
		fauxAssistantMessage(fauxToolCall("bash", { command: "touch /tmp/never" }), { stopReason: "toolUse" }),
	])("rejects malformed or executable model output without retry (#59)", async (response) => {
		const { models, faux } = configured();
		faux.setResponses([response]);
		const result = await interpretCommand("xyzzy", "cli", models, choice, signal);
		expect(result.commandIds).toEqual([]);
		expect(faux.state.callCount).toBe(1);
	});
});
