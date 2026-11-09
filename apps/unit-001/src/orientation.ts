// Describes the host identity and exposes authoritative owner runtime facts.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { ModelChoice } from "./provider.ts";

export interface RuntimeFacts {
	readonly application: "unit-001";
	readonly name: string;
	readonly provider: string;
	readonly modelId: string;
	readonly pid: number;
	readonly startedAt: number;
	readonly uptimeMs: number;
	readonly observedAt: number;
}

/** Creates one owner's monotonic runtime clock; it is never reconstructed from shell or SSH timestamps. */
export function createRuntimeFacts(name: string, model: ModelChoice): () => RuntimeFacts {
	const startedAt = Math.floor(performance.timeOrigin);
	return () => ({
		application: "unit-001",
		name,
		provider: model.provider,
		modelId: model.modelId,
		pid: process.pid,
		startedAt,
		uptimeMs: Math.floor(performance.now()),
		observedAt: Date.now(),
	});
}

/** Keeps operator identity distinct from provider identity and supplies fresh process facts without model calls. */
export function orientationExtension(facts: () => RuntimeFacts): Extension {
	const identity = facts();
	return defineExtension({
		name: "unit-001",
		sections: [
			section(
				"preamble",
				() =>
					`You operate inside unit-001, the durable agent named ${identity.name}. The configured model is ${identity.provider}/${identity.modelId}; distinguish the host application and operator-given name from the underlying model or provider authentication identity. ` +
					"Conversation history and unfinished work persist in this session across restarts. Context may be compacted; do not claim all prior context is absent or that memory never persists. Structured memory is session-scoped and exposed by the memory tools; inspect it before claiming what is remembered. Separate transcript history, structured memory, and the current request. Autonomous mission scheduling is not implemented; do not claim an always-on mission loop is active. " +
					"Use unit_status for the current owner's identity, model, process start time and uptime. Its observedAt timestamp identifies when those facts were read; refresh historical tool results before answering a current-status question. Shell subprocess uptime, SSH login time and machine uptime do not establish agent uptime. Say when information is unavailable instead of guessing. Be concise and state what you changed or found.",
				{ tag: false },
			),
		],
		tools: [
			defineTool({
				name: "unit_status",
				description:
					"Read the unit-001 owner's actual identity, model, process start timestamp and elapsed uptime.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => ({ output: [{ type: "text", text: JSON.stringify(facts()) }] }),
			}),
		],
	});
}
