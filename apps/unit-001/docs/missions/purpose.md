# A mission is the agent's enduring purpose

The mission defines why the agent exists. It survives a finished task, an empty queue, a pause in execution and a process restart. The creator agrees that purpose and its operating boundaries with the agent. The agent chooses bounded work that advances it; it does not repeatedly ask its creator to start the mission.

For example, “keep this repository's dependencies secure” is a mission. “Check this week's advisories and prepare a verified patch” is work toward that mission. Finishing the patch completes that work. It does not complete or erase the purpose. Waiting for the next approved observation is useful agent behavior, without a model heartbeat.

## Current implementation and required correction

The current source combines enduring purpose, one finite work allowance and one artifact-completion requirement in `MissionTerms`. Its separate execution ledger preserves receipts, evidence and uncertain effects, but supports only one bounded execution. The existing `mission start/pause/resume/stop` commands control that execution. They must not define the lifecycle of the agent's purpose.

This document defines the correction; it does not claim the purpose/work separation or continuous planning is implemented. Existing approvals must never acquire new execution authority through migration. File-hash evidence can prove a work result, not fulfillment of an enduring mission.

## Implementation contract

Keep the existing sole storage owner, Durable scheduler, protected creator receipts and request/tool admission gates. Split the data and authority they describe:

| Record | Meaning | Changes |
|---|---|---|
| Purpose agreement | Stable mission identity, purpose, intended scope, creator, standing authority and review conditions. | Explicit creator approval of exact revisions; no automatic expiry of the purpose when a work allowance expires. |
| Work definition | A bounded objective, evidence requirements, selected capabilities, finite allowances and deadline, linked to its purpose revision. | Proposed by the agent within standing authority, otherwise awaiting creator approval. |
| Work execution | Existing task/conversation identities, counters, receipts, evidence and uncertainty for one work definition. | The owner admits, executes, verifies and closes work through existing gates. |
| Agent operation | Whether the agent may admit autonomous work; observation deadlines and reasons for waiting or requiring help. | Protected creator/administrator intent. Suspending operation preserves the purpose and all unfinished work. |

Standing authority must state whether autonomous work selection is approved, which registered actions are grantable, and how finite allowances apply. A work completion, restart or elapsed review interval never resets a lifetime allowance or invents new spend. If renewable allowances are desired, their period, ceiling and accounting must be explicitly approved and persisted before admission.

The planner consumes a wake/event once, inspects saved evidence and remaining authority, then proposes one bounded work definition or a reasoned wait. It records the proposal before external effects. The host validates its purpose revision, operations and allowances; model prose cannot grant permission. Reuse Durable sleeps for the next observation. Unknown request/tool effects block the affected work until reconciled; they cannot be discarded by planning a replacement.

## Migration and release boundary

Introduce an explicit new mission document version only with real SQLite fixtures. Preserve old identity, approved terms, authority digests, counters, paused/stopped intent, controller references and evidence. Imported one-shot terms become a legacy bounded work definition under the saved purpose. Old approvals remain restricted to their exact old scope; a new approval is needed for autonomous work selection or renewable allowances. Do not reuse a different digest under an existing receipt.

Retain registered old task definitions/checkpoint readers while they may be persisted. Keep existing execution controls functional during migration; expose their meaning as work/agent-operation controls rather than silently deleting them. A new purpose agreement can include explicit consent to begin continuous operation, removing a separate “start mission” ritual without weakening creator consent.

Implement in this order: purpose/work schemas and migrations; separate approval/operation intents; work admission and preserved accounting; bounded planner/wake receipts; projections and first-start flow; release qualification. Do not market the one-shot engine as complete continuous operation before these slices pass.

## Acceptance

Use faux providers and real SQLite to prove two distinct bounded work items advance the same enduring purpose, with a persisted wait and restart between them. Complete one item and assert the purpose remains agreed. Exhaust an allowance and assert no additional work is admitted. Suspend operation during a request, drain it and preserve the purpose; a stale revision must not reopen work. Amend or revoke standing authority and reject previously planned actions. Prove old approvals do not enable the planner after migration. Inspect the actual 80×24 and 40×12 terminal flow and browser projection, in addition to logic tests.
