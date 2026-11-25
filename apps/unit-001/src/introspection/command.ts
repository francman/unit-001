// Parses deterministic inspection operands for both terminal and CLI surfaces.
import {
	INSPECTION_SCOPES,
	type InspectionQuery,
	type InspectionWireReport,
	parseInspectionQuery,
} from "./contract.ts";

/** Resolves explicit selectors without probabilistic inference or an arbitrary filesystem path. */
export function inspectionCommand(scope = "runtime", path?: string, offset = 0): InspectionQuery {
	if (scope === "file") return parseInspectionQuery({ scope, path, offset });
	const selected = INSPECTION_SCOPES.find((value) => value === scope);
	// Checked here rather than by parseInspectionQuery so an operator typo gets the usage text.
	if (path !== undefined || offset !== 0 || selected === undefined)
		throw new Error(
			"Usage: inspect runtime|configuration|tools|channels|mission|tasks|host, or inspect file PATH [--offset N].",
		);
	return { scope: selected };
}

/** Labels a bounded owner summary with the observation time and its explicitly limited coverage. */
export function describeInspection(report: InspectionWireReport): string {
	return `${report.summary}\nObserved ${new Date(report.observedAt).toISOString()}; service-account read-only access; only this selected query was inspected.`;
}

/** Parses explicit slash-command operands; file offsets are positional bytes of the sanitized view. */
export function inspectionText(text: string): InspectionQuery {
	const operands = text
		.replace(/^\/?inspect\b/, "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (operands.length > 3 || (operands[2] !== undefined && !/^[0-9]+$/.test(operands[2])))
		throw new Error("Usage: /inspect SCOPE or /inspect file PATH [OFFSET].");
	return inspectionCommand(operands[0], operands[1], operands[2] === undefined ? 0 : Number(operands[2]));
}
