// Checks that resting relations, as composited on the canvas (token alpha times draw alpha), keep 3:1 against the page in light and dark (codex review, low).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgeOpacity, edgeStyles } from "./views/memory-graph-draw.ts";
import { contrast, parseColor, type Rgba } from "./views/memory-graph-theme.ts";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const tokenNames = { fg3: "fg-3", ok: "ok", warn: "warn", info: "info" } as const;

// A `--name: light-dark(<light>, <dark>)` token as hex or rgb().
function token(name: string, scheme: "light" | "dark"): Rgba {
	const line = new RegExp(`--${name}:\\s*light-dark\\((.+)\\);`).exec(css)?.[1];
	if (!line) throw new Error(`token ${name} not found`);
	const pair = /^(#[0-9a-f]{6}|rgba?\([^)]*\)),\s*(#[0-9a-f]{6}|rgba?\([^)]*\))$/i.exec(line);
	const value = pair?.[scheme === "light" ? 1 : 2];
	if (!value) throw new Error(`token ${name} has no ${scheme} value`);
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
	if (hex) return { r: Number.parseInt(hex[1] ?? "0", 16), g: Number.parseInt(hex[2] ?? "0", 16), b: Number.parseInt(hex[3] ?? "0", 16), a: 1 };
	const parsed = parseColor(value);
	if (!parsed) throw new Error(`token ${name} is not a color`);
	return parsed;
}

describe("memory graph resting edge contrast", () => {
	it.each(["light", "dark"] as const)("composites each relation kind at its resting draw alpha to at least 3:1 in %s", (scheme) => {
		const canvas = token("canvas", scheme);
		expect(canvas.a).toBe(1);
		for (const [kind, style] of Object.entries(edgeStyles)) {
			const color = token(tokenNames[style.color], scheme);
			const ratio = contrast({ ...color, a: color.a * style.alpha }, canvas);
			expect(ratio, `${kind} in ${scheme}`).toBeGreaterThanOrEqual(3);
		}
	});

	it.each(["light", "dark"] as const)("uses the alpha the canvas really draws with when nothing is focused or searched in %s", (scheme) => {
		const canvas = token("canvas", scheme);
		for (const kind of Object.keys(edgeStyles) as (keyof typeof edgeStyles)[]) {
			const style = edgeStyles[kind];
			// edgeOpacity is what drawEdges assigns to globalAlpha.
			const drawn = edgeOpacity({ focus: null, mix: 0, matches: null }, { from: 0, to: 1, kind });
			expect(drawn).toBe(style.alpha);
			const color = token(tokenNames[style.color], scheme);
			expect(contrast({ ...color, a: color.a * drawn }, canvas), `${kind} in ${scheme}`).toBeGreaterThanOrEqual(3);
		}
	});
});
