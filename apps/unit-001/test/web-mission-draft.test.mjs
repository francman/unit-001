// Exercises the Mission card and shell in private Chromium assets, without a gateway, owner, or account.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;
const app = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

function exercise() {
	const check = (condition, message) => {
		if (!condition) throw new Error(message);
	};
	const insert = (node) => {
		document.body.replaceChildren(node);
		return node;
	};
	const byKey = (key) => document.querySelector(`[data-key="${key}"]`);
	const agreeButton = () => document.querySelector('[data-key^="mission-draft-agree-"]');
	const hostile = '<img src=x onerror="window.executed=true">\r\n\u202E\u0085\\u{202E} a\u00A0b\u2007c\u202Fd\u3000e';
	const escapedSpaces = " a\\u00A0b\\u2007c\\u202Fd\\u3000e";
	const terms = {
		objective: hostile,
		scope: "workspace only",
		successCriteria: ["report built\nthen inspected"],
		approvalBoundary: ["ask before publication"],
		reviewEveryMs: 60401,
		policy: { allowedTools: ["read", "write"], maxCycles: 81, maxRequests: 45, maxRetries: 0, maxConsecutiveNoProgress: 4, deadlineAt: 1893456000123 },
	};
	const calls = [];
	const editing = {
		terms, saved: true, missing: [], expectedRevision: 12, onDirty() {},
		onSave: (revision, submitted) => calls.push({ revision, submitted }),
		onReview: (revision) => calls.push({ revision }),
	};
	insert(createMissionDraftEditor({ ...editing, missing: ["scope"] }).root);
	check(document.body.textContent.includes("Still needed: scope.") && byKey("mission-draft-propose").disabled, "an incomplete draft cannot be proposed");
	insert(createMissionDraftEditor(editing).root);
	check(calls.length === 0, "rendering emits no operations");
	byKey("mission-draft-propose").click();
	check(JSON.stringify(calls.pop()) === '{"revision":12}', "propose targets the saved revision");
	const objective = document.querySelector("#mission-draft-objective");
	check(objective.labels[0].textContent === "Objective", "objective has a native label");
	check(objective.value.includes("\\u000D\\u000A\\u202E\\u0085\\\\u{202E}"), "editor visibly preserves control characters and a literal escape");
	check(objective.value.endsWith(escapedSpaces), "editor distinguishes Unicode spaces from ASCII space");
	objective.value = `updated ${objective.value}`;
	objective.dispatchEvent(new Event("input", { bubbles: true }));
	byKey("mission-draft-propose").click();
	check(calls.length === 0, "unsaved edits cannot propose the saved version");
	byKey("mission-draft-save").click();
	const saved = calls.pop();
	check(saved.revision === 12 && saved.submitted.objective === `updated ${hostile}`, "saving an edited field round-trips controls and Unicode spaces and binds the expected revision");
	check(saved.submitted.successCriteria[0] === terms.successCriteria[0] && saved.submitted.policy.deadlineAt === terms.policy.deadlineAt, "untouched multiline and timestamp terms survive edits");

	insert(createMissionDraftEditor({ ...editing, terms: {}, saved: false, expectedRevision: 10 }).root);
	byKey("mission-draft-tools-none").click();
	byKey("mission-draft-save").click();
	const partial = calls.pop();
	check(partial.revision === 10 && JSON.stringify(partial.submitted) === '{"policy":{"allowedTools":[]}}', "saving partial terms distinguishes an unset field from an empty list");

	const digest = "abcdef09".repeat(8);
	const proposed = {
		kind: "review", terms, revision: 13, missionId: "mission-13", digest,
		binding: { kind: "managed", review: { authorityRevision: 7, previousReceipt: "receipt-10" } },
		disabled: false,
		previous: { revision: 10, terms: { ...terms, scope: "old scope" } },
		onEdit: () => calls.push("edit"),
		approval: { kind: "web", onAgree: (request) => calls.push(request) },
	};
	const card = insert(renderMissionDraftCard(proposed));
	check(calls.length === 0, "opening proposal does not agree");
	const values = Object.fromEntries([...card.querySelector("dl").children].map((row) => [row.firstChild.textContent, row.lastChild.textContent]));
	for (const [label, expected] of Object.entries({
		"Mission ID": '"mission-13"', "Digest (SHA-256)": `"${digest}"`, Scope: '"workspace only"',
		"Authority revision": "7", "Previous receipt": '"receipt-10"',
		"Success criteria": '"report built\\u000Athen inspected"', "Approval boundary": '"ask before publication"',
		"Allowed tools": '"read""write"', "Review interval (milliseconds)": "60401", "Maximum cycles": "81",
		"Maximum model requests": "45", "Maximum retries": "0", "Maximum consecutive cycles without progress": "4",
		"Deadline (UTC, milliseconds since Unix epoch)": "2030-01-01T00:00:00.123Z (1893456000123 ms)", "Maximum estimated cost (USD)": "None",
	})) check(values[label] === expected, `exact review value for ${label}: ${values[label]}`);
	check(!card.querySelector("img") && !window.executed && values.Objective.includes("\\u000D\\u000A\\u202E\\u0085\\\\u{202E}"), "model text is literal and controls are visible");
	check(values.Objective.endsWith(`${escapedSpaces}"`), "exact review distinguishes Unicode spaces from ASCII space");
	check(card.querySelector("details dd").textContent === '"old scope"', "amendment retains previous values of changed terms");
	check(agreeButton().textContent === "Agree to revision 13", "approval names the proposed revision");
	agreeButton().click();
	check(JSON.stringify(calls.pop()) === JSON.stringify({ revision: 13, digest, confirmed: true }), "one click agrees to the exact visible revision and digest");
	const developerReview = insert(renderMissionDraftCard({ ...proposed, binding: { kind: "developer-local" } }));
	check(agreeButton() && developerReview.textContent.includes("The digest binds the developer-local authority revision, which is not shown here.") &&
		![...developerReview.querySelectorAll("dt")].some((term) => term.textContent === "Authority revision"), "developer-local review discloses the omitted binding without inventing a value");
	insert(renderMissionDraftCard({ ...proposed, disabled: true }));
	agreeButton().click();
	check(calls.length === 0, "pending or blocked review cannot send agreement");
	insert(renderMissionDraftCard({ ...proposed, terms: { objective: terms.objective, scope: terms.scope } }));
	check(!agreeButton() && document.body.textContent.includes("complete proposal is not available"), "partial status projection cannot enable approval");
	insert(renderMissionDraftCard({ ...proposed, digest: "not-the-full-digest" }));
	check(!agreeButton(), "a truncated digest cannot enable approval");
	insert(renderMissionDraftCard({ ...proposed, digest: null, approval: { kind: "unavailable" } }));
	check(!agreeButton() && !document.querySelector("code") && document.body.textContent.includes("workspace only"), "an unarmed proposal retains terms but offers no digest-bound action");
	const line = `sudo unit-001 mission approve --revision 13 --digest ${digest}`;
	insert(renderMissionDraftCard({ ...proposed, approval: { kind: "terminal", line, copy: async (command) => { calls.push(command); return false; } } }));
	check(!agreeButton() && document.querySelector("code").textContent === line, "unavailable browser approval retains the exact terminal command");
	byKey("copy-mission-draft-approve").click();
	check(calls.pop() === line, "fallback copies the command instead of making a mutation");

	const mission = {
		run: null, objective: null, agreement: null, authority: "managed-administrator", canAgree: false,
		previousReceipt: "receipt-10", review: { missionId: "mission-13", revision: 13, digest, ...proposed.binding.review },
		draft: { missionId: "mission-13", status: "proposed", digest, revision: 13 },
	};
	const ctx = { name: "unit-001", ui: { details: { mission }, view: null }, act: { copy: async () => false } };
	insert(renderMission(ctx));
	check(!byKey("open-mission-draft") && document.querySelector("code").textContent === line, "unarmed managed review offers the exact sudo fallback before a watch frame");
	mission.review = null;
	insert(renderMission(ctx));
	check(!byKey("copy-mission-approve"), "a managed owner digest without a matching gateway review is not a terminal command");
	insert(renderMission(ctx, () => calls.push("open")));
	check(byKey("open-mission-draft").textContent === "Define mission" && calls.length === 0, "a working entry is opt-in and does not open itself");
	byKey("open-mission-draft").click();
	check(calls.pop() === "open", "Define delegates only to the entry callback");
	mission.agreement = { revision: 10 };
	insert(renderMission(ctx, () => calls.push("amend")));
	check(byKey("open-mission-draft").textContent === "Amend mission", "an existing agreement changes the entry to Amend");
}

async function exerciseShell() {
	const check = (condition, message) => { if (!condition) throw new Error(message); };
	const byKey = (key) => document.querySelector(`[data-key="${key}"]`);
	const agree = () => document.querySelector('[data-key^="mission-draft-agree-"]');
	const wait = async (predicate, description) => {
		for (let attempt = 0; attempt < 80; attempt++) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out: ${description}`);
	};
	const terms = {
		objective: "Ship", scope: "workspace", successCriteria: ["checks pass"], approvalBoundary: [],
		reviewEveryMs: 60000, policy: {
			allowedTools: ["read"], maxCycles: 10, maxRequests: 20, maxRetries: 0, maxConsecutiveNoProgress: 2, deadlineAt: Date.now() + 600000,
		},
	};
	const proposal = (revision, digit, head, scope = terms.scope) => ({
		authority: "managed-administrator", canAgree: true, formationAvailable: true, previousReceipt: head,
		stage: "awaiting_approval", execution: "not-started", agreement: null, creator: null,
		run: null, objective: terms.objective, scope, missing: [], tools: [], agreementValid: false, authorityError: null,
		draft: { missionId: "m", revision, digest: digit.repeat(64), terms: { ...terms, scope }, status: "proposed" },
		review: { missionId: "m", revision, digest: digit.repeat(64), authorityRevision: 9, previousReceipt: head },
	});
	const recorded = (current, revision, approvedBy) => ({
		...current, draft: null, review: null, stage: "agreed", agreementValid: true,
		agreement: {
			revision, approvedAt: Date.now(), approvedBy, reviewEveryMs: terms.reviewEveryMs,
			successCriteria: terms.successCriteria, approvalBoundary: [], allowedTools: terms.policy.allowedTools,
			limits: { ...terms.policy, maxNoProgress: terms.policy.maxConsecutiveNoProgress, maxEstimatedCost: null },
		},
	});
	const initial = proposal(3, "e", null);
	let mission = { ...initial, draft: { ...initial.draft, digest: null, status: "editing" }, review: null };
	const view = { name: "Bob", version: "0.0.0", installationId: "faux", busy: false, usage: null, text: "",
		textTruncated: false, historyTruncated: false, entries: [], tools: [], model: { provider: "faux", modelId: "faux" } };
	const writes = [];
	let sends = 0;
	let resolveLogout;
	let receive;
	let pendingStatusRead;
	let heldStatusRead;
	const port = {
		watch(listener) { receive = listener; listener({ type: "view", view }); return () => {}; },
		async details() { return { mission, owner: null, channels: [], memory: { count: null, stats: null, records: [] } }; },
		async mission() {
			if (pendingStatusRead) {
				const capture = pendingStatusRead;
				pendingStatusRead = null;
				return new Promise(capture);
			}
			return mission;
		},
		async mutateMission(request) {
			writes.push(request);
			if (writes.length === 1) {
				mission = proposal(7, "b", "receipt-6", "fresh scope");
				return { state: "refused", code: "stale-digest" };
			}
			return { state: "issued", receiptId: `receipt-${request.revision}`, reconciled: request.revision === 8 };
		},
		async send() { sends++; return { state: "completed" }; },
		logout() { return new Promise((resolve) => { resolveLogout = resolve; }); },
	};
	const root = document.createElement("div");
	document.body.replaceChildren(root);
	const unmount = mountWorkspace(root, port);
	try {
		await wait(() => document.querySelector("#composer"), "composer");
		const composer = document.querySelector("#composer");
		composer.value = "An unsent message";
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		byKey("nav-mission").click();
		await wait(() => byKey("open-mission-draft"), "Mission entry");
		byKey("open-mission-draft").click();
		await wait(() => document.querySelector("#mission-draft-objective"), "initial editor");
		mission = { ...initial, draft: { ...initial.draft, revision: 4, digest: null, status: "editing", terms: { ...terms, objective: "Bob's fresh draft" } }, review: null };
		receive({ type: "view", view: { ...view, busy: true, tools: [{ callId: "mission-edit", name: "unit_mission_draft", status: "succeeded" }] } });
		await wait(() => document.querySelector("#mission-draft-objective")?.value === "Bob's fresh draft", "draft tool updates the pinned card before the reply ends");
		const objective = document.querySelector("#mission-draft-objective");
		objective.value = "My unsaved objective";
		objective.dispatchEvent(new Event("input", { bubbles: true }));
		byKey("mission-draft-success-add").click();
		const criterion = document.querySelector("#mission-draft-success-2");
		criterion.value = "My unsaved criterion";
		criterion.dispatchEvent(new Event("input", { bubbles: true }));
		const cost = document.querySelector("#mission-draft-maxEstimatedCost");
		cost.focus();
		document.execCommand("insertText", false, "1e");
		check(cost.validity.badInput && cost.value === "", "Chromium holds invalid raw numeric input outside the value property");

		mission = { ...mission, draft: { ...mission.draft, revision: 5, terms: { ...terms, objective: "Bob's second draft" } } };
		receive({ type: "view", view: { ...view, busy: true, tools: [{ callId: "second-mission-edit", name: "unit_mission_draft", status: "succeeded" }] } });
		await wait(() => root.textContent.includes("Revision 5 is now current."), "new draft conflict");
		check(document.activeElement === cost && cost.validity.badInput, "tool refresh preserves native invalid input and focus");
		check(byKey("mission-draft-save").disabled && byKey("mission-draft-propose").disabled &&
			root.textContent.includes("edits based on revision 4"), "updated server status never rebases the editor");

		mission = proposal(6, "a", "receipt-5");
		receive({ type: "connection", state: "connecting" });
		check(document.activeElement === cost && cost.validity.badInput, "disconnection does not detach the editor or clear raw input");
		receive({ type: "view", view });
		await wait(() => root.textContent.includes("Revision 6 is now current."), "fresh status after reconnect");
		check(document.querySelector("#mission-draft-maxEstimatedCost") === cost && document.activeElement === cost && cost.validity.badInput &&
			objective.value === "My unsaved objective" && criterion.value === "My unsaved criterion" &&
			root.contains(objective) && root.contains(criterion), "reconnect preserves text, list edits, invalid numeric text and native focus");
		document.execCommand("insertText", false, "2");
		check(cost.valueAsNumber === 100, "the native input kept the raw exponent and its caret");
		byKey("mission-draft-save").click();
		check(!agree() && writes.length === 0, "conflict cannot save or approve through the preserved editor");
		byKey("mission-draft-discard").click();
		await wait(() => agree()?.textContent === "Agree to revision 6", "explicit discard shows only the latest proposal");
		check(!root.contains(objective) && !root.textContent.includes("edits based on revision 4") && !agree().disabled, "discard removes the local copy and allows a fresh review");
		check(composer.value === "An unsent message" && writes.length === 0 && sends === 0, "entry, updates and discard do not send or write");
		agree().click();
		await wait(() => agree()?.textContent === "Agree to revision 7", "fresh review after refusing stale digest");
		check(writes.length === 1 && writes[0].digest === "a".repeat(64) && writes[0].previousReceipt === "receipt-5", "first request uses only its visible review and is not replayed");
		check(root.textContent.includes("fresh scope") && root.querySelector('[role="alert"]').textContent.includes("proposal or its authority changed"), "fixed refusal and all updated terms shown");
		agree().click();
		await wait(() => root.textContent.includes("Reconciliation is pending"), "pending receipt");
		check(writes.length === 2 && writes[1].revision === 7 && writes[1].digest === "b".repeat(64) &&
			writes[1].previousReceipt === "receipt-6" && writes[1].confirmed === true, "second click binds only to the newer review");
		check(!agree() && !byKey("copy-mission-draft-approve") && !root.textContent.includes("Agreed, revision 7"), "an issued receipt is not agreement and cannot be retried");
		mission = recorded(mission, 7, "host-administrator");
		byKey("mission-draft-refresh").click();
		await wait(() => root.textContent.includes("Agreed, revision 7"), "recorded host-administrator attribution");
		check(root.textContent.includes("by the host administrator.") && !root.textContent.includes("by you."),
			"a receipt alone cannot override the recorded approver");

		mission = proposal(8, "c", "receipt-7");
		byKey("mission-draft-refresh").click();
		await wait(() => agree()?.textContent === "Agree to revision 8", "distinct later proposal");
		pendingStatusRead = (resolve) => { heldStatusRead = resolve; };
		agree().click();
		await wait(() => heldStatusRead && root.textContent.includes("Checking the recorded agreement."), "in-flight receipt status check");
		heldStatusRead(mission);
		await wait(() => root.textContent.includes("The agreement is not recorded in the current status."), "reconciled receipt but still proposed");
		check(root.textContent.includes("receipt-8") && !root.textContent.includes("Checking the recorded agreement.") &&
			!agree() && !byKey("copy-mission-draft-approve") && writes.length === 3, "settled read shows honest pending receipt without reapproval or replay");
		byKey("nav-mission").click();
		check(!byKey("copy-mission-approve"), "the Mission page also suppresses the issued revision's terminal command");
		byKey("open-mission-draft").click();
		mission = recorded(mission, 8, "local-creator");
		byKey("mission-draft-refresh").click();
		await wait(() => root.textContent.includes("Agreed, revision 8"), "recorded agreement after explicit status refresh");
		check(root.textContent.includes("by you. This did not start work.") &&
			!root.textContent.includes("not recorded in the current status") && writes.length === 3, "verified local-creator agreement matches this tab's issued approval");
		byKey("signout").click();
		check(!document.querySelector("#composer") && root.textContent.includes("Signed out locally"), "local sign-out removes protected content immediately");
		resolveLogout("unconfirmed");
		await wait(() => root.textContent.includes("Remote revocation could not be confirmed"), "unconfirmed remote logout");
	} finally {
		unmount();
	}
}


test("Mission card and shell bind explicit agreement to current terms and never replay it", { skip: !executable, timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-web-mission-draft-"));
	try {
		await build({
			stdin: {
				contents: `import { createMissionDraftEditor, renderMissionDraftCard } from "./web/views/mission-draft.ts";
				import { renderMission } from "./web/views/mission.ts";
				import { mountWorkspace } from "./web/shell.ts";
				(async () => {
					try { (${exercise.toString()})(); await (${exerciseShell.toString()})(); document.body.textContent = 'MISSION-CARD-PASSED'; }
					catch (error) { document.body.textContent = error.stack; }
				})();`,
				resolveDir: app,
			},
			bundle: true,
			outfile: join(directory, "fixture.js"),
		});
		const page = join(directory, "index.html");
		await writeFile(page, '<!doctype html><html lang="en"><body><script src="fixture.js" defer></script></body></html>');
		const { stdout } = await run(executable, ["--headless=new", "--no-first-run", `--user-data-dir=${join(directory, "profile")}`, "--virtual-time-budget=2500", "--dump-dom", pathToFileURL(page).href], { timeout: 25_000 });
		assert.match(stdout, /<body>MISSION-CARD-PASSED<\/body>/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
