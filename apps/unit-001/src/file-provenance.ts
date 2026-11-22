// Records which files Durable's file tools opened, so evidence is withheld by the file a call used, not by its spelling.
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { type ExecutionEnv, err, FileError, type FileErrorCode, ok, type Result } from "@earendil-works/pi-durable/env";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { credentialLocation, resolvedCredentialRoots } from "./evidence-redaction.ts";

/** One file a call moved content to or from: the absolute path the tool used and what the call established about it. */
export interface OpenedFile {
	readonly path: string;
	/** Where the file the content moved through was, read from that file's own handle; `null` when not established. */
	readonly resolved: string | null;
	/** The decision when the call ran: the path or the file was a credential location under the roots as they were. */
	readonly credential: boolean;
}

/** What a file tool recorded at execution time; `complete: false` means it opened more files than are kept. */
export interface FileProvenance {
	readonly files: readonly OpenedFile[];
	readonly complete: boolean;
}

/** Result details key holding a call's `FileProvenance`; models never see details. */
export const PROVENANCE_KEY = "unitFiles";

/** Tools whose content is a file's content, so their evidence depends on which file they opened. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/**
 * Durable's `coding-tools` extension with `read`, `write` and `edit` recording the files they open; `credentialRoots`
 * are the directories whose every file is a credential location, resolved again on every operation.
 */
export function recordedCodingTools(credentialRoots: readonly string[]): Extension {
	const tools = (createCodingTools().tools ?? []) as readonly ToolRegistration[];
	return defineExtension({
		name: "coding-tools",
		tools: tools.map((tool) => (FILE_TOOLS.has(tool.name) ? recordFiles(tool, credentialRoots) : tool)),
	});
}

// A call opens one file; edit touches the same file twice. More distinct files than this is not a file tool's
// behaviour, so the record stops and says it is incomplete.
const FILE_LIMIT = 8;

type Recorder = { readonly roots: readonly string[]; files: OpenedFile[]; complete: boolean };

// The tool gets an environment that records every content operation; the record joins the details it reports, and a
// thrown call reports it before the error settles the result.
function recordFiles(tool: ToolRegistration, roots: readonly string[]): ToolRegistration {
	return {
		...tool,
		async execute(args, api, context) {
			const record: Recorder = { roots, files: [], complete: true };
			let reported: JsonValue | undefined;
			const recorded = {
				...api,
				env: api.env === undefined ? undefined : recordingEnv(api.env, record),
				details: (value: JsonValue, ctx: Context) => {
					reported = value;
					return api.details(withProvenance(value, record), ctx);
				},
			};
			try {
				const result = await tool.execute(args, recorded, context);
				return { ...result, details: withProvenance(result.details ?? reported, record) };
			} catch (error) {
				// The tool's error is what the model must see; a record that cannot be stored reads as unknown provenance.
				await api.details(withProvenance(reported, record), context).catch(() => {});
				throw error;
			}
		},
	};
}

// Every operation that reads or writes file content; metadata calls (exists, fileInfo) move no content.
const CONTENT_OPERATIONS = new Set([
	"readTextFile",
	"openTextLineReader",
	"readTextLines",
	"readBinaryFile",
	"openBinaryReader",
	"writeFile",
	"appendFile",
	"truncateFile",
]);

// Every local Node environment shares this namespace id; only there are the tool's paths this process's paths.
const LOCAL_ENV = "node:local";

// Where an open descriptor can be named as a path that reaches the same open file: /proc on Linux, fdesc on macOS.
const DESCRIPTOR_DIRECTORY =
	process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : undefined;

/**
 * Durable opens a file by path in one call and checks nothing about it, so a check by path before or after cannot
 * say which file it opened: an alias retargeted during the call and restored after passes both. The operations
 * Durable's file tools use are therefore run here on a handle this module opens, and the record names that handle's
 * file. Anywhere identity cannot be read from a handle (another environment, another platform, an operation not bound
 * here) the operation runs as is and records no file, which evidence withholds.
 */
function recordingEnv(env: ExecutionEnv, record: Recorder): ExecutionEnv {
	const bound = env.id === LOCAL_ENV && DESCRIPTOR_DIRECTORY !== undefined ? boundOperations(env, record) : {};
	return new Proxy(env, {
		get(target, property) {
			const value = Reflect.get(target, property, target) as unknown;
			if (typeof value !== "function") return value;
			if (typeof property !== "string" || !CONTENT_OPERATIONS.has(property)) return value.bind(target);
			const own = (bound as Record<string, unknown>)[property];
			if (own !== undefined) return own;
			return async (path: string, ...rest: unknown[]) => {
				const result = await (value as (...args: unknown[]) => Promise<unknown>).call(target, path, ...rest);
				await note(record, await absolute(target, path, rest.at(-1) as Context), null);
				return result;
			};
		},
	});
}

type BoundOperations = Pick<ExecutionEnv, "readTextFile" | "writeFile" | "openBinaryReader">;

// What the content moved through is the handle; when this module cannot open one, Durable's own call runs, so the
// model gets Durable's error, and nothing is recorded as established.
function boundOperations(env: ExecutionEnv, record: Recorder): BoundOperations {
	return {
		readTextFile: (path, context) =>
			throughHandle(
				env,
				record,
				path,
				constants.O_RDONLY,
				context,
				() => env.readTextFile(path, context),
				async (handle) => ok(await handle.readFile({ encoding: "utf8", signal: context.abortSignal })),
			),
		writeFile: async (path, content, context) => {
			// Durable's writeFile creates missing parents first; a failure here falls through to its own error below.
			const target = await absolute(env, path, context);
			if (!context.abortSignal?.aborted) await mkdir(dirname(target), { recursive: true }).catch(() => {});
			return throughHandle(
				env,
				record,
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
				context,
				() => env.writeFile(path, content, context),
				async (handle) => ok(await handle.writeFile(content, { signal: context.abortSignal })),
			);
		},
		// Durable's reader is opened on the descriptor's own path, so it reads the very file the handle holds. The
		// handle carries `noFollow`; the descriptor path is a link on Linux, so it is opened following it.
		openBinaryReader: (path, options, context) =>
			throughHandle(
				env,
				record,
				path,
				constants.O_RDONLY | constants.O_NONBLOCK | (options?.noFollow ? constants.O_NOFOLLOW : 0),
				context,
				() => env.openBinaryReader(path, options, context),
				(handle) => env.openBinaryReader(`${DESCRIPTOR_DIRECTORY}/${handle.fd}`, undefined, context),
			),
	};
}

// Opens the handle, records the file it holds, then moves content through it. A failed open defers to `fallback`.
async function throughHandle<T>(
	env: ExecutionEnv,
	record: Recorder,
	path: string,
	flags: number,
	context: Context,
	fallback: () => Promise<Result<T, FileError>>,
	use: (handle: FileHandle) => Promise<Result<T, FileError>>,
): Promise<Result<T, FileError>> {
	const target = await absolute(env, path, context);
	// An aborted call must not truncate or create anything; Durable's own call reports the abort.
	const handle = context.abortSignal?.aborted ? undefined : await open(target, flags, 0o666).catch(() => undefined);
	if (handle === undefined) {
		const result = await fallback();
		await note(record, target, null);
		return result;
	}
	try {
		await note(record, target, await openedPath(handle, target));
		return await use(handle);
	} catch (error) {
		return err(fileError(error, target));
	} finally {
		await handle.close().catch(() => {});
	}
}

// Darwin <sys/fcntl.h> values Node does not export: fail on a link in any component, and open for event notification
// only, so the check never reads the file; a file it cannot open that way gives `null`.
const O_NOFOLLOW_ANY = 0x20000000;
const O_EVTONLY = 0x8000;

/**
 * The path of the file an open handle holds. Linux names it from the descriptor. macOS has no such call in Node, so
 * `realpath` proposes a path and opening it with no link followed in any component must reach the handle's own file
 * (same device and inode); a path retargeted in between reaches another file and gives `null`.
 */
export async function openedPath(handle: FileHandle, path: string): Promise<string | null> {
	if (process.platform === "linux") {
		const named = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
		return named !== undefined && isAbsolute(named) && !named.endsWith(" (deleted)") ? named : null;
	}
	const candidate = await realpath(path).catch(() => undefined);
	if (candidate === undefined) return null;
	const check = await open(candidate, O_NOFOLLOW_ANY | O_EVTONLY | constants.O_NONBLOCK).catch(() => undefined);
	if (check === undefined) return null;
	try {
		const [held, named] = await Promise.all([handle.stat(), check.stat()]);
		return held.dev === named.dev && held.ino === named.ino ? candidate : null;
	} finally {
		await check.close().catch(() => {});
	}
}

async function absolute(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const result = await env.absolutePath(path, context);
	return result.ok ? result.value : path;
}

// The credential roots are resolved now, so a root retargeted after the call cannot change what this call used.
async function note(record: Recorder, path: string, resolved: string | null): Promise<void> {
	const roots = await resolvedCredentialRoots(record.roots);
	const credential = credentialLocation(path, roots) || (resolved !== null && credentialLocation(resolved, roots));
	const file = { path, resolved, credential };
	const known = (item: OpenedFile) =>
		item.path === file.path && item.resolved === file.resolved && item.credential === file.credential;
	if (record.files.some(known)) return;
	if (record.files.length >= FILE_LIMIT) record.complete = false;
	else record.files.push(file);
}

// The codes Durable's own environment reports for the same failures, so the tools' messages stay the same.
const ERROR_CODES: Readonly<Record<string, FileErrorCode>> = {
	ABORT_ERR: "aborted",
	ENOENT: "not_found",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	ENOTDIR: "not_directory",
	EISDIR: "is_directory",
	EINVAL: "invalid",
};

function fileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) return error;
	const cause = error instanceof Error ? error : new Error(String(error));
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return new FileError((code !== undefined && ERROR_CODES[code]) || "unknown", cause.message, path, cause);
}

// Durable's file tools report object details or none; any other shape cannot carry the record, which then reads as
// unknown provenance.
function withProvenance(details: JsonValue | undefined, record: FileProvenance): JsonValue {
	const provenance = { files: record.files.map((file) => ({ ...file })), complete: record.complete };
	if (details === undefined) return { [PROVENANCE_KEY]: provenance };
	if (typeof details !== "object" || details === null || Array.isArray(details)) return details;
	return { ...details, [PROVENANCE_KEY]: provenance };
}

/** Reads the record a file tool stored in its result details; `undefined` when there is none or it is malformed. */
export function readProvenance(details: unknown): FileProvenance | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const value = (details as Record<string, unknown>)[PROVENANCE_KEY];
	if (typeof value !== "object" || value === null) return undefined;
	const { files, complete } = value as { files?: unknown; complete?: unknown };
	if (typeof complete !== "boolean" || !Array.isArray(files) || files.length > FILE_LIMIT) return undefined;
	const parsed: OpenedFile[] = [];
	for (const file of files as unknown[]) {
		const { path, resolved, credential } = (file ?? {}) as { path?: unknown; resolved?: unknown; credential?: unknown };
		if (typeof path !== "string" || (resolved !== null && typeof resolved !== "string") || typeof credential !== "boolean")
			return undefined;
		parsed.push({ path, resolved, credential });
	}
	return { files: parsed, complete };
}
