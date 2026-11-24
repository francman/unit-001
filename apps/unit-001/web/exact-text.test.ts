// Exercises the one escape rule the Mission and plan editors and cards share.
import { describe, expect, it } from "vitest";
import { decodeExactText, encodeExactText } from "./views/exact-text.ts";

describe("exact text codec", () => {
	it("round-trips controls, invisible characters, non-ASCII spaces and literal backslashes", () => {
		const value = "a\r\nb\t\u202E\u0085\\u{202E} c\u00A0d\u2007e\u3000f\\";
		const encoded = encodeExactText(value);
		expect(encoded).toBe("a\\u000D\\u000Ab\\u0009\\u202E\\u0085\\\\u{202E} c\\u00A0d\\u2007e\\u3000f\\\\");
		expect(decodeExactText(encoded)).toBe(value);
	});

	it("encodes an isolated surrogate and an astral default-ignorable point", () => {
		expect(encodeExactText("a\uD800b")).toBe("a\\uD800b");
		expect(encodeExactText("\u{E0001}")).toBe("\\u{E0001}");
	});

	// The Mission editor once decoded these and sent an isolated UTF-16 code unit to the owner, while the plan editor kept them literal.
	it.each(["\\uD800", "\\uDFFF", "\\u{D800}", "\\u{110000}", "\\u{FFFFFF}"])("keeps a typed %s escape literal", (typed) => {
		expect(decodeExactText(typed)).toBe(typed);
		expect(decodeExactText(`x${typed}y`)).toBe(`x${typed}y`);
	});

	it("decodes typed escapes for ordinary and astral points and the escaped backslash", () => {
		expect(decodeExactText("\\u000A\\u0009\\u{1F600}\\\\u0041\\u0041")).toBe("\n\t\u{1F600}\\u0041A");
	});

	it("leaves malformed escapes alone", () => {
		expect(decodeExactText("\\u12 \\u{} \\u{1234567} \\x41")).toBe("\\u12 \\u{} \\u{1234567} \\x41");
	});
});
