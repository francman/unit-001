// Mission refusals cross the owner wire as fixed codes; terminals turn each into one readable sentence.
import { describe, expect, it } from "vitest";
import {
	describeMissionRefusal,
	MISSION_REFUSAL_CODES,
	MissionRefusal,
	parseMissionRefusalCode,
} from "../../src/missions/refusal.ts";

describe("mission refusal codes", () => {
	it("parses every known code and nothing else", () => {
		for (const code of MISSION_REFUSAL_CODES) expect(parseMissionRefusalCode(code)).toBe(code);
		for (const value of ["", "Stale", "stale_revision", null, 1]) expect(() => parseMissionRefusalCode(value)).toThrow();
	});

	it("gives every code a distinct sentence and keeps the code on the error", () => {
		const sentences = MISSION_REFUSAL_CODES.map(describeMissionRefusal);
		expect(new Set(sentences).size).toBe(MISSION_REFUSAL_CODES.length);
		const error = new MissionRefusal("held", "Service is held for maintenance.");
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ name: "MissionRefusal", code: "held", message: "Service is held for maintenance." });
	});
});
