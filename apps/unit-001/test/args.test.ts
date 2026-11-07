import { describe, expect, it } from "vitest";
import { parseArguments } from "../src/args.ts";
import { UsageError } from "../src/errors.ts";

describe("parseArguments", () => {
	it("defaults to an interactive run of the default session", () => {
		expect(parseArguments([])).toEqual({ kind: "run", options: { session: "default" } });
	});

	it("reads every option, in both the spaced and the = form", () => {
		expect(
			parseArguments([
				"-p",
				"hello",
				"--session",
				"work",
				"--model=anthropic/claude-sonnet-5-5",
				"--data-dir",
				"/d",
			]),
		).toEqual({
			kind: "run",
			options: { print: "hello", session: "work", model: "anthropic/claude-sonnet-5-5", dataDir: "/d" },
		});
	});

	it("keeps an = inside a value", () => {
		expect(parseArguments(["--print=a=b"])).toEqual({ kind: "run", options: { print: "a=b", session: "default" } });
	});

	it("accepts - as the prompt, meaning standard input", () => {
		expect(parseArguments(["-p", "-"])).toEqual({ kind: "run", options: { print: "-", session: "default" } });
	});

	it("returns help or version as soon as it sees them", () => {
		expect(parseArguments(["-h"])).toEqual({ kind: "help" });
		expect(parseArguments(["--session", "x", "--version"])).toEqual({ kind: "version" });
	});

	it.each([
		[["--bogus"], /Unknown option: --bogus/],
		[["-x"], /Unknown option: -x/],
		[["stray"], /Unexpected argument: stray/],
		[["-p"], /needs a value/],
		[["--session"], /needs a value/],
		[["--session="], /needs a value/],
		[["--session", "a", "--session", "b"], /more than once/],
	])("rejects %j", (argv, message) => {
		expect(() => parseArguments(argv)).toThrow(UsageError);
		expect(() => parseArguments(argv)).toThrow(message);
	});
});

describe("parseArguments account commands", () => {
	it("parses login, logout, and status", () => {
		expect(parseArguments(["login", "anthropic"])).toEqual({ kind: "login", provider: "anthropic" });
		expect(parseArguments(["logout", "openai", "--data-dir", "/d"])).toEqual({
			kind: "logout",
			provider: "openai",
			dataDir: "/d",
		});
		expect(parseArguments(["status"])).toEqual({ kind: "status" });
		expect(parseArguments(["status", "--data-dir=/d"])).toEqual({ kind: "status", dataDir: "/d" });
	});

	it("returns help for a subcommand's --help", () => {
		expect(parseArguments(["login", "--help"])).toEqual({ kind: "help" });
	});

	it.each([
		[["login"], /Usage: agent login <provider>/],
		[["logout"], /Usage: agent logout <provider>/],
		[["login", "a", "b"], /Unexpected argument: b/],
		[["status", "extra"], /Unexpected argument: extra/],
		[["login", "a", "--bogus"], /Unknown option: --bogus/],
		[["login", "a", "--data-dir"], /needs a value/],
	])("rejects %j", (argv, message) => {
		expect(() => parseArguments(argv)).toThrow(UsageError);
		expect(() => parseArguments(argv)).toThrow(message);
	});

	it("treats login, logout, and status as commands only in first position", () => {
		expect(() => parseArguments(["--session", "x", "login"])).toThrow(/Unexpected argument: login/);
	});
});

describe("parseArguments service commands", () => {
	it("parses inhibited startup and bounded maintenance controls", () => {
		// #18: Inhibition belongs to service startup, never a client-side admission override.
		expect(parseArguments(["serve", "--inhibited"])).toEqual({
			kind: "serve",
			options: { session: "default", inhibited: true },
		});
		expect(parseArguments(["maintenance-enter", "--operation-id", "upgrade", "--timeout-ms", "0"])).toEqual({
			kind: "maintenance-enter",
			operationId: "upgrade",
			timeoutMs: 0,
			options: { session: "default" },
		});
		expect(parseArguments(["maintenance-release", "--operation-id", "upgrade", "--session", "work"])).toEqual({
			kind: "maintenance-release",
			operationId: "upgrade",
			options: { session: "work" },
		});
		for (const args of [
			["send", "x", "--inhibited"],
			["maintenance-enter"],
			["maintenance-enter", "--operation-id", "x", "--timeout-ms", "30001"],
			["maintenance-release", "--operation-id", "x", "--timeout-ms", "0"],
		])
			expect(() => parseArguments(args)).toThrow(UsageError);
	});
	it.each(["- explain this failure", "--help", "--session=literal"])(
		"keeps %s as a literal prompt after --",
		(prompt) => {
			expect(parseArguments(["send", "--session", "work", "--request-id", "retry", "--", prompt])).toEqual({
				kind: "send",
				prompt,
				requestId: "retry",
				options: { session: "work" },
			});
		},
	);

	it("parses the headless owner and local controls", () => {
		// #22: plain attachment remains available without changing service ownership or automation.
		expect(parseArguments(["attach", "--plain", "--session", "work"])).toEqual({
			kind: "attach",
			options: { session: "work", plain: true },
		});
		// #21: attaching is a socket client and cannot select a new owner model.
		expect(parseArguments(["attach", "--session", "work", "--data-dir=/d"])).toEqual({
			kind: "attach",
			options: { session: "work", dataDir: "/d" },
		});
		expect(parseArguments(["serve", "--session", "work", "--data-dir=/d", "--model", "openai/gpt-5"])).toEqual({
			kind: "serve",
			options: { session: "work", dataDir: "/d", model: "openai/gpt-5" },
		});
		expect(parseArguments(["send", "hello", "--request-id", "r1", "--session=work"])).toEqual({
			kind: "send",
			prompt: "hello",
			requestId: "r1",
			options: { session: "work" },
		});
		expect(parseArguments(["service-status"])).toEqual({ kind: "service-status", options: { session: "default" } });
		expect(parseArguments(["cancel", "--data-dir", "/d"])).toEqual({
			kind: "cancel",
			options: { session: "default", dataDir: "/d" },
		});
	});

	it.each([
		["serve", "-p", "hello"],
		["send"],
		["send", "hello", "extra"],
		["service-status", "--model", "x"],
		["attach", "--model", "x"],
		["attach", "stray"],
		["attach", "--plain", "--plain"],
		["send", "hello", "--plain"],
		["cancel", "--session"],
		["serve", "--session=a", "--session=b"],
		["send", "--"],
		["send", "--", "hello", "extra"],
		["send", "hello", "--", "extra"],
		["send", "--", ""],
	])("rejects invalid service arguments %j", (...argv) => {
		expect(() => parseArguments(argv)).toThrow(UsageError);
	});
});
