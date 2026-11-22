// Shares mission command parsing and presentation across terminal and headless clients.
import { randomUUID } from "node:crypto";
import { sanitizeTerminalText } from "../render.ts";
import type { MissionView } from "./contract.ts";
import type { MissionPurposeView } from "./purpose-view.ts";

export type MissionCommand =
	| { action: "status"; json: boolean }
	| { action: "setup" }
	| { action: "draft"; file: string; revision: number; requestId: string; json: boolean }
	| { action: "propose"; revision: number; requestId: string; json: boolean }
	| { action: "approve"; revision: number; digest: string; requestId: string; json: boolean }
	| { action: "start" | "pause" | "resume" | "stop"; policyRevision?: number; requestId: string; json: boolean }
	| { action: "creator"; file: string; json: boolean }
	| { action: "purpose"; file: string; revision: number; requestId: string; json: boolean }
	| { action: "approve-purpose"; revision: number; digest: string; requestId: string; json: boolean }
	| {
			action: "operate";
			operate: "open" | "suspend" | "close" | "acknowledge";
			operationRevision?: number;
			requestId: string;
			runId?: string;
			json: boolean;
	  };

const OPERATE_ACTIONS = ["open", "suspend", "close", "acknowledge"] as const;

/** Parses the concrete mission client interface; only the primary owner session is supported. */
export function parseMissionCommand(args: readonly string[]): {
	command: MissionCommand;
	session: string;
	dataDir?: string;
} {
	const action = args[0] ?? "status";
	const operate = action === "operate" ? OPERATE_ACTIONS.find((item) => item === args[1]) : undefined;
	if (action === "operate" && !operate) throw new Error("Mission operate expects open, suspend, close or acknowledge.");
	const values = new Map<string, string>();
	let json = false;
	for (let index = operate ? 2 : 1; index < args.length; index++) {
		const flag = args[index];
		if (flag === "--json") {
			if (json) throw new Error("Duplicate --json.");
			json = true;
			continue;
		}
		if (
			![
				"--file",
				"--revision",
				"--policy-revision",
				"--operation-revision",
				"--run",
				"--digest",
				"--request-id",
				"--session",
				"--data-dir",
			].includes(flag)
		)
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
	if (action === "start" || action === "pause" || action === "resume" || action === "stop") {
		unexpected(["--policy-revision", "--request-id"]);
		const policyRevision = values.has("--policy-revision") ? Number(values.get("--policy-revision")) : undefined;
		if (policyRevision !== undefined && (!Number.isSafeInteger(policyRevision) || policyRevision < 0))
			throw new Error("Mission policy revision must be a nonnegative integer.");
		if (values.has("--request-id") && policyRevision === undefined)
			throw new Error("An explicit lifecycle request ID requires --policy-revision N for safe retries.");
		const requestId = values.get("--request-id") ?? randomUUID();
		if (!requestId.trim() || Buffer.byteLength(requestId) > 200)
			throw new Error("Mission request ID must fit 200 bytes.");
		return {
			command: { action, ...(policyRevision === undefined ? {} : { policyRevision }), requestId, json },
			...location,
		};
	}
	if (operate) {
		unexpected(["--operation-revision", "--request-id", "--run"]);
		const operationRevision = values.has("--operation-revision")
			? Number(values.get("--operation-revision"))
			: undefined;
		if (operationRevision !== undefined && (!Number.isSafeInteger(operationRevision) || operationRevision < 0))
			throw new Error("Mission operation revision must be a nonnegative integer.");
		if (values.has("--request-id") && operationRevision === undefined)
			throw new Error("An explicit operation request ID requires --operation-revision N for safe retries.");
		if ((operate === "acknowledge") !== values.has("--run"))
			throw new Error("Acknowledge needs exactly one --run ID; other operation actions take none.");
		const requestId = values.get("--request-id") ?? randomUUID();
		if (!requestId.trim() || Buffer.byteLength(requestId) > 200)
			throw new Error("Mission request ID must fit 200 bytes.");
		return {
			command: {
				action: "operate",
				operate,
				...(operationRevision === undefined ? {} : { operationRevision }),
				requestId,
				...(values.has("--run") ? { runId: values.get("--run") } : {}),
				json,
			},
			...location,
		};
	}
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
	if (
		action !== "draft" &&
		action !== "propose" &&
		action !== "approve" &&
		action !== "purpose" &&
		action !== "approve-purpose"
	)
		throw new Error(
			"Mission expects status, setup, draft, propose, creator, approve, start, pause, resume, stop, purpose, approve-purpose or operate.",
		);
	unexpected(
		action === "draft" || action === "purpose"
			? ["--file", "--revision", "--request-id"]
			: action === "approve" || action === "approve-purpose"
				? ["--revision", "--digest", "--request-id"]
				: ["--revision", "--request-id"],
	);
	const revision = Number(values.get("--revision"));
	if (!values.has("--revision") || !Number.isSafeInteger(revision) || revision < 0)
		throw new Error("Mission change requires --revision N (0 for the first draft).");
	const requestId = values.get("--request-id") ?? randomUUID();
	if (!requestId.trim() || requestId.length > 200)
		throw new Error("Mission request ID must contain 1–200 characters.");
	if (action === "draft" || action === "purpose") {
		const file = values.get("--file");
		if (!file) throw new Error(`Mission ${action} requires --file FILE.`);
		return { command: { action, file, revision, requestId, json }, ...location };
	}
	if (action === "approve" || action === "approve-purpose") {
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
		`Mission: ${view.stage.replaceAll("_", " ")}. Execution: ${view.execution}.`,
		`Authority: ${view.authority}${view.creator ? `; ${view.creator.kind} ${view.creator.id}` : "; creator not configured"}.`,
	];
	if (agreement)
		lines.push(
			`Agreement revision ${agreement.revision}: ${view.agreementValid ? "verified receipt" : "authority expired, changed or awaiting reconciliation"}.`,
		);
	if (view.authorityError) lines.push(`Authority error: ${field(view.authorityError)}`);
	if (view.policyRevision !== undefined && !view.runtime) lines.push(`Policy revision ${view.policyRevision}.`);
	if (view.runtime) {
		const runtime = view.runtime;
		lines.push(
			`Policy revision ${runtime.policyRevision}; execution revision ${runtime.revision}.`,
			`Work: ${runtime.cycles} cycles, ${runtime.requests} request attempts, ${runtime.retries} retries, ${runtime.noProgress} consecutive steps without verified progress.`,
			`Estimated model cost: ${runtime.estimatedCost}; reserved: ${runtime.reservedCost}; unknown requests: ${runtime.unknownRequests}; unpriced responses: ${runtime.unpricedResponses}; uncertain tools: ${runtime.uncertainTools}.`,
		);
		if (runtime.blocker) lines.push(`Reason: ${field(runtime.blocker)}.`);
		if (runtime.nextWakeAt !== null) lines.push(`Next wake: ${new Date(runtime.nextWakeAt).toISOString()}.`);
		for (const item of runtime.evidence)
			lines.push(`${item.accepted ? "Verified" : "Unverified"}: ${field(item.criterion)}; ${field(item.detail)}`);
	}
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
	if (view.purpose && (view.purpose.revision !== null || view.purpose.proposed !== null))
		lines.push(...describePurpose(view.purpose, field));
	if (view.purposeError)
		lines.push(
			`Purpose records are invalid: ${field(view.purposeError)}`,
			"Continuous operation runs and admits nothing until they are repaired.",
		);
	if (view.loopRollback === "live-loop" && view.purpose?.rollback !== "live-loop")
		lines.push("Rollback: a loop task is still live.");
	if (view.authority === "unconfigured")
		lines.push("An administrator must provision the creator and finite authority ceiling before approval.");
	return sanitizeTerminalText(lines.join("\n"));
}

// Purpose revision, operation, activity, next wake, per-work result and lifetime use, one fact per line.
function describePurpose(purpose: MissionPurposeView, field: (value: string) => string): string[] {
	const lines = [
		`Purpose revision ${purpose.revision ?? "none agreed"}: ${field(purpose.purpose ?? "")}`.trimEnd(),
		`Operation: ${purpose.operation} (revision ${purpose.operationRevision}).`,
	];
	if (purpose.proposed)
		lines.push(`Proposed purpose revision ${purpose.proposed.revision}.`, `Purpose digest: ${purpose.proposed.digest}`);
	if (purpose.activity)
		lines.push(`Activity: ${purpose.activity}${purpose.reason ? ` (${field(purpose.reason)})` : ""}.`);
	if (purpose.nextWakeAt !== null) lines.push(`Next observation: ${new Date(purpose.nextWakeAt).toISOString()}.`);
	for (const work of purpose.works)
		lines.push(`${work.workId} ${field(work.path)}: ${work.result}${work.runId ? `; run ${field(work.runId)}` : ""}.`);
	for (const run of purpose.unsettled)
		lines.push(`Unsettled run ${field(run.runId)} (${run.workId} ${field(run.path)}): acknowledge it to continue.`);
	const used = purpose.used;
	const limits = purpose.limits;
	lines.push(
		`Lifetime: ${used.workItems}/${limits?.maxWorkItems ?? "-"} work, ${used.cycles}/${limits?.maxCycles ?? "-"} cycles, ${used.requests}/${limits?.maxRequests ?? "-"} requests.`,
		`Spend: estimated ${used.estimatedCost}; reserved ${used.reservedCost}; unknown requests ${used.unknownRequests}; unpriced ${used.unpricedResponses}.`,
	);
	if (purpose.rollback === "live-loop") lines.push("Rollback: close operation first (a loop is live).");
	return lines;
}
