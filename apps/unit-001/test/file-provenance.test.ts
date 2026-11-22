// #26: Durable's file tools record, when they run, which files they opened, so evidence can withhold by that file.
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_TOOLS, openedPath, PROVENANCE_KEY, readProvenance, recordedCodingTools } from "../src/file-provenance.ts";
import { projectToolEvidence } from "../src/tool-evidence.ts";

let workspace: string;
beforeEach(async () => {
	workspace = await realpath(await mkdtemp(join(tmpdir(), "u1-file-provenance-")));
	await writeFile(join(workspace, ".env"), "SESSION_SIGNING=Zx9qQ8vL2mN4pR6s\n");
	await writeFile(join(workspace, "notes.txt"), "plain notes\n");
});
afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

function tool(name: string, roots: readonly string[]): ToolRegistration {
	const found = recordedCodingTools(roots).tools?.find((item) => item.name === name);
	if (found === undefined) throw new Error(`no ${name} tool`);
	return found;
}

type RunOptions = { readonly env?: ExecutionEnv; readonly roots?: readonly string[] };

// Runs one recorded tool call, by default with a real local environment and no credential roots; returns its result,
// its details and the details it reported on the way.
async function run(name: string, args: Record<string, unknown>, options: RunOptions = {}) {
	const reported: JsonValue[] = [];
	const api = {
		env: options.env ?? new NodeExecutionEnv({ cwd: workspace }),
		callId: "call-1",
		details: async (value: JsonValue) => {
			reported.push(value);
		},
		diagnostic: () => {},
		output: () => {},
		outputWindow: undefined,
	} as unknown as ToolExecutionApi;
	try {
		const result = await tool(name, options.roots ?? []).execute(args as never, api, BACKGROUND_CONTEXT);
		return { output: result.output, details: result.details, error: undefined, reported };
	} catch (error) {
		return { output: undefined, details: reported.at(-1), error, reported };
	}
}

// What a recorded call's evidence shows, projected from its own committed output and details.
async function evidenceOf(name: string, args: Record<string, unknown>, ran: Awaited<ReturnType<typeof run>>, roots: readonly string[] = []) {
	const entries = [
		{
			id: 2,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "call-under-test",
					toolName: name,
					isError: ran.error !== undefined,
					content: ran.output ?? [],
					details: ran.details,
				},
			],
			data: { diagnostics: [] },
		},
		{
			id: 1,
			kind: "pi.assistant",
			model: [{ role: "assistant", content: [{ type: "toolCall", id: "call-under-test", name, arguments: args }] }],
		},
	] as unknown as EntryRecord[];
	return projectToolEvidence(entries, "call-under-test", { cwd: workspace, secrets: [], credentialRoots: roots });
}

// A local environment whose content operations retarget `alias` to `.env` while they run and restore it after: the
// race a check by path before and after cannot see.
class RetargetingEnv extends NodeExecutionEnv {
	readonly #alias: string;

	constructor(alias: string) {
		super({ cwd: workspace });
		this.#alias = alias;
	}

	override async readTextFile(path: string, context: Context) {
		return this.#during(() => super.readTextFile(path, context));
	}

	override async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
		return this.#during(() => super.openBinaryReader(path, options, context));
	}

	override async writeFile(path: string, content: string | Uint8Array, context: Context) {
		return this.#during(() => super.writeFile(path, content, context));
	}

	async #during<T>(operation: () => Promise<T>): Promise<T> {
		await retarget(this.#alias, join(workspace, ".env"));
		try {
			return await operation();
		} finally {
			await retarget(this.#alias, join(workspace, "notes.txt"));
		}
	}
}

async function retarget(alias: string, target: string): Promise<void> {
	await symlink(target, `${alias}.next`);
	await rename(`${alias}.next`, alias);
}

describe("recorded coding tools", () => {
	it("wraps exactly read, write and edit and keeps bash and the extension name", () => {
		const extension = recordedCodingTools([]);
		expect(extension.name).toBe("coding-tools");
		expect(extension.tools?.map((item) => item.name)).toEqual(["read", "write", "edit", "bash"]);
		expect([...FILE_TOOLS]).toEqual(["read", "write", "edit"]);
	});

	it("records the file a read resolved to through a symlink, next to the tool's own details", async () => {
		await symlink(join(workspace, ".env"), join(workspace, "innocent.txt"));
		const { details } = await run("read", { path: "innocent.txt" });
		expect(readProvenance(details)).toEqual({
			files: [{ path: join(workspace, "innocent.txt"), resolved: join(workspace, ".env"), credential: true }],
			complete: true,
		});
	});

	it("records the variant Durable's read actually opened, not the spelling it was given", async () => {
		// The model asks for a straight apostrophe; Durable falls back to the curly one, a link to the credential file.
		await symlink(join(workspace, ".env"), join(workspace, "bob’s notes.txt"));
		const { details } = await run("read", { path: "bob's notes.txt" });
		expect(readProvenance(details)?.files).toEqual([
			{ path: join(workspace, "bob’s notes.txt"), resolved: join(workspace, ".env"), credential: true },
		]);
	});

	it("lets evidence withhold what a read variant returned from a credential file", async () => {
		await symlink(join(workspace, ".env"), join(workspace, "bob’s notes.txt"));
		const { details } = await run("read", { path: "bob's notes.txt" });
		const entries = [
			{
				id: 2,
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: "call-variant",
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "SESSION_SIGNING=Zx9qQ8vL2mN4pR6s\n" }],
						details,
					},
				],
				data: { diagnostics: [] },
			},
			{
				id: 1,
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call-variant", name: "read", arguments: { path: "bob's notes.txt" } }],
					},
				],
			},
		] as unknown as EntryRecord[];
		const evidence = await projectToolEvidence(entries, "call-variant", { cwd: workspace, secrets: [], credentialRoots: [] });
		expect(evidence).toMatchObject({ kind: "found", withheld: "credential-path", output: null });
		expect(JSON.stringify(evidence)).not.toContain("Zx9qQ8vL2mN4pR6s");
	});

	it("records a file write creates, and edit's one file once, keeping edit's diff", async () => {
		const written = await run("write", { path: "new.txt", content: "fresh\n" });
		expect(readProvenance(written.details)?.files).toEqual([
			{ path: join(workspace, "new.txt"), resolved: join(workspace, "new.txt"), credential: false },
		]);
		const edited = await run("edit", { path: "notes.txt", edits: [{ oldText: "plain", newText: "edited" }] });
		expect(readProvenance(edited.details)?.files).toEqual([
			{ path: join(workspace, "notes.txt"), resolved: join(workspace, "notes.txt"), credential: false },
		]);
		expect(edited.details).toMatchObject({ diff: expect.stringContaining("edited") });
	});

	it("reports the record before a thrown call settles, with an unresolved file", async () => {
		const missing = await run("read", { path: "missing.txt" });
		expect(missing.error).toBeInstanceOf(Error);
		expect(readProvenance(missing.details)).toEqual({
			files: [{ path: join(workspace, "missing.txt"), resolved: null, credential: false }],
			complete: true,
		});
	});

	it("reads only well-formed records", () => {
		const file = { path: "/a", resolved: "/a", credential: false };
		expect(readProvenance({ [PROVENANCE_KEY]: { files: [file], complete: true } })).toEqual({ files: [file], complete: true });
		expect(readProvenance(undefined)).toBeUndefined();
		expect(readProvenance({ diff: "x" })).toBeUndefined();
		expect(readProvenance({ [PROVENANCE_KEY]: { files: [file] } })).toBeUndefined();
		expect(readProvenance({ [PROVENANCE_KEY]: { files: [{ path: 1, resolved: null, credential: false }], complete: true } })).toBeUndefined();
		expect(readProvenance({ [PROVENANCE_KEY]: { files: [{ path: "/a", resolved: "/a" }], complete: true } })).toBeUndefined();
		expect(readProvenance({ [PROVENANCE_KEY]: { files: Array(9).fill(file), complete: true } })).toBeUndefined();
	});
});

// #26 final verification, findings 1 and 2: the record names the file the content moved through, and keeps the
// credential decision taken when the call ran.
describe("records bound to the handle", () => {
	it("never records an ordinary file for content a retargeted alias led to", async () => {
		const alias = join(workspace, "alias.txt");
		await symlink(join(workspace, "notes.txt"), alias);
		const env = new RetargetingEnv(alias);
		const read = await run("read", { path: "alias.txt" }, { env });
		const shown = await evidenceOf("read", { path: "alias.txt" }, read);
		expect(JSON.stringify(shown)).not.toContain("Zx9qQ8vL2mN4pR6s");
		// A write goes to the file its record names, so withholding by the record covers what was written.
		const written = await run("write", { path: "alias.txt", content: "fresh\n" }, { env });
		const [file] = readProvenance(written.details)?.files ?? [];
		expect(file?.resolved).not.toBeNull();
		expect(await readFile(file?.resolved as string, "utf8")).toBe("fresh\n");
		expect(await readFile(join(workspace, ".env"), "utf8")).toBe("SESSION_SIGNING=Zx9qQ8vL2mN4pR6s\n");
	});

	it("names only the file a handle holds, never one its path names since", async () => {
		const alias = join(workspace, "alias.txt");
		await symlink(join(workspace, ".env"), alias);
		const handle = await open(alias, "r");
		try {
			await retarget(alias, join(workspace, "notes.txt"));
			// Linux names the file from the descriptor; macOS cannot confirm the path it is offered and gives nothing.
			expect([join(workspace, ".env"), null]).toContain(await openedPath(handle, alias));
		} finally {
			await handle.close();
		}
	});

	it("records no file for an environment whose handles it cannot read, so evidence withholds", async () => {
		const local = new NodeExecutionEnv({ cwd: workspace });
		const remote = new Proxy(local, {
			get: (target, property) => (property === "id" ? "ssh:elsewhere" : Reflect.get(target, property, target)),
		});
		const read = await run("read", { path: "notes.txt" }, { env: remote });
		expect(readProvenance(read.details)?.files).toEqual([
			{ path: join(workspace, "notes.txt"), resolved: null, credential: false },
		]);
		expect(await evidenceOf("read", { path: "notes.txt" }, read)).toMatchObject({ withheld: "unverified-file", output: null });
	});

	it("keeps the root decision taken when the call ran after the root is retargeted", async () => {
		await mkdir(join(workspace, "managed-a"));
		await mkdir(join(workspace, "managed-b"));
		const path = join(workspace, "managed-a", "environment");
		await writeFile(path, "PROVIDER_VALUE=value-no-pattern-matches-this\n");
		const root = join(workspace, "managed");
		await symlink(join(workspace, "managed-a"), root);
		const read = await run("read", { path }, { roots: [root] });
		expect(readProvenance(read.details)?.files).toEqual([{ path, resolved: path, credential: true }]);
		await retarget(root, join(workspace, "managed-b"));
		const evidence = await evidenceOf("read", { path }, read, [root]);
		expect(evidence).toMatchObject({ withheld: "credential-path", output: null });
		expect(JSON.stringify(evidence)).not.toContain("value-no-pattern");
	});
});
