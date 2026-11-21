// Line icons drawn as inline SVG through the DOM (no icon font, no CDN); geometry follows Lucide (ISC), as Hermes.app uses.

const svgNamespace = "http://www.w3.org/2000/svg";

function circle(cx: number, cy: number, r: number): string {
	return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

function rect(x: number, y: number, w: number, h: number, r: number): string {
	return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}

/** Path data on a 24 x 24 grid, stroked; `filled` icons are painted instead. */
const paths = {
	chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
	status: ["M22 12h-4l-3 9L9 3l-3 9H2"],
	memory: ["M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0","M3 5v14a9 3 0 0 0 18 0V5", "M3 12a9 3 0 0 0 18 0"],
	connections: [
		circle(12, 12, 2),
		"M16.24 7.76a6 6 0 0 1 0 8.49",
		"M7.76 16.24a6 6 0 0 1 0-8.49",
		"M19.07 4.93a10 10 0 0 1 0 14.14",
		"M4.93 19.07a10 10 0 0 1 0-14.14",
	],
	menu: ["M4 6h16M4 12h16M4 18h16"],
	close: ["M18 6 6 18M6 6l12 12"],
	send: ["m5 12 7-7 7 7M12 19V5"],
	copy: [rect(8, 8, 14, 14, 2), "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
	check: ["M20 6 9 17l-5-5"],
	warning: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
	error: [circle(12, 12, 10), "m15 9-6 6", "m9 9 6 6"],
	alert: [circle(12, 12, 10), "M12 8v4", "M12 16h.01"],
	info: [circle(12, 12, 10), "M12 16v-4", "M12 8h.01"],
	success: [circle(12, 12, 10), "m9 12 2 2 4-4"],
	chevronRight: ["m9 18 6-6-6-6"],
	chevronDown: ["m6 9 6 6 6-6"],
	search: [circle(11, 11, 8), "m21 21-4.3-4.3"],
	trash: ["M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2"],
	sun: [
		circle(12, 12, 4),
		"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
	],
	moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
	monitor: [rect(2, 3, 20, 14, 2), "M8 21h8M12 17v4"],
	logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"],
	plus: ["M5 12h14M12 5v14"],
	tool: [
		"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
	],
	file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
	terminal: ["m4 17 6-6-6-6", "M12 19h8"],
	spinner: ["M21 12a9 9 0 1 1-6.22-8.56"],
	clock: [circle(12, 12, 10), "M12 6v6l4 2"],
	history: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"],
	panelLeft: [rect(3, 3, 18, 18, 2), "M9 3v18"],
	panelRight: [rect(3, 3, 18, 18, 2), "M15 3v18"],
	arrowDown: ["M12 5v14", "m19 12-7 7-7-7"],
	user: ["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", circle(12, 7, 4)],
	shield: [
		"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
	],
	target: [circle(12, 12, 10), circle(12, 12, 6), circle(12, 12, 2)],
	link: [
		"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
		"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
	],
	lock: [rect(3, 11, 18, 11, 2), "M7 11V7a5 5 0 0 1 10 0v4"],
	pause: [rect(14, 4, 4, 16, 1), rect(6, 4, 4, 16, 1)],
	checks: ["m3 17 2 2 4-4", "m3 7 2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8"],
	mail: [rect(2, 4, 20, 16, 2), "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"],
	telegram: [
		"M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z",
		"m21.85 2.15-10.94 10.94",
	],
	plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"],
	cpu: [rect(4, 4, 16, 16, 2), rect(9, 9, 6, 6, 1), "M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"],
	more: [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)],
	refresh: [
		"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
		"M21 3v5h-5",
		"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
		"M8 16H3v5",
	],
	command: ["M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"],
	dot: [circle(12, 12, 4)],
	stop: [rect(6, 6, 12, 12, 1.5)],
	cost: [circle(12, 12, 10), "M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8", "M12 18V6"],
} as const;

/** Icons painted with the current color instead of stroked. */
const filled: ReadonlySet<IconName> = new Set<IconName>(["stop", "dot"]);

export type IconName = keyof typeof paths;

/**
 * Draws one icon at 16 px (size it with the class, e.g. `size-3.5`); it is hidden from assistive technology,
 * so the control around it must carry the name (visible text or `srOnly`).
 */
export function icon(name: IconName, className = "size-4 shrink-0"): SVGSVGElement {
	const svg = document.createElementNS(svgNamespace, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	svg.setAttribute("class", className);
	const paint = filled.has(name);
	svg.setAttribute("fill", paint ? "currentColor" : "none");
	svg.setAttribute("stroke", paint ? "none" : "currentColor");
	svg.setAttribute("stroke-width", "1.75");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	for (const d of paths[name]) {
		const path = document.createElementNS(svgNamespace, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}
