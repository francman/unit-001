// Checks the color math and that the map's colors keep their contrast against the page in light and dark.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgeStyles } from "./views/memory-graph-draw.ts";
import { contrast, parseColor, type Rgba } from "./views/memory-graph-theme.ts";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

// `--name: light-dark(<light>, <dark>)` lines of the page's stylesheet, as hex or rgb() colors.
function token(name: string, scheme: "light" | "dark"): Rgba {
	const line = new RegExp(`--${name}:\\s*light-dark\\((.+)\\);`).exec(css)?.[1];
	if (!line) throw new Error(`token ${name} not found`);
	const pair = /^(#[0-9a-f]{6}|rgb\([^)]*\)),\s*(#[0-9a-f]{6}|rgb\([^)]*\))$/i.exec(line);
	const value = pair?.[scheme === "light" ? 1 : 2];
	if (!value) throw new Error(`token ${name} has no ${scheme} value`);
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
	if (hex) return { r: Number.parseInt(hex[1] ?? "0", 16), g: Number.parseInt(hex[2] ?? "0", 16), b: Number.parseInt(hex[3] ?? "0", 16), a: 1 };
	const parsed = parseColor(value);
	if (!parsed) throw new Error(`token ${name} is not a color`);
	return parsed;
}

describe("memory graph colors", () => {
	it("parses the color strings a browser reports", () => {
		expect(parseColor("rgb(0, 83, 253)")).toEqual({ r: 0, g: 83, b: 253, a: 1 });
		expect(parseColor("rgba(23, 23, 26, 0.94)")).toEqual({ r: 23, g: 23, b: 26, a: 0.94 });
		expect(parseColor("rgb(230 237 243 / 0.56)")).toEqual({ r: 230, g: 237, b: 243, a: 0.56 });
		expect(parseColor("rgb(1 2 3 / 50%)")?.a).toBeCloseTo(0.5, 5);
		expect(parseColor("oklch(0.5 0.1 200)")).toBeNull();
	});

	it("computes the WCAG contrast ratio", () => {
		const white = { r: 255, g: 255, b: 255, a: 1 };
		const black = { r: 0, g: 0, b: 0, a: 1 };
		expect(contrast(black, white)).toBeCloseTo(21, 3);
		expect(contrast(white, white)).toBeCloseTo(1, 5);
		// A half-transparent black on white reads as mid-gray.
		expect(contrast({ ...black, a: 0.5 }, white)).toBeLessThan(contrast(black, white));
	});

	it.each(["light", "dark"] as const)("keeps nodes at 3:1 against the page and label text at 4.5:1 in %s", (scheme) => {
		const canvas = token("canvas", scheme);
		// Node colors by kind, and the colors of typed relations: all graphics, so 3:1.
		for (const name of ["accent", "ok", "warn", "info", "fg-2"]) expect(contrast(token(name, scheme), canvas), `${name} against the page`).toBeGreaterThanOrEqual(3);
		// The ring that marks the selection and the keyboard focus ring.
		expect(contrast(token("fg", scheme), canvas)).toBeGreaterThanOrEqual(3);
		// Labels are drawn in fg-2 (and fg when strong), at the opacity the map uses for them (0.85 at most when resting).
		const label = token("fg-2", scheme);
		expect(contrast({ ...label, a: label.a * 0.85 }, canvas)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(token("fg", scheme), canvas)).toBeGreaterThanOrEqual(4.5);
	});

	// Codex review: the old test checked source colors, but the canvas draws edges at reduced opacity; resting summary links were 1.88:1 in light.
	it.each(["light", "dark"] as const)("keeps every relation at 3:1 against the page at the strength it is drawn at rest in %s", (scheme) => {
		const canvas = token("canvas", scheme);
		const tokenNames = { fg3: "fg-3", ok: "ok", warn: "warn", info: "info" } as const;
		for (const [kind, style] of Object.entries(edgeStyles)) {
			const color = token(tokenNames[style.color], scheme);
			// The token's own opacity times the draw opacity: what the pixels are.
			const ratio = contrast({ ...color, a: color.a * style.alpha }, canvas);
			expect(ratio, `${kind} links in ${scheme}`).toBeGreaterThanOrEqual(3);
		}
	});
});
