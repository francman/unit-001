// Shares mission command parsing and presentation across terminal and headless clients.
import { randomUUID } from "node:crypto";
import { sanitizeTerminalText } from "../render.ts";
import type { MissionView } from "./contract.ts";

export type MissionCommand =
	| { action: "status"; json: boolean }
	| { action: "setup" }
	| { action: "draft"; file: string; revision: number; requestId: string; json: boolean }
	| { action: "propose"; revision: number; requestId: string; json: boolean }
	| { action: "approve"; revision: number; digest: string; requestId: string; json: boolean }
	| { action: "creator"; file: string; json: boolean };

/** Parses the concrete mission client interface; only the primary owner session is supported. */
export function parseMissionCommand(args: readonly string[]): {
	command: MissionCommand;
	session: string;
	dataDir?: string;
} {
	const action = args[0] ?? "status";
	const values = new Map<string, string>();
	let json = false;
	for (let index = 1; index < args.length; index++) {
		const flag = args[index];
		if (flag === "--json") {
			if (json) throw new Error("Duplicate --json.");
			json = true;
			continue;
		}
		if (!["--file", "--revision", "--digest", "--request-id", "--session", "--data-dir"].includes(flag))
			throw new Error(`Unknown mission option: ${flag}`);
		const value = args[++index];
		if (!value || values.has(flag)) throw new Error(`Mission option ${flag} needs one value.`);
		values.set(flag, value);
	}
	const session = values.get("--session") ?? "default";
	if (session !== "default")
		throw new Error(
			"Mission formation belongs to the default owner session; other sessions remain available for ordinary work.",
		);
	const location = { session, ...(values.has("--data-dir") ? { dataDir: values.get("--data-dir") } : {}) };
	const unexpected = (allowed: readonly string[]) => {
		if ([...values.keys()].some((key) => !["--session", "--data-dir", ...allowed].includes(key)))
			throw new Error(`Unexpected ${action} mission option.`);
	};
	if (action === "status") {
		unexpected([]);
		return { command: { action, json }, ...location };
	}
	if (action === "setup") {
		unexpected([]);
		if (json) throw new Error("Mission setup requires a terminal, not --json.");
		return { command: { action }, ...location };
	}
	if (action === "creator") {
		unexpected(["--file"]);
		const file = values.get("--file");
		if (!file) throw new Error("Mission creator requires --file FILE.");
		return { command: { action, file, json }, ...location };
	}
	if (action !== "draft" && action !== "propose" && action !== "approve")
		throw new Error("Mission expects status, setup, draft, propose, creator or approve.");
	unexpected(
		action === "draft"
			? ["--file", "--revision", "--request-id"]
			: action === "approve"
				? ["--revision", "--digest", "--request-id"]
				: ["--revision", "--request-id"],
	);
	const revision = Number(values.get("--revision"));
	if (!values.has("--revision") || !Number.isSafeInteger(revision) || revision < 0)
		throw new Error("Mission change requires --revision N (0 for the first draft).");
	const requestId = values.get("--request-id") ?? randomUUID();
	if (!requestId.trim() || requestId.length > 200)
		throw new Error("Mission request ID must contain 1–200 characters.");
	if (action === "draft") {
		const file = values.get("--file");
		if (!file) throw new Error("Mission draft requires --file FILE.");
		return { command: { action, file, revision, requestId, json }, ...location };
	}
	if (action === "approve") {
		const digest = values.get("--digest");
		if (!digest || !/^[0-9a-f]{64}$/.test(digest))
			throw new Error("Mission approval requires the exact --digest SHA256.");
		return { command: { action, revision, digest, requestId, json }, ...location };
	}
	return { command: { action, revision, requestId, json }, ...location };
}

/** Presents a bounded, factual agreement summary without claiming autonomous execution. */
export function describeMission(view: MissionView): string {
	const draft = view.formation.draft;
	const agreement = view.formation.agreement;
	const terms = draft?.terms ?? agreement?.terms;
	const field = (value: string) => sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
	const lines = [
		`Mission: ${view.stage.replaceAll("_", " ")}. Execution is not implemented.`,
		`Authority: ${view.authority}${view.creator ? `; ${view.creator.kind} ${view.creator.id}` : "; creator not configured"}.`,
	];
	if (agreement)
		lines.push(
			`Agreement revision ${agreement.revision}: ${view.agreementValid ? "verified receipt" : "authority expired, changed or awaiting reconciliation"}.`,
		);
	if (view.authorityError) lines.push(`Authority error: ${field(view.authorityError)}`);
	if (draft)
		lines.push(`Draft revision ${draft.revision}: ${draft.status}.`, `Digest: ${draft.digest ?? "not proposed"}`);
	if (terms) {
		lines.push(`Goal: ${field(terms.objective ?? "not set")}`, `Scope: ${field(terms.scope ?? "not set")}`);
		lines.push(`Allowed tool actions: ${terms.policy?.allowedTools?.join(", ") || "none selected"}`);
		if (terms.successCriteria?.length) lines.push(`Success: ${terms.successCriteria.map(field).join("; ")}`);
		if (terms.approvalBoundary !== undefined)
			lines.push(
				`Approval boundary: ${terms.approvalBoundary.map(field).join("; ") || "no additional requested boundary"}`,
			);
		if (terms.policy)
			lines.push(
				`Limits: requests ${terms.policy.maxRequests ?? "unset"}, cycles ${terms.policy.maxCycles ?? "unset"}, retries ${terms.policy.maxRetries ?? "unset"}, no-progress ${terms.policy.maxConsecutiveNoProgress ?? "unset"}; deadline ${terms.policy.deadlineAt === undefined ? "unset" : Number.isNaN(new Date(terms.policy.deadlineAt).getTime()) ? "invalid" : new Date(terms.policy.deadlineAt).toISOString()}.`,
			);
		lines.push(`Review: ${terms.reviewEveryMs === undefined ? "unset" : `${terms.reviewEveryMs} ms`}.`);
	}
	if (draft && view.missing.length) lines.push(`Still needed: ${view.missing.join(", ")}.`);
	if (view.authority === "unconfigured")
		lines.push("An administrator must provision the creator and finite authority ceiling before approval.");
	return sanitizeTerminalText(lines.join("\n"));
}
