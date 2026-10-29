import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
