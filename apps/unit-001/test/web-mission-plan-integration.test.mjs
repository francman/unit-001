// Drives the integrated shell and port at 320 px and desktop width against private faux gateway responses.
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

async function exercise(mountWorkspace, browserWorkspacePort, width) {
	const check = (condition, why) => { if (!condition) throw new Error(why); };
	const byKey = (key) => document.querySelector(`[data-key="${key}"]`);
	const byId = (id) => document.getElementById(id);
	const wait = async (predicate, label, timeout = 240) => {
		for (let elapsed = 0; elapsed < timeout; elapsed += 4) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 4));
		}
		throw new Error(`Missing ${label}: ${document.querySelector("main")?.innerText.slice(0, 1600)}`);
	};
	const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
	const go = (section) => {
		if (width === 320) byKey("menu").click();
		byKey(`nav-${section}`).click();
	};
	const input = (field, value) => {
		field.value = value;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const digest = (digit) => String(digit).repeat(64);
	const cadence = 604800000;
	const binding = { missionId: "purpose-on-wire", purposeRevision: 17, purposeDigest: digest(9) };
	const terms = {
		overall: { purpose: "Keep releases safe", scope: "New scope", askFirst: ["Publish"], reviewEveryMs: cadence },
		strategics: [{ id: "releases", title: "Safe releases", intent: "Check candidates", signals: [], priority: "high" }],
		tacticals: [{ id: "builds", strategic: "releases", objective: "Verify builds", successCriteria: ["Check manifest"],
			priority: "normal", deadlineAt: null, mode: "runnable", binding }],
	};
	const revision = (number, terms, previousDigest = null, receiptId = `receipt-${number}`) => ({
		revision: number, digest: digest(number), previousDigest, terms, agreedAt: number * cadence, receiptId,
	});
	const historyRow = ({ revision, digest, agreedAt }) => ({ revision, digest, agreedAt });
	const first = revision(1, { ...terms, overall: { ...terms.overall, scope: "Old exact scope\nno extra permission" } });
	const head = revision(2, terms, first.digest);
	const due = { kind: "cadence", key: "2:cadence:1", subject: null };
	const preview = {
		reviewId: "computed-preview", key: due.key, trigger: due, planRevision: 2, planDigest: head.digest,
		window: { from: 2 * cadence, to: 3 * cadence }, createdAt: 3 * cadence, outcome: "no-change", items: [],
		facts: { runsUsed: 2, runsLimit: 32, cycles: 2, maxCycles: 8, requests: 7, maxRequests: 21, estimatedCost: 0.2, maxEstimatedCost: 3 },
		uncertainty: [], disposition: null,
	};
	const plan = {
		missionId: "charter", adopted: true, head, headValid: true, previous: first, history: [head, first].map(historyRow), draft: null,
		gate: { state: "closed", reason: "reopen-needed" }, runs: { used: 2, limit: 32 }, due: [due], preview, reviews: [],
	};
	const legacy = {
		stage: "agreed", missing: [], tools: [], execution: "not-started", runtime: null,
		creator: { kind: "human", id: "operator" }, authority: "developer-local", agreementValid: true, authorityError: null,
		canAgree: true, draft: null, review: null, formation: { draft: null, agreement: {
			revision: 17, terms: { objective: "Legacy dependency purpose", scope: "Old operations only", successCriteria: ["No drift"],
				approvalBoundary: [], reviewEveryMs: cadence,
				policy: { allowedTools: [], maxCycles: 8, maxRequests: 21, maxRetries: 0, maxConsecutiveNoProgress: 2, deadlineAt: 20 * cadence } },
			approval: { approvedAt: 0, approvedBy: { kind: "developer-local" } },
		} },
	};
	const frame = {
		name: "Agent", version: "local", installationId: null, busy: false, model: { provider: "faux", modelId: "faux" }, usage: null,
		entries: [{ id: 5, role: "user", text: "Retained chat entry", truncated: false }],
		text: "", textTruncated: false, historyTruncated: true, tools: [],
	};
	let mission = legacy;
	const workspaceId = "a".repeat(64);
	const csrfToken = "fixture-csrf";
	const identity = { "X-Unit-Workspace": workspaceId };
	let metadataReads = 0;
	const requests = [];
	const changes = [];
	let events;
	let reads = 0;
	let holdNextStatus;
	let approvalOutcome = { state: "issued", receiptId: "issued-receipt-4", reconciled: false };
	const emit = (event, value) => events.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
	let copied;
	Object.defineProperty(navigator, "clipboard", { value: { async writeText(line) { copied = line; } } });
	window.fetch = async (path, options) => {
		if (path === "/api/v1/session") {
			++metadataReads;
			return Response.json({ csrfToken }, { headers: identity });
		}
		if (path === "/api/v1/events") return new Response(new ReadableStream({
			start(controller) { events = controller; emit("view", frame); },
		}), { headers: { ...identity, "Content-Type": "text/event-stream" } });
		check(path === "/api/v1/requests" && options.headers["X-Unit-CSRF"] === csrfToken && options.credentials === "omit",
			"the port uses the existing code-free request transport");
		const { operation: envelope, requestId } = JSON.parse(options.body);
		check(typeof requestId === "string" && requestId.length > 0, "an explicit request ID stays in the envelope");
		requests.push(envelope);
		const completed = (response) => Response.json({ requestId, state: "completed", response });
		if (envelope.type === "status") return completed({ type: "status", maintenance: { state: "open" }, inhibited: false,
			runtime: { uptimeMs: 1234, configuration: "configured" } });
		if (envelope.type === "channels") return completed({ type: "channels", result: { operation: "status", view: { channels: [] } } });
		if (envelope.type === "chat-history") return completed({ type: "chat-history", page: { nextBefore: null,
			entries: [{ id: 1, role: "assistant", text: "Earlier faux message", truncated: false }] } });
		const change = envelope.request;
		if (envelope.type === "memory") {
			const result = change.operation === "graph" ? { nodes: [], edges: [], total: 0, limited: false }
				: change.operation === "recall" ? { records: [{ id: "m1", content: "Faux memory result", tier: "working", origin: "user" }] }
					: { working: 1, episodic: 0, tombstones: 0, pendingCaptures: 0, failedCaptures: 0, consolidation: "idle" };
			return completed({ type: "memory", result: { operation: change.operation, ...result } });
		}
		check(envelope.type === "mission", `unexpected request type: ${envelope.type}`);
		if (change.operation === "status") {
			++reads;
			if (holdNextStatus) { const pending = holdNextStatus; holdNextStatus = null; await pending; }
			return completed({ type: "mission", result: mission });
		}
		changes.push({ change, requestId });
		let next = mission.plan;
		switch (change.operation) {
			case "review-now":
				next = { ...next, due: [], preview: null, reviews: [{ ...preview, reviewId: "saved-note" }] };
				break;
			case "review-dismiss":
				next = { ...next, reviews: next.reviews.map((note) => note.reviewId === change.reviewId ? { ...note,
					disposition: { kind: "dismissed", at: 4 * cadence, draftRevision: null } } : note) };
				break;
			case "plan-draft":
				next = { ...next, draft: { ...next.draft, terms: change.terms, revision: change.expectedRevision + 1, savedBy: "owner" } };
				break;
			case "plan-propose":
				next = { ...next, draft: { ...next.draft, status: "proposed", digest: digest(change.expectedRevision) } };
				break;
			case "plan-agree":
				return Response.json({ requestId, ...approvalOutcome });
			default: throw new Error(`unexpected mission operation: ${change.operation}`);
		}
		mission = { ...mission, plan: next };
		return completed({ type: "mission", result: mission });
	};

	const root = document.querySelector("#app");
	const unmount = mountWorkspace(root, browserWorkspacePort({ csrfToken, workspaceId }), { section: "mission" });
	const has = (value) => root.textContent.includes(value);
	const planEntry = () => byKey("open-mission-plan-draft");
	const agree = () => document.querySelector('[data-key^="mission-plan-draft-agree-"]');
	const refresh = () => byKey("mission-draft-refresh").click();
	const save = () => byKey("mission-plan-draft-save");
	const propose = () => byKey("mission-plan-draft-review");
	const field = (name) => byId(`mission-plan-draft-${name}`);
	const fit = (node) => check(innerWidth === width && node.scrollWidth === node.clientWidth &&
		root.scrollWidth === root.clientWidth, `${node.dataset.scroll} and the shell fit ${width}px`);
	const editingDraft = { revision: 3, baseRevision: 2, status: "editing", terms, digest: null, savedBy: "bob", fromReview: null, missing: [] };
	try {
		await wait(() => byKey("open-mission-draft"), "old Mission");
		check(has("Legacy dependency purpose") && !planEntry(), "legacy status retains the fixed Mission without inventing plan support");
		mission = { ...legacy, plan: { ...plan, headValid: false, gate: { state: "closed", reason: "receipt" } },
			planError: null, canAgreePlan: false, runnablePurposeBinding: null };
		go("mission");
		await wait(() => planEntry() && byKey("mission-plan-review-now"), "fresh plan and controls");
		check(!byKey("mission-plan-copy-open"), "an invalid receipt never offers Open");
		const diff = [...root.querySelectorAll("details")].find((item) => item.firstChild.textContent === "Diff from revision 1 to 2");
		diff.open = true;
		check(diff.textContent.includes("Old exact scope\\u000Ano extra permission") && diff.textContent.includes("New scope") &&
			diff.textContent.includes("Affected tactics") && diff.textContent.includes("builds"), "exact incoming predecessor and descendant diff");
		fit(root.querySelector('[data-scroll="mission"]'));
		check(has("Unsaved review preview · No change") && !byKey("mission-plan-dismiss-computed-preview") && !changes.length,
			"due preview and history reads do not save a review");
		const reviewNow = byKey("mission-plan-review-now");
		reviewNow.click();
		reviewNow.click();
		await wait(() => byKey("mission-plan-review-now") && has("Saved review · No change"), "saved deterministic review");
		check(changes.length === 1 && JSON.stringify(changes[0].change) === '{"operation":"review-now"}' && !has("Unsaved review preview"),
			"only the explicit review action makes one review-now write");
		check(has("Approval not current") && !byKey("mission-plan-draft-saved-note"),
			"reviewing invalid approval records evidence but cannot launch Chat drafting against it");
		mission = { ...mission, plan: { ...mission.plan, headValid: true, gate: plan.gate } };
		const beforeBobDraft = reads;
		emit("view", { ...frame, tools: [{ callId: "agent-plan-draft", name: "unit_plan_draft", status: "succeeded" }] });
		await wait(() => reads > beforeBobDraft && byKey("mission-plan-draft-saved-note"), "fresh status after Bob's plan tool");
		byKey("mission-plan-copy-open").click();
		await wait(() => copied === "agent mission operate open", "developer-local Open command");
		check(changes.length === 1, "copying Open does not send an operation");
		byKey("mission-plan-draft-saved-note").click();
		check(byId("composer").value === "Draft a revision from review saved-note" && root.querySelector('[data-scroll="mission-draft"]').hidden &&
			changes.length === 1 && !requests.some(({ type }) => type === "send"), "draft from review only prefills Chat");
		input(byId("composer"), "Existing unsent text");
		byKey("load-earlier").click();
		await wait(() => has("Earlier faux message"), "paged chat history");
		go("memory");
		input(byId("memory-query"), "faux");
		byKey("memory-search").click();
		await wait(() => has("Faux memory result"), "Memory recall");
		go("mission");
		await wait(() => byKey("mission-plan-draft-saved-note"), "saved review remains undisposed");
		byKey("mission-plan-draft-saved-note").click();
		check(has("Chat already has a draft") && !byId("composer"), "review action does not overwrite a nonempty composer");
		byKey("mission-plan-dismiss-saved-note").click();
		await wait(() => has("Dismissed"), "recorded dismissal");
		check(JSON.stringify(changes[1].change) === '{"operation":"review-dismiss","reviewId":"saved-note"}' &&
			has("Agreed revision 2") && !byKey("mission-plan-draft-saved-note"), "dismiss only records the selected review disposition");
		planEntry().click();
		const panel = root.querySelector('[data-scroll="mission-draft"]');
		fit(panel);
		const mainLeft = root.querySelector("main").getBoundingClientRect().left;
		check((panel.getBoundingClientRect().left > mainLeft) === (width !== 320), "the desktop panel is beside Chat and the mobile panel is stacked");
		const bindingControl = () => root.querySelector('select[id$="-binding"]');
		check(byId("composer").value === "Existing unsent text" && bindingControl().options.length === 1 && !bindingControl().value,
			"plan editor preserves Chat and never derives a binding from legacy or historical plan terms");
		save().click();
		check(changes.length === 2, "an unbound runnable tactic cannot be saved");
		mission = { ...mission, runnablePurposeBinding: binding };
		refresh();
		await wait(() => bindingControl()?.options.length === 2, "one exact projected binding");
		check(bindingControl().selectedIndex === 1 && bindingControl().selectedOptions[0].textContent.includes(binding.purposeDigest),
			"the editor round-trips the known exact binding only");
		const purpose = field("purpose");
		input(purpose, "Local unsaved purpose");
		const number = field("review-every");
		number.focus();
		number.select();
		document.execCommand("insertText", false, "1e");
		check(number.validity.badInput, "Chromium keeps the invalid partial exponent natively");
		events.close();
		await wait(() => save().disabled, "offline edit access");
		check(document.activeElement === number && number.validity.badInput, "disconnect keeps focus and partial input");
		mission = { ...mission, plan: { ...mission.plan, draft: editingDraft } };
		const pendingStatus = Promise.withResolvers();
		holdNextStatus = pendingStatus.promise;
		const beforeReconnect = reads;
		await wait(() => reads > beforeReconnect, "pending reconnect status read", 3500);
		check(metadataReads === 1 && save().disabled && document.activeElement === number, "same-workspace reconnect is not plan freshness");
		pendingStatus.resolve();
		await wait(() => has("Your edits based on revision 2"), "stale draft conflict");
		check(field("review-every") === number && document.activeElement === number && number.validity.badInput &&
			purpose.value === "Local unsaved purpose" && save().disabled && propose().disabled && changes.length === 2,
			"stale CAS disables writes without replacing native dirty inputs");
		byKey("mission-draft-discard").click();
		await wait(() => propose() && !propose().disabled, "fresh saved revision after explicit discard");
		check(has("Revision 3 saved by Bob (base 2)"), "the pinned editor identifies the source of the saved revision");
		input(field("purpose"), "Owner edited purpose");
		check(propose().disabled, "dirty terms cannot propose the saved draft");
		save().click();
		await wait(() => has("Revision 4 saved") && !propose()?.disabled, "owner-saved revision");
		check(changes[2].change.expectedRevision === 3 && changes[2].change.terms.overall.purpose === "Owner edited purpose" &&
			JSON.stringify(changes[2].change.terms.tacticals[0].binding) === JSON.stringify(binding), "save sends exact terms and captured CAS revision");
		propose().click();
		await wait(() => has("Review proposed plan revision 4"), "exact proposal card");
		check(changes[3].change.expectedRevision === 4 && !agree(), "review targets the clean saved revision and legacy canAgree does not authorize plan Agree");
		const proposalDiff = [...panel.querySelectorAll("details")].find((node) => node.firstChild.textContent === "Diff from base revision 2");
		proposalDiff.open = true;
		check(proposalDiff.innerText.includes("Keep releases safe") && proposalDiff.innerText.includes("Owner edited purpose") &&
			proposalDiff.innerText.includes("Affected tactics") && has("the owner"), "the exact base diff and saved source are visible before agreement");
		fit(panel);
		byKey("mission-plan-draft-copy-approval").click();
		await wait(() => copied === `agent mission plan approve --revision 4 --digest ${digest(4)}`, "developer-local terminal approval");
		byKey("mission-plan-draft-edit").click();
		check(has("Editing proposed revision 4") && save().disabled && propose().disabled && changes.length === 4,
			"opening the saved proposal for edits neither withdraws nor reproposes it");
		byKey("mission-draft-close").click();
		go("mission");
		await wait(() => byKey("mission-plan-copy-approval"), "developer-local fallback on Mission");
		planEntry().click();
		await wait(() => byKey("mission-plan-draft-copy-approval"), "local proposal remains saved when reopening the panel");
		mission = { ...mission, canAgreePlan: true };
		refresh();
		await wait(agree, "affirmative developer-local exact proposal");
		agree().click();
		await wait(() => has("issued-receipt-4"), "explicit receipt pending");
		check(JSON.stringify(changes[4].change) === JSON.stringify({ operation: "plan-agree", revision: 4, digest: digest(4), confirmed: true }),
			"only explicit Agree sends the confirmed revision/digest pair");
		refresh();
		await nextTurn();
		check(!agree() && changes.length === 5 && has("Do not submit again"), "a fresh read of the old proposal does not replay an issued receipt");
		const fourth = revision(4, mission.plan.draft.terms, head.digest, "issued-receipt-4");
		mission = { ...mission, plan: { ...mission.plan, head: { ...fourth, receiptId: "other-receipt" }, previous: head,
			history: [historyRow(fourth), ...mission.plan.history], draft: null } };
		refresh();
		await nextTurn();
		check(has("Do not submit again"), "the same digest with another receipt does not settle an issued response");
		mission = { ...mission, plan: { ...mission.plan, head: fourth, draft: { ...editingDraft, revision: 5, baseRevision: 4,
			status: "proposed", digest: digest(5) } } };
		approvalOutcome = { state: "unknown" };
		refresh();
		await wait(agree, "a different proposal after receipt confirmation");
		agree().click();
		await wait(() => has("approval for revision 5 is unconfirmed"), "unknown approval state");
		refresh();
		await nextTurn();
		check(!agree() && changes.length === 6, "unknown delivery is never automatically retried or rearmed by an unchanged status read");
		const fifth = revision(5, terms, fourth.digest);
		mission = { ...mission, authority: "managed-administrator", plan: { ...mission.plan, head: fifth, previous: fourth,
			history: [historyRow(fifth), ...mission.plan.history], draft: { ...editingDraft, revision: 6, baseRevision: 5, status: "proposed", digest: digest(6) } } };
		emit("view", { ...frame, name: "Release-Bob" });
		refresh();
		await wait(() => byKey("mission-plan-draft-copy-approval"), "managed terminal fallback");
		const command = `sudo release-bob mission plan approve --revision 6 --digest ${digest(6)}`;
		check(!agree() && has(command), "the managed lane offers the exact terminal command, never web Agree");
		byKey("mission-plan-draft-copy-approval").click();
		await wait(() => copied === command, "copy-only managed approval");
		byKey("mission-draft-close").click();
		go("mission");
		await wait(() => byKey("mission-plan-copy-approval"), "same exact fallback on Mission");
		byKey("mission-plan-copy-open").click();
		await wait(() => copied === "sudo release-bob mission operate open", "copy-only named managed Open");
		fit(root.querySelector('[data-scroll="mission"]'));
		mission = { ...mission, plan: null, planError: "invalid-plan", canAgreePlan: false, runnablePurposeBinding: null };
		go("mission");
		await wait(() => has("Plan admission is blocked"), "safe invalid-plan projection");
		check(!planEntry() && !byKey("mission-plan-copy-approval") && has("Legacy dependency purpose"), "invalid plan hides writes and leaves legacy facts present");
		fit(root.querySelector('[data-scroll="mission"]'));
		check(new Set(changes.map(({ requestId }) => requestId)).size === 6 &&
			!requests.some(({ type, request }) => type === "send" || /open|start/.test(request?.operation ?? "")), "no replay, Chat send or implicit Open");
	} finally {
		unmount();
	}
}

const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;
const app = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

test("Missions v2 shell keeps reads, edits, review prefill and receipt recovery separate", { skip: !executable, timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-web-mission-plan-integration-"));
	try {
		buildTailwind(join(directory, "style.css"), true);
		await build({
			stdin: { contents: `import { mountWorkspace } from './web/shell.ts';
				import { browserWorkspacePort } from './web/port.ts';
				const width = Number(frameElement.dataset.width);
				const output = parent.document.querySelector('output');
				(${exercise.toString()})(mountWorkspace, browserWorkspacePort, width).then(
					() => output.textContent = 'MISSION-PLAN-INTEGRATED', error => output.textContent = error.stack);`, resolveDir: app },
			bundle: true,
			outfile: join(directory, "fixture.js"),
		});
		await writeFile(join(directory, "fixture.html"), '<!doctype html><html lang="en"><head><link rel="stylesheet" href="style.css"></head><body><div id="app"></div><script src="fixture.js" defer></script></body></html>');
		for (const width of [320, 1280]) {
			const page = join(directory, `index-${width}.html`);
			await writeFile(page, `<!doctype html><html lang="en"><body><output>Incomplete</output><iframe title="${width}px Missions workspace" data-width="${width}" width="${width}" height="700" src="fixture.html"></iframe></body></html>`);
			const { stdout } = await run(executable, ["--headless=new", "--no-first-run", "--allow-file-access-from-files", "--window-size=1440,900",
				`--user-data-dir=${join(directory, `profile-${width}`)}`, "--virtual-time-budget=4000", "--dump-dom", pathToFileURL(page).href], { timeout: 12_000 });
			assert.match(stdout, /<output>MISSION-PLAN-INTEGRATED<\/output>/, `${width}px fixture: ${stdout}`);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
