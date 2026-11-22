// Short confirmations that float at the top right, under the top bar, clear of the composer, and leave on their own.
import { el } from "./dom.ts";
import { icon } from "./icons.ts";

/** How long a toast stays; long enough to read two short sentences. */
const toastMs = 6000;

/** Creates the toast stack. It is not a live region: announce separately. */
export function createToaster(): { root: HTMLElement; show(text: string): void } {
	const root = el(
		"div",
		"pointer-events-none fixed top-11 right-3 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col items-end gap-2 max-md:top-13 max-md:right-auto max-md:left-1/2 max-md:-translate-x-1/2",
	);
	return {
		root,
		show(text) {
			const toast = el(
				"div",
				"pointer-events-auto flex max-w-full items-start gap-2 rounded-md border border-line bg-elevated px-3 py-2 text-sm text-fg shadow-float animate-rise",
				el("span", "mt-px text-ok", icon("success", "size-3.5 shrink-0")),
				el("span", "min-w-0 [overflow-wrap:anywhere]", text),
			);
			root.append(toast);
			setTimeout(() => toast.remove(), toastMs);
		},
	};
}
