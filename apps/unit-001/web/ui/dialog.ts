// Confirmation dialog content (Hermes ConfirmDialog); the shell owns the one <dialog> element and shows it modally.
import { text } from "./classes.ts";
import { attrs, type Child, el } from "./dom.ts";

/** The id the shell's <dialog> is labelled by; the content's title carries it. */
export const dialogTitleId = "dialog-title";

/**
 * Builds the content of the modal dialog: 15 px title, a sentence, optional body blocks, actions at the right.
 * Put `autofocus` on the button that should take focus when it opens (the safe choice for destructive actions).
 * Escape and the backdrop are the shell's job: they call the view's close action.
 */
export function dialogContent(options: { title: string; description?: string; body?: Child[]; actions: HTMLElement[] }): HTMLElement {
	const title = attrs(el("h2", text.title, options.title), { id: dialogTitleId });
	return el(
		"div",
		"flex flex-col gap-4 p-5 max-sm:p-4",
		el("div", "flex flex-col gap-1.5", title, options.description ? el("p", text.body, options.description) : null),
		...(options.body ?? []),
		el("div", "flex flex-wrap items-center justify-end gap-2 pt-1", ...options.actions),
	);
}
