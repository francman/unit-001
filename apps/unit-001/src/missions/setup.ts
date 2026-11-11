// Guides saved mission drafting through the existing native setup editor; approval remains a separate authority action.
import { randomUUID } from "node:crypto";
import type { Terminal } from "../repl.ts";
import { SetupBack, SetupCancelled, SetupUI } from "../setup-ui.ts";
import type { MissionDraftTerms, MissionRequest, MissionView } from "./contract.ts";

type Field =
	| { kind: "text"; key: "objective" | "scope"; label: string; hint: string }
	| { kind: "list"; key: "successCriteria" | "approvalBoundary"; label: string; hint: string }
	| {
			kind: "limit";
			key: "maxCycles" | "maxRequests" | "maxRetries" | "maxConsecutiveNoProgress" | "maxEstimatedCost";
			label: string;
			hint: string;
	  }
	| { kind: "tools" | "deadline" | "cadence"; key: string; label: string; hint: string };

const FIELDS: readonly Field[] = [
	{ kind: "text", key: "objective", label: "Goal", hint: "What outcome should your agent work toward?" },
	{
		kind: "text",
		key: "scope",
		label: "Scope",
		hint: "Describe the intended scope. Prose does not create tool or filesystem permissions.",
	},
	{
		kind: "list",
		key: "successCriteria",
		label: "Success criteria",
		hint: "Separate concrete evidence requirements with |.",
	},
	{
		kind: "tools",
		key: "tools",
		label: "Allowed tool actions",
		hint: "Comma-separated registered tool names; an empty list grants no actions.",
	},
	{ kind: "limit", key: "maxCycles", label: "Maximum cycles", hint: "An explicit positive integer is required." },
	{
		kind: "limit",
		key: "maxRequests",
		label: "Maximum model requests",
		hint: "An explicit positive integer is required; no allowance is inferred.",
	},
	{
		kind: "limit",
		key: "maxRetries",
		label: "Maximum retries",
		hint: "Enter a nonnegative integer; zero means no retries.",
	},
	{
		kind: "limit",
		key: "maxConsecutiveNoProgress",
		label: "No-progress limit",
		hint: "Maximum consecutive cycles without progress; enter a positive integer.",
	},
	{ kind: "deadline", key: "deadline", label: "Deadline", hint: "Enter an ISO timestamp or epoch milliseconds." },
	{
		kind: "limit",
		key: "maxEstimatedCost",
		label: "Estimated spend limit",
		hint: "Optional positive USD estimate. This is not a provider billing cap.",
	},
	{
		kind: "list",
		key: "approvalBoundary",
		label: "Approval boundary",
		hint: "Separate requested approval exceptions with |. Tool scope still needs administrator approval.",
	},
	{ kind: "cadence", key: "cadence", label: "Review cadence", hint: "Enter a positive interval in milliseconds." },
];

/** Saves each submitted field so cancellation and restart reopen the exact draft without starting execution. */
export async function runMissionSetup(
	terminal: Terminal,
	name: string,
	request: (input: MissionRequest) => Promise<MissionView>,
	signal: AbortSignal,
	color: boolean,
): Promise<number> {
	if (!terminal.output) throw new Error("Mission setup requires an interactive terminal.");
	const ui = new SetupUI(terminal, name, color);
	let notice = "Each submitted field is saved. Drafting does not approve or start work.";
	try {
		let view = await request({ operation: "status" });
		for (;;) {
			const choice = await ui.choose(
				{
					flow: "mission",
					totalSteps: 2,
					step: 1,
					title: "Form your mission",
					description: notice,
					detail: [`State: ${view.stage.replaceAll("_", " ")}`, "Execution: not implemented."],
				},
				[
					...FIELDS.map((field) => ({ id: field.key, label: field.label })),
					{
						id: "propose",
						label: "Propose exact saved terms",
						description: "Requires a configured creator and finite authority ceiling",
					},
					{ id: "done", label: "Save and return", description: "Approval is a separate administrator action" },
				],
				undefined,
				signal,
			);
			if (choice === "done") return 0;
			try {
				if (choice === "propose") {
					const revision = view.formation.draft?.revision;
					if (revision === undefined) throw new Error("Save a draft field before proposing a mission.");
					view = await request({ operation: "propose", expectedRevision: revision, requestId: randomUUID() });
					notice = `Proposal saved at revision ${revision}. Review its digest with ${name} mission status; approval requires its configured authority.`;
					continue;
				}
				const field = FIELDS.find((field) => field.key === choice)!;
				const current = view.formation.draft?.terms ?? view.formation.agreement?.terms ?? {};
				let value = "";
				if (field.kind === "text") value = current[field.key] ?? "";
				else if (field.kind === "list") value = current[field.key]?.join(" | ") ?? "";
				else if (field.kind === "limit") value = current.policy?.[field.key]?.toString() ?? "";
				else if (field.kind === "tools") value = current.policy?.allowedTools?.join(", ") ?? "";
				else if (field.kind === "cadence") value = current.reviewEveryMs?.toString() ?? "";
				else value = current.policy?.deadlineAt === undefined ? "" : String(current.policy.deadlineAt);
				const answer = await ui.text(
					{
						flow: "mission",
						totalSteps: 2,
						step: 2,
						title: field.label,
						fieldLabel: field.label,
						description: field.hint,
						...(field.kind === "tools" ? { detail: [`Registered: ${view.tools.join(", ")}`] } : {}),
					},
					value,
					signal,
				);
				const terms: MissionDraftTerms = {
					...current,
					...(current.policy === undefined ? {} : { policy: { ...current.policy } }),
				};
				if (field.kind === "text") terms[field.key] = answer;
				else if (field.kind === "list")
					terms[field.key] = answer
						.split("|")
						.map((value) => value.trim())
						.filter(Boolean);
				else if (field.kind === "cadence") {
					if (answer === "") delete terms.reviewEveryMs;
					else terms.reviewEveryMs = Number(answer);
				} else {
					terms.policy ??= {};
					if (field.kind === "tools")
						terms.policy.allowedTools = answer
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean);
					else if (field.kind === "limit") {
						if (answer === "") delete terms.policy[field.key];
						else terms.policy[field.key] = Number(answer);
					} else if (answer === "") delete terms.policy.deadlineAt;
					else terms.policy.deadlineAt = /^\d+$/.test(answer) ? Number(answer) : Date.parse(answer);
				}
				view = await request({
					operation: "draft",
					expectedRevision: view.formation.draft?.revision ?? view.formation.agreement?.revision ?? 0,
					requestId: randomUUID(),
					terms,
				});
				notice = `${field.label} saved in draft revision ${view.formation.draft!.revision}. ${view.missing.length ? `${view.missing.length} required fields remain.` : "Ready to propose; no execution is enabled."}`;
			} catch (error) {
				if (error instanceof SetupBack) continue;
				if (error instanceof SetupCancelled || signal.aborted) throw error;
				notice = error instanceof Error ? error.message : String(error);
			}
		}
	} catch (error) {
		if (error instanceof SetupBack || error instanceof SetupCancelled || signal.aborted) {
			terminal.err("Mission setup closed; submitted fields remain saved.\n");
			return 130;
		}
		throw error;
	} finally {
		await ui.close();
	}
}
