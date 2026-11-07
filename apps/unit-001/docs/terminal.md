# Terminal interface for the always-on agent

Run `sudo agent attach` over SSH, or `sudo bob attach` for an installation named Bob. It connects to the running owner over its private socket; the client does not open SQLite or start another model runtime. Start the service first.

## Rich interface

Attach opens a full-screen terminal interface with a name/session/model header, a scrolling Markdown conversation, tool status cards, and a fixed composer. Live updates leave the draft and cursor intact. Output follows the conversation until you scroll away to inspect earlier text.

- **Enter** submits; **Ctrl+J** or **Shift+Enter** inserts a newline. The footer shows the active shortcuts.
- **PageUp/PageDown** scroll; **Ctrl+Shift+F** searches the displayed transcript when the terminal forwards that key combination distinctly. In search, **Enter/Shift+Enter** moves between matches and **Esc** closes search. These are default bindings; this does not search older or other sessions' history.
- `/status` shows identity, session, PID, version and activity; `/help` lists commands.
- `/cancel`, or **Ctrl+C** while working/submitting, cancels shared work. Cancellation can also withdraw queued inputs from other attached operators.
- `/exit`, `/detach`, **Ctrl+D**, EOF or a lost SSH connection detaches without cancelling admitted work. Idle **Ctrl+C** also detaches. Unsent drafts are not saved after exit.

One client allows one unresolved submission at a time; another prompt stays in the rich editor when rejected. Inputs are limited to 16 KiB. Request IDs appear at submission: after an uncertain disconnect, retry with `sudo agent send --request-id ID "the same prompt"` to avoid duplicate admission. Reattach manually after a disconnect or service restart.

## Status and bounded views

The footer shows recorded conversation-model token totals and estimated USD when the ledger has usable cost values. **Cost unknown** means the ledger cannot establish pricing; it never means a free request. Estimates are not provider invoices or subscription charges. Totals exclude tool and subagent usage; missing metadata remains unknown.

Tool cards retain recent committed successes/failures. A neutral `done` has no known outcome. Arguments, output, diagnostics and internal documents are not exposed in these cards.

Views contain at most 20 recent durable entries, 4,096 characters per displayed entry, 8,192 live characters and 32 tool status records. Truncation is visible. These are bounded snapshots: intermediate progress can fold together, and this is not a complete transcript export.

## Basic terminals and scripts

Use `sudo agent attach --plain` for the basic line interface. It is also selected when `TERM` is missing or `dumb`, or the initial terminal is smaller than 40 columns or 12 rows. Plain mode submits one line at a time; while a draft is being edited, remote display updates wait. Execution continues. Partial answer text appears when its line or answer completes.

Attach requires an interactive terminal in either mode. Use `send` for scripts and pipes; its final-answer stdout contract is unchanged.

Set `NO_COLOR` in the attaching process for monochrome rich output; for a named installation, use `sudo NO_COLOR=1 agent attach` where your sudo policy permits it.

## Remaining gaps

The [design](terminal-design.md), [omp assessment](terminal-assessment-omp.md) and [other terminal assessments](terminal-assessment-others.md) explain the direction. Persistent drafts, cross-session/older-history search, in-interface model/session switching, expanded tool output/diffs and complete transcript export remain later work. The CLI does not yet load a user keybinding file; override support currently exists only through the TUI's programmatic API. Foreground source chat remains a separate owner, with `/status` and corrected recovery cancellation.
