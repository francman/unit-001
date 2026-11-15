// Verifies #65 provisions browser access only through an explicit authorized operator terminal.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { main, type Runtime } from "../src/cli.ts";

describe("browser launcher authority", () => {
	it.each([
		{
			interactive: false,
			access: "operator" as const,
			args: ["web"],
			code: 2,
			message: "requires an operator terminal",
		},
		{ interactive: true, access: undefined, args: ["web"], code: 1, message: "without sudo" },
		{
			interactive: true,
			access: "operator" as const,
			args: ["web", "--data-dir", "/private"],
			code: 2,
			message: "cannot change their data directory",
		},
	])("#65 rejects unsafe provisioning $message", async (input) => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let output = "";
		stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		const runtime: Runtime = {
			managed: {
				id: "11111111-1111-4111-8111-111111111111",
				name: "agent",
				state: "/var/lib/unit-001/agents/11111111-1111-4111-8111-111111111111",
				...(input.access ? { access: input.access } : {}),
			},
			env: {},
			platform: process.platform,
			home: "/nonexistent",
			cwd: "/nonexistent",
			stdin: new PassThrough(),
			stdout,
			stderr,
			interactive: input.interactive,
		};
		expect(await main(input.args, runtime, new AbortController().signal)).toBe(input.code);
		expect(output).toContain(input.message);
		expect(output).not.toMatch(/ENOENT|One-time pairing code/);
	});
});
