# Durable mission contract

The first-start slice forms a saved mission agreement with an authenticated creator. A person, elder agent, or organization can supply the goal, scope, evidence requirements, limits and approval boundary through the terminal or local headless commands. Approval records exact terms; it does not start autonomous execution. The controller remains [#15](https://github.com/francman/unit-001/issues/15).

This contract advances [#14](https://github.com/francman/unit-001/issues/14) and guides [#15](https://github.com/francman/unit-001/issues/15) and [#17](https://github.com/francman/unit-001/issues/17). Formation below is the current slice. Sections describing decisions, execution and verification specify later work.

See [formation verification and remaining native coverage](verification.md) for the local acceptance procedure and published rollback-reader check.

## First-start formation

The default owner session offers `/mission setup` without blocking ordinary work. Every submitted field saves a revision; cancellation and restart preserve that exact draft. No provider account or model call is needed to form it. An unconfigured owner still exposes mission, memory and runtime inspection; submitting ordinary model work explains how to configure a provider and restart the owner. Invalid configured authentication remains an error rather than silently becoming unconfigured.

Managed command privileges follow the existing operator boundary:

| Command | Authority and result |
|---|---|
| `bob mission status [--json]` | Authorized operator; shows the draft, exact proposal digest, receipt validity and execution availability. |
| `bob mission setup` | Authorized operator; guided editor saves each submitted field. |
| `bob mission draft --file terms.json --revision 0 --request-id draft-1` | Authorized operator; saves partial or complete terms. Later edits use the currently displayed revision. |
| `bob mission propose --revision 1` | Authorized operator; validates complete terms against the provisioned ceiling and saves their digest. |
| `sudo bob mission creator --file creator.json` | Administrator; binds a local human, elder or organization principal and finite maximum authority. Changing it invalidates previous approval. |
| `sudo bob mission approve --revision 1 --digest SHA256 --request-id approval-1` | Administrator; issues a receipt for exactly those terms, then asks the existing owner to reconcile it. |

`terms.json` contains `objective`, `scope`, ordered `successCriteria`, `approvalBoundary`, `reviewEveryMs`, and `policy`. Policy requires registered `allowedTools`, positive integer `maxCycles`, `maxRequests`, `maxConsecutiveNoProgress`, nonnegative integer `maxRetries`, and a future `deadlineAt` in epoch milliseconds. Optional `maxEstimatedCost` is an estimate, not a provider billing cap. Empty allowed actions and an empty additional approval boundary are explicit choices; missing required fields never invent allowances.

`creator.json` contains `creator: {kind, id, uid}` and `ceiling: {allowedTools, maxCycles, maxRequests, maxRetries, maxConsecutiveNoProgress, maxDurationMs, maxEstimatedCost?}`. The administrator provisions an existing local OS UID. The supplied label or conversation text cannot authenticate it. Remote channel, Paperclip and organization identity protocols are deferred; an elder or organization currently uses this same provisioned local principal.

Only the primary `default` session forms a mission in this slice. Other sessions remain ordinary work and explicitly reject formation commands. Developer-local instances use the same commands without sudo but report `developer-local` provenance: the user owns both the instance and its authority file, which provides no managed root attestation. Managed setup and provider changes retain their existing sudo and explicit owner-restart requirements.

### Approval and interruption

The root command executes only the selected, verified release's `deploy/mission.mjs`. It is a client of the existing owner, never another SQLite writer, Agent, provider or tool runtime. The private owner socket is not proof of administrator identity: coding tools share that service UID. Authority and approval receipts instead live in protected root-owned `/etc/unit-001/agents/INSTALLATION_ID/mission-authority.json`.

Each receipt binds installation, default session, creator UID and kind, authority revision, mission identity, draft revision and a canonical SHA-256 digest of every approved term. The root command validates finite ceilings and registered action IDs before publishing it atomically. A conversation message, model-claimed identity, memory record, owner document or approval-looking socket request cannot mint that receipt. Coding tools still retain the agent account's file authority; this is command authorization, not an OS sandbox or malicious-model containment claim.

Publishing a receipt precedes the owner's agreement commit. If interrupted, startup reconciles the exact still-current protected receipt, or the administrator retries the same request ID. Changed terms, a stale revision, changed authority or expiry block approval. A pending operator amendment does not change the current agreement; issuing its new protected receipt closes the prior authority immediately. Retained receipt history cannot restore older authority. Proposed terms may need a new deadline after expiry.

### Stored format and execution boundary

`unit.mission` version 2 preserves the existing version-1 `current` record, IDs, policy, counters, tasks and paused/stopped intent. It adds formation revisions, a partial draft, an agreement and a latest-operation replay receipt in the same session document. A version-1 current record seeds an incomplete draft for review; it never becomes automatically agreed. New formation allocates no controller, holder, execution conversation or scheduled task.

An agreement always reports `execution: not-implemented`. The existing nonexecuting version-1 holder remains registered solely so prior persisted tasks can reopen safely; maintenance recognizes only that exact owned holder. Controller admission, tool enforcement, completion proof, pause/resume and autonomous wakeup remain later slices. Reader compatibility must be verified against the exact published rollback artifact; a generic version-1 document reader is not promised to understand version 2.

The agent receives an objective, evidence required for success, and operating boundaries. It chooses an action, executes it, verifies the result, and chooses again without requiring another user prompt. Waiting must consume no model requests. A process restart must preserve the objective, limits, pending work, and reasons for waiting or stopping.

## Existing implementation and boundaries

The working tree already contains a headless service with an owner-only local socket, per-session SQLite ownership, and managed Ubuntu 24.04 x86-64 deployment under systemd. Named installations have stable identities. These provide hosting and submitted work, not autonomous missions. See [deployment](../deployment.md) and [operations](../operations.md).

Keep those identities separate:

- Installation identity selects the account, service, credentials, workspace, and release.
- Durable Session identity selects one storage file and its conversations/tasks.
- Mission identity selects an objective and its durable operating policy.

A mission pause must not stop another mission or the service. A service stop/kill preserves unfinished mission state and prevents the process from restarting until the operator starts it. Restarting the service must not activate a paused or stopped mission. Memory from #3–#9 is supporting evidence; it cannot grant authority or replace the mission record.

## Proposed first-slice decisions

The identity, Session scope, and explicit finite-policy requirements are reviewed for the nonexecuting foundation. These broader decisions require review before #15 enables autonomous execution:

| Decision | Proposed contract |
|---|---|
| Scope | One current mission per Durable Session initially. Different named sessions remain isolated; multiple concurrent missions in one Session are later work. |
| Ownership | A session-scoped mission document holds current state. A dedicated control conversation owns one background controller task; its execution conversation is task-owned. Ordinary interactive input stays separate. |
| Activation | An authenticated local operator explicitly creates and starts a mission with its policy. A normal chat message or remembered instruction does not create one. |
| Authority | The operator supplies explicit tool capabilities and any constraints that the host can enforce. There is no inferred permission from objective prose. Missing permission produces a durable blocker. |
| Limits | Activation requires finite cycle, request-attempt, retry, consecutive-no-progress, and wall-clock limits. Estimated spend can additionally stop admissions; it is not a provider billing cap. No numeric default or spending allowance is selected here. |
| Completion | The controller records evidence against each success criterion and the configured verifier accepts it. An assistant saying "done" is insufficient. |
| First verifier | Host-owned deterministic checks for supported objectives; unsupported verification asks for operator review. LLM judgment alone does not become proof of completion. |
| Scheduling | Immediate next cycles while progress is possible; persisted deadlines for bounded retry/reassessment; no requests while waiting for input or paused. |
| Hosting | Reuse the existing managed Ubuntu/systemd deployment. Source execution stays supported without adding other service installers in this slice. |

Choosing concrete numeric limits is part of mission activation, not an implicit repository-wide authorization. Implementations must reject missing or non-finite required limits rather than invent them. The foundation uses a waiting state with reason `execution_support`, which deadline expiry may change to blocked. It offers no lifecycle controls or mission replacement. The broader state transitions and runtime admission policy still require review before executable #15 work.

## Stored state and revisions

Define a versioned session-scoped `unit.mission` document through Durable public APIs. Session documents have no `history` or `fork` policy: every conversation in that Session reads current state. A conversation fork does not roll back mission policy. Supply deterministic stored-version migrations and test reopening older fixtures; incompatible newer state must fail clearly.

The document stores mission ID, objective, ordered success criteria, operator policy, the selected execution conversation, controller task ID, lifecycle state, counters, evidence references, and pending decisions/submissions. Store times as epoch milliseconds on the Harness clock. References use Durable's exported IDs; do not inspect internal SQL tables.

Keep three counters distinct:

- `revision` advances on each mission-state mutation and supports operator compare-and-set controls.
- `policyRevision` advances when the operator changes the objective, authority, limits, or lifecycle intent. Every admitted action records it; a stale action cannot grant itself current authority.
- `cycle` identifies one decision/execution/verification cycle. A retry or restart does not create a new logical cycle.

Use tagged lifecycle states with state-specific data:

| State | Meaning and allowed progress |
|---|---|
| `ready` | An active mission can start its next cycle after checking policy and remaining limits. |
| `running` | A persisted cycle identifies its decision, submission, and execution/verification phase. |
| `waiting` | Work awaits a stored deadline or named input; the reason and optional next wake are visible. No model polling while waiting for human input. |
| `paused` | Operator admission gate is closed. Preserve progress; explicit resume re-evaluates current evidence and policy. |
| `blocked` | A named problem requires operator action, such as missing authority, unknown external outcome, unsupported verification, or exhausted limits. Store the required resolution. |
| `completed` | All criteria have accepted evidence. No automatic continuation. |
| `stopped` | Operator ended the mission. Preserve history; later work requires a new mission identity. |

Durable task states (`pending`, `running`, `waiting`, `sleeping`, `terminal`) implement scheduling; they are not substitutes for mission lifecycle intent. A task ending or a conversation becoming idle does not prove mission completion.

## Decision, execution, and verification

A cycle saves a bounded next-action decision with its intended result, selected capabilities, current policy revision, and verification plan. The controller validates that decision before starting execution. Unsupported or ambiguous decisions become blockers rather than unbounded retries.

Use an explicit synthetic input entry carrying mission ID, cycle, and policy revision. The input must remain distinguishable from a human instruction for memory capture. Admit it through `Conversation.submit(tx, draft)` with a stable request ID derived from mission identity and cycle, and save its submission ID/checkpoint in the same `runtime.commit`. Admission must precede the commit's first table write; document reads and edits are allowed around it. On restart, use the persisted submission instead of asking the planner to choose again.

After its answer settles, inspect the persisted result and execute the declared verifier. Record evidence by entry IDs and verifier receipts. Verification failure produces either a bounded next corrective cycle, a persisted retry deadline, or a blocker. Completion is committed only when all criteria have accepted evidence and the mission policy is still current. Do not turn an unsupported verifier into an automatic success.

`continue` is for unfinished conversational context; after a final answer it produces `nothing_to_answer`. Each autonomous cycle therefore needs explicit mission input. `onYield` may continue a run but resets its turn count, so it is not the mission scheduler or a mission lifetime limit.

## Enforcing authority and work limits

Check lifecycle intent and policy at cycle admission, provider-request admission, and tool execution. Operator input and model/tool results cross trust boundaries and require schema validation; internal typed values do not need repeated defensive validation.

For tool actions, install host-owned wrappers or `beforeTool` blocking checks for both direct and nested calls. Grant only tools selected by the policy. A working directory is not a filesystem sandbox. General shell access can execute programs and access resources available to the account; a shell grant must acknowledge that scope. Do not claim path or network isolation from prompt instructions or command-name matching. Stronger containment requires an explicit environment/sandbox design before promising those restrictions.

For model requests, use a host-owned `Models` admission wrapper covering generation, retries, compaction, and any mission-paid helper requests. A `beforeRequest` hook only replaces messages; ordinary hook exceptions are reported and skipped, so throwing there is not an admission barrier. Reserve a request attempt durably before provider dispatch and settle its outcome afterward. A crash after reservation but before dispatch conservatively consumes the attempt allowance. A crash with an uncertain request must not silently refund it.

The mission controller owns finite cycle/retry/no-progress limits. Per-conversation `maxTurns` additionally bounds tool rounds in one run; it does not bound all model requests, mission cycles, or tool costs. Failed and aborted attempts count. Avoid unlimited model retries that bypass the mission allowance.

Durable usage totals report known token and estimated cost data. Reserve estimated cost conservatively where supported, including retries and maximum output, and stop new admissions at the policy threshold. Unknown/unpriced usage cannot count as zero. Provider retries, interrupted requests, subscription accounting, and external tool spend prevent this estimate from guaranteeing a final bill; strict billing controls belong at the provider/account boundary. Never label a token/cycle limit a dollar cap.

An action already dispatched when pause/stop is committed may still have effects. The acceptance guarantee is that later admissions observe the closed gate; cancellation is best effort for an in-flight external operation. Record the resulting evidence or uncertainty before resuming.

## Pause, stop, and maintenance

Operator controls reach the existing owner-only socket. A second CLI must not become another SQLite writer. Controls carry mission identity and expected revision so a delayed command cannot affect a replacement mission silently. Mission command names and wire schemas are to be defined with #17; existing service lifecycle commands retain their meaning.

Pause first commits lifecycle intent and advances the policy revision, closing admissions. Then signal the controller/execution scope. Stop additionally marks the mission terminal and reaches all mission-owned work, including background tasks and owned conversations. Unrelated service work must not be cancelled. Resumption creates at most one new controller after the previous scope drains; stale tasks recheck the policy revision before committing new work.

A Durable sleep cannot be advanced by editing a mission deadline alone. To react to a changed deadline or operator resume, close the old controller's gate, abort its sleeping task, wait for it to drain, then atomically install its replacement if the mission is still eligible. Do not create a second live controller while the first still owns work.

Release maintenance (#18) is a service-level admission barrier in addition to mission policy. It prevents both new mission cycles and ordinary submissions, drains to the chosen safe boundary, and preserves desired mission intent while the process is stopped. If draining times out, defer the update rather than declaring the agent idle. Readiness/compatibility startup runs with model/tool execution inhibited. A healthy activation reopens admission only if service intent, mission intent, and current policy all permit it.

## Restart and external-effect recovery

The registered controller definition must be installed before opening/resuming stored work. Its checkpoint contains all facts needed to select the next phase. Use durable `sleepUntil` for deadlines; a phase must not sleep in memory or recompute an already persisted deadline after every restart.

Durable's default sleep timer keeps a running Node process alive. If an evictable host uses `onWake`, that host must arm the next sleep and recovery wakeups before starting work, then call `resume()` when woken. Neither API resurrects a dead Node process; systemd supplies process restart. A service with a paused/stopped mission may remain available for operator controls without making model calls.

Atomic admission provides at-most-one stored submission per request ID, not exactly-once external execution. For an external action interrupted after dispatch, reconcile using a provider receipt, idempotency key, or observable result. If none exists, mark its outcome unknown and block automatic repetition. Verification must distinguish "not performed" from "may have completed". Never restore an old backup after new mission work has run merely to retry an action.

## Concrete trace

An operator assigns a bounded mission to inspect a repository and produce a report citing existing files. The policy grants the read tool, limits requests/cycles/deadline, and chooses a host verifier requiring accessible source citations and the report artifact. No shell or write capability is inferred from the objective; if creating that artifact needs an ungranted tool, the controller blocks and names the missing grant.

1. Activation persists mission identity, policy, and one controller. Cycle 1 saves a read plan and admits synthetic input with a stable request ID.
2. The process dies after admission. Restart reopens the same submission; it does not create another read plan or cycle.
3. The response cites two files. Verification records the evidence but finds a required section missing; cycle 2 is a bounded corrective action.
4. The operator pauses during a request. The durable gate closes first; an already dispatched request may finish, but no later tool/request is admitted. Status shows paused plus any pending outcome.
5. Resume advances policy revision and reconciles that outcome before the next cycle. A transient verifier error uses a stored retry deadline; a restart before that deadline performs no model polling.
6. The verifier accepts every success criterion. One commit records completion and its receipts. The service stays available; it makes no more autonomous requests for this mission.
7. Alternatively, a stop commits terminal intent and drains mission-owned background work. Service restart and future updates leave that mission stopped.

## Implementation slices and verification

| Slice | Deliverable and acceptance |
|---|---|
| #14 contract review | Approve or revise the first-slice choices, authority representation, verifier interface, and finite-limit input requirements above. No execution authority is activated by this document. |
| #15a durable mission state | Existing nonexecuting foundation in `src/missions/state.ts`; the formation slice above migrates its version-1 state to version 2. SQLite reopen/version boundaries and atomic activation tests reject a second mission/controller and stale policy references. Only legacy deadline holders run; formation adds no autonomous model/tool/submission admission. |
| #15b first executable loop | Faux model, explicit synthetic admission, host verifier, finite request/cycle allowances, and read-only capability fixtures. One assignment produces multiple verified cycles. Crash tests cover before/after admission, dispatched request, tool effect, verification, and completion. |
| #16 host integration | Wire the reviewed controller into the existing service. Kill/restart a real fixture process and prove persisted-deadline wakeup, one storage owner, and stopped-intent preservation. Existing headless/deployment work satisfies infrastructure, not this mission proof. |
| #17 controls | Local owner transport for inspect/pause/resume/stop. Test controls while requesting, executing, sleeping, blocked, and restarting. Include delayed controls and changed policy revisions. |
| #18 maintenance | Inhibited readiness, admission barrier/drain, compatible activation and recovery; paused/stopped mission intent survives. Coordinate with the updater's activation journal. |

Every slice runs meaningful faux-provider tests on real SQLite, plus `npm run check` for code changes. Measure added admission, policy, prompt, and checkpoint cost under #4. No live account or paid model is required for deterministic acceptance. Persistent memory can improve decisions later; #15's basic correctness cannot depend on it.

## Public API references

The current upstream sources provide [document semantics and checkpoint information](../../../../packages/durable/src/types.ts), [document definitions/migrations](../../../../packages/durable/src/documents.ts), [task runtime/ownership](../../../../packages/durable/src/types.ts), and [Harness, submission, hooks, and run limits](../../../../packages/durable/src/harness/types.ts). The [Durable spec](../../../../packages/durable/docs/spec.md), sections 5.6 and 8.3, defines durable sleep/wake and generation boundaries. [The turn-limit example](../../../../packages/durable/test/examples/33-turn-limit-and-continue.ts) demonstrates why conversational continuation is not a persistent mission loop.

No upstream file change is required by this proposed contract. If implementation exposes a missing public admission or ownership capability, identify it explicitly before changing the contract; do not patch upstream internals.
