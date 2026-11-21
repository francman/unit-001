// Buttons and fields: the only interactive primitives; each carries a `data-key` so focus survives a redraw.
import { buttons, fields } from "./classes.ts";
import { attrs, el, srOnly } from "./dom.ts";
import { type IconName, icon } from "./icons.ts";

export type ButtonVariant = keyof typeof buttons;

/**
 * A text button. `key` must be unique on the page: after a redraw focus returns to the button with the same key.
 * The visible label is the button's whole text (tests and screen readers rely on it).
 */
export function button(options: {
	label: string;
	key: string;
	onClick: (event: MouseEvent) => void;
	variant?: Exclude<ButtonVariant, "icon" | "iconLarge">;
	icon?: IconName;
	disabled?: boolean;
	type?: "button" | "submit";
	title?: string;
}): HTMLButtonElement {
	const node = el("button", buttons[options.variant ?? "secondary"]);
	node.type = options.type ?? "button";
	node.dataset.key = options.key;
	if (options.icon) node.append(icon(options.icon, "size-3.5 shrink-0"));
	node.append(options.label);
	if (options.disabled) node.disabled = true;
	if (options.title) node.title = options.title;
	node.addEventListener("click", options.onClick);
	return node;
}

/** An icon-only button; `label` becomes its accessible name (screen-reader text) and its tooltip. */
export function iconButton(options: {
	icon: IconName;
	label: string;
	key: string;
	onClick: (event: MouseEvent) => void;
	size?: "small" | "large";
	disabled?: boolean;
}): HTMLButtonElement {
	const node = el("button", options.size === "large" ? buttons.iconLarge : buttons.icon);
	node.type = "button";
	node.dataset.key = options.key;
	node.title = options.label;
	node.append(icon(options.icon, options.size === "large" ? "size-4 shrink-0" : "size-3.5 shrink-0"), srOnly(options.label));
	if (options.disabled) node.disabled = true;
	node.addEventListener("click", options.onClick);
	return node;
}

/** A labelled text input; the label is visible unless `hideLabel`, then it is the accessible name. */
export function textField(options: {
	id: string;
	label: string;
	value: string;
	onInput: (value: string) => void;
	type?: "text" | "password" | "search";
	placeholder?: string;
	hideLabel?: boolean;
}): { root: HTMLElement; input: HTMLInputElement } {
	const input = el("input", fields.input);
	input.id = options.id;
	input.type = options.type ?? "text";
	input.value = options.value;
	input.autocomplete = "off";
	input.spellcheck = false;
	if (options.placeholder) input.placeholder = options.placeholder;
	input.addEventListener("input", () => options.onInput(input.value));
	const label = el("label", options.hideLabel ? "sr-only" : fields.label, options.label);
	label.htmlFor = options.id;
	return { root: el("div", "flex min-w-0 flex-col gap-1.5", label, input), input };
}

/** Hermes SearchField: borderless, leading search icon, underline on focus; submit is the form's job. */
export function searchField(options: {
	id: string;
	label: string;
	value: string;
	onInput: (value: string) => void;
	placeholder?: string;
}): { root: HTMLElement; input: HTMLInputElement } {
	const input = attrs(el("input", fields.search), { "aria-label": options.label });
	input.id = options.id;
	input.type = "search";
	input.value = options.value;
	input.autocomplete = "off";
	input.spellcheck = false;
	input.placeholder = options.placeholder ?? options.label;
	input.addEventListener("input", () => options.onInput(input.value));
	return { root: el("div", fields.searchWrap, icon("search", "size-3.5 shrink-0"), input), input };
}
