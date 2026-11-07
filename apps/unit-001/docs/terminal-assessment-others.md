# Terminal assessment: service ownership before interface parity

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
