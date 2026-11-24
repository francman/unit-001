// Verifies the one classification of terminal input that the attached, foreground and rich terminals share.
import { describe, expect, it } from "vitest";
import type { CommandInterpretation } from "../../src/commands/interpretation.ts";
import {
	activityLabel,
	classifySlashInput,
	confirmsForget,
	describeInterpretation,
	interpretedCommands,
	isEvidenceCallId,
	parseMemorySlash,
	unknownCommandNotice,
} from "../../src/commands/slash.ts";

describe("slash input classification", () => {
	it.each([
		["/exit", { kind: "exit" }],
		["/quit", { kind: "exit" }],
		["  /detach  ", { kind: "exit" }],
		["/help", { kind: "help" }],
		["/?", { kind: "help" }],
		["/status", { kind: "status" }],
		["/cancel", { kind: "cancel" }],
		["/mission", { kind: "mission", setup: false }],
		["/mission status", { kind: "mission", setup: false }],
		["/mission setup", { kind: "mission", setup: true }],
		["/evidence", { kind: "evidence", argument: "" }],
		["/evidence  call-1 ", { kind: "evidence", argument: "call-1" }],
		["/inspect runtime", { kind: "inspect", text: "/inspect runtime" }],
		["/brain stats", { kind: "memory", text: "/memory stats" }],
		["/memory remember My KEY", { kind: "memory", text: "/memory remember My KEY" }],
		["/mission bogus", { kind: "unknown" }],
		["/exit now", { kind: "unknown" }],
		["", { kind: "empty" }],
		["   ", { kind: "empty" }],
		["hello there", { kind: "prompt", text: "hello there" }],
	])("classifies %j", (line, expected) => {
		expect(classifySlashInput(line)).toMatchObject(expected);
	});

	it("sends an operating-system question to the model even when it starts with a slash", () => {
		expect(classifySlashInput("/inspect os")).toEqual({ kind: "prompt", text: "/inspect os" });
		expect(classifySlashInput("what os are you running?")).toEqual({
			kind: "prompt",
			text: "what os are you running?",
		});
	});

	it("separates near misses and unmatched commands from known ones", () => {
		expect(classifySlashInput("/memroy")).toMatchObject({ kind: "suggestions" });
		expect(classifySlashInput("/xyzzy now")).toEqual({ kind: "unresolved", text: "/xyzzy now" });
		expect(classifySlashInput("/ ")).toEqual({ kind: "unresolved", text: "/" });
	});
});

describe("shared slash rules", () => {
	it("parses memory operands the same way for every terminal", () => {
		expect(parseMemorySlash("/memory")).toEqual({ operation: "stats" });
		expect(parseMemorySlash("/memory recall a\nb")).toEqual({ operation: "recall", query: "a\nb" });
		expect(parseMemorySlash("/memory forget id-1")).toMatchObject({ operation: "confirm-forget", id: "id-1" });
		expect(() => parseMemorySlash("/memory stats extra")).toThrow("takes no argument");
	});

	it("confirms a forget only on an exact yes", () => {
		expect(confirmsForget(" YES ")).toBe(true);
		expect(confirmsForget("y")).toBe(false);
		expect(confirmsForget("yes please")).toBe(false);
	});

	it("accepts only a single bounded token as a tool call ID", () => {
		expect(isEvidenceCallId("call_1")).toBe(true);
		expect(isEvidenceCallId("a b")).toBe(false);
		expect(isEvidenceCallId("x".repeat(200))).toBe(true);
		expect(isEvidenceCallId("x".repeat(201))).toBe(false);
	});

	it("words activity and unknown commands once", () => {
		expect(activityLabel(true)).toBe("working");
		expect(activityLabel(false)).toBe("ready");
		expect(unknownCommandNotice("Use /help.")).toBe("Unknown command. Use /help.");
	});

	it("turns an owner interpretation into catalog commands, or its explanation when none match", () => {
		const named: CommandInterpretation = {
			stage: "local",
			commandIds: ["status", "no-such-command"],
			explanation: "ignored",
			usage: null,
		};
		expect(interpretedCommands(named).map((command) => command.id)).toEqual(["status"]);
		expect(describeInterpretation(named)).toContain("/status");
		const none: CommandInterpretation = { stage: "model", commandIds: [], explanation: "Nothing matches.", usage: null };
		expect(describeInterpretation(none)).toBe("Nothing matches.");
	});
});
