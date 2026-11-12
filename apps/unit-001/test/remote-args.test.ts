import { describe, expect, it } from "vitest";
import { parseArguments } from "../src/args.ts";
import { parseRemoteArguments, REMOTE_COMMANDS } from "../src/remote/args.ts";

describe("explicit remote commands", () => {
	it("#55 exposes every supported verb through the typed command catalog", () => {
		expect(REMOTE_COMMANDS.map((command) => command.name)).toEqual([
			"add",
			"list",
			"remove",
			"connect",
			"status",
			"send",
			"cancel",
		]);
		expect(parseArguments(["remote", "list"])).toEqual({ kind: "remote", command: { action: "list" } });
		expect(parseRemoteArguments(["add", "work", "--host", "work-host"])).toEqual({
			action: "add",
			name: "work",
			host: "work-host",
			agentName: "agent",
			session: "default",
		});
		expect(parseRemoteArguments(["connect", "work", "--session=research", "--plain"])).toEqual({
			action: "connect",
			name: "work",
			session: "research",
			plain: true,
		});
	});

	it("#55 preserves literal prompts, stable retry IDs and explicit session selection", () => {
		expect(
			parseRemoteArguments(["send", "work", "--request-id", "same", "--session", "research", "--", "--help"]),
		).toEqual({
			action: "send",
			name: "work",
			session: "research",
			requestId: "same",
			prompt: "--help",
		});
	});

	it.each([
		["add", "work"],
		["add", "work", "--host", "-bad"],
		["connect", "work", "--session", "../bad"],
		["connect", "work", "--plain", "--plain"],
		["send", "work"],
		["send", "work", "--", ""],
		["list", "unexpected"],
		["remove", "work", "--host", "other"],
		["connect", "work", "--sudo"],
		["unknown"],
		["status", "work", "--session", "a", "--session", "b"],
	])("#55 rejects invalid remote arguments %j", (...argv) => {
		expect(() => parseRemoteArguments(argv)).toThrow();
	});
});
