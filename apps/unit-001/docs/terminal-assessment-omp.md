# Terminal improvements informed by oh-my-pi

Assessment: 2026-11-07. OMP source pinned to [`abc8f6eef3404f7cd91b3d52f150c97466c26ff6`](https://github.com/can1357/oh-my-pi/tree/abc8f6eef3404f7cd91b3d52f150c97466c26ff6). This is a documentation/source comparison, not a live usability or performance benchmark.

**Recommendation:** make the terminal a reliable client of the always-on agent before adding a richer editor. An SSH disconnect should lose the view, never the mission or admitted request.

## Evidence

| Area | OMP evidence | unit-001 today |
| --- | --- | --- |
| Sessions | [Resume picker](https://github.com/can1357/oh-my-pi/blob/abc8f6eef3404f7cd91b3d52f150c97466c26ff6/docs/session-switching-and-recent-listing.md) documents search, lifecycle labels, current-session markers and project scope. | `--session` selects a SQLite file; no listing, picker or transcript replay. |
| Input | [Keybindings](https://github.com/can1357/oh-my-pi/blob/abc8f6eef3404f7cd91b3d52f150c97466c26ff6/docs/keybindings.md) document external editing, prompt-history search, follow-up queues and draft recovery. | Readline submits each nonempty trimmed line; `/help`, `/exit`, `/quit`; no explicit multiline composer or persistent draft recovery. |
| Tools | [Interactive documentation](https://github.com/can1357/oh-my-pi/blob/abc8f6eef3404f7cd91b3d52f150c97466c26ff6/README.md#interactive--when-in-doubt-the-agent-asks) describes tool cards and structured questions. | `ToolAnnouncer` prints each started tool name once, without completion, duration, arguments or output. |
| Status | [Status types](https://github.com/can1357/oh-my-pi/blob/abc8f6eef3404f7cd91b3d52f150c97466c26ff6/packages/tui/src/status-line/types.ts) include model, context, usage and turn timing; [billing formatting](https://github.com/can1357/oh-my-pi/blob/abc8f6eef3404f7cd91b3d52f150c97466c26ff6/packages/tui/src/status-line/metrics.ts) distinguishes subscription and metered units. | Startup banner and prompt; service status exposes identity, PID, version and busy only. |

Local baseline before #21: [repl](../src/repl.ts), [render](../src/render.ts), [CLI](../src/cli.ts), [protocol](../src/service.ts), [arguments](../src/args.ts), read in full. Foreground mode acquires ownership; it cannot attach to the service's already-owned default session. `send` returns one final response; disconnect preserves admitted work but offers no live reattachment.

## Proposed order and acceptance

1. **Attach and recover.** Add `bob attach` over the existing private socket, retaining one SQLite owner. Replay bounded history, then ordered live text/tool events with reconnect cursors. Slow observers cannot block execution. Detach/EOF leaves work running; cancel is explicit. Test disconnect/reconnect during tools, duplicate admissions and service restart with faux models.
2. **Explain activity.** Show name/session/model, running/recovering/disconnected state, elapsed turn time, and tool start/result/failure summaries. Escape terminal control text, bound output, support narrow SSH terminals and plain output. Preserve clean script stdout. Usage/cost is optional when unavailable; label estimates and subscription usage accurately.
3. **Prevent input mistakes.** Add explicit multiline/paste submission, history, command completion and external-editor support. Keep drafts across reconnects. Document cancel versus detach; add PTY tests for paste, resize, Ctrl+C and EOF.
4. **Find prior work.** Owner-mediated session listing, readable titles/timestamps/state and transcript search; show the selected installation/session before submission. Switching views must not cancel work or start another owner.

Borrow interaction patterns, not OMP's runtime wholesale. Native tooling, remote collaboration, voice, themes and agent dashboards add scope beyond the immediate VPS operator need. Keep changes inside unit-owned packages without new dependencies or upstream modifications.

The foreground #21 slice adds `/status`, correct recovery cancellation, cancellation-listener cleanup, and a reusable terminal sanitizer. The table records the comparison baseline, not a completion checklist.

## Live setup and chat comparison for #36

The follow-up review ran installed OMP `18.13.3` with an empty profile and no provider environment, and unit-001 `0.0.4` in real PTYs. No model request was submitted. OMP source was reviewed at [`21f1188cf88b2f534c092181968cd5a4d1a9c296`](https://github.com/can1357/oh-my-pi/tree/21f1188cf88b2f534c092181968cd5a4d1a9c296); that source revision is newer than the installed binary, so source and observed behavior are distinguished here.

| Pattern | Observed OMP behavior and primary source | Unit implementation direction |
| --- | --- | --- |
| Stable setup frame | Step counter, strong title/subtitle, framed picker and fixed keyboard footer; [wizard overlay](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/setup/wizard-overlay.ts). | One focused step at a time, shared visual language with attached chat. |
| Visible selection/search | Typing `OpenRouter` immediately displays `Search: OpenRouter` and filters the provider list; [sign-in scene](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/setup/scenes/sign-in.ts). | Visible editable search, highlighted selection, explicit credential state and masked secret input. |
| Model choice | Bounded model browser, current/default selection and inline status; [model scene](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/setup/scenes/model.ts). | Search selected-provider models without a paid probe or an unbounded terminal dump. |
| Small terminal | The installed OMP's logo consumes eight rows at 40×12, cropping its picker and footer. | Preserve active input, selection and help first; reduce branding instead of reproducing that defect. |

The unit baseline reproduced invisible provider typing before Enter. Attached chat at 40×12 also lost its send hint and spent four transcript rows on two tool outcomes. The presentation changes label the composer, compress tool rows, keep the model readable, prioritize send/cancel/detach help and distinguish errors without relying on color.

OMP is MIT-licensed. This work independently implements its interaction patterns through existing public Pi APIs; it does not copy OMP branding, assets, runtime or scene code. Actual terminal acceptance is required in addition to logic tests; the [interaction specification](setup-experience.md) defines the gate.
