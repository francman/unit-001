# Setup that shows what the keyboard is doing

The setup wizard should feel like OMP's searchable terminal choices, not a list of invisible readline prompts. Use one input owner and a stable step frame: agent identity and progress, the current choice or field, feedback, then keyboard help. Keep the input and primary action visible before optional decoration.

Normal input must appear as each character is entered. API keys and other secret fields display a mask; backspace and cursor movement update that mask without revealing the value. A bracketed paste stays in the active field. Newlines in a pasted key cannot approve later steps or save settings accidentally.

Provider choice shows configured state and lets the operator retain an existing credential. Authentication explains browser/code steps and offers a recoverable failure path. The model picker shows a bounded list from the selected provider, current/default markers and a visible search query. Review makes the selected provider/model and save action explicit. Setup makes no paid request.

At 80×24, use a clear title/subtitle, framed choices and stable footer. At 40×12, remove optional spacing and branding while retaining the active input, highlighted result and confirm/cancel guidance. Monochrome remains readable; no special font or animation is required. Key hints must come from the active bindings.

Critical titles and selected choices use bold default terminal foreground so light and dark palettes remain legible. Color is an accent, not the only indication of focus or failure. The installed bare command and source foreground chat open the rich conversation view by default on capable terminals; a missing service shows a persistent recovery screen rather than raw socket errors.

## Acceptance before release

Review actual terminal output for provider search before Enter, key typing/paste/backspace, model search, review/save, login failure, cancellation and EOF. Repeat at 80×24 and 40×12; resize during an unfinished field and confirm the draft survives. Confirm raw mode, cursor and alternate screen restore on every exit. Use only fake keys and fake provider/service data.

For attached chat, inspect visible draft typing during progress, multiline paste without submission, compact tool outcomes, readable errors, narrow send/cancel/detach hints and terminal restoration. Focused tests cover each modified mechanism; a separate reviewer inspects the real terminal frames and interaction transcript. Unverified provider/network behavior stays explicitly unverified.
