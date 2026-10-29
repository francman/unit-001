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
		[["login"], /Usage: u1 login <provider>/],
		[["logout"], /Usage: u1 logout <provider>/],
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
