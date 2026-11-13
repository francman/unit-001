// Verifies local command intent resolution without a provider or executable side effects.
import { describe, expect, it } from "vitest";
import { commandCatalog } from "../../src/commands/catalog.ts";
import { describeCommandSuggestions, resolveLocalCommand } from "../../src/commands/resolution.ts";

describe("local command resolution", () => {
	it("resolves brain locally and leaves operands to the normal parser (#59)", () => {
		expect(resolveLocalCommand("/brain", "slash")).toMatchObject({
			kind: "exact",
			text: "memory",
			command: { id: "memory" },
		});
		expect(resolveLocalCommand("brain forget private-id", "cli")).toMatchObject({
			kind: "exact",
			text: "memory forget private-id",
		});
	});

	it("uses longest declared command and preserves case-sensitive operands", () => {
		expect(resolveLocalCommand("memory remember My KEY", "cli")).toMatchObject({
			kind: "exact",
			text: "memory remember My KEY",
			command: { id: "memory.remember" },
		});
	});

	it("ranks spelling and vocabulary suggestions deterministically without executing (#59)", () => {
		for (const input of ["/memroy", "/memories"]) {
			const result = resolveLocalCommand(input, "slash");
			expect(result.kind).toBe("suggestions");
			if (result.kind !== "suggestions") throw new Error("Expected local suggestions");
			expect(result.commands[0].id).toBe("memory");
			expect(result.commands.length).toBeLessThanOrEqual(3);
			expect(describeCommandSuggestions(result.commands, "slash")).toContain("nothing was executed");
			expect(resolveLocalCommand(input, "slash")).toEqual(result);
		}
	});

	it("leaves unsupported input unresolved and bounds ranking work", () => {
		expect(resolveLocalCommand("/xyzzy", "slash")).toEqual({ kind: "unresolved" });
		expect(resolveLocalCommand("x".repeat(513), "cli")).toEqual({ kind: "unresolved" });
		expect(commandCatalog("slash").some((entry) => entry.id === "setup")).toBe(false);
	});

	it("does not interpret shell syntax as an executable command", () => {
		const result = resolveLocalCommand("rm -rf /", "cli");
		expect(result.kind).not.toBe("exact");
	});
});
