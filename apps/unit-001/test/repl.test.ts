import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { runPrint, runRepl, type Terminal } from "../src/repl.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

let directory: string;
const open: Agent[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-repl-"));
});
afterEach(async () => {
	await Promise.all(open.splice(0).map((agent) => agent.close(context).catch(() => {})));
	await rm(directory, { recursive: true, force: true });
});

async function launch(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = await Agent.open(
		{ storage: await openNodeSqliteStorage(join(directory, "session.sqlite")), models, model, cwd: directory },
		context,
	);
	open.push(agent);
	return agent;
}

function terminal(lines: string): { terminal: Terminal; out: () => string; err: () => string } {
	const input = new PassThrough();
	input.end(lines);
	const out: string[] = [];
	const err: string[] = [];
	return {
		terminal: { input, out: (text) => void out.push(text), err: (text) => void err.push(text) },
		out: () => out.join(""),
		err: () => err.join(""),
	};
}

const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);
const signal = () => new AbortController().signal;

describe("runRepl", () => {
	it("answers each line and stops at /exit", async () => {
		const agent = await launch([reply("Paris."), reply("Berlin.")]);
		const io = terminal("Capital of France?\nAnd of Germany?\n/exit\nignored\n");
		expect(await runRepl(agent, io.terminal, signal())).toBe(0);
		expect(io.out()).toBe("Paris.\nBerlin.\n");
	});

	it("stops at the end of input", async () => {
		const agent = await launch([reply("Paris.")]);
		const io = terminal("Capital of France?\n");
		expect(await runRepl(agent, io.terminal, signal())).toBe(0);
		expect(io.out()).toBe("Paris.\n");
	});

	it("handles /help, unknown commands, and blank lines without asking the model", async () => {
		const agent = await launch([]);
		const io = terminal("\n   \n/help\n/nope arg\n/exit\n");
		expect(await runRepl(agent, io.terminal, signal())).toBe(0);
		expect(io.out()).toBe("");
		expect(io.err()).toContain("Commands: /help");
		expect(io.err()).toContain("Unknown command /nope.");
	});

	// #21: local status must not submit another model request or pollute answer stdout.
	it("reports local name and activity without asking the model", async () => {
		const agent = await launch([]);
		const io = terminal("/status\n/exit\n");
		await runRepl(agent, io.terminal, signal());
		expect(io.err()).toBe("agent: idle\n");
		expect(io.out()).toBe("");
	});

	// #21: each completed turn releases its cancellation listeners.
	it("releases signal listeners after multiple turns and normal exit", async () => {
		const agent = await launch([reply("one"), reply("two")]);
		const controller = new AbortController();
		const io = terminal("first\nsecond\n/exit\n");
		await runRepl(agent, io.terminal, controller.signal);
		expect(io.out()).toBe("one\ntwo\n");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("announces tool use on the error stream, not in the answer", async () => {
		await writeFile(join(directory, "note.txt"), "hello from the file");
		const agent = await launch([
			fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			reply("The file says hello."),
		]);
		const io = terminal("What is in note.txt?\n/exit\n");
		await runRepl(agent, io.terminal, signal());
		expect(io.err()).toContain("[read]");
		expect(io.out()).toContain("The file says hello.");
		expect(io.out()).not.toContain("[read]");
	});

	it("resumes and shows the run an earlier process left unfinished", async () => {
		let started!: () => void;
		const requested = new Promise<void>((resolve) => {
			started = resolve;
		});
		const first = await launch([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					started();
					options?.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true });
				}),
		]);
		await first.submit("Capital of France?", context);
		await requested;
		await first.close(context);

		const second = await launch([reply("Paris.")]);
		const io = terminal("/exit\n");
		expect(await runRepl(second, io.terminal, signal())).toBe(0);
		expect(io.err()).toContain("Resuming the run that was interrupted.");
		expect(io.out()).toContain("Paris.");
	});

	// #21: Ctrl+C during recovery cancels the resumed run rather than closing an apparently idle REPL.
	it("cancels a recovered run once and returns to the prompt", async () => {
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const pending = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise<never>((_resolve, reject) => {
				requested();
				options?.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
			});
		const first = await launch([pending]);
		await first.submit("unfinished", context);
		await started;
		await first.close(context);
		const second = await launch([pending]);
		const abort = vi.spyOn(second, "abort");
		const input = new PassThrough();
		const output = new PassThrough();
		const io = terminal("");
		let ready!: () => void;
		const resumed = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const running = runRepl(
			second,
			{
				...io.terminal,
				input,
				output,
				err: (text) => {
					io.terminal.err(text);
					if (text.includes("Resuming")) ready();
				},
			},
			signal(),
		);
		await resumed;
		input.write("\x03");
		await vi.waitFor(async () => expect((await second.status(context)).busy).toBe(false));
		input.end("/status\n/exit\n");
		expect(await running).toBe(0);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(io.err()).toContain("^C stopping the run");
		expect(io.err()).toContain("agent: idle");
	});

	it("ends when the signal aborts", async () => {
		const agent = await launch([]);
		const controller = new AbortController();
		const input = new PassThrough(); // never ends: only the signal can stop the loop
		const io = terminal("");
		const running = runRepl(agent, { ...io.terminal, input }, controller.signal);
		controller.abort();
		expect(await running).toBe(0);
	});
});

describe("runPrint", () => {
	it("prints only the answer, ending with a newline, and returns 0", async () => {
		const agent = await launch([reply("Paris.")]);
		const io = terminal("");
		expect(await runPrint(agent, "Capital of France?", io.terminal, signal())).toBe(0);
		expect(io.out()).toBe("Paris.\n");
		expect(io.err()).toBe("");
	});

	it("does not add a second newline to an answer that already ends with one", async () => {
		const agent = await launch([reply("Paris.\n")]);
		const io = terminal("");
		await runPrint(agent, "Capital of France?", io.terminal, signal());
		expect(io.out()).toBe("Paris.\n");
	});

	// #21: successful one-shot calls must not retain abort listeners or alter script payloads.
	it("releases its listener and preserves the raw answer for scripts", async () => {
		const agent = await launch([reply("\x1b[31mraw\x1b[0m")]);
		const controller = new AbortController();
		const io = terminal("");
		await runPrint(agent, "answer", io.terminal, controller.signal);
		expect(io.out()).toBe("\x1b[31mraw\x1b[0m\n");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	// #21: cleanup also covers a failed live-state subscription before any prompt is admitted.
	it("releases its signal listener when watching fails", async () => {
		const agent = await launch([]);
		vi.spyOn(agent, "watch").mockRejectedValueOnce(new Error("watch failed"));
		const controller = new AbortController();
		const io = terminal("");
		await expect(runPrint(agent, "answer", io.terminal, controller.signal)).rejects.toThrow("watch failed");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(io.out()).toBe("");
	});
});
