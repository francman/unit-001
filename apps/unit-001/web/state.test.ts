// Exercises the draft and recovery state consumed by the chat composer and its notices.
import { describe, expect, it } from "vitest";
import { createStore, settleSend } from "./state.ts";

describe("send recovery", () => {
	it.each(["", "new draft"])("does not offer to replay an admitted send when the draft is %j", (draft) => {
		const { ui } = createStore({ theme: "system" });
		ui.sending = true;
		ui.draft = draft;
		settleSend(ui, { state: "failed-after-admission", message: "Your message was sent." }, "admitted", "original");
		expect(ui).toMatchObject({ sending: false, draft, unknown: null, error: "Your message was sent." });
	});

	it.each([
		["", "original"],
		["new draft", "new draft"],
	])("restores a provably undispatched send without overwriting a newer draft", (draft, expected) => {
		const { ui } = createStore({ theme: "system" });
		ui.draft = draft;
		settleSend(ui, { state: "failed", message: "Before dispatch." }, "rejected", "original");
		expect(ui).toMatchObject({ draft: expected, unknown: null, error: "Before dispatch." });
	});

	it("offers inspection with the request ID instead of restoring an uncertain send", () => {
		const { ui } = createStore({ theme: "system" });
		settleSend(ui, { state: "unknown", message: "Inspect the conversation." }, "uncertain", "original");
		expect(ui).toMatchObject({ draft: "", unknown: { requestId: "uncertain", prompt: "original" }, error: "" });
	});
});
