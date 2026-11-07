# Implementation, interface, and mission readiness review

Reviewed 7 November 2026 by Codex and Claude Code against `a147caae7` (PR #24), with the operator guidance and activity corrections accompanying this review.

## One-minute assessment

The project has a credible durable coding-service foundation: named installations, restart recovery, private owner controls, and a usable rich terminal. It is ready for continued engineering and a controlled **submitted-work** VPS pilot after real authentication and managed-terminal checks. It is **not yet an autonomous mission agent**. Mission and memory documents exist, but neither execution loop nor memory behavior is connected to production.

Build the smallest bounded mission loop next, with verified outcomes, request attribution, and pause/stop gates. Prove it with faux providers before granting live authority. Improve the interface around inspectable work and mission state; a browser dashboard is not necessary for that slice. Research fan-out, external ticketing, and authenticated updates follow explicit capability and recovery boundaries.

No user decision blocks fixture-based engineering. Live activation needs the target host/provider, mission objective and permissions, and finite operating limits.

## What is delivered

| Area | Evidence and present limit |
|---|---|
| Managed host | Ubuntu 24.04 x64, bundled Node, per-name UUID/account/state, systemd supervision. Real release CI covers installation, readiness, independent agents, lifecycle, rename and retained-data uninstall. It makes no model requests. |
| Durable work | One storage owner admits submitted prompts with retry IDs and resumes unfinished work. An answered prompt does not create another objective or decision. |
| Provider setup | API keys and subscription login adapters exist. Provider/model selection is configured at startup; real unattended authentication/refresh remains unverified. |
| Terminal | Rich and plain attachment use the owner's socket. Markdown, multiline editing, tool status, bounded history, draft retention during updates, cancellation and detachment work. |
| Missions | Versioned policy/state, atomic identity reservation, owned controller/execution conversation and an inert deadline task. The extension is not installed by `Agent.open`; there is no decision/execution/verification loop. |
| Memory | Versioned document contracts with provenance, receipts and tombstones; persistence/isolation tests. No production recall, remember/forget tools, capture or consolidation. |
| Maintenance | Release verification and managed activation exist. An authenticated feed, unattended updater, maintenance barrier and activation journal do not. |
| Performance | Checkpoint and request-preparation benchmarks are enforced. Mission admission and memory-specific budgets still need measurement. |

Sources: [agent](../src/agent.ts), [mission foundation](../src/missions/state.ts), [memory contracts](../../../packages/unit-memory/README.md), [release acceptance](../scripts/verify-managed-install.sh), [latency](latency.md).

## Interface review

| Operator journey | Assessment | Next change |
|---|---|---|
| Install and sign in | Identity isolation and credential ownership are implemented. Managed login previously recommended foreground mode; accompanying changes point to `sudo NAME start`, then `sudo NAME attach`. | Add a guided effective-provider/model status view; test real headless login and expiry. |
| Compose and follow work | Fixed composer, streaming Markdown, paste limits and live-update draft retention work at 80x24 and 40x12. The pending reply previously masked execution as Sending; authoritative busy state now displays Working. Managed dispatch now preserves the monochrome flag. | Preserve the restrained visual design. Prioritize information over more decoration. |
| Navigate | PageUp/PageDown and Ctrl+Shift+F work through the public TUI; search covers the displayed snapshot only. Help now exposes these defaults, which depend on terminal key forwarding. | Add older-history/session navigation later. Operator-loaded keybindings are not implemented; current override support is programmatic. |
| Inspect tools and errors | Cards show bounded name/status, including committed success/failure. They cannot expand, show output/diffs, or explain a failed tool. Notices share muted styling and only the last three are shown. | Add bounded evidence/detail expansion and a distinct, readable failure/retry view. Preserve sanitization and keep secrets out of projections. |
| Understand cost | The footer correctly labels recorded conversation-model cost as an estimate or unknown. It excludes tool/subagent spend and is not subscription billing. | Explain scope in-app and eventually add mission/helper accounting. Never turn unknown pricing into zero or claim a billing cap. |
| Cancel, detach and stop | Detach leaves admitted work running. Cancel affects the shared conversation and can withdraw other operators' queued input; help now states this. Stop/kill remain separate privileged service commands. | Mission controls must target a mission and revision, with admission closed before cancellation. Service stop and mission pause must remain distinct. |
| Reconnect | Reattachment recovers bounded committed history. Unsent drafts are lost on client exit; request IDs support manual admission-safe retry. | Retain drafts and improve reconnect/retry guidance before relying on long remote operator sessions. |
| Select model/session | Header shows the model. Managed service startup serves the default session; `--session` targets an already served owner and does not provision another one. Models change through configuration/restart. | Add deliberate owner-mediated selection only after defining service/session ownership. Preserve script stdout contracts. |
| Observe a mission | There is no active mission panel or mission protocol yet. Ready currently means ready for submitted work. | Show objective, phase, evidence, remaining limits, waiting reason and pause/resume/stop when the mission loop lands. |

The interface audit passed 139 focused tests before these corrections. Headless terminal checks exercised scrolling/search and narrow layout; earlier tmux checks exercised multiline submission, resizing, detach and restoration. New release acceptance exercises the installed dispatcher/account switch through a real controlling terminal in color and monochrome, checking detach and restoration without model requests. Full SSH-client/key-encoding behavior, actual light-theme contrast and real-provider login remain explicit acceptance work.

See [terminal behavior](terminal.md), [controller](../src/terminal-controller.ts), [rich view](../src/terminal-ui.ts), [provider selection](../src/provider.ts) and [login](../src/login.ts).

## Recommended engineering sequence

1. **Prove mission request attribution and admission.** Bind an execution conversation to persisted mission identity/revision. The public `ProviderDoc`, conversation stream metadata and a host-owned `Models` wrapper offer a supported route to test. Generation, compaction, retries and helpers must count against the correct mission while ordinary conversations remain unaffected. Disable or account for provider-internal retries. Defer provider-deferred mode until its polling/handle attribution is covered. The public assistant-event-stream factory supports a denied request returning a terminal error; full recovery/accounting still needs executable proof.
2. **Complete the first mission loop and controls together (#14–#17).** One bounded assignment should produce explicit decisions, atomic synthetic admission, verified evidence and another cycle without another prompt. Use a deterministic verifier and read-only fixture tools. Test crash boundaries, stale policy, exhausted limits, sleep, pause and stop. Inspection and controls use the existing owner socket; no second SQLite writer. Memory is not a prerequisite.
3. **Finish host acceptance and run a controlled pilot (#20).** Exercise real managed attach/login through a terminal, actual reboot with running/stopped intent, and kill while a tool owns child processes. Then test a selected provider, small request allowance, restart and credential recovery on the approved host. Current readiness only proves local owner identity, not working provider credentials.
4. **Add bounded research and proposal work.** Persist source evidence, child identities/budgets, comparable candidates and selection receipts. Start with host-owned fetch/evidence tools, no shell or generic filesystem access in the research registry. Remote content is untrusted data. Size/time/redirect/address handling and credential non-exposure need tests. A steered model can still place mission context into requested URLs; an enforced source allowlist or selected search provider is needed, without promising elimination of every disclosure risk. This is a proposed capability boundary, not a shipped sandbox. General shell execution requires a separate credential/tool isolation design; environment filtering or a working directory alone is insufficient.
5. **Add replay-safe external ticketing and later maintenance.** Record a selected candidate before external writes. Use correlation markers/receipts and reconcile unknown remote outcomes; stable local submission IDs do not guarantee exactly-once GitHub effects. Implement memory along its [specified sequence](memory/port-spec.md) with measured recall cost. Implement #18's selected authenticated-update direction only after admission/drain and compatibility recovery exist.

The first mission proof should stay small. A generic multi-agent framework, browser dashboard, embeddings and autonomous self-modification are not prerequisites. Development-time agent coordination does not give the deployed unit a research or delegation capability.

## Decisions and authority

Engineering can proceed with faux providers, bounded fixture policies, deterministic verification, protocol design and recovery tests. It does not need a real cloud instance, model spend or permission to publish anything.

Before a live pilot, the operator must supply:

- **Target and provider:** AWS account/region or another host, provisioning authorization, provider/model and live request allowance. The selected defaults remain `agent`, Ubuntu 24.04 x64 and systemd; they need not be re-approved.
- **Mission and limits:** initial objective, required evidence of success, permitted repository/resources/tools, whether shell is allowed, and finite request/cycle/retry/no-progress/deadline limits. Estimated spend is an additional admission threshold, not a guaranteed invoice cap.
- **External authority:** allowed research sources or search provider, whether paid sources may be used, which external writes are allowed, and whether selected candidates need approval before ticketing or implementation. These grants apply to the deployed agent, not merely this development conversation.

Update signing-key custody and release credentials become decisions before enabling #18, not blockers to the mission proof. Routine command naming, UI layout and implementation choices remain engineering work. The [mission contract](missions/design.md) is a proposed execution design; merging this review does not activate a real mission.

## Board alignment

Keep #4, #6–#10 and #14–#18 open: their remaining acceptance is substantive. Keep #20 open for reboot and child-cgroup proof. #25 tracks the operator guidance/activity/help corrections accompanying this review. #26 covers inspectable work and recovery; #27 covers research, proposal selection and ticketing. These are future capabilities, not delivered by the hosting or TUI work.
