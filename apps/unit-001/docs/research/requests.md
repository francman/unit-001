# Research and design briefs

These briefs preserve the engineering requirements behind the short board tickets. They define work to assess or implement; they do not claim that a feature has shipped. The board remains the live status record. Each finished report needs review and a durable repository link before its research ticket is complete.

## Deliverable shared by research items

Start with a recommendation readable in under one minute, then an official-source comparison and implementation appendix. Pin source versions and distinguish documentation, inspected code, test evidence and unverified claims.

The appendix must define components and interfaces, stored state and migrations, identity and permissions, approval rules, failure and restart behavior, resource limits, acceptance fixtures and ordered coding tasks. Name unresolved decisions explicitly. Reuse the existing owner and public Pi Durable APIs; do not introduce a second agent runtime or modify upstream Pi. A research result is not permission to enable external actions.

## Definitions and implementation boundaries

The [report index](README.md) links recommendations and coding definitions. The board holds live priorities and progress; this document preserves scope.

| Ticket | Work | Definition |
|---|---|---|
| [#10](https://github.com/francman/unit-001/issues/10) | README and upstream sync | [Application README](../../README.md) |
| [#14](https://github.com/francman/unit-001/issues/14) | Mission and creator agreement | [Mission-first implementation](agent-qualities.md#coding-ready-first-implementation) |
| [#33](https://github.com/francman/unit-001/issues/33) | Everyday operator access | [Operator access](../operations.md#operator-access-and-sudo) |
| [#39](https://github.com/francman/unit-001/issues/39) | Browser | [Browser worker](browser.md) |
| [#40](https://github.com/francman/unit-001/issues/40) | Messaging | [Messaging adapters](messaging.md) |
| [#41](https://github.com/francman/unit-001/issues/41) | Organizations and Paperclip | [Organization adapter](organizations.md) |
| [#42](https://github.com/francman/unit-001/issues/42) | Operational facts and costs | [Receipt-based metrics](self-metrics.md) |
| [#44](https://github.com/francman/unit-001/issues/44) | Security posture | [Factual posture report](security-posture.md) |
| [#45](https://github.com/francman/unit-001/issues/45) | Voice | [Speech adapters](voice.md) |
| [#46](https://github.com/francman/unit-001/issues/46) | Peer teams | [Collaboration contract](peer-collaboration.md) |
| [#47](https://github.com/francman/unit-001/issues/47) | Autonomous-agent qualities | [Agency qualities](agent-qualities.md) |
| [#48](https://github.com/francman/unit-001/issues/48) | Simplicity audit | [Feature-preserving refactors](simplicity-audit.md) |

## Mission agreement — #14

Bob must pursue a persisted mission without another prompt, with execution, verification and reassessment separated from process supervision. On first configured startup, the creator may be a human, an elder/parent agent or an authenticated organization principal. Provider setup does not establish mission authority. No approved mission means no autonomous execution; ordinary authorized conversation can still help draft one.

Administrator-owned policy binds the creator and maximum authority. The agreement records the exact goal, scope, actions, budgets, approval boundary, success evidence and review cadence. Approval targets an exact revision. Restart resumes the agreement or pending handshake; amendment and creator handoff invalidate stale decisions. Parent creation/delegation and uncertain external effects need stable receipts and reconciliation. Headless parent handshakes must not require a terminal.

Reuse the existing session-scoped `unit.mission` version 1 foundation, its mission/controller identity and nonexecuting deadline holder. The proposed shared version 2 must preserve existing IDs, policies, conversations and tasks without automatically agreeing to or executing legacy missions. Do not create separate mission stores for each adapter.

Tests must cover restart, pause, stop, deadlines, unavailable creators, stale approvals, duplicate child creation and authority expansion. Attribute generation, retries, compaction and explicitly bound helpers to their mission. Ordinary conversations still count toward installation costs, but not mission costs unless explicitly bound. Address provider-internal retries and deferred requests; a mutable current-mission variable is insufficient. Memory is not a prerequisite. Implementation remains coordinated through #15–#17 and research selection through #27.

## Trusted operator access — #33

Authorized operators use help/version, terminal attach, send/cancel, runtime status and memory inspection/edits without sudo. Forget keeps confirmation. Setup, sign-in/logout and credentials, configuration, identity, permissions, service lifecycle, updates and uninstall remain privileged.

Operators retain Bob's coding tools and agent-owned file authority. This is command authorization, not a model/tool sandbox. Direct credential/settings/database access and the private administration socket remain protected. Unrelated users and other installations' operators must be denied. Keep one database owner and avoid broad sudoers rules.

Acceptance includes real user/group isolation, normal terminal interaction, retained coding tools through a faux provider, native install, the actual published 0.0.6 updater migration, rollback/recovery and deployed normal-user checks. Existing installations need an explicit operator grant and fresh login. Removing group membership does not instantly revoke already-running processes or connected clients. One-time service-policy migration must be explicit and administrator-controlled, not hidden in help or an automatic restart.

## Browser — #39

First identify the actual official products behind “Muse”, “ChatGPT Dots” and “Claude Duets”; ambiguity must remain explicit until verified. Compare source-backed behavior rather than inventing product identities or links.

Define persistent browser/profile/session ownership, DOM and visual control, headless operation and visible human handoff. Cover authentication/cookie isolation, private data, hostile page content and model injection, and confirmations for external actions. Compare local and remote browsers against the 512 MB VPS's memory, CPU and network constraints, including reconnect and failure behavior.

The implementation plan must integrate the existing owner, tools, lifecycle and memory rather than another runtime. Test cross-agent denial, authentication retention, injected content, action approval and bounded resource use. Coordinate online research/proposals with #27. The research draft needs review and durable publication; no browser implementation is claimed.

## Messaging — #40

Messaging is authenticated mission control, delegation, approvals, progress, escalation and proactive outbound delivery. It must not turn the agent into a chatbot whose work stops when a conversation disconnects.

Compare official channel APIs and implementations, including outbound-only choices for the small VPS. Define creator/operator/parent/organization identity, pairing, channel/session ownership, and distinct security administration. Receiving a message never expands authority. Preserve private credentials/content and treat message bodies as untrusted data.

Persist message and action IDs, ordering, inbox/outbox receipts, approval revisions, delivery uncertainty, bounded retries and rate limits. Cover polling versus webhooks, public ingress and reconnect/restart costs. Tests must reject unauthorized or cross-agent control, replayed/stale approvals and duplicate actions, and retain unknown delivery honestly. Reuse #14 mission agreement, #17 owner controls, #41 organizations and #42 usage provenance. No live channel credentials or messages are needed for research acceptance.

## Organizations and Paperclip — #41

Verify Paperclip's official identity and current integration surfaces. Define human, elder-agent and organization creators, provisioning, work assignment, delegation, approvals, progress evidence, escalation, cancellation and creator handoff. Map organization and local mission ownership explicitly; disagreements must not silently overwrite either side.

Administrator-owned local policy remains the authority ceiling. Use authenticated identity and scoped delegation, tenant isolation, finite authority leases, correlation IDs and receipts. Remote revocation cannot be observed while disconnected; expiry bounds the gap, and observed revocation stops new admission according to the mission contract. A remote role, task or memory statement cannot grant local permissions.

The proposed first slice has one organization binding per installation, not a universal restriction. Keep the control plane off the small VPS. Compare outbound-only and inbound transports, avoid a broad trusted-operator endpoint for remote organizational control, and preserve the signed-update lifecycle. Share selected artifacts rather than private transcript/memory. Do not equate HTTP acceptance with completed mission work or a draft synchronization specification with a shipped runtime interface. Coordinate #14–#17, #39, #40 and #46.

## Facts and costs — #42

Bob must answer operational questions from recorded facts, including monthly cost, rather than guessing from model identity or conversation text. Compare OMP, OpenClaw, Hermes, Paperclip and relevant observability tools using primary sources.

Distinguish provider-reported charges, estimates, missing coverage, subscriptions and optional hosting/tool expenses. Attribute tokens, runtime, mission/task outcomes, failures and retries across parent agents and organizations without duplicate charges. Define calendar/month boundaries, pricing provenance and stale/unknown values; missing is not zero and estimated cost is not guaranteed billing.

Reuse public Pi/Durable usage and telemetry APIs, with read-only owner tools/CLI/TUI and durable receipts. Include voice/browser accounting interfaces without duplicating their adapters. Test crash/retry, reconciliation, deduplication, month boundaries, privacy and terminal behavior. Measure latency and capacity on the small VPS; no new telemetry daemon, mandatory hosted service or paid provider calls are required. Coordinate #17, #26 and #41.

## Security posture — #44

Define a small enforced control set and an authoritative read-only report of what is enforced, exposed, stale or unknown. Trusted operators retain coding tools; direct-client privacy and privileged administration do not sandbox those tools.

Audit owner/IPC boundaries, service hardening, credentials and tool environment, signed updates and recovery against actual code and primary security guidance. Report scope, observation time, check/version, pass/warn/fail/unknown, findings and remediation. Privileged evidence is optional; absence must not become a score or an assurance of no compromise.

Acceptance needs deterministic tests, actual terminal and deployment checks, bounded cost/latency and restart behavior. No security mutations, phone-home, secret contents in model context or paid requests. Coordinate mission authority, trusted access and adapter permissions with #14, #17, #33 and #40–#42. This is a design boundary before external autonomous integrations, not an assertion of complete security.

## Voice — #45

Research speech-to-text and text-to-speech as mission-control/status/approval and proactive-notification adapters, not another conversation runtime. Noisy or ambiguous commands must not silently authorize external effects.

Use official sources to compare hosted streaming/realtime services and practical open-weight alternatives. Record model/version, pricing units, partial/final text and audio latency, interruption and voice activity detection, language/noise performance, privacy/retention/residency, licenses and CPU/RAM/GPU needs. Separate published claims from independent evaluation and unknowns.

Define audio/transcript references, creator/mission binding, confirmation, replay, cancellation, restart, resource limits and cost attribution using the existing owner and #42 ledger. Fixtures must cover commands, numbers, accents, noise and interruptions, with UI/terminal acceptance where applicable. Choose a default/fallback and ordered coding slices. Dedicated voice research is active; no credentials, provider calls or dependency installation are needed for the assessment.

## Peer teams — #46

Support temporary or standing teams, formal organization membership and ad hoc peers. Define participants, roles, shared goals, duration, entry/exit, ownership, approval boundaries and success evidence. Peer collaboration is distinct from parent/child delegation and tool access.

Verify current A2A, Agent Client Protocol, legacy ACP and MCP roles from official sources. Do not treat them as interchangeable or import an entire orchestrator. Root-owned bindings and the shared mission contract govern tenant identity, delegated authority and finite leases, even for standing teams.

Persist delegation/task correlation, budget reservations, cancellation and effect receipts. Reconcile lost acknowledgments, timeouts and restarts instead of blindly repeating uncertain work. Share explicit artifacts with disclosure provenance; retain private memory locally. A participant saying done is not verified completion. Cover permission denial, interruptions, duplicates, lease expiry and resources on the 512 MB VPS. Coordinate #14–#17, #27, #39–#41.

## Autonomous-agent qualities — #47

Identify the exact official product/project behind the user's “Meta Muse” reference and relevant predecessors. Do not equate Muse, Manus or Muse Spark without evidence.

Compare demonstrated persistent missions, proactive work, planning, learning, tools, delegation, verification, accountability and supervision. Distinguish implementation evidence from marketing and ordinary conversational features. Rank useful qualities by value, effort and fit, then map them to existing tickets rather than another runtime.

Selected recommendations need coding-ready components, state/migrations, authority/approval boundaries, failure/recovery/resource contracts, tests and ordered tasks. Coordinate mission #14–#17, research/proposals #27, browser #39 and the OpenClaw feature assessment. The research draft needs review and durable publication; it does not approve implementation.
