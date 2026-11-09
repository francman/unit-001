# Terminal interface for the always-on agent

Run `sudo agent` over SSH, or `sudo bob` for an installation named Bob. Bare interactive entry opens the terminal client of the running owner; it does not read provider credentials, open SQLite or create a second model runtime. `attach` remains an explicit equivalent. If the service is unavailable, a persistent screen shows the setup/start commands and waits for you to exit; it never starts the service automatically.

Source development uses the same rich interface around its already-open foreground owner. Explicit foreground options such as `--model` and `--session` retain their existing owner behavior. Closing a foreground session closes that process; closing an attached client leaves the managed service running. The header and footer distinguish these modes.

## Rich interface

The full-screen interface has a branded name/session/model header, a scrolling Markdown conversation, compact tool outcomes, and a fixed composer. An empty workspace explains where to ask a question or describe a task. Live updates leave the draft and cursor intact. Output follows the conversation until you scroll away to inspect earlier text.

The composer border names the agent and shows the newline shortcut; ordinary typing appears immediately. Tool outcomes use compact `[status] name` rows. Actionable failures are marked **Error** even in monochrome. The header keeps the model and version visible; `/status` provides the process ID.

- **Enter** submits; **Ctrl+J** or **Shift+Enter** inserts a newline. The footer shows the active shortcuts.
- **PageUp/PageDown** scroll; **Ctrl+Shift+F** searches the displayed transcript when the terminal forwards that key combination distinctly. In search, **Enter/Shift+Enter** moves between matches and **Esc** closes search. These are default bindings; this does not search older or other sessions' history.
- `/status` shows identity, session, PID, version and activity, then fresh owner-process start time, uptime and observation time; `/help` lists commands.
- `/memory` shows counts; `recall QUERY` finds evidence, `remember TEXT` stores a statement, `forget ID` asks for confirmation, and `sleep` schedules consolidation. See [memory commands](memory.md). These operations never submit a model request.
- `/cancel`, or **Ctrl+C** while working/submitting, cancels shared work. Cancellation can also withdraw queued inputs from other attached operators.
- `/exit`, `/detach`, **Ctrl+D**, EOF or a lost SSH connection detaches without cancelling admitted work. Idle **Ctrl+C** also detaches. Unsent drafts are not saved after exit.

Those detach semantics apply to a managed service client. In foreground mode, **Ctrl+D** and idle **Ctrl+C** are labeled **exit**; the caller closes the foreground owner after the view exits. Unfinished durable work can resume on the next launch. Busy **Ctrl+C** still requests cancellation.

One client allows one unresolved submission at a time; another prompt stays in the rich editor when rejected. Inputs are limited to 16 KiB. Routine submission notices are compact; uncertain send failures include a request ID. Retry with `sudo agent send --request-id ID "the same prompt"` to avoid duplicate admission. Reattach manually after a disconnect or service restart.

## Status and bounded views

The footer shows recorded conversation-model token totals and estimated USD when the ledger has usable cost values. **Cost unknown** means the ledger cannot establish pricing; it never means a free request. Estimates are not provider invoices or subscription charges. Totals exclude tool and subagent usage; missing metadata remains unknown.

At 40 columns, the footer prioritizes **Enter send**, compact token totals, cost availability and cancel/detach controls. The composer border retains the newline hint. Ctrl+C is labeled **exit** while idle and **cancel** while working or submitting.

Tool cards retain recent committed successes/failures. A neutral `done` has no known outcome. Arguments, output, diagnostics and internal documents are not exposed in these cards.

Views contain at most 20 recent durable entries, 4,096 characters per displayed entry, 8,192 live characters and 32 tool status records. Truncation is visible. These are bounded snapshots: intermediate progress can fold together, and this is not a complete transcript export.

## Basic terminals and scripts

Use `sudo agent attach --plain` for the basic line interface. It is also selected when `TERM` is missing or `dumb`, or the initial terminal is smaller than 40 columns or 12 rows. Plain mode submits one line at a time; while a draft is being edited, remote display updates wait. Execution continues. Partial answer text appears when its line or answer completes.

Attach requires an interactive terminal in either mode. Use `send` for scripts and pipes; its final-answer stdout contract is unchanged.

Set `NO_COLOR` in the attaching process for monochrome rich output; for a named installation, use `sudo NO_COLOR=1 agent attach` where your sudo policy permits it.

## Remaining gaps

The [design](terminal-design.md), [omp assessment](terminal-assessment-omp.md) and [other terminal assessments](terminal-assessment-others.md) explain the direction. Persistent drafts, cross-session/older-history search, in-interface model/session switching, expanded tool output/diffs and complete transcript export remain later work. The CLI does not yet load a user keybinding file; override support currently exists only through the TUI's programmatic API. Foreground source chat remains a separate owner, rendered through the same rich view and bounded projection.
