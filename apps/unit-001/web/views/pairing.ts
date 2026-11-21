// Pairing screen: connects this browser to the local operator gateway with a one-time code.
import { callout, command } from "../ui/blocks.ts";
import { text } from "../ui/classes.ts";
import { button, textField } from "../ui/controls.ts";
import { attrs, coarsePointer, el } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";

export interface PairingOptions {
	/** Submits the one-time code; resolves to what happened so the screen can explain it. */
	submit(code: string): Promise<"paired" | "wrong" | "limited" | "unreachable">;
	/** Called once after a successful pairing; the caller mounts the workspace. */
	onPaired(): void;
}

const failures = {
	wrong: "Pairing failed. Check the code and try again. If it keeps failing, run the web command again for a fresh code.",
	limited: "That code was already used, or there were too many wrong attempts. Run the web command again for a fresh code.",
	unreachable: "Cannot reach the agent. Check that the web command is still running in its terminal.",
} as const;

const steps = [
	["Open a terminal where your agent runs.", "Use the computer or server you installed it on."],
	["Run its web command.", "Type your agent's name followed by web."],
	["Enter the code it prints.", "It is shown once and works once."],
] as const;

/** Renders pairing into `root`, replacing its content; the code lives only in the input and is cleared after each try. */
export function renderPairing(root: HTMLElement, options: PairingOptions): void {
	const failure = el("div", "");
	const code = textField({ id: "pairing-code", label: "One-time pairing code", value: "", type: "password", onInput: () => undefined });
	code.input.required = true;
	code.input.setAttribute("autocapitalize", "off");
	const submit = button({ label: "Connect", key: "pairing-connect", variant: "primary", type: "submit", onClick: () => undefined });
	submit.classList.add("w-full");
	const form = el("form", "flex flex-col gap-3", code.root, submit, failure);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		submit.disabled = true;
		failure.replaceChildren();
		void options.submit(code.input.value).then((outcome) => {
			code.input.value = "";
			if (outcome === "paired") return options.onPaired();
			submit.disabled = false;
			if (!coarsePointer()) code.input.focus();
			failure.replaceChildren(callout({ tone: "danger", body: failures[outcome], role: "alert" }));
		});
	});

	const card = el(
		"div",
		"flex w-full max-w-[28rem] flex-col gap-5 rounded-md border border-line bg-bubble p-5 shadow-[0_2px_4px_-2px_rgba(0,0,0,.07),0_8px_12px_-6px_rgba(0,0,0,.06),0_20px_28px_-14px_rgba(0,0,0,.06)] max-sm:p-4",
		el(
			"div",
			"flex flex-col gap-1.5",
			el("h1", text.title, "Connect to your agent"),
			el("p", text.body, "Your agent runs on your computer or server. Pair this browser once to talk to it and see what it is doing."),
		),
		stepList(),
		form,
		remoteHelp(),
		el(
			"p",
			text.description,
			"A pairing grants conversation and coding access and lasts thirty minutes. Keep the code private. Pairing never stops your agent: closing this tab leaves its work running.",
		),
	);
	const brand = el("div", "flex items-center gap-2 text-fg", icon("terminal", "size-4 shrink-0"), el("span", "text-sm font-semibold tracking-[0.12em]", "UNIT-001"));
	root.replaceChildren(el("main", "flex min-h-dvh flex-col items-center justify-center gap-5 bg-canvas px-4 py-8", brand, card));
	if (!coarsePointer()) code.input.focus();
}

function stepList(): HTMLElement {
	const list = attrs(el("ol", "m-0 flex list-none flex-col gap-2.5 p-0"), { role: "list" });
	steps.forEach(([title, hint], index) => {
		list.append(
			el(
				"li",
				"grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2",
				el("span", "grid size-5 place-items-center rounded-xs bg-fill text-xs font-medium text-fg-2 tabular-nums", String(index + 1)),
				el("p", "m-0 text-base text-fg", title, " ", el("span", "text-fg-3", hint)),
			),
		);
	});
	return list;
}

// The pairing screen has no workspace, so copying goes straight to the clipboard (127.0.0.1 is a secure context).
async function copyText(value: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		return false;
	}
}

function remoteHelp(): HTMLElement {
	const summary = el(
		"summary",
		"flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-xs text-sm font-medium text-fg-2 hover:text-fg pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden",
		icon("chevronRight", "size-3.5 shrink-0 transition-transform group-open:rotate-90"),
		"My agent is on another machine",
	);
	return el(
		"details",
		"group",
		summary,
		el(
			"div",
			"mt-2 flex flex-col gap-3 pl-5",
			el("p", text.body, "Connect your own computer to the other one first, so this address reaches it. The tunnel keeps the agent off the public internet."),
			command("ssh -L 4317:127.0.0.1:4317 your-server", "copy-tunnel", copyText),
			el("p", text.body, "In that terminal, run the web command, then come back to http://127.0.0.1:4317."),
			el(
				"p",
				text.description,
				"If the page says the origin is not permitted, the address must be exactly http://127.0.0.1:4317, not localhost, with the same port on both ends.",
			),
		),
	);
}
