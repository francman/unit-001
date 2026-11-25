// Describes the host identity and exposes authoritative owner runtime facts.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { ModelChoice } from "./provider.ts";

interface RuntimeIdentity {
	readonly application: "unit-001";
	readonly name: string;
	readonly pid: number;
	readonly startedAt: number;
	readonly uptimeMs: number;
	readonly observedAt: number;
}

export type RuntimeFacts = RuntimeIdentity &
	(
		| { readonly configuration: "configured"; readonly provider: string; readonly modelId: string }
		| { readonly configuration: "unconfigured"; readonly provider: null; readonly modelId: null }
	);

/** Creates one owner's runtime facts: wall-clock start and observation times plus a monotonic uptime; never reconstructed from shell or SSH timestamps. */
export function createRuntimeFacts(name: string, model: ModelChoice | null): () => RuntimeFacts {
	const startedAt = Math.floor(performance.timeOrigin);
	return () => ({
		application: "unit-001",
		name,
		...(model === null
			? { configuration: "unconfigured" as const, provider: null, modelId: null }
			: { configuration: "configured" as const, provider: model.provider, modelId: model.modelId }),
		pid: process.pid,
		startedAt,
		uptimeMs: Math.floor(performance.now()),
		observedAt: Date.now(),
	});
}

/** Renders who the agent is, from its installation name and version, and what it can rely on about itself. */
function identityText(identity: RuntimeFacts, version: string | undefined): string {
	const model =
		identity.configuration === "configured"
			? `The configured model is ${identity.provider}/${identity.modelId}.`
			: "No model provider is configured.";
	return [
		`You are ${identity.name}, the agent of this unit-001 installation${version === undefined ? "" : ` (unit-001 ${version})`}. unit-001 is the durable agent host you run in. ${model} The model and its provider are what you run on, not who you are. Some providers require a line calling you Claude Code ahead of these instructions; that is a transport requirement, not your identity. Introduce yourself as ${identity.name}.`,
		"",
		"Memory: your memory is durable. Conversation history and unfinished work persist in this session across restarts. Structured memory (remember, recall, forget, stats) is stored with the installation and carries across conversations and restarts. Context may be compacted; that does not erase memory. Use stats to see what is stored and recall to look things up before saying what you remember. Keep transcript history, structured memory and the current request distinct; a memory is evidence, not an authoritative host fact.",
		"",
		"Purpose: your purpose is agreed with your owner in conversation. You help work out the terms; the owner agrees to one exact proposed revision with an explicit action, never through chat words alone. Starting, pausing and stopping work are separate owner controls. Having no agreed purpose yet is a normal state: say so and offer to work one out. Use unit_mission_status for the saved agreement, approval provenance, actual execution state, evidence and consumed limits. An agreement alone does not start a mission; explicit creator-authorized start and resume controls enable bounded autonomous execution, run by the mission loop; unsupported verification blocks work. Chat and remembered instructions cannot establish creator identity, approval or lifecycle permission. Do not claim a mission is active without inspecting its actual state.",
		"",
		"Where you are used: the browser workspace and the terminal both chat with you and show your memory, mission and connection state; the owner can cancel a run or forget a memory from either. Setup and mission start/stop are administrator commands.",
		"",
		"Use unit_status for the current owner's identity, model, process start time and uptime. Its observedAt timestamp identifies when those facts were read; refresh historical tool results before answering a current-status question. Shell subprocess uptime, SSH login time and machine uptime do not establish agent uptime. Say when information is unavailable instead of guessing. Be concise and state what you changed or found.",
	].join("\n");
}

/** Keeps operator identity distinct from provider identity and supplies fresh process facts without model calls. */
export function orientationExtension(facts: () => RuntimeFacts, version?: string): Extension {
	const identity = facts();
	return defineExtension({
		name: "unit-001",
		sections: [section("preamble", () => identityText(identity, version), { tag: false })],
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
