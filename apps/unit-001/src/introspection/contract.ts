// Defines bounded read-only introspection selectors and reports without accepting paths to private state.
import type { RuntimeFacts } from "../orientation.ts";
import type { ImplementationExcerpt } from "./files.ts";
import type { HostResources } from "./host.ts";

export const INSPECTION_SCOPES = ["runtime", "configuration", "tools", "channels", "mission", "tasks", "host"] as const;
export type InspectionQuery =
	| { scope: (typeof INSPECTION_SCOPES)[number] }
	| { scope: "file"; path: string; offset: number };
export type InspectionData =
	| { scope: "runtime"; facts: RuntimeFacts }
	| {
			scope: "configuration";
			model: RuntimeFacts;
			executionProfile: "trusted-operator-execution";
			codingTools: "owner-authority";
			environmentValues: "excluded";
			credentialContents: "excluded";
			securityAttestation: "not-provided";
	  }
	| { scope: "tools"; tools: readonly { name: string; health: "not-probed" }[]; truncated: boolean }
	| {
			scope: "channels";
			available: readonly string[];
			channels: readonly {
				id: string;
				adapter: string;
				state: string;
				observedAt: number | null;
				delivery: "unverified";
			}[];
	  }
	| {
			scope: "mission";
			mission: {
				stage: string;
				objective: string | null;
				scope: string | null;
				revision: number | null;
				agreementValid: boolean;
				execution: string;
				authority: string;
				missing: readonly string[];
			};
	  }
	| {
			scope: "tasks";
			scheduling: "paused" | "running" | "closing";
			active: number;
			queuedSubmissions: number;
			tasks: readonly { id: number; type: string; state: string; wakeAt: number | null }[];
			truncated: boolean;
	  }
	| { scope: "host"; facts: HostResources }
	| { scope: "file"; result: ImplementationExcerpt };
export type InspectionReport = {
	schemaVersion: 1;
	observedAt: number;
	access: "service-account-read-only";
	coverage: "selected-query-only";
	summary: string;
	data: InspectionData;
};

// Clients display the bounded payload as JSON; they never treat unvalidated nested data as authority or commands.
export type InspectionWireReport = Omit<InspectionReport, "data"> & { data: Record<string, unknown> };

/** Checks the closed display envelope at the socket boundary without claiming nested JSON is an authenticated fact. */
export function parseInspectionReport(value: unknown): InspectionWireReport {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid inspection report.");
	const report = value as Record<string, unknown>;
	if (
		report.schemaVersion !== 1 ||
		typeof report.observedAt !== "number" ||
		!Number.isSafeInteger(report.observedAt) ||
		report.observedAt < 0 ||
		report.observedAt > 8_640_000_000_000_000 ||
		report.access !== "service-account-read-only" ||
		report.coverage !== "selected-query-only" ||
		typeof report.summary !== "string" ||
		report.summary.length > 2048 ||
		typeof report.data !== "object" ||
		report.data === null ||
		Array.isArray(report.data) ||
		Buffer.byteLength(JSON.stringify(value)) > 32768
	)
		throw new Error("Invalid inspection report.");
	const data = report.data as Record<string, unknown>;
	if (data.scope !== "file" && !INSPECTION_SCOPES.some((scope) => scope === data.scope))
		throw new Error("Invalid inspection scope.");
	return {
		schemaVersion: 1,
		observedAt: report.observedAt,
		access: "service-account-read-only",
		coverage: "selected-query-only",
		summary: report.summary,
		data,
	};
}

/** Parses only closed selectors at the model and operator wire boundary; no query grants authority. */
export function parseInspectionQuery(value: unknown): InspectionQuery {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected an inspection query.");
	const input = value as Record<string, unknown>;
	if (input.scope === "file") {
		if (
			Object.keys(input).some((key) => !["scope", "path", "offset"].includes(key)) ||
			typeof input.path !== "string" ||
			input.path.length > 300
		)
			throw new Error("Invalid file inspection.");
		const offset = input.offset ?? 0;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
			throw new Error("Invalid file offset.");
		return { scope: "file", path: input.path, offset };
	}
	if (Object.keys(input).length !== 1 || !INSPECTION_SCOPES.some((scope) => scope === input.scope))
		throw new Error("Unknown inspection scope.");
	return { scope: input.scope as (typeof INSPECTION_SCOPES)[number] };
}
