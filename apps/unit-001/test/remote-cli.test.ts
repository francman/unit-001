// One-shot remote commands report a reply only when its type answers the operation sent.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRemoteCommand } from "../src/remote/cli.ts";
import { addRemoteProfile } from "../src/remote/profiles.ts";
import type { ServiceRequest, ServiceResponse } from "../src/service.ts";
import type { TerminalIO } from "../src/terminal-io.ts";

const responses: ServiceResponse[] = [];
const requests: ServiceRequest[] = [];

vi.mock("../src/remote/client.ts", () => ({
	connectRemoteClient: async () => ({
		session: "default@remote",
		ownerSession: "default",
		async request(request: ServiceRequest) {
			requests.push(request);
			return responses.shift() ?? { type: "error", message: "no scripted response" };
		},
		watch: async () => {},
		close: async () => {},
	}),
}));

let root: string;
let directory: string;
let output: string[];
let errors: string[];

beforeEach(async () => {
	responses.length = 0;
	requests.length = 0;
	output = [];
	errors = [];
	root = await mkdtemp(join(tmpdir(), "unit-remote-cli-"));
	directory = join(root, "remotes");
	await mkdir(directory, { mode: 0o700 });
	await addRemoteProfile(directory, {
		schema: 1,
		name: "remote",
		host: "ssh-alias",
		installationId: "aa49e3de-4cb1-4caf-9b98-26e4c399c12d",
		session: "default",
	});
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const terminal = (): TerminalIO => ({
	input: process.stdin,
	out: (text) => void output.push(text),
	err: (text) => void errors.push(text),
});

const run = (command: Parameters<typeof runRemoteCommand>[0]) =>
	runRemoteCommand(command, { directory, terminal: terminal(), colorMode: "monochrome" }, new AbortController().signal);

describe("one-shot remote commands", () => {
	it("refuses a reply that answers another operation instead of reporting success", async () => {
		const cases = [
			{ command: { action: "status", name: "remote" }, wrong: { type: "cancelled" }, label: "cancelled" },
			{
				command: { action: "cancel", name: "remote" },
				wrong: { type: "reply", reply: { status: "answered", text: "hello" } },
				label: "reply",
			},
			{
				command: { action: "send", name: "remote", prompt: "work", requestId: "id-1" },
				wrong: { type: "cancelled" },
				label: "cancelled",
			},
		] as const;
		for (const { command, wrong, label } of cases) {
			output.length = 0;
			errors.length = 0;
			responses.push(wrong);
			expect(await run(command)).toBe(1);
			expect(output).toEqual([]);
			expect(errors.join("")).toContain(`Unexpected remote ${label} response to ${command.action}.`);
		}
	});

	it("prints the reply whose type matches the operation", async () => {
		responses.push({ type: "cancelled" });
		expect(await run({ action: "cancel", name: "remote" })).toBe(0);
		expect(output.join("")).toBe('{"type":"cancelled"}\n');

		output.length = 0;
		responses.push({ type: "reply", reply: { status: "answered", text: "done" } });
		expect(await run({ action: "send", name: "remote", prompt: "work", requestId: "id-2" })).toBe(0);
		expect(output.join("")).toBe("done\n");
		expect(requests.at(-1)).toEqual({ type: "send", prompt: "work", requestId: "id-2" });
	});

	it("still reports an owner error as a failure", async () => {
		responses.push({ type: "error", message: "owner busy" });
		expect(await run({ action: "status", name: "remote" })).toBe(1);
		expect(errors.join("")).toContain("owner busy");
	});
});
