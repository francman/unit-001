# Bob should own a mission, not wait for the next message

**Recommendation:** prioritize agreed missions, durable autonomous decisions and verified progress. Browser control, messaging and voice are ways to observe and act; none alone establishes autonomy. Bob should choose useful next actions within its agreement, persist what happened, resume after restart and interrupt its creator only for a meaningful result, missing authority or a blocker.

Research/design for [#47](https://github.com/francman/unit-001/issues/47), checked 2026-11-09. This is a proposal, not a feature acceptance report. Bob source reviewed through `edf7503a58ab3ea47f99578c96e27b3a6d1e9d1e`. No competing product was exercised, no paid calls were made, and vendor descriptions are labeled accordingly.

## Identity and historical evidence

Meta's **Muse personal agent** launched September 8, 2026. It is distinct from the Muse Spark model family and from the July Meta AI product update. Meta's launch describes turning goals into plans, continuing after the app closes and proactively returning when circumstances change. It also describes a dedicated per-person VM and user-selected access. These are first-party product claims, not independent reliability measurements. [Meta launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

The earlier July Meta AI release described scheduled briefings and recurring work, plus steering an unfinished task. That makes it a useful functional predecessor, without proving Muse's internal runtime descended from precisely the same code. [July release](https://about.fb.com/news/2026/07/meta-ai-muse-spark-doesnt-just-think-it-acts/)

Operator's January 2025 research preview provided browser actions for a delegated task. OpenAI's July 2025 ChatGPT agent announcement combined browser action and research; the page now explicitly calls itself outdated. Treat these as historical steps from answers toward execution, not current product limits or evidence of permanent self-directed missions. [Operator](https://openai.com/index/introducing-operator/), [ChatGPT agent launch](https://openai.com/index/introducing-chatgpt-agent/)

Anthropic's December 2024 architecture article distinguishes predefined workflows from model-directed processes and tool selection. It now points readers toward newer tooling. Its enduring lesson is useful here: dynamic choices and environmental feedback matter more than adding another framework. [Architecture article](https://www.anthropic.com/research/building-effective-agents)

## What distinguishes the target agent

| Quality | Evidence and limitation | Bob decision |
|---|---|---|
| Durable purpose | Muse describes long-running goals; a product statement does not prove exact crash semantics. | Agreed mission revision must survive restart; no autonomous work before agreement. #14 |
| Initiative | Muse design describes schedule/event-driven work and filtering notifications for meaningful changes. | Durable wake sources feed a bounded decision cycle, not a permanent busy inference loop. #15–16 |
| Adaptive action | Anthropic's agent distinction concerns dynamic tool choice. | Model proposes the next useful action; host validates authority, bounds and stale revisions before admission. #14–15 |
| Observable outcomes | Muse design describes goals/activity views and deterministic approvals. | Show goal, current action, verified receipts, blockers and next wake; a generated summary is not evidence of completion. #17/#26 |
| Continuity | OpenClaw source includes standing orders and scheduled jobs; existing memory alone does not start work. | Reuse Durable jobs and the owner, not a second scheduler or memory-as-policy. #15–16 |
| Learning with provenance | Bob already has durable recall/capture and explicit forget. | Separate remembered evidence from mission authority; promote reusable lessons only with source references. #26 |
| Delegation | OpenClaw has explicit subagent handoff concepts; Hermes documents trusted execution boundaries. | Parent owns delegated scope, receipts and cancellation. Ad hoc peers and permanent organizations need authenticated principals. #27/#41/#46 |
| Controlled reach | Muse's security design separates its agent runtime from credential/permission services. Bob currently does not. | Preserve Bob's accepted trusted coding tools; report its real exposure. Any isolated credential broker is a separate profile. #44 |

OpenClaw references are pinned to `f947b3caf5d0fb04c780205dfeff509d87cd2527`: [standing orders](https://github.com/openclaw/openclaw/blob/f947b3caf5d0fb04c780205dfeff509d87cd2527/docs/automation/standing-orders.md), [cron mechanics](https://github.com/openclaw/openclaw/blob/f947b3caf5d0fb04c780205dfeff509d87cd2527/docs/automation/cron-jobs/how-it-works.md), [subagent handoff](https://github.com/openclaw/openclaw/blob/f947b3caf5d0fb04c780205dfeff509d87cd2527/docs/concepts/subagent-yield-handoff.md). The separate OpenClaw assessment contains the source-level fit review; do not infer benchmark parity. [Hermes security, pinned](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/SECURITY.md).

Muse's design article supports progress visibility and low-noise proactive communication, rather than a need to copy its avatar or chat layout. Its goal/activity/approval views are interaction patterns, not an API or implementation license. [Design account](https://muse.ai/blog/how-we-designed-muse)

Muse's security article describes a separate runtime cell, host-side credential and authorization services, and network controls. Its approvals are scoped capabilities outside the agent conversation. This supports separating policy enforcement from model interpretation. Reproducing that architecture would be a substantial isolation project; an extra reviewing LLM in Bob's own process would not reproduce it. No 512 MB feasibility follows from the article. [Security architecture](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

## Coding-ready first implementation

Reuse existing `apps/unit-001/src/missions/state.ts` and its version-1 `unit.mission` document. It currently supplies a nonexecuting foundation, not a running autonomous controller in `Agent.open`. Do not create another mission store or call the existing holder a completed autonomy feature.

1. **Agreement, #14.** Define a version-2 schema migration preserving identity, policy, paused/stopped intent and existing task references. Add authenticated creator principal (human, elder or organization), draft/agreed revision and exact approval receipt. Proposed owner operations are `proposeMission`, `approveMission`, `pauseMission` and `inspectMission`; they are new interfaces requiring design review, not existing methods. A restart cannot turn a draft into agreement. Test actual version-1 SQLite migration, stale approval, wrong creator, amendment and headless continuation.
2. **One durable decision cycle, #15.** In the mission component, persist wake receipt, observed state references, proposed action, authority revision, action key and outcome evidence. Use public Durable task/commit APIs. The host admits one action at a time initially. A model may choose an action or a reasoned wait; it cannot mint authority. Completion means verified evidence, not a successful tool response alone. External uncertain effects become `unknown` pending reconciliation; never blindly replay a purchase or message.
3. **Recovery and observation, #16–17/#26.** Integrate the controller with owner open/close, existing service lifecycle and safe operator IPC. Persist next wake and pause/cancel intent. Separate idle waiting from foreground busy so updates and shutdown can drain. Expose a compact mission view: agreement revision, action, last verified outcome, blocker and next wake. Run actual 80×24/40×12 PTYs plus closed-database restart and SIGKILL fixtures.
4. **Reach and collaboration, #27/#40/#41/#46.** Add a single authenticated event adapter and parent-owned delegation only after the first cycle works. Reuse inbox/outbox receipts and mission admission. Child/peer results are untrusted evidence until checked; they do not inherit root privileges or expand the parent agreement. Messaging and organization reports define those separate contracts.

Initial proposed limits: one active action and one inference at a time; bounded event batches and context; sleep until a relevant event/deadline instead of polling with paid inference. Measure RSS and wake/request latency on the actual 512 MB target before increasing concurrency. #42 supplies cost coverage, including unknown/uninstrumented work; token counters alone are not a hard billing ceiling. Paid-provider behavior is outside the no-cost acceptance suite.

The smallest end-to-end acceptance is concrete: agree that Bob watches a fixture release feed, wake it with a new release, let it choose between research and waiting, record a source-backed recommendation, restart it, and verify it neither loses the mission nor posts twice. Add a creator amendment during execution and prove the old revision cannot authorize the next action. Then expose the same evidence in the terminal without requiring another chat prompt.

## Adoption and licensing

Adopt the observable behaviors: continuity, initiative, dynamic bounded choices, evidence and clear intervention points. Adapt deterministic grants and progress views. Defer full browser runtime isolation, credential surrogation and parallel swarms until separately designed and measured. Reject claims that a personality, memory file, model brand or self-preservation goal makes Bob autonomous.

Meta's product/security articles describe a proprietary service; no source license or transferable implementation was established. OpenAI/Anthropic articles are architectural references, not permission to copy proprietary implementations. OpenClaw is MIT: retain its notice if substantial source is copied. This proposal requires no new dependency, runtime, account or copied implementation.
