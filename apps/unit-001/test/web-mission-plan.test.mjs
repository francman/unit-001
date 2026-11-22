// Exercises the plan read view in a private Chromium profile, without a shell, gateway, or owner.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { buildTailwind } from "../scripts/build-tailwind.mjs";

const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;
const app = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

function exercise(width) {
	const check = (condition, message) => { if (!condition) throw new Error(message); };
	const mount = (options) => {
		const root = renderMissionPlan(options);
		document.body.replaceChildren(root);
		return root;
	};
	const section = (root, title) => [...root.querySelectorAll("section")].find((node) => node.querySelector("h2").textContent === title);
	const fact = (root, label) => [...root.querySelectorAll("dt")].find((node) => node.textContent === label)?.nextElementSibling;
	const disclose = (root, label) => {
		const summary = [...root.querySelectorAll("summary")].find((node) => node.textContent === label);
		summary.focus();
		summary.click();
		check(summary.parentElement.open && document.activeElement === summary, `native focusable disclosure: ${label}`);
		return summary.parentElement;
	};
	const buttonByKey = (key) => document.querySelector(`[data-key="${key}"]`);
	const actions = () => [...document.querySelectorAll("button")].map((node) => node.textContent);
	const actionable = (root) => section(root, "Needs you")?.textContent ?? "";
	const previousDigest = "a".repeat(64);
	const digest = "b".repeat(64);
	const proposalDigest = "c".repeat(64);
	const ts = 1893456000123;
	const hostile = '<img src=x onerror="window.executed=true">\r\n\u202E\u00A0\\u202E \uD800 \\uD800 ' + "long".repeat(200);
	const strategy = { id: "s1", title: hostile, intent: "Old intent", signals: ["a signal"], priority: "normal" };
	const second = { ...strategy, id: "s2", title: "Second strategy", intent: "Another intent" };
	const runnable = { id: "runner", strategic: "s1", mode: "runnable", objective: "Runnable objective", priority: "high", successCriteria: ["check"], deadlineAt: ts + 500, binding: { missionId: "m", purposeRevision: 7, purposeDigest: "d".repeat(64) } };
	const parked = { ...runnable, id: "quiet", mode: "parked", objective: "Parked objective", deadlineAt: null, binding: null };
	const removed = { ...parked, id: "gone", objective: "Removed objective" };
	const added = { ...parked, id: "new", mode: "planned", objective: "Planned objective" };
	const termsBefore = { overall: { purpose: "Former purpose", scope: "Read only\n\t", askFirst: ["a", "b"], reviewEveryMs: 604801234 }, strategics: [strategy, second], tacticals: [runnable, parked, removed] };
	const termsAfter = { overall: { ...termsBefore.overall, purpose: "Current purpose", askFirst: ["b", "a"] }, strategics: [second, { ...strategy, intent: "New intent" }], tacticals: [{ ...parked, strategic: "s2" }, runnable, added] };
	const previous = { revision: 2, digest: previousDigest, previousDigest: null, terms: termsBefore, agreedAt: ts, receiptId: "receipt-2" };
	const head = { revision: 4, digest, previousDigest, terms: termsAfter, agreedAt: ts + 100, receiptId: "receipt-4" };
	const draft = { revision: 5, baseRevision: 4, status: "proposed", terms: termsAfter, digest: proposalDigest, savedBy: "bob", fromReview: "saved", missing: [] };
	const trigger = { kind: "cadence", key: "4:cadence:window", subject: null };
	const note = {
		reviewId: "saved", key: trigger.key, trigger, planRevision: 4, planDigest: digest, window: { from: ts - 1000, to: ts }, createdAt: ts,
		outcome: "no-change", disposition: null,
		facts: { runsUsed: 31, runsLimit: 32, cycles: 4, maxCycles: 21, requests: 6, maxRequests: 36, estimatedCost: 0.02, maxEstimatedCost: null },
		items: [{ id: "runner", level: "tactical", status: "at-risk", verifiedWorks: 1, listedWorks: 3, runIds: ["run-31"], blockReasons: [hostile], unsettled: 2, deadlineAt: ts + 100 }],
		uncertainty: ["A charge may still settle"],
	};
	const plan = {
		missionId: "m", adopted: true, head, headValid: true, previous, history: [head, previous], draft,
		gate: { state: "closed", reason: "reopen-needed" }, runs: { used: 31, limit: 32 },
		due: [trigger], preview: { ...note, reviewId: "computed", outcome: "attention" },
		reviews: [note, { ...note, reviewId: "same-window" }, { ...note, reviewId: "stale", planRevision: 2, planDigest: previousDigest },
			{ ...note, reviewId: "dismissed", disposition: { kind: "dismissed", at: ts, draftRevision: null } }],
		allowance: null, turns: [], blocker: null,
	};
	const legacy = { purpose: "Legacy owner objective", scope: "Legacy scope" };
	const terminalLine = `sudo release-bob mission plan approve --revision 5 --digest ${proposalDigest}`;
	const openLine = "sudo release-bob mission operate open";
	const terminalApproval = { revision: 5, digest: proposalDigest, line: terminalLine, copy: async () => false };
	let root = mount({ plan, legacy, terminalApproval });
	check(actions().join() === "Copy" && root.querySelector("code")?.textContent === terminalLine, "exact terminal approval is copy-only");
	check(!root.textContent.includes(legacy.purpose), "adopted plan does not present a fall-back Legacy authority");
	const overall = section(root, "Overall");
	check(fact(overall, "Approval").textContent === "Agreed revision 4" && fact(overall, "Plan admission").textContent === "Admission closed", "recorded approval is independent of admission");
	check(fact(overall, "Lifetime runs").textContent === "31 of 32 used; 1 left", "run cap is shown before admission");
	check(actionable(root).includes("separate Open in the terminal") && actionable(root).includes("awaiting approval"), "Needs you identifies an actionable gate and proposal");
	const groups = section(root, "Strategies and tactics");
	const tactic = (objective) => [...groups.querySelectorAll("h4")].find((node) => node.textContent.includes(objective)).parentElement;
	check(tactic("Runnable objective").textContent.includes("Blocked") && tactic("Parked objective").textContent.includes("Parked") && tactic("Planned objective").textContent.includes("Planned"), "a closed gate blocks only the runnable tactic");
	check(!actionable(root).includes("Parked") && !actionable(root).includes("Planned"), "inactive planned work is not a request for action");
	check(tactic("Parked objective").parentElement.parentElement.querySelector("h3").textContent.includes("Second strategy"), "a moved tactic renders under the assigned strategy");
	const history = section(root, "History");
	const old = disclose(history, "Previous exact revision 2");
	check(fact(old, "Review interval (milliseconds)").textContent === "604801234" && fact(old, "Scope").textContent === '"Read only\\u000A\\u0009"', "historic terms preserve exact numeric and multiline values");
	check(fact(old, "Title").querySelector('bdi[dir="auto"]').textContent.includes("\\u000D\\u000A\\u202E\\u00A0\\\\u202E"), "invisible controls and literal escapes stay distinct and isolated");
	check(fact(old, "Title").textContent.includes("\\uD800 \\\\uD800"), "an existing unpaired surrogate is visibly distinct from the literal escape");
	check(!root.querySelector("img") && !window.executed, "operator and model text remain literal, including review evidence");
	const diff = disclose(history, "Diff from revision 2 to 4");
	for (const value of ["Former purpose", "Current purpose", "Affected tactics", "Old intent", "New intent", "Parent strategy", '"s1"', '"s2"', "Removed objective", "Planned objective", "Strategy order", "Tactic order"]) {
		check(diff.textContent.includes(value), `history diff includes ${value}`);
	}
	check(disclose(section(root, "Plan draft"), "Diff from base revision 4").textContent.includes("No plan terms changed."), "an unchanged proposal is distinguished from an empty history or review");
	const reviews = section(root, "Reviews");
	check(reviews.textContent.includes("Review due") && reviews.textContent.includes("Unsaved review preview · Needs attention") && reviews.textContent.includes("Saved review · No change"), "due, unsaved and saved no-change are distinct");
	check(!reviews.textContent.includes("Model review usage and history"), "an empty projection, including parsed legacy status, stays inert");
	const evidence = disclose(reviews, "Read preview evidence");
	check(fact(evidence, "Unsettled effects").textContent === "2" && fact(evidence, "Cited runs").textContent === '"run-31"' && fact(evidence, "Verified works").textContent === '"1 of 3"', "review evidence explains what was and was not verified");
	check(fact(evidence, "Deadline distance").textContent === '"under 1 min left at review time"', "historical deadline distance is relative to review time");
	for (const details of root.querySelectorAll("details")) details.open = true;
	check(innerWidth === width && getComputedStyle(overall.querySelector("dl")).gridTemplateColumns.split(" ").length === (width === 320 ? 1 : 2),
		`facts use the expected column count at ${width}px`);
	check(document.documentElement.scrollWidth === width, `expanded exact terms and commands fit ${width}px`);

	const called = [];
	const copy = async (line) => { called.push(line); return false; };
	root = mount({ plan, onReviewNow: () => called.push("review"), onDismissReview: (id) => called.push(`dismiss:${id}`), onDraftFromReview: (id) => called.push(`draft:${id}`),
		terminalApproval: { ...terminalApproval, copy }, terminalOpen: { line: openLine, copy } });
	check(called.length === 0 && !actions().some((label) => /^(agree|open|start)/i.test(label)), "mounting with callbacks does not manufacture an operation");
	for (const kind of ["dismiss", "draft"]) {
		const first = buttonByKey(`mission-plan-${kind}-saved`).getAttribute("aria-label");
		const second = buttonByKey(`mission-plan-${kind}-same-window`).getAttribute("aria-label");
		check(first?.includes("Scheduled review") && first.endsWith("review saved") && second.endsWith("review same-window"), "review controls announce their exact note");
	}
	check(!buttonByKey("mission-plan-dismiss-computed") && !buttonByKey("mission-plan-draft-stale") && !buttonByKey("mission-plan-dismiss-dismissed"), "preview, moved-head and disposed notes cannot offer inapplicable actions");
	buttonByKey("mission-plan-review-now").click();
	buttonByKey("mission-plan-dismiss-saved").click();
	buttonByKey("mission-plan-draft-saved").click();
	buttonByKey("mission-plan-copy-approval").click();
	buttonByKey("mission-plan-copy-open").click();
	check(JSON.stringify(called) === JSON.stringify(["review", "dismiss:saved", "draft:saved", terminalLine, openLine]), "explicit controls delegate to supplied callbacks with the exact target");
	root = mount({ plan: { ...plan, gate: { state: "open", reason: null }, due: [], preview: null, draft: null } });
	check(!actionable(root) && section(root, "Strategies and tactics").textContent.includes("Runnable"), "ready plan does not invent an owner task");
	const running = { key: "running", planRevision: 4, trigger, state: "running", reason: null, reviewId: "running-note", draftRevision: null, requests: 1, at: ts + 400 };
	const done = { ...running, key: "done", state: "done", reviewId: "done-note", draftRevision: 8, requests: 2, at: ts + 300 };
	const skipped = { ...running, key: "skipped", state: "skipped", reason: "hold", reviewId: null, requests: 0, at: ts + 200 };
	const blocked = { ...running, key: "blocked", state: "blocked", reason: "authority", reviewId: null, at: ts + 100 };
	const blocker = { ...blocked, key: "old-uncertain", planRevision: 2, reason: "unknown_request_outcome", at: ts - 100 };
	const modelPlan = { ...plan, gate: { state: "open", reason: null }, due: [], preview: null, draft: null,
		allowance: { maxRequests: 6, maxRequestsPerReview: 3, maxEstimatedCost: null, requests: 5, estimatedCost: 0.0125, reservedCost: 0.00125 },
		turns: [running, done, skipped, blocked], blocker };
	root = mount({ plan: modelPlan });
	const model = section(root, "Reviews");
	const pinned = section(root, "Needs you");
	check(pinned.innerText.includes("Unresolved model review blocker") && pinned.innerText.includes("Plan revision 2") &&
		pinned.innerText.includes("outcome is unknown") && !pinned.innerText.includes("unknown_request_outcome"),
		"a projected blocker outside history explains the issue in plain language even with no due triggers and an open gate");
	check(fact(disclose(pinned, "Read model review turn details"), "Reason code").textContent === '"unknown_request_outcome"', "the pinned blocker retains the exact reason code in details");
	check(model.textContent.includes("pinned under Needs you") && !actions().length, "reading projected history offers no new operation");
	for (const [label, value] of Object.entries({
		"Lifetime review requests used": "5", "Lifetime review request limit": "6", "Requests per review limit": "3",
		"Review estimated cost (USD)": "0.0125", "Review reserved cost (USD)": "0.00125",
		"Review estimated cost cap (USD)": "No separate review cap (purpose limits apply)",
	})) check(fact(model, label)?.textContent === value, `projected model review usage shows exact ${label}`);
	const rows = [...model.querySelectorAll("summary")].filter((summary) => summary.textContent === "Read model review turn details");
	check(rows.map((summary) => summary.parentElement.parentElement.querySelector("p").textContent.split(" · ")[0]).join() === "Running,Done,Skipped,Blocked",
		"all turn states retain the server's newest-first order");
	check(model.innerText.includes("The purpose is on hold.") && model.innerText.includes("The current authority did not allow"), "skipped and blocked rows explain their reasons");
	for (const [index, reason] of [[2, "hold"], [3, "authority"]]) {
		rows[index].click();
		check(fact(rows[index].parentElement, "Reason code").textContent === `"${reason}"`, "turn details retain the verbatim reason code");
	}
	rows[1].click();
	check(fact(rows[1].parentElement, "Draft revision").textContent === "8" && fact(rows[1].parentElement, "Review ID").textContent === '"done-note"',
		"the done turn identifies its exact review and generated draft");
	for (const details of root.querySelectorAll("details")) details.open = true;
	check(document.documentElement.scrollWidth === width, `expanded turn history fits ${width}px`);
	root = mount({ plan: { ...modelPlan, allowance: null, turns: [...modelPlan.turns, blocker] } });
	check(actionable(root).includes("unknown_request_outcome") && !section(root, "Reviews").textContent.includes("unknown_request_outcome"),
		"the blocker is shown once and survives removal of the active allowance");
	check(section(root, "Reviews").innerText.includes("Model reviews are disabled in the agreed plan."), "history without an allowance does not imply active reviews");
	root = mount({ plan: { ...modelPlan, blocker: done } });
	check(actionable(root).includes("Done") && actionable(root).includes("receipt is still unresolved") &&
		!section(root, "Reviews").textContent.includes("done-note"), "a finished turn with an unresolved receipt is pinned and deduplicated without relabelling it as blocked");
	for (const turns of [[done, running, skipped], [done, skipped]]) {
		root = mount({ plan: { ...modelPlan, turns, blocker: running } });
		const inFlight = section(root, "Reviews");
		check(!section(root, "Needs you") && !inFlight.innerText.includes("pinned under Needs you"), "a running reservation does not raise a Needs you alarm");
		const firstTurn = [...inFlight.querySelectorAll("li")].find((item) => item.querySelector("summary")?.textContent === "Read model review turn details");
		check(firstTurn.innerText.includes("Request in flight; outcome not yet known. Later reviews wait for it.") &&
			firstTurn.innerText.includes("Running") && inFlight.textContent.split("running-note").length === 2,
			"the running reservation is pinned once at the top of history, even if outside the list");
	}
	root = mount({ plan: { ...modelPlan, blocker: null, allowance: { ...modelPlan.allowance, requests: 6, maxEstimatedCost: 0.05 } } });
	const exhausted = section(root, "Reviews");
	check(fact(exhausted, "Review requests remaining")?.textContent === "No review requests left" &&
		fact(exhausted, "Review estimated cost cap (USD)").textContent === "0.05" && !exhausted.innerText.includes("No separate review cap"),
		"an exhausted allowance reports exhaustion without suggesting its separate cost cap is absent");
	root = mount({ plan: { ...plan, gate: { state: "open", reason: null }, draft: null, runs: { used: 32, limit: 32 } } });
	check(actionable(root).includes("lifetime run limit is exhausted") && section(root, "Strategies and tactics").textContent.includes("Blocked"), "budget exhaustion is visible even with open plan gate");
	root = mount({ plan: { ...plan, history: Array.from({ length: 32 }, (_, index) => ({ ...head, revision: 32 - index })) } });
	check(actionable(root).includes("32-revision limit. A new revision cannot be proposed."), "plan history cap is separate from the lifetime run cap");
	root = mount({ plan: { ...plan, headValid: false, gate: { state: "closed", reason: "receipt" } },
		terminalApproval: { ...terminalApproval, digest }, terminalOpen: { line: openLine, copy } });
	check(!root.querySelector("code") && fact(section(root, "Overall"), "Approval").textContent.includes("Approval not current"), "a different digest cannot show a command and a stale receipt is not valid approval");
	root = mount({ plan: null, legacy });
	check(root.textContent.includes("Legacy purpose") && !section(root, "Strategies and tactics"), "legacy work has no invented ancestry");
	root = mount({ plan: { ...plan, head: null, headValid: false, adopted: false, gate: { state: "closed", reason: "head-missing" } }, legacy });
	check(root.textContent.includes("do not rely on legacy authority"), "first-receipt crash window does not imply legacy fallback");
	root = mount({ plan, planError: true, legacy, onReviewNow: () => called.push("bad") });
	check(root.querySelector('[role="alert"]').textContent.includes("Plan admission is blocked") && !actions().length && !root.textContent.includes(legacy.purpose), "invalid stored plan fails closed without contextual actions");
}

test("Mission plan keeps admission, approval, reviews, and exact history distinct", { skip: !executable, timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-web-mission-plan-"));
	try {
		buildTailwind(join(directory, "style.css"), true);
		await build({
			stdin: {
				contents: `import { renderMissionPlan } from './web/views/mission-plan.ts';
				const width = Number(frameElement.dataset.width);
				const status = parent.document.querySelector('#result-' + width);
				try { (${exercise.toString()})(width); status.textContent = 'MISSION-PLAN-PASSED'; }
				catch (error) { status.textContent = error.stack; }`,
				resolveDir: app,
			},
			bundle: true,
			outfile: join(directory, "fixture.js"),
		});
		await writeFile(join(directory, "fixture.html"), '<!doctype html><html lang="en"><head><link rel="stylesheet" href="style.css"></head><body><script src="fixture.js" defer></script></body></html>');
		const page = join(directory, "index.html");
		await writeFile(page, `<!doctype html><html lang="en"><body>${[320, 1280].map((width) =>
			`<output id="result-${width}">Incomplete</output><iframe title="${width}px Mission plan" data-width="${width}" width="${width}" height="700" src="fixture.html"></iframe>`).join("")}</body></html>`);
		const { stdout } = await run(executable, ["--headless=new", "--no-first-run", "--allow-file-access-from-files", `--user-data-dir=${join(directory, "profile")}`,
			"--window-size=1440,900", "--virtual-time-budget=2500", "--dump-dom", pathToFileURL(page).href], { timeout: 25_000 });
		for (const width of [320, 1280]) assert.match(stdout, new RegExp(`<output id="result-${width}">MISSION-PLAN-PASSED</output>`));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
