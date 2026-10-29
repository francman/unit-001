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
