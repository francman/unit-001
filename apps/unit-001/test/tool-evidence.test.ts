// #26: tool evidence is bounded, redacted, withheld by provenance, and projected only from committed entries on request.
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	environmentSecrets,
	REDACTION_SOURCE_LIMIT,
	redactArguments,
	redactEvidenceText,
} from "../src/evidence-redaction.ts";
import { PROVENANCE_KEY } from "../src/file-provenance.ts";
import { redactImplementationText } from "../src/introspection/files.ts";
import {
	EVIDENCE_LIMITS,
	type EvidenceScope,
	evidenceLines,
	parseToolEvidence,
	projectToolEvidence,
	type ToolEvidence,
} from "../src/tool-evidence.ts";

const SECRETS = [
	"sk-ant-api03-ABCDEFGHIJKLMNOP1234",
	"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
	"dXNlcjpwYXNzd29yZA==",
	"hunter2hunter2",
	"AKIAIOSFODNN7EXAMPLE",
	"pa55word-in-url",
	"plain-api-value",
	"cookie-session-value",
	"env-literal-secret-value",
];

const leaked = (value: unknown): string[] => SECRETS.filter((secret) => JSON.stringify(value).includes(secret));

const secretText = [
	"ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOP1234",
	"token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
	"Authorization: Basic dXNlcjpwYXNzd29yZA==",
	"curl --password hunter2hunter2 https://example.test",
	"aws AKIAIOSFODNN7EXAMPLE",
	"postgres://user:pa55word-in-url@db.example/app",
	"Set-Cookie: session=cookie-session-value; Path=/",
	"printed env-literal-secret-value in prose",
].join("\n");

let workspace: string;
let scope: EvidenceScope;
beforeAll(async () => {
	workspace = await realpath(await mkdtemp(join(tmpdir(), "u1-provenance-")));
	await writeFile(join(workspace, ".env"), "SESSION_SIGNING=Zx9qQ8vL2mN4pR6s\n");
	await writeFile(join(workspace, "notes.txt"), "plain notes\n");
	await symlink(join(workspace, ".env"), join(workspace, "innocent.txt"));
	await mkdir(join(workspace, "managed"));
	await writeFile(join(workspace, "managed", "environment"), "PROVIDER=x\n");
	scope = { cwd: workspace, secrets: [], credentialRoots: [join(workspace, "managed")] };
});
afterAll(async () => {
	await rm(workspace, { recursive: true, force: true });
});

const withSecrets = (secrets: readonly string[]): EvidenceScope => ({ ...scope, secrets });

function call(id: number, callId: string, name: string, args: object): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] }],
	} as unknown as EntryRecord;
}

function result(
	id: number,
	callId: string,
	text: string | readonly string[],
	options: { isError?: boolean; details?: object; diagnostics?: readonly object[] } = {},
) {
	return {
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				isError: options.isError ?? false,
				content: (typeof text === "string" ? [text] : text).map((part) => ({ type: "text", text: part })),
				...(options.details === undefined ? {} : { details: options.details }),
			},
		],
		data: { diagnostics: options.diagnostics ?? [] },
	} as unknown as EntryRecord;
}

// The details a recorded file tool stores (`file-provenance.ts`): the path it opened, the file that was then, and that
// the call did not find a credential location.
const recorded = (path: string, resolved: string | null = path, extra: object = {}) => ({
	...extra,
	[PROVENANCE_KEY]: { files: [{ path, resolved, credential: false }], complete: true },
});

const found = (evidence: ToolEvidence) => {
	if (evidence.kind !== "found") throw new Error(`Expected evidence, got ${evidence.reason}`);
	return evidence;
};

// One call and its result, projected by its ID.
async function project(name: string, args: object, output: string | readonly string[], options = {}, at = scope) {
	return found(await projectToolEvidence([result(2, "call-under-test", output, options), call(1, "call-under-test", name, args)], "call-under-test", at));
}

describe("tool evidence projection", () => {
	it("redacts secret samples from arguments, output and diff", async () => {
		const entries = [
			result(2, "call-secret-1", secretText, { details: { diff: `+${secretText}` } }),
			call(1, "call-secret-1", "bash", {
				command: "curl --password hunter2hunter2 -H 'Authorization: Basic dXNlcjpwYXNzd29yZA==' x",
				apiKey: "plain-api-value",
				nested: { items: [{ secretToken: "plain-api-value" }] },
			}),
		];
		const evidence = found(await projectToolEvidence(entries, "call-secret-1", withSecrets(["env-literal-secret-value"])));
		expect(leaked(evidence)).toEqual([]);
		expect(evidence.arguments.redacted).toBe(true);
		expect(evidence.output?.redacted).toBe(true);
		expect(evidence.diff?.redacted).toBe(true);
		expect(evidence.status).toBe("succeeded");
		expect(evidence.output?.text).toContain("[redacted");
		expect(leaked(evidenceLines(evidence))).toEqual([]);
	});

	it("cuts each field to its limit after redaction and never half-shows a secret at the cut", async () => {
		const padding = "a".repeat(EVIDENCE_LIMITS.output - 8);
		const long = await project("bash", {}, `${padding}ghp_abcdefghijklmnopqrstuvwxyz0123456789${"b".repeat(9000)}`);
		expect(Buffer.byteLength(long.output?.text ?? "")).toBeLessThanOrEqual(EVIDENCE_LIMITS.output);
		expect(long.output?.truncated).toBe(true);
		expect(long.output?.bytes).toBeGreaterThan(EVIDENCE_LIMITS.output);
		expect(long.output?.text).not.toContain("ghp_");
		const multibyte = await project("bash", {}, "€".repeat(5000));
		expect(Buffer.byteLength(multibyte.output?.text ?? "")).toBeLessThanOrEqual(EVIDENCE_LIMITS.output);
		expect(multibyte.output?.text).not.toContain("�");
		const big = found(await projectToolEvidence([call(1, "call-args-1", "bash", { content: "x".repeat(10_000) })], "call-args-1", scope));
		expect(Buffer.byteLength(big.arguments.text)).toBeLessThanOrEqual(EVIDENCE_LIMITS.arguments);
		expect(big.arguments.truncated).toBe(true);
	});

	it("cuts call IDs and names without leaving half a surrogate pair (decision 7)", async () => {
		const id = `${"a".repeat(199)}😀`;
		const evidence = found(await projectToolEvidence([call(1, id, `${"n".repeat(127)}😀`, {})], id, scope));
		expect(evidence.callId).toBe("a".repeat(199));
		expect(evidence.name).toBe("n".repeat(127));
	});

	it("reports pending calls, failed calls, diffs and images without raw image data", async () => {
		const pending = found(await projectToolEvidence([call(1, "call-pending-1", "bash", { command: "sleep 1" })], "call-pending-1", scope));
		expect(pending).toMatchObject({ status: "pending", output: null, diff: null, withheld: null, sourceTruncated: false });
		const notes = join(workspace, "notes.txt");
		const failed = await project("edit", { path: "notes.txt" }, "exit 1", {
			isError: true,
			details: recorded(notes, notes, { diff: "-a\n+b" }),
		});
		expect(failed).toMatchObject({ status: "failed", diff: { text: "-a\n+b" }, redaction: "classified" });
		const image = {
			...result(3, "call-image-1", ""),
			model: [
				{
					role: "toolResult",
					toolCallId: "call-image-1",
					toolName: "read",
					isError: false,
					content: [{ type: "image", data: "AAAABASE64" }],
					details: recorded(notes),
				},
			],
		} as unknown as EntryRecord;
		const shown = found(await projectToolEvidence([image, call(1, "call-image-1", "read", {})], "call-image-1", scope));
		expect(shown.output?.text).toBe("[image omitted]");
	});

	it("selects by exact ID or unique prefix, newest reused ID first, and refuses short or ambiguous IDs", async () => {
		const entries = [
			result(6, "toolu_reused", "second output"),
			call(5, "toolu_reused", "bash", { command: "second" }),
			call(4, "toolu_other_two", "bash", {}),
			result(3, "toolu_reused", "first output"),
			call(2, "toolu_reused", "bash", { command: "first" }),
			call(1, "toolu_other_one", "bash", {}),
		];
		const latest = found(await projectToolEvidence(entries, "toolu_reused", scope));
		expect(latest.output?.text).toBe("second output");
		expect(latest.arguments.text).toContain("second");
		expect(found(await projectToolEvidence(entries, "toolu_reu", scope)).callId).toBe("toolu_reused");
		expect(await projectToolEvidence(entries, "toolu_o", scope)).toEqual({ kind: "unavailable", reason: "ambiguous" });
		expect(await projectToolEvidence(entries, "toolu", scope)).toEqual({ kind: "unavailable", reason: "not-found" });
		expect(await projectToolEvidence(entries, "missing-call", scope)).toEqual({ kind: "unavailable", reason: "not-found" });
	});

	it("validates owner replies at the wire boundary", async () => {
		const evidence = await project("bash", {}, "ok");
		expect(parseToolEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
		const field = { text: "x".repeat(EVIDENCE_LIMITS.output + 1), bytes: 1, truncated: false, redacted: false };
		expect(() => parseToolEvidence({ ...evidence, output: field })).toThrow("Invalid tool evidence field.");
		expect(() => parseToolEvidence({ ...evidence, status: "other" })).toThrow("Invalid tool evidence.");
		expect(() => parseToolEvidence({ ...evidence, redaction: undefined })).toThrow("Invalid tool evidence.");
		expect(() => parseToolEvidence({ ...evidence, sourceTruncated: "no" })).toThrow("Invalid tool evidence.");
		expect(() => parseToolEvidence({ kind: "unavailable", reason: "other" })).toThrow("Invalid tool evidence.");
	});

	it("keeps owner strings terminal-safe, including bidi controls in names (sec-ipc Low 2)", async () => {
		const evidence = found(
			await projectToolEvidence(
				[result(2, "call-escape-1", "\x1b]0;title\x07shown"), call(1, "call-escape-1", "re‮ad​", {})],
				"call-escape-1",
				scope,
			),
		);
		const lines = evidenceLines(evidence).join("\n");
		expect(lines).not.toContain("\x1b");
		expect(lines).not.toMatch(/[‮​]/);
		expect(lines).toContain("Evidence · read ·");
	});
});

describe("withholding by provenance (decision 2)", () => {
	it("withholds content-bearing arguments of write and edit on a credential file (review H1)", async () => {
		const value = "Zx9qQ8vL2mN4pR6s";
		for (const [name, args] of [
			["write", { path: ".env", content: `SESSION_SIGNING=${value}\n` }],
			["edit", { path: ".env", oldText: "SESSION_SIGNING=old", newText: `SESSION_SIGNING=${value}` }],
			["edit", { path: ".env", edits: [{ oldText: "SESSION_SIGNING=old", newText: `SESSION_SIGNING=${value}` }] }],
		] as const) {
			const evidence = await project(name, args, `Wrote .env: SESSION_SIGNING=${value}`, { details: { diff: `+${value}` } });
			expect(evidence.withheld).toBe("credential-path");
			expect(evidence.output).toBeNull();
			expect(evidence.diff).toBeNull();
			expect(JSON.stringify(evidence)).not.toContain(value);
			expect(JSON.parse(evidence.arguments.text)).toMatchObject({ path: ".env" });
			expect(evidence.arguments.text).toContain("[withheld]");
		}
	});

	it("classifies a file tool by the file it recorded, through symlinks and configured roots", async () => {
		// `innocent.txt` is a symlink to `.env`: the spelling looks public, the file is not.
		const innocent = join(workspace, "innocent.txt");
		const secret = "SESSION_SIGNING=Zx9qQ8vL2mN4pR6s";
		const aliased = await project("read", { path: "innocent.txt" }, secret, {
			details: recorded(innocent, join(workspace, ".env")),
		});
		expect(aliased).toMatchObject({ withheld: "credential-path", output: null, redaction: "classified" });
		const environment = join(workspace, "managed", "environment");
		const managed = await project("read", { path: environment }, "PROVIDER=x", { details: recorded(environment) });
		expect(managed).toMatchObject({ withheld: "credential-path", output: null });
		const notes = join(workspace, "notes.txt");
		const plain = await project("read", { path: "notes.txt" }, "plain notes", { details: recorded(notes) });
		expect(plain).toMatchObject({ withheld: null, redaction: "classified", output: { text: "plain notes" } });
		expect(evidenceLines(plain).join("\n")).not.toContain("pattern-only");
	});

	// #26 second review, finding 1: an alias retargeted after the call must not turn credential output into "classified".
	it("withholds by the file used at execution even when the path now resolves to an ordinary file", async () => {
		const alias = join(workspace, "retargeted.txt");
		await symlink(join(workspace, "notes.txt"), alias);
		try {
			const secret = "SESSION_SIGNING=Zx9qQ8vL2mN4pR6s";
			const evidence = await project("read", { path: "retargeted.txt" }, secret, {
				details: recorded(alias, join(workspace, ".env")),
			});
			expect(evidence).toMatchObject({ withheld: "credential-path", output: null });
			expect(JSON.stringify(evidence)).not.toContain("Zx9qQ8vL2mN4pR6s");
		} finally {
			await unlink(alias);
		}
	});

	it("withholds content when the record is missing, unresolved, incomplete or contradicted by the file system", async () => {
		const notes = join(workspace, "notes.txt");
		const write = { path: "notes.txt", content: "SOME_PLAIN_NAME=value-no-pattern-matches-this" };
		const cases: [string, object | undefined][] = [
			// An entry from before recording, or a pending call, has no record.
			["missing", undefined],
			["unresolved", recorded(notes, null)],
			["incomplete", { [PROVENANCE_KEY]: { files: [{ path: notes, resolved: notes, credential: false }], complete: false } }],
			// A record without the decision taken when the call ran (written before it was kept) cannot be trusted.
			["undecided", { [PROVENANCE_KEY]: { files: [{ path: notes, resolved: notes }], complete: true } }],
			// The record names another file than the path resolves to now; it cannot be checked, so it is not trusted.
			["contradicted", recorded(notes, join(workspace, "elsewhere.txt"))],
		];
		for (const [label, details] of cases) {
			const evidence = await project("write", write, "Successfully wrote", details === undefined ? {} : { details });
			expect(evidence, label).toMatchObject({ withheld: "unverified-file", output: null, diff: null });
			expect(JSON.stringify(evidence), label).not.toContain("value-no-pattern");
			expect(JSON.parse(evidence.arguments.text), label).toEqual({ path: "notes.txt", content: "[withheld]" });
			expect(evidenceLines(evidence).join("\n"), label).toContain("cannot be established from its record");
		}
		const pending = found(
			await projectToolEvidence([call(1, "call-pending-2", "write", write)], "call-pending-2", scope),
		);
		expect(pending).toMatchObject({ status: "pending", withheld: "unverified-file" });
		expect(pending.arguments.text).not.toContain("value-no-pattern");
	});

	it("keeps a record whose file was removed since, and matches a root that does not exist through its parent", async () => {
		const removed = join(workspace, "removed.txt");
		const gone = await project("read", { path: "removed.txt" }, "old contents", { details: recorded(removed) });
		expect(gone).toMatchObject({ withheld: null, redaction: "classified", output: { text: "old contents" } });
		// The root is spelled through a symlinked parent and does not exist; the file was recorded under its real path.
		await symlink(workspace, join(workspace, "linked-parent"));
		try {
			const at = { ...scope, credentialRoots: [join(workspace, "linked-parent", "absent-root")] };
			const inside = join(workspace, "absent-root", "token");
			const evidence = await project("read", { path: inside }, "x", { details: recorded(inside) }, at);
			expect(evidence.withheld).toBe("credential-path");
		} finally {
			await unlink(join(workspace, "linked-parent"));
		}
	});

	// #26 final verification, finding 2: the root decision is the call's, so a root retargeted since cannot clear it.
	it("keeps the credential decision recorded at execution when the configured root now resolves elsewhere", async () => {
		const token = join(workspace, "former-root", "token");
		const at = { ...scope, credentialRoots: [join(workspace, "root-alias")] };
		await symlink(join(workspace, "notes-dir-that-is-not-a-root"), join(workspace, "root-alias"));
		try {
			const details = { [PROVENANCE_KEY]: { files: [{ path: token, resolved: token, credential: true }], complete: true } };
			const evidence = await project("read", { path: token }, "SOME_PLAIN_NAME=value-no-pattern-matches-this", { details }, at);
			expect(evidence).toMatchObject({ withheld: "credential-path", output: null, redaction: "classified" });
			expect(JSON.stringify(evidence)).not.toContain("value-no-pattern");
		} finally {
			await unlink(join(workspace, "root-alias"));
		}
	});

	it("withholds the credential locations the review found missing (review L3)", async () => {
		for (const path of [
			"/home/bob/.env",
			"/app/.env.production",
			"config/prod.env",
			"/srv/app/staging.env",
			"~/.aws/credentials",
			"/home/bob/.ssh/id_ed25519",
			"deploy/server.pem",
			"/home/bob/.config/gh/hosts.yml",
			"infra/terraform.tfstate",
			"/home/bob/kubeconfig",
			"/home/bob/.kube/prod",
			"/home/bob/.docker/config.json",
			"/home/bob/.netrc",
			"/home/bob/.git-credentials",
			"/home/bob/.npmrc",
			"/home/bob/.pypirc",
			"/etc/unit-001/agents/a/environment",
		]) {
			const at = { ...scope, credentialRoots: ["/etc/unit-001"] };
			const evidence = await project("read", { path }, "SOME_PLAIN_NAME=value-no-pattern-matches-this", {}, at);
			expect(evidence.withheld, path).toBe("credential-path");
			expect(JSON.stringify(evidence)).not.toContain("value-no-pattern");
		}
	});

	it("labels opaque tools pattern-only, shows their redacted output, and withholds an obvious credential name", async () => {
		const shell = await project("bash", { command: "make test" }, "ok: token=abc123secret");
		expect(shell).toMatchObject({ withheld: null, redaction: "pattern-only" });
		expect(shell.output?.text).toBe("ok: token=[redacted]");
		expect(evidenceLines(shell).join("\n")).toContain("Redaction: pattern-only (source unclassified)");
		const spelled = await project("bash", { command: "echo SESSION_SIGNING=Zx9qQ8vL2mN4pR6s >> config/prod.env" }, "");
		expect(spelled).toMatchObject({ withheld: "credential-path", output: null });
		expect(JSON.stringify(spelled)).not.toContain("Zx9qQ8vL2mN4pR6s");
		expect(evidenceLines(spelled).join("\n")).toContain("withheld, the call used a credential file");
	});

	it("says when the tool's output was already truncated upstream", async () => {
		const diagnostics = [{ severity: "warn", code: "truncated", message: "Output truncated to its end: 9 lines dropped" }];
		const evidence = await project("bash", { command: "cat big.log" }, "tail", { diagnostics });
		expect(evidence.sourceTruncated).toBe(true);
		expect(evidenceLines(evidence).join("\n")).toContain("truncated before evidence saw it");
		expect((await project("bash", {}, "whole")).sourceTruncated).toBe(false);
	});
});

describe("argument redaction before serialization (decision 3)", () => {
	it("redacts string leaves before JSON escaping and visits arrays", async () => {
		const secret = 'quote"secret\\value-1234';
		const evidence = found(
			await projectToolEvidence(
				[call(1, "call-escape-2", "bash", { note: `x ${secret} y`, list: ["a", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"] })],
				"call-escape-2",
				withSecrets([secret]),
			),
		);
		expect(evidence.arguments.text).not.toContain("secret\\\\value");
		expect(evidence.arguments.text).not.toContain("ghp_");
		expect(JSON.parse(evidence.arguments.text)).toEqual({ note: "x [redacted] y", list: ["a", "[redacted credential]"] });
	});

	it("withholds a subtree past the depth limit instead of returning it unredacted (review L4)", async () => {
		let nested: object = { auth: "deep-cookie-credential-value" };
		for (let level = 0; level < 10; level++) nested = { level: nested };
		const projected = redactArguments(nested as JsonValue, []);
		expect(JSON.stringify(projected.value)).not.toContain("deep-cookie-credential-value");
		expect(JSON.stringify(projected.value)).toContain("[withheld: too deep]");
		expect(projected.redacted).toBe(true);
		// Arguments too deep to scan for a credential name cannot clear the call, so its output is withheld too.
		const evidence = found(await projectToolEvidence([call(1, "call-deep-1", "bash", nested)], "call-deep-1", scope));
		expect(JSON.stringify(evidence)).not.toContain("deep-cookie-credential-value");
		expect(evidence.withheld).toBe("credential-path");
	});

	it("joins adjacent output blocks as Durable does, so a split secret is still recognized", async () => {
		const evidence = await project("bash", {}, ["key ghp_abcdefghij", "klmnopqrstuvwxyz0123456789 end"]);
		expect(evidence.output?.text).toBe("key [redacted credential] end");
	});
});

describe("bounded redaction work (decision 4)", () => {
	const size = 1_000_000;
	const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

	it.each([
		["eyJ runs without dots", fill("eyJ")],
		["one long eyJ run", `eyJ${"a".repeat(size)}`],
		["near-miss JWTs", fill("eyJaaaa.bbbb ")],
		["near-miss name=value keys", fill("token-")],
		["dash runs", fill("a-")],
		["password flags", fill("--password")],
		["unterminated quotes", fill('token="')],
		["header names", fill('Cookie: "')],
		["mysql prefixes", fill("mysql ")],
		["userinfo prefixes", fill("://a:")],
		["private key headers", fill("-----BEGIN RSA PRIVATE KEY-----")],
		// #26 second review, finding 4: values are consumed whole, so these scans must stay linear too.
		["one dotted run", fill("a.")],
		["dotted eyJ segments", fill("eyJa.")],
		["double-dot restarts", fill("..eyJaaaa")],
		["unterminated quoted flags", fill('--token "')],
		["quoted curl users", fill('-u "a')],
		["long unquoted userinfo", `://${"u".repeat(size)}`],
		["credential keys", fill('"auth": "')],
	])("redacts 1 MB of %s in under 100 ms", (_name, text) => {
		redactEvidenceText(text.slice(0, 1000), []);
		const started = performance.now();
		redactEvidenceText(text, ["env-literal-secret-value"]);
		expect(performance.now() - started).toBeLessThan(100);
	});

	it("withholds an oversized output or argument before reading it", async () => {
		const huge = `SESSION_SIGNING=${"z".repeat(REDACTION_SOURCE_LIMIT)}`;
		const started = performance.now();
		const output = await project("bash", {}, huge);
		expect(output.output).toMatchObject({ text: "[withheld: too large to redact]", truncated: true, redacted: true });
		expect(JSON.stringify(redactArguments({ command: huge }, []).value)).toBe('{"command":"[withheld: too large]"}');
		// An argument too large to scan for a credential name withholds the whole call.
		const args = found(await projectToolEvidence([call(1, "call-huge-1", "bash", { command: huge })], "call-huge-1", scope));
		expect(args).toMatchObject({ withheld: "credential-path", output: null });
		expect(args.arguments.text).not.toContain("zzzz");
		expect(performance.now() - started).toBeLessThan(500);
	});

	// #26 second review, finding 3: work is bounded by structure (keys, items, blocks), not only by text.
	it("bounds work on wide arguments and many output blocks before walking or copying them", async () => {
		const wideObject: Record<string, JsonValue> = { path: "notes.txt" };
		for (let index = 0; index < 200_000; index++) wideObject[`k${index}`] = index;
		const wideArray = Array.from({ length: 1_000_000 }, (_, index) => index);
		const images = {
			...result(2, "call-images-1", ""),
			model: [
				{
					role: "toolResult",
					toolCallId: "call-images-1",
					toolName: "bash",
					isError: false,
					content: Array.from({ length: 100_000 }, () => ({ type: "image", data: "AAAA" })),
				},
			],
		} as unknown as EntryRecord;
		const started = performance.now();
		// Too wide to scan for a credential name: the opaque call is withheld, without copying every key.
		const object = found(await projectToolEvidence([call(1, "call-wide-1", "bash", wideObject)], "call-wide-1", scope));
		expect(object.withheld).toBe("credential-path");
		expect(object.arguments.text).toContain("[withheld: more arguments]");
		const array = found(
			await projectToolEvidence([call(1, "call-wide-2", "bash", { values: wideArray })], "call-wide-2", scope),
		);
		expect(array.withheld).toBe("credential-path");
		expect(redactArguments({ values: wideArray }, []).value).toMatchObject({
			values: expect.arrayContaining(["[withheld: too large]"]),
		});
		const blocks = found(await projectToolEvidence([images, call(1, "call-images-1", "bash", {})], "call-images-1", scope));
		expect(blocks.output).toMatchObject({ text: "[withheld: too large to redact]", truncated: true });
		expect(performance.now() - started).toBeLessThan(250);
	});
});

describe("evidence redaction", () => {
	it("redacts literal secret-named environment values and keeps unrelated values", () => {
		const secrets = environmentSecrets({
			PROVIDER_API_KEY: "env-literal-secret-value",
			GIT_AUTHOR_NAME: "Frank Manu Example",
			SHORT_TOKEN: "short",
			PATH: "/usr/bin:/bin",
		});
		expect(secrets).toEqual(["env-literal-secret-value"]);
		expect(redactEvidenceText("a env-literal-secret-value b", secrets)).toBe("a [redacted] b");
		expect(redactEvidenceText("Frank Manu Example", secrets)).toBe("Frank Manu Example");
	});

	it("redacts further provider token shapes and URL query credentials", () => {
		const text = [
			"AIzaSyA1234567890abcdefghijklmnopqrstuv",
			"sk_live_abcdefghijklmnop1234",
			"npm_abcdefghijklmnopqrstuvwxyz0123456789",
			"hf_abcdefghijklmnopqrstuvwxyz0123456789",
			"glpat-abcdefghijklmnopqrstuv",
			"https://api.example.test/v1?user=a&access_token=query-secret-value&page=2",
			"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlXzEyMw done",
		].join("\n");
		const cleaned = redactEvidenceText(text, []);
		for (const sample of ["AIzaSy", "sk_live_", "npm_abc", "hf_abc", "glpat-", "query-secret-value", "eyJhbGci"])
			expect(cleaned).not.toContain(sample);
		// The name=value rule takes the rest of the line, which errs toward hiding.
		expect(cleaned).toContain("?user=a&access_token=[redacted]");
		expect(redactEvidenceText("GET /v1?user=a&key=abc123&page=2 HTTP/1.1", [])).toBe("GET /v1?user=a&key=[redacted]&page=2 HTTP/1.1");
	});

	it("redacts header values to the end of the line", () => {
		expect(redactEvidenceText("Proxy-Authorization: Negotiate abc\nnext", [])).toBe("Proxy-Authorization: [redacted]\nnext");
	});

	it("redacts JSON-quoted headers and credential keys, kubeconfig data and CLI passwords (review M1)", () => {
		const cases: readonly (readonly [string, string, string])[] = [
			['{"headers":{"Authorization":"Basic dXNlcjpwYXNz","Host":"h"}}', "dXNlcjpwYXNz", '"Host":"h"'],
			['{"Cookie": "session=abc123"}', "abc123", "Cookie"],
			['{"auths":{"ghcr.io":{"auth":"dXNlcjpnaHBfc2VjcmV0"}}}', "dXNlcjpnaHBf", "ghcr.io"],
			['{"credentials": "opaque-credential-blob"}', "opaque-credential-blob", "credentials"],
			['{"private_key": "MIIEvQIBADANBg"}', "MIIEvQIBADANBg", "private_key"],
			["    client-key-data: LS0tLS1CRUdJTi1SU0E=", "LS0tLS1CRUdJTi", "client-key-data"],
			["    client-certificate-data: LS0tQ0VSVA==", "LS0tQ0VSVA", "client-certificate-data"],
			["curl -u admin:hunter2pass https://x", "hunter2pass", "https://x"],
			["curl --user admin:hunter2pass https://x", "hunter2pass", "https://x"],
			["mysql -h db -u root -pS3cretPass app", "S3cretPass", " app"],
		];
		for (const [text, secret, kept] of cases) {
			const cleaned = redactEvidenceText(text, []);
			expect(cleaned, text).not.toContain(secret);
			expect(cleaned, text).toContain(kept);
		}
		// Option values without a credential stay readable.
		for (const text of ["git push -u origin main", "sort -u file.txt", "mkdir -p /tmp/x", "ssh -p 2222 host"])
			expect(redactEvidenceText(text, [])).toBe(text);
	});

	// #26 second review, finding 4: once the syntax is found, no suffix of a long or unterminated value survives.
	it("consumes whole values at the old matcher limits", () => {
		const long = (unit: string, count: number) => unit.repeat(count);
		const cases: readonly (readonly [string, string])[] = [
			[`curl --password ${long("A", 20_000)}SECRETTAIL x`, "SECRETTAIL"],
			[`{"auth": "${long("x ", 5000)}SECRETTAIL"}`, "SECRETTAIL"],
			[`{"credentials": ${long("y", 9000)}SECRETTAIL}`, "SECRETTAIL"],
			[`client-key-data: "${long("z", 300)} SECRETTAIL`, "SECRETTAIL"],
			[`--token "abc def SECRETTAIL`, "SECRETTAIL"],
			[`password="${long("q", 9000)} SECRETTAIL"`, "SECRETTAIL"],
			[`curl -u admin:${long("p", 2000)}SECRETTAIL https://x`, "SECRETTAIL"],
			[`curl -u ${long("u", 300)}:SECRETTAIL https://x`, "SECRETTAIL"],
			[`curl -u "admin:pass ${long("w ", 600)}SECRETTAIL" https://x`, "SECRETTAIL"],
			[`mysql -h db -p${long("m", 300)}SECRETTAIL app`, "SECRETTAIL"],
			[`mysql -h db -p"pass ${long("m ", 200)}SECRETTAIL" app`, "SECRETTAIL"],
			[`https://user:${long("p", 2000)}SECRETTAIL@db.example/app`, "SECRETTAIL"],
			[`https://${long("u", 300)}:SECRETTAIL@db.example/app`, "SECRETTAIL"],
		];
		for (const [text, secret] of cases) expect(redactEvidenceText(text, []), text.slice(0, 40)).not.toContain(secret);
	});

	it("finds a JWT that starts inside a base64url run, here and in introspection excerpts", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlXzEyMw";
		for (const text of [`x${jwt}`, `_${jwt}`, `token-${jwt}`, `a..${jwt}`, `prefix.${jwt}.suffix`, `id=${jwt}`]) {
			expect(redactEvidenceText(text, []), text).not.toContain("c2lnbmF0dXJl");
			expect(redactImplementationText(text), text).not.toContain("c2lnbmF0dXJl");
		}
		for (const text of ["example.com", "src/file.test.ts", "v1.2.3", "eyJ.ab.cd", "a.b.c.d"])
			expect(redactEvidenceText(text, []), text).toBe(text);
	});
});
