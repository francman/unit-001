// Projects explicit owner facts without returning task inputs, raw configuration or credentials.
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { ChannelOwner } from "../channels/owner.ts";
import type { MissionControl } from "../missions/control.ts";
import type { RuntimeFacts } from "../orientation.ts";
import type { InspectionData, InspectionQuery, InspectionReport } from "./contract.ts";
import { implementationExcerpt } from "./files.ts";
import { hostResources } from "./host.ts";

export type InspectionHost = {
	harness: Harness;
	runtime: () => RuntimeFacts;
	mission: Pick<MissionControl, "inspect">;
	channels: ChannelOwner;
	tools: readonly string[];
	workspace: string;
	implementationRoot: string;
};

/** Collects one bounded read-only view of a query its ingress already parsed; registration and saved configuration never imply a healthy integration. */
export async function inspectAgent(
	query: InspectionQuery,
	host: InspectionHost,
	context: Context,
): Promise<InspectionReport> {
	let data: InspectionData;
	switch (query.scope) {
		case "runtime":
			data = { scope: "runtime", facts: host.runtime() };
			break;
		case "configuration":
			data = {
				scope: "configuration",
				model: host.runtime(),
				executionProfile: "trusted-operator-execution",
				codingTools: "owner-authority",
				environmentValues: "excluded",
				credentialContents: "excluded",
				securityAttestation: "not-provided",
			};
			break;
		case "tools":
			data = {
				scope: "tools",
				tools: host.tools.slice(0, 128).map((name) => ({ name: name.slice(0, 128), health: "not-probed" })),
				truncated: host.tools.length > 128,
			};
			break;
		case "channels": {
			const result = await host.channels.request({ operation: "status" }, context);
			if (result.operation !== "status") throw new Error("Unexpected channel inspection operation.");
			data = {
				scope: "channels",
				available: result.view.available.map((adapter) => adapter.id),
				channels: result.view.channels.slice(0, 16).map((channel) => ({
					id: channel.request.channelId,
					adapter: channel.request.adapter,
					state: channel.outcome.kind,
					observedAt: channel.lastHealth?.observedAt ?? null,
					delivery: "unverified",
				})),
			};
			break;
		}
		case "mission": {
			const result = await host.mission.inspect(context);
			const current = result.formation.agreement ?? result.formation.draft;
			data = {
				scope: "mission",
				mission: {
					stage: result.stage,
					objective: current?.terms.objective?.slice(0, 1024) ?? null,
					scope: current?.terms.scope?.slice(0, 1024) ?? null,
					revision: current?.revision ?? null,
					agreementValid: result.agreementValid,
					execution: result.execution,
					authority: result.authority,
					missing: result.missing.slice(0, 32),
				},
			};
			break;
		}
		case "tasks": {
			const work = await host.harness.inspect(context);
			data = {
				scope: "tasks",
				scheduling: work.scheduling,
				active: work.tasks.length,
				queuedSubmissions: work.submissions.length,
				tasks: work.tasks.slice(0, 64).map((task) => ({
					id: task.record.id,
					type: task.record.kind.slice(0, 128),
					state: task.state.kind,
					wakeAt: task.state.kind === "sleeping" ? task.state.until : null,
				})),
				truncated: work.tasks.length > 64,
			};
			break;
		}
		case "host":
			data = { scope: "host", facts: await hostResources(host.workspace) };
			break;
		case "file":
			data = {
				scope: "file",
				result: await implementationExcerpt(host.implementationRoot, query.path, query.offset),
			};
			break;
	}
	const report: InspectionReport = {
		schemaVersion: 1,
		observedAt: Date.now(),
		access: "service-account-read-only",
		coverage: "selected-query-only",
		summary: describeData(data).slice(0, 1900),
		data,
	};
	if (Buffer.byteLength(JSON.stringify(report)) > 32768)
		throw new Error("Inspection exceeds its 32 KiB report bound; choose a narrower query.");
	return report;
}

function describeData(data: InspectionData): string {
	switch (data.scope) {
		case "runtime":
			return `${data.facts.name}: PID ${data.facts.pid}; uptime ${Math.floor(data.facts.uptimeMs / 1000)}s; ${data.facts.configuration === "configured" ? `${data.facts.provider}/${data.facts.modelId}` : "provider unconfigured"}.`;
		case "configuration":
			return `Trusted operator execution; coding tools run with owner authority. Credential contents and environment values are excluded. Configuration is not a security attestation. Model: ${data.model.provider ?? "unconfigured"}/${data.model.modelId ?? "unconfigured"}.`;
		case "tools":
			return `Registered tools: ${data.tools.map((tool) => tool.name).join(", ")}. Registration does not establish health; tools were not probed.${data.truncated ? " List truncated; inspect the selected registry in source." : ""}`;
		case "channels":
			return `Available adapters: ${data.available.join(", ") || "none"}. Channels: ${data.channels.map((channel) => `${channel.id}: ${channel.state}`).join("; ") || "none"}. Ready verifies setup identity, not message delivery.`;
		case "mission":
			return `Mission: ${data.mission.stage}; verified agreement: ${data.mission.agreementValid ? "yes" : "no"}; execution: ${data.mission.execution}. Objective: ${(data.mission.objective ?? "unset").slice(0, 500)}.`;
		case "tasks":
			return `Scheduler: ${data.scheduling}; ${data.active} active tasks; ${data.queuedSubmissions} queued/placed submissions. ${data.tasks
				.slice(0, 8)
				.map(
					(task) =>
						`#${task.id} ${task.type}: ${task.state}${task.wakeAt === null ? "" : ` until scheduler clock ${task.wakeAt}ms`}`,
				)
				.join(
					"; ",
				)}${data.truncated || data.tasks.length > 8 ? " More tasks in JSON output." : ""} Task inputs and errors are excluded.`;
		case "host":
			return `Owner PID ${data.facts.process.pid}, UID ${data.facts.process.uid ?? "unavailable"}, ${data.facts.process.node}/${data.facts.process.architecture}; RSS ${(data.facts.process.rssBytes / 1048576).toFixed(1)} MiB; heap ${(data.facts.process.heapUsedBytes / 1048576).toFixed(1)} MiB. System: ${data.facts.system.availableParallelism} available CPUs; ${(data.facts.system.freeMemoryBytes / 1048576).toFixed(1)} MiB free of ${(data.facts.system.totalMemoryBytes / 1048576).toFixed(1)} MiB visible memory. Container memory limit is unobserved. Workspace disk: ${data.facts.filesystem.kind === "available" ? `${data.facts.filesystem.availableBytes} bytes available` : "unavailable"}. Scope: current process namespace.`;
		case "file":
			return data.result.kind === "available"
				? `${data.result.path}, sanitized offset ${data.result.offset}, ${data.result.totalBytes} bytes total${data.result.nextOffset === null ? "" : `; next offset ${data.result.nextOffset}`}.\n${data.result.text.slice(0, 700)}${data.result.text.length > 700 ? "\nTerminal preview truncated; use inspect file --json for this excerpt." : ""}`
				: `Implementation file ${data.result.path}: unavailable (${data.result.reason}).`;
	}
}
