// The map's colors: resolved from the page's CSS variables (a canvas cannot use classes), refreshed when the theme changes.
import { attrs, el } from "../ui/dom.ts";

/** Resolved CSS colors, ready for a canvas context. */
export interface Theme {
	accent: string;
	ok: string;
	warn: string;
	info: string;
	fg: string;
	fg2: string;
	fg3: string;
	/** The page background, for node outlines and label halos. */
	canvas: string;
	font: string;
}

/** A parsed sRGB color with alpha 0..1. */
export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

// One hidden probe per token: the page's own classes resolve `light-dark()` and `var()`, then `color` is read back as plain rgb.
// Whole class literals so Tailwind finds them.
const probes = {
	accent: "text-accent",
	ok: "text-ok",
	warn: "text-warn",
	info: "text-info",
	fg: "text-fg",
	fg2: "text-fg-2",
	fg3: "text-fg-3",
	canvas: "text-canvas",
} as const;

/** A set of probe elements to put in the page; `readTheme` reads them. */
export interface ThemeProbes {
	root: HTMLElement;
	read(): Theme;
}

/** Hidden elements that carry the theme's colors; add `root` anywhere inside the page. */
export function createProbes(): ThemeProbes {
	const nodes = Object.fromEntries(Object.entries(probes).map(([name, className]) => [name, attrs(el("span", `hidden ${className}`), { "aria-hidden": "true" })])) as Record<keyof typeof probes, HTMLElement>;
	const root = attrs(el("span", "hidden", ...Object.values(nodes)), { "aria-hidden": "true" });
	return {
		root,
		read() {
			const color = (name: keyof typeof probes) => getComputedStyle(nodes[name]).color;
			return {
				accent: color("accent"),
				ok: color("ok"),
				warn: color("warn"),
				info: color("info"),
				fg: color("fg"),
				fg2: color("fg2"),
				fg3: color("fg3"),
				canvas: color("canvas"),
				font: getComputedStyle(root).fontFamily,
			};
		},
	};
}

/** Calls `onChange` when the theme changes: the page's `data-theme` choice or the system's color scheme. Returns the stop function. */
export function watchTheme(onChange: () => void): () => void {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	const scheme = matchMedia("(prefers-color-scheme: dark)");
	scheme.addEventListener("change", onChange);
	return () => {
		observer.disconnect();
		scheme.removeEventListener("change", onChange);
	};
}

/** Parses the `rgb()`/`rgba()` strings a browser reports for computed colors, in comma or space syntax; null for anything else. */
export function parseColor(value: string): Rgba | null {
	const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
	if (!match) return null;
	const alpha = match[4] === undefined ? 1 : match[4].endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4]);
	return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}

/** WCAG contrast ratio of `fore` drawn over an opaque `back`; a translucent `fore` is blended onto `back` first. */
export function contrast(fore: Rgba, back: Rgba): number {
	const blended = { r: fore.r * fore.a + back.r * (1 - fore.a), g: fore.g * fore.a + back.g * (1 - fore.a), b: fore.b * fore.a + back.b * (1 - fore.a) };
	const high = Math.max(luminance(blended), luminance(back));
	const low = Math.min(luminance(blended), luminance(back));
	return (high + 0.05) / (low + 0.05);
}

function luminance(color: { r: number; g: number; b: number }): number {
	const channel = (value: number) => {
		const scaled = value / 255;
		return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}
