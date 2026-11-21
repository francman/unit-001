// Builds DOM from text nodes only, so owner and model text can never become markup.

/** A child accepted by `el`: nodes as they are, strings as text nodes, null/false skipped. */
export type Child = Node | string | null | undefined | false;

/** Creates an element with a class string and children; strings always become text nodes. */
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
	return node;
}

/** Sets attributes on a node and returns it; use for aria-*, data-*, id, role and similar. */
export function attrs<T extends Element>(node: T, values: Record<string, string>): T {
	for (const [name, value] of Object.entries(values)) node.setAttribute(name, value);
	return node;
}

/** Text only screen readers hear, for icon-only controls and state suffixes. */
export function srOnly(text: string): HTMLSpanElement {
	return el("span", "sr-only", text);
}

/** Renders plain text as paragraphs (blank-line separated) with line breaks kept; never parses markup. */
export function paragraphs(root: HTMLElement, text: string, className = "mt-3 first:mt-0"): void {
	root.replaceChildren();
	for (const block of text.split(/\n{2,}/)) {
		if (!block.trim()) continue;
		const p = el("p", className);
		const lines = block.split("\n");
		lines.forEach((line, index) => {
			if (index > 0) p.append(document.createElement("br"));
			p.append(line);
		});
		root.append(p);
	}
}

/** True on touch-first devices, where Enter inserts a line and focus is not moved for the person. */
export function coarsePointer(): boolean {
	return matchMedia("(pointer: coarse)").matches;
}
