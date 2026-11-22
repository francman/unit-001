// Redacts credential-shaped text and classifies credential locations before tool evidence leaves the owner; the boundary is docs/tool-evidence.md.
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";

/** Longest text, in UTF-16 code units, that redaction reads; a longer source is withheld unread, which bounds CPU. */
export const REDACTION_SOURCE_LIMIT = 262_144;

const CREDENTIAL_NAME = /^(?:\w*key|token|secret|password|passwd|credentials?|auth|authorization|cookie)$/i;

/** Literal values of this process's secret-named environment variables, for exact-match redaction. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(env))
		if (value !== undefined && value.length >= 8 && name.split(/[_-]/).some((part) => CREDENTIAL_NAME.test(part)))
			values.add(value);
	return [...values].sort((left, right) => right.length - left.length);
}

// A quoted value runs to its closing quote or, unterminated, to the end of its line. It never fails once the quote is
// seen, so a long or unterminated value is consumed whole by one scan instead of falling through to a shorter rule.
const QUOTED = String.raw`"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?`;

// Every rule is linear in its input: each match starts at a fixed literal or a run boundary, and only the search for
// the credential syntax before the value is bounded. Once the syntax is found the value is consumed whole, however
// long, so no suffix of it survives. `introspection/files.ts` keeps its own rules for bounded public files; these are
// a linear superset because evidence text is tool-controlled and redacted synchronously on the owner.
const RULES: readonly (readonly [RegExp, string])[] = [
	[/-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,64}PRIVATE KEY-----|$)/g, "[redacted private key]"],
	[
		/(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})/g,
		"[redacted credential]",
	],
	[/\bBearer[ \t]+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]"],
	// `name=value` and `"name": "value"`; the match starts at the keyword, so a long identifier is not rescanned.
	[
		new RegExp(
			String.raw`((?:api[_-]?key|token|password|passwd|secret)[A-Za-z0-9_-]{0,40}["']?\s{0,16}[=:]\s{0,16})(${QUOTED}|[^\r\n]+)`,
			"gi",
		),
		"$1[redacted]",
	],
	// The user part cannot contain `:` and the password cannot contain `/`, so a start scans only to the next `://`.
	[/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@"],
	[
		new RegExp(String.raw`((?:Proxy-)?Authorization|Set-Cookie|Cookie)(["']?\s{0,16}:\s{0,16})(${QUOTED}|[^\r\n]*)`, "gi"),
		"$1$2[redacted]",
	],
	// JSON or YAML keys whose value is a credential in a format no token shape recognizes (docker `auth`, kubeconfig).
	[
		new RegExp(
			String.raw`(["'](?:auth|credentials?|private[_-]?key|client[_-]?secret)["']\s{0,16}:\s{0,16})(${QUOTED}|[^\s,}\]]+)`,
			"gi",
		),
		"$1[redacted]",
	],
	[
		new RegExp(String.raw`(-(?:key|cert|certificate)-data["']?\s{0,16}:\s{0,16})(${QUOTED}|[^\s"',}\]]+)`, "gi"),
		"$1[redacted]",
	],
	[/([?&](?:access_token|token|api_?key|key|secret|password|sig|signature)=)[^&\s"'#]+/gi, "$1[redacted]"],
	[
		new RegExp(
			String.raw`(--(?:password|passwd|token|secret|api-?key|auth|access-token|client-secret)(?:=|\s{1,16}))(${QUOTED}|\S+)`,
			"gi",
		),
		"$1[redacted]",
	],
	// `curl -u user:pass`, `--user user:pass`; a value without a colon (a bare user, `sort -u`) is left alone. The user
	// part stops at the first quote, colon or space, so each start scans one token.
	[
		/((?:^|\s)(?:-u|--user|--proxy-user)(?:=|\s{0,16}))("[^"\r\n:]*:[^"\r\n]*"?|'[^'\r\n:]*:[^'\r\n]*'?|[^\s:'"]*:\S+)/g,
		"$1[redacted]",
	],
	// MySQL and MariaDB clients take the password attached to `-p`; other commands' `-p` (mkdir, ssh) is not a secret.
	[
		new RegExp(String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\r\n;&|]{0,128}?\s-p)(${QUOTED}|[^\s'"]+)`, "g"),
		"$1[redacted]",
	],
];

// Base64url segments joined by dots, from the start of a run, so a scan never restarts inside a run already read. A
// dot not preceded by a run character (`a..eyJ`) starts a new run.
const DOTTED_RUN = /(?<![A-Za-z0-9_-]|[A-Za-z0-9_-]\.)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;
const JWT_START = /eyJ[A-Za-z0-9_-]{4}/;

/**
 * Replaces every dotted base64url run holding a JWT (three segments, the first containing `eyJ`, wherever it starts
 * inside the run) with `[redacted credential]`; the whole run goes, so no part of the token survives. Linear.
 */
export function redactJsonWebTokens(text: string): string {
	return text.replace(DOTTED_RUN, (run) => {
		const segments = run.split(".");
		for (let index = 0; index + 2 < segments.length; index++)
			if (JWT_START.test(segments[index]) && segments[index + 1].length >= 4 && segments[index + 2].length >= 4)
				return "[redacted credential]";
		return run;
	});
}

/** Redacts known credential shapes and the given literal secrets; never call it on isolated fragments of a larger field. */
export function redactEvidenceText(text: string, secrets: readonly string[]): string {
	let cleaned = text;
	for (const secret of secrets) cleaned = cleaned.split(secret).join("[redacted]");
	cleaned = cleaned.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
		character === "\n" || character === "\t" ? character : "\uFFFD",
	);
	cleaned = redactJsonWebTokens(cleaned);
	for (const [pattern, replacement] of RULES) cleaned = cleaned.replace(pattern, replacement);
	return cleaned;
}

const ARGUMENT_NAME = /(?:key|token|secret|password|passwd|auth|credential|cookie)/i;

/** How deep and how many nodes (every key, value and item) one argument walk visits before withholding the rest. */
export const ARGUMENT_LIMITS = { depth: 8, nodes: 4096 } as const;

/** Arguments with credential-named values masked and every key and string leaf redacted before serialization. */
export function redactArguments(
	value: JsonValue,
	secrets: readonly string[],
): { readonly value: JsonValue; readonly redacted: boolean } {
	const budget = { nodes: 0, chars: 0, redacted: false };
	return { value: redactNode(value, 0, secrets, budget), redacted: budget.redacted };
}

type Budget = { nodes: number; chars: number; redacted: boolean };

// Past the depth, node or character budget a subtree is withheld whole: it cannot be redacted within bounded work. Keys
// are charged one node each, so redaction and copying stop at the budget; collecting the keys before the first
// iteration stays linear in the width (V8 does it eagerly), the same order as parsing the stored arguments.
function redactNode(value: JsonValue, depth: number, secrets: readonly string[], budget: Budget): JsonValue {
	budget.nodes++;
	if (typeof value === "string") return redactLeaf(value, secrets, budget);
	if (typeof value !== "object" || value === null) return value;
	if (depth >= ARGUMENT_LIMITS.depth) return withhold(budget, "[withheld: too deep]");
	if (Array.isArray(value)) {
		const items: JsonValue[] = [];
		for (const item of value) {
			if (exhausted(budget)) return [...items, withhold(budget, "[withheld: too large]")];
			items.push(redactNode(item, depth + 1, secrets, budget));
		}
		return items;
	}
	const result: Record<string, JsonValue> = {};
	for (const name in value) {
		const item = value[name];
		if (item === undefined) continue;
		if (exhausted(budget)) {
			result["[withheld]"] = withhold(budget, "[withheld: too large]");
			break;
		}
		budget.nodes++;
		const key = redactLeaf(name, secrets, budget);
		result[key] = ARGUMENT_NAME.test(name) ? withhold(budget, "[redacted]") : redactNode(item, depth + 1, secrets, budget);
	}
	return result;
}

function redactLeaf(text: string, secrets: readonly string[], budget: Budget): string {
	budget.chars += text.length;
	if (budget.chars > REDACTION_SOURCE_LIMIT) return withhold(budget, "[withheld: too large]");
	const cleaned = redactEvidenceText(text, secrets);
	if (cleaned !== text) budget.redacted = true;
	return cleaned;
}

function exhausted(budget: Budget): boolean {
	return budget.nodes >= ARGUMENT_LIMITS.nodes || budget.chars > REDACTION_SOURCE_LIMIT;
}

function withhold(budget: Budget, text: string): string {
	budget.redacted = true;
	return text;
}

// Run-bounded name scans keep this linear; it runs only over string leaves within the redaction budget.
const SPELLED_CREDENTIAL_PATH =
	/(?:^|[\s"'=:/\\<>|;&(])(?:[\w.-]{0,255}\.env|\.env\.[\w.-]{1,255}|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|auth\.json|hosts\.ya?ml|kubeconfig|[\w.-]{1,255}\.tfstate(?:\.backup)?|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]{1,255}\.(?:pem|key|p12|pfx)|\.unit-channels)(?=$|[\s"'\\/:;,)<>|&])|\.aws\/|\.ssh\/|\.gnupg\/|\.kube\/|\.docker\/config\.json|\/etc\/unit-001(?=$|\/)|\/credentials(?:\.json)?(?=$|[\s"'\\;,)<>|&])/i;

/** True when text spells a credential file; shell quoting and expansion can hide one, so this is a floor, not a proof. */
export function namesCredentialPath(text: string): boolean {
	return SPELLED_CREDENTIAL_PATH.test(text);
}

const CREDENTIAL_FILE =
	/^(?:\.env|.*\.env|\.env\..*|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|auth\.json|hosts\.ya?ml|kubeconfig|.*\.tfstate(?:\.backup)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx)|.*credentials(?:\.json)?)$/i;
const CREDENTIAL_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".unit-channels"]);

/**
 * Each root as spelled and as it resolves now, through its nearest existing ancestor, so a root that does not exist
 * still matches a file under its resolved parent (on macOS /etc is /private/etc).
 */
export async function resolvedCredentialRoots(roots: readonly string[]): Promise<string[]> {
	return [...roots, ...(await Promise.all(roots.map(resolveExisting)))];
}

async function resolveExisting(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(await resolveExisting(parent), basename(path));
	}
}

/** True when an absolute path is a credential location: a credential file name, directory, or a configured root. */
export function credentialLocation(path: string, roots: readonly string[]): boolean {
	if (roots.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`))) return true;
	const parts = path.split(/[\\/]+/);
	if (CREDENTIAL_FILE.test(parts.at(-1) ?? "")) return true;
	for (let index = 0; index < parts.length - 1; index++) {
		const directory = parts[index].toLowerCase();
		if (CREDENTIAL_DIRECTORIES.has(directory)) return true;
		if (directory === ".docker" && parts[index + 1].toLowerCase() === "config.json") return true;
	}
	return false;
}
