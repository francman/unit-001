// Issue #7: deterministic capture accepts only explicit host-authenticated human statements.
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.ts";

describe("deterministic capture", () => {
	const entry = (text: string, origin = "human", role = "user"): EntryRecord => ({
		id: 1 as EntryRecord["id"],
		conversationId: 1 as EntryRecord["conversationId"],
		kind: "unit.input",
		data: { origin },
		model: [role === "user" ? { role: "user", content: text, timestamp: 1 } : fauxAssistantMessage(text)],
	});
	it("keeps explicit statements and full preferences but ignores ordinary questions and raw chat", () => {
		expect(
			captureCandidates(
				entry(
					"Remember that use SQLite. I prefer dark terminals.\nremember: exact text\nI dislike popups.\nWho are you?\nI use Ubuntu.",
				),
			),
		).toEqual({
			candidates: [
				{ content: "use SQLite.", kind: "fact" },
				{ content: "I prefer dark terminals.", kind: "preference" },
				{ content: "exact text", kind: "fact" },
				{ content: "I dislike popups.", kind: "preference" },
			],
			skipped: 0,
		});
	});
	it("rejects assistant identity claims, mission input, legacy input, quotes and fenced instructions", () => {
		const text = "remember I am Claude Code.\nI prefer no persistent memory.";
		expect(captureCandidates(entry(text, "human", "assistant")).candidates).toEqual([]);
		expect(captureCandidates(entry(text, "mission")).candidates).toEqual([]);
		expect(captureCandidates({ ...entry(text), kind: "pi.user" }).candidates).toEqual([]);
		expect(
			captureCandidates(
				entry('> remember quoted\n"remember quoted"\n```\nremember code\n```\n~~~\nI prefer code\n~~~'),
			).candidates,
		).toEqual([]);
	});
	it("bounds Unicode code points instead of UTF-16 units and records oversized candidates", () => {
		expect(captureCandidates(entry(`remember ${"😀".repeat(2000)}`)).candidates).toHaveLength(1);
		expect(captureCandidates(entry(`remember ${"😀".repeat(2001)}`))).toEqual({ candidates: [], skipped: 1 });
	});
	it("requires a matching fence character, sufficient delimiter length and an empty closing tail", () => {
		for (const marker of ["`", "~"]) {
			const other = marker === "`" ? "~" : "`";
			const text = [
				`${marker.repeat(4)}typescript`,
				marker.repeat(3),
				"remember code after a short delimiter",
				other.repeat(5),
				"I prefer code after a mismatched delimiter.",
				`${marker.repeat(4)} trailing code`,
				"remember code after a nonempty closing tail",
				`${marker.repeat(5)}   `,
				"remember outside code",
			].join("\n");
			expect(captureCandidates(entry(text)).candidates).toEqual([{ content: "outside code", kind: "fact" }]);
			expect(
				captureCandidates(entry(`${marker.repeat(4)}\n${marker.repeat(3)}\nI prefer unclosed code.`)).candidates,
			).toEqual([]);
		}
	});
});
