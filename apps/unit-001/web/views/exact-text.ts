// The one escape rule for exact text the owner reads before agreeing: Mission terms, plan terms and their editors.
import { text } from "../ui/classes.ts";
import { attrs, el } from "../ui/dom.ts";

// Unicode separators other than ASCII space, plus controls, isolated surrogates and literal backslashes.
const escaped = /[\\\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/gu;
const escapes = /\\\\|\\u(?:([\dA-Fa-f]{4})|\{([\dA-Fa-f]{1,6})\})/g;

/** Encodes text without normalizing it, including isolated surrogate code units. */
export function encodeExactText(value: string): string {
	return value.replace(escaped, (character) => {
		if (character === "\\") return "\\\\";
		const point = character.codePointAt(0) ?? 0;
		const hex = point.toString(16).toUpperCase();
		return point <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
	});
}

/** Reads typed escapes back into text; an escape for a surrogate or a point past U+10FFFF stays literal, so typing never creates an isolated UTF-16 code unit. */
export function decodeExactText(value: string): string {
	return value.replace(escapes, (match, bmp: string | undefined, extended: string | undefined) => {
		if (match === "\\\\") return "\\";
		const point = Number.parseInt((bmp ?? extended) || "", 16);
		return point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? match : String.fromCodePoint(point);
	});
}

/** Quotes and isolates text so invisible differences remain visible without changing the terms. */
export function visibleExactText(value: string): HTMLElement {
	return attrs(el("bdi", `whitespace-pre-wrap ${text.mono}`, `"${encodeExactText(value).replaceAll('"', '\\"')}"`), { dir: "auto" });
}
