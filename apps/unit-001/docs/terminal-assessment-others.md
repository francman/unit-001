# Terminal assessment: service ownership before interface parity

## Modern terminal composition review for #36

The terminal should open as an application, with a stable identity, one obvious composer, readable state and discoverable actions. The November 9 review compared the live OMP setup baseline, Herdr's official terminal preview and configuration documentation, and OpenCode's TUI documentation and home-view source. No production Herdr pane, provider account or model request was used for this comparison.

| Reference | Pattern adopted in unit-001 |
|---|---|
| [OMP setup](terminal-assessment-omp.md#live-setup-and-chat-comparison-for-36) | Persistent step chrome, framed searchable choices, highlighted selection and fixed keyboard guidance. |
| [Herdr terminal preview](https://herdr.dev/tui/) and [theme/layout configuration](https://herdr.dev/tui/docs/configuration/) | Stable identity and activity regions, semantic state labels, transparent host-aware foreground, and a clear distinction between a client view and a durable owner. |
| [OpenCode TUI](https://docs.opencode.ai/docs/tui/) and [home composition](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/home.tsx) | The default command opens the TUI; an empty workspace has a branded purpose, focused composer and compact contextual actions. |

The implementation opens the owner client for a bare managed invocation before credentials or storage are read. Explicit foreground flags retain their original meaning. Source foreground chat uses the same rich presentation through its already-open Agent, without creating another database owner. A stopped service shows a persistent setup/start screen rather than flashing a raw socket error. Empty conversations receive a compact welcome region; narrow screens prioritize model, input and actionable hints over branding.

The gate is independent real-terminal review at 80×24 and 40×12, with light/dark and monochrome frames, normal typing before Enter, masked secret entry, paste, resizing, busy/error states and lifetime-safe exit. This review does not claim feature parity with session browsers, dashboards, plugins or collaborative runtimes; those are separate features rather than requirements for a polished first interaction.

## Historical baseline before #21

Baseline reviewed 2026-11-07 before #21 implementation; see [current terminal behavior](terminal.md). Recommend a service-aware terminal client before adopting a full-screen interface. This is a source/docs assessment, not a hands-on benchmark of competitors.

## Evidence

| Interface | Useful behavior to adopt |
|---|---|
| Local Pi | [Usage](../../../packages/coding-agent/docs/usage.md) exposes tool results, steering versus queued follow-ups, session resume, and configurable interruption. Its [footer](../../../packages/coding-agent/src/modes/interactive/components/footer.ts) caches usage calculations and shows model, session, context, and cost; [status indicators](../../../packages/coding-agent/src/modes/interactive/components/status-indicator.ts) distinguish working, retry countdown, and compaction. |
| Claude Code | [Interactive controls](https://code.claude.com/docs/en/interactive-mode) distinguish interruption, task inspection, and exit. [Session management](https://code.claude.com/docs/en/sessions) reconnects to an already-running background session instead of loading another owner; persisted transcripts support named resume. |
| OpenCode | Its [current architecture](https://opencode.ai/docs/cli/) connects local clients to one shared background server, with an explicit standalone alternative. The [TUI](https://opencode.ai/docs/cli/tui/) distinguishes steering from queued input and provides session selection. |

These patterns support clearer ownership and recovery. They do not establish parity with Durable's restart semantics or require copying another product's shortcuts.

## Baseline gaps before #21

1. **Foreground/service confusion.** [`cli.ts`](../src/cli.ts) opens the database for bare `agent`; an active managed service therefore produces a lock error. [`lock.ts`](../src/lock.ts) suggests stopping the owner or choosing another session, without suggesting the existing service controls. Users should not need to stop an always-on agent to interact with it.
2. **No service progress.** [`service.ts`](../src/service.ts) returns one final reply. `send` cannot display streamed text or tool progress. Disconnect preserves admitted work, while foreground Ctrl+C aborts it; the distinction is not visible when sending.
3. **Recovery cancellation bug.** During [`repl.ts`](../src/repl.ts)'s interrupted-run recovery, `current` remains unset while `agent.idle()` waits. Readline Ctrl+C follows the idle-exit branch and never aborts the recovered run. The waiting call can outlive the closed input.
4. **Thin status.** The REPL only prints a name and generic prompt; service status exposes identity/version/PID/busy but no session/model/recovery explanation. Tool announcements show names without completion or failure.

## Recommended implementation order at baseline

**First:** fix recovered-run cancellation with a faux-provider regression. Add an identity/mode/session/model header, actionable owner-lock guidance, and an explicit “disconnected; work continues” hint for interrupted sends. Keep machine output stable.

**Next:** implement owner-socket attach with bounded streaming events and initial committed state. Detach must close only the client; cancel must be an explicit action. Reconnect must never submit duplicate work or open SQLite. Test slow/disconnected clients, restart, cancellation, and multiple observers.

**Later:** session picker, multiline editor, bounded transcript/tool expansion, and cached usage display through Durable public APIs. Avoid hot-path history scans, automatic recap model calls, new dependencies, or upstream edits. Show actual running/waiting state; do not label submitted work an autonomous mission.
