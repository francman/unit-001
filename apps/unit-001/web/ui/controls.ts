// Buttons and fields: the only interactive primitives; each carries a `data-key` so focus survives a redraw.
import { buttons, fields } from "./classes.ts";
import { el, srOnly } from "./dom.ts";
import { type IconName, icon } from "./icons.ts";

export type ButtonVariant = keyof typeof buttons;

/**
 * A text button. `key` must be unique on the page: after a redraw focus returns to the button with the same key.
 * The visible label is the button's whole text (tests and screen readers rely on it).
 * A submit button has no `onClick`: its form's submit handler does the work.
 */
export function button(
	options: {
		label: string;
		key: string;
		variant?: Exclude<ButtonVariant, "icon">;
		icon?: IconName;
		disabled?: boolean;
	} & ({ type?: "button"; onClick: (event: MouseEvent) => void } | { type: "submit"; onClick?: undefined }),
): HTMLButtonElement {
	const node = el("button", buttons[options.variant ?? "secondary"]);
	node.type = options.type ?? "button";
	node.dataset.key = options.key;
	if (options.icon) node.append(icon(options.icon, "size-3.5 shrink-0"));
	node.append(options.label);
	if (options.disabled) node.disabled = true;
	if (options.onClick) node.addEventListener("click", options.onClick);
	return node;
}

/** An icon-only button; `label` becomes its accessible name (screen-reader text) and its tooltip. */
export function iconButton(options: {
	icon: IconName;
	label: string;
	key: string;
	onClick: (event: MouseEvent) => void;
	disabled?: boolean;
}): HTMLButtonElement {
	const node = el("button", buttons.icon);
	node.type = "button";
	node.dataset.key = options.key;
	node.title = options.label;
	node.append(icon(options.icon, "size-3.5 shrink-0"), srOnly(options.label));
	if (options.disabled) node.disabled = true;
	node.addEventListener("click", options.onClick);
	return node;
}

/**
 * Hermes SearchField: borderless, leading search icon, underline on focus; submit is the form's job.
 * The caller places `label` (the field's visible name) where its layout wants it.
 */
export function searchField(options: {
	id: string;
	label: string;
	value: string;
	onInput: (value: string) => void;
	placeholder?: string;
}): { root: HTMLElement; input: HTMLInputElement; label: HTMLLabelElement } {
	const input = el("input", fields.search);
	input.id = options.id;
	input.type = "search";
	input.value = options.value;
	input.autocomplete = "off";
	input.spellcheck = false;
	input.placeholder = options.placeholder ?? options.label;
	input.addEventListener("input", () => options.onInput(input.value));
	const label = el("label", fields.label, options.label);
	label.htmlFor = options.id;
	return { root: el("div", fields.searchWrap, icon("search", "size-3.5 shrink-0"), input), input, label };
}
