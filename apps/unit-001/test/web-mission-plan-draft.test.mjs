// Exercises only the pure plan editor and review card, with private Chromium assets and no workspace port.
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
	const field = (id) => document.getElementById(`mission-plan-draft-${id}`);
	const action = (key) => document.querySelector(`[data-key="mission-plan-draft-${key}"]`);
	const agree = () => document.querySelector('[data-key^="mission-plan-draft-agree-"]');
	const edit = (id, value) => {
		const input = field(id);
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const mount = (root) => { document.body.replaceChildren(root); return root; };
	const fit = (root) => check(innerWidth === width && root.scrollWidth <= width && document.documentElement.scrollWidth === width, `draft fits ${width}px`);
	const terms = {
		overall: { purpose: '<img src=x onerror="window.ran=true">\r\n\u202E a\u00A0b \\u000A', scope: "This workspace only", askFirst: ["publish\nexternally", ""], reviewEveryMs: 604800001 },
		strategics: [{ id: "release-goal", title: "Release", intent: "Publish checked artifacts", signals: ["No missed releases \uD800 \\uD800"], priority: "high" }],
		tacticals: [
			{ id: "build", strategic: "release-goal", objective: "Package the build", successCriteria: ["bundle verifies"], priority: "low", deadlineAt: 1893456000123, mode: "runnable", binding: { missionId: "purpose-2", purposeRevision: 7, purposeDigest: "b".repeat(64) } },
			{ id: "audit", strategic: "release-goal", objective: "Audit the build", successCriteria: ["review recorded"], priority: "normal", deadlineAt: null, mode: "parked", binding: null },
		],
	};
	const binding = terms.tacticals[0].binding;
	const alternate = { ...binding, missionId: "purpose-1" };
	const calls = [];
	const ready = { canSave: true, canReview: true };
	const initial = {
		terms, expectedRevision: 12, draft: { baseRevision: 10, status: "editing", savedBy: "bob", fromReview: "review-42", missing: [] },
		bindings: [alternate, binding], access: ready,
		onSave: (revision, submitted) => calls.push({ revision, submitted }),
		onReview: (revision) => calls.push({ revision }),
		onDirty: () => calls.push("dirty"),
	};
	const editor = createMissionPlanDraftEditor(initial);
	mount(editor.root);
	fit(editor.root);
	check(!calls.length && action("save").disabled, "mounting a saved revision performs no write");
	check(editor.root.textContent.includes("Revision 12 saved by Bob (base 10)") && editor.root.textContent.includes('Drafted from review "review-42"'),
		"the editor identifies Bob and the review that seeded these terms");
	const hint = (input) => document.getElementById(input.getAttribute("aria-describedby"));
	const deadline = field("tactic-1-deadline");
	check(hint(field("review-every")).textContent === "About 7 days" && hint(deadline).textContent === "2030-01-01T00:00:00.123Z", "exact numeric values have readable hints");
	action("review").click();
	check(calls.pop()?.revision === 12, "only the explicit review button proposes the saved revision");
	check(field("tactic-1-binding").selectedIndex === 2, "the saved binding matches the complete tuple, not only revision and digest");
	const purpose = field("purpose");
	check(purpose.labels[0].textContent === "Purpose" && purpose.value.includes("\\u000D\\u000A\\u202E a\\u00A0b \\\\u000A"), "native labels and reversible text escapes");
	edit("purpose", `Updated ${purpose.value} \\uD800 \\u{DFFF} \\u{1F4A1}`);
	action("review").click();
	check(calls.pop() === "dirty" && !calls.length, "local edits cannot propose the saved revision");
	action("save").click();
	const saved = calls.pop();
	check(saved.revision === 12 && saved.submitted.overall.purpose === `Updated ${terms.overall.purpose} \\uD800 \\u{DFFF} 💡`,
		"authored surrogate escapes stay literal while valid scalar escapes decode");
	check(JSON.stringify({ ...saved.submitted, overall: { ...saved.submitted.overall, purpose: terms.overall.purpose } }) === JSON.stringify(terms), "untouched term lists, exact binding and timestamp are not normalized");
	edit("tactic-1-deadline", "");
	check(hint(deadline).hidden, "an empty optional deadline has no date preview");
	edit("tactic-1-deadline", "1893456000124");
	check(hint(deadline).textContent === "2030-01-01T00:00:00.124Z", "changing the raw deadline updates the hint immediately");
	edit("tactic-1-deadline", "1893456000123");

	action("strategy-add").click();
	check(field("strategy-2-id").value === "", "new strategies do not get generated plan IDs");
	edit("strategy-2-id", "verify-release");
	action("strategy-add").click();
	check(action("strategy-add").disabled, "at most three strategies can be authored");
	for (let count = 0; count < 4; count++) action("tactic-add").click();
	check(action("tactic-add").disabled && field("tactic-6-id").value === "", "at most six tactics can be authored; new IDs are blank");
	for (let row = 3; row <= 6; row++) action(`tactic-${row}-remove`).click();
	action("strategy-3-remove").click();
	edit("tactic-2-strategic", "verify-release");
	edit("tactic-2-mode", "runnable");
	check(!field("tactic-2-binding").value, "Runnable never defaults to an agreed purpose");
	action("save").click();
	check(!calls.length, "there is no runnable save without an explicit purpose choice");
	edit("tactic-2-binding", "0");
	action("save").click();
	check(!calls.length && editor.root.textContent.includes("Only one tactic can be runnable"), "a second runnable tactic cannot be saved");
	edit("tactic-1-mode", "planned");
	action("save").click();
	const next = calls.pop().submitted;
	check(next.tacticals[0].binding === null && next.tacticals[1].binding.missionId === alternate.missionId &&
		next.tacticals[1].strategic === "verify-release" && next.strategics[1].id === "verify-release", "changing modes clears the outgoing binding and saving preserves authored ancestry and the selected tuple");

	const cadence = field("review-every");
	cadence.focus();
	cadence.select();
	document.execCommand("insertText", false, "1e");
	check(cadence.validity.badInput, "Chromium keeps a partial exponent outside the value property");
	editor.update({ canSave: false, canReview: false });
	action("save").click();
	action("review").click();
	check(!calls.length && document.activeElement === cadence && field("review-every") === cadence && cadence.validity.badInput && purpose.value.startsWith("Updated "), "stale access disables writes without replacing raw edits or focus");
	document.execCommand("insertText", false, "2");
	check(cadence.valueAsNumber === 100, "native caret and raw numeric input survive stale access");

	mount(createMissionPlanDraftEditor({ ...initial, bindings: [alternate], draft: { ...initial.draft, missing: ["scope"] } }).root);
	check(action("review").disabled && !field("tactic-1-binding").value && document.body.textContent.includes("Current binding is not one of the allowed choices"), "incomplete terms cannot be proposed and an unlisted binding is not substituted");
	edit("scope", "Changes");
	check(calls.pop() === "dirty", "a new edit is local");
	action("save").click();
	check(!calls.length, "an unlisted binding cannot be submitted on a newly edited draft");

	const proposedEditor = mount(createMissionPlanDraftEditor({ ...initial, draft: { ...initial.draft, status: "proposed" } }).root);
	check(action("save").disabled && action("review").disabled && proposedEditor.textContent.includes("Editing proposed revision 12") &&
		proposedEditor.textContent.includes("must be proposed again") && !proposedEditor.textContent.includes("No plan draft saved yet."),
		"editing a proposal does not offer an unchanged save or claim the draft is unsaved");
	edit("scope", "Scope for the next revision");
	action("save").click();
	check(calls.pop()?.revision === 12 && calls.pop() === "dirty", "a changed proposal saves against its original revision");

	const digest = "a".repeat(64);
	const baseDigest = "c".repeat(64);
	const proposed = {
		missionId: "charter-001", draft: { revision: 12, baseRevision: 10, digest, terms, fromReview: "review-42", status: "proposed", missing: [], savedBy: "bob" },
		head: { revision: 10, digest: baseDigest, receiptId: "receipt-10",
			terms: { ...terms, overall: { ...terms.overall, scope: "Prior exact scope\n" } } },
		currentEffect: "suspended", gate: { state: "closed", reason: "reopen-needed" }, authority: "developer-local",
		creator: { kind: "human", id: "creator-42" }, session: "default", authorityRevision: 11,
		approval: { kind: "web", revision: 12, digest, onAgree: (exact) => calls.push(exact) },
	};
	const card = mount(renderMissionPlanDraftCard(proposed));
	fit(card);
	const diff = [...card.querySelectorAll("details")].find((node) => node.firstChild.textContent === "Diff from base revision 10");
	diff.open = true;
	check(diff.innerText.includes('Prior exact scope\\u000A') && diff.innerText.includes("This workspace only") &&
		diff.innerText.includes("Affected tactics") && diff.innerText.includes('"build"'), "the agreement card shows the exact base diff and descendants");
	fit(card);
	check(!calls.length && !card.querySelector("img") && !window.ran, "projected proposal is literal, and rendering grants nothing");
	const facts = (label) => [...card.querySelectorAll("dt")].filter((dt) => dt.textContent === label).map((dt) => dt.nextElementSibling.textContent);
	for (const [label, values] of Object.entries({
		"Mission ID": ['"charter-001"'], "Plan revision": ["12"], "Base revision": ["10"],
		"Previous plan digest (SHA-256)": [`"${baseDigest}"`], "Base approval receipt": ['"receipt-10"'], "Proposed digest (SHA-256)": [`"${digest}"`],
		"Saved by": ['"Bob"'], "Drafted from review": ['"review-42"'], "Current privileged effect": ['"suspended"'], "Current plan admission": ['"closed"'],
		"Admission reason": ['"reopen-needed"'], "Authority revision": ["11"], "Creator ID": ['"creator-42"'], Session: ['"default"'],
		Scope: ['"This workspace only"'], "Ask first": ['"publish\\u000Aexternally"""'], "Review interval (milliseconds)": ["604800001"],
		"Strategy ID": ['"release-goal"'], Title: ['"Release"'], Intent: ['"Publish checked artifacts"'],
		"Success signals (reviewed, not host-verified)": ['"No missed releases \\uD800 \\\\uD800"'], Priority: ['"high"', '"low"', '"normal"'],
		"Tactic ID": ['"build"', '"audit"'], "Parent strategy ID": ['"release-goal"', '"release-goal"'],
		Objective: ['"Package the build"', '"Audit the build"'], "Success criteria": ['"bundle verifies"', '"review recorded"'],
		"Deadline (UTC, milliseconds since Unix epoch)": ["1893456000123", "None"], Mode: ['"runnable"', '"parked"'],
		"Bound mission ID": ['"purpose-2"', "None"], "Bound purpose revision": ["7", "None"], "Bound purpose digest (SHA-256)": [`"${binding.purposeDigest}"`, "None"],
	})) check(JSON.stringify(facts(label)) === JSON.stringify(values), `exact review fact ${label}: ${facts(label)}`);
	check(facts("Purpose")[0].includes("\\u000D\\u000A\\u202E a\\u00A0b \\\\u000A"), "review makes Unicode and control differences visible");
	check([...card.querySelectorAll("button")].every((button) => !/open|start/i.test(button.textContent)), "the card contains no Open or Start action");
	agree().click();
	check(JSON.stringify(calls.pop()) === JSON.stringify({ revision: 12, digest }), "the single explicit Agree callback targets the exact rendered proposal");

	mount(renderMissionPlanDraftCard({ ...proposed, authority: "managed-administrator" }));
	check(!agree(), "managed authority never shows browser Agree, even if presented a web callback");
	const line = `sudo release-bob mission plan approve --revision 12 --digest ${digest}`;
	const terminal = { ...proposed, authority: "managed-administrator", approval: {
		kind: "terminal", revision: 12, digest, line, copy: async (line) => { calls.push(line); return false; },
	} };
	const terminalCard = mount(renderMissionPlanDraftCard(terminal));
	fit(terminalCard);
	check(!agree() && document.querySelector("code").textContent === line && !calls.length, "managed terminal fallback targets the full current digest without browser assent");
	action("copy-approval").click();
	check(calls.pop() === line, "fallback copies the exact command without agreeing");
	const localLine = `agent mission plan approve --revision 12 --digest ${digest}`;
	mount(renderMissionPlanDraftCard({ ...terminal, authority: "developer-local", approval: { ...terminal.approval, line: localLine } }));
	check(!agree() && document.querySelector("code").textContent === localLine, "developer-local without browser agreement has its own exact terminal command");
	action("copy-approval").click();
	check(calls.pop() === localLine, "local terminal fallback is also copy-only");
	for (const changed of [
		{ approval: { ...terminal.approval, digest: baseDigest } },
		{ head: { ...terminal.head, revision: 11 } },
		{ draft: { ...terminal.draft, status: "editing", digest: null } },
		{ approval: { kind: "unavailable" } },
	]) {
		mount(renderMissionPlanDraftCard({ ...terminal, ...changed }));
		check(!agree() && !document.querySelector("code") && document.body.textContent.includes(terms.overall.scope), "stale or withheld approval retains exact terms but offers no command");
	}
}

test("Charter editor preserves raw edits and only offers exact explicit agreement", { skip: !executable, timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-web-mission-plan-draft-"));
	try {
		buildTailwind(join(directory, "style.css"), true);
		await build({
			stdin: {
				contents: `import { createMissionPlanDraftEditor, renderMissionPlanDraftCard } from './web/views/mission-plan-draft.ts';
				const width = Number(frameElement.dataset.width);
				const result = parent.document.querySelector('#result-' + width);
				try { (${exercise.toString()})(width); result.textContent = 'PLAN-DRAFT-PASSED'; }
				catch (error) { result.textContent = error.stack; }`,
				resolveDir: app,
			},
			bundle: true,
			outfile: join(directory, "fixture.js"),
		});
		await writeFile(join(directory, "fixture.html"), '<!doctype html><html lang="en"><head><link rel="stylesheet" href="style.css"></head><body style="margin:0"><script src="fixture.js" defer></script></body></html>');
		const page = join(directory, "index.html");
		await writeFile(page, `<!doctype html><html lang="en"><body>${[320, 1280].map((width) =>
			`<output id="result-${width}">Incomplete</output><iframe title="${width}px charter" data-width="${width}" width="${width}" height="700" src="fixture.html"></iframe>`).join("")}</body></html>`);
		const { stdout } = await run(executable, ["--headless=new", "--no-first-run", "--allow-file-access-from-files", `--user-data-dir=${join(directory, "profile")}`,
			"--window-size=1440,900", "--virtual-time-budget=2500", "--dump-dom", pathToFileURL(page).href], { timeout: 25_000 });
		for (const width of [320, 1280]) assert.match(stdout, new RegExp(`<output id="result-${width}">PLAN-DRAFT-PASSED</output>`));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
