# A mission is the agent's enduring purpose

The mission defines why the agent exists. It survives a finished task, an empty queue, a pause in execution and a process restart. The creator agrees that purpose and its operating boundaries with the agent. The agent chooses bounded work that advances it; it does not repeatedly ask its creator to start the mission.

For example, “keep this repository's dependencies secure” is a mission. “Check this week's advisories and prepare a verified patch” is work toward that mission. Finishing the patch completes that work. It does not complete or erase the purpose. Waiting for the next approved observation is useful agent behavior, without a model heartbeat.

## Current implementation and required correction

The current source combines enduring purpose, one finite work allowance and one artifact-completion requirement in `MissionTerms`. Its separate execution ledger preserves receipts, evidence and uncertain effects, but supports only one bounded execution. The existing `mission start/pause/resume/stop` commands control that execution. They must not define the lifecycle of the agent's purpose.

This document defines the correction. Slice 1, the separate records and their migration, is implemented (see [Slice 1 status](#slice-1-status)). Slice 2, continuous operation of a creator-listed purpose, is implemented in source (see [Continuous operation](#continuous-operation-slice-2)); autonomous work selection is not. Existing approvals must never acquire new execution authority through migration. File-hash evidence can prove a work result, not fulfillment of an enduring mission.

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

## Slice 1 status

Implemented in `src/missions/purpose.ts`. A new Session document, `unit.mission.purpose` version 1, sits beside `unit.mission` (formation, version 2) and `unit.mission.execution` (ledger, version 2). Neither existing document changes version, and owner wire and projection shapes are unchanged. The purpose document does not stop the published 0.0.9 reader (see [Published reader round trip](#published-reader-round-trip)), and neither does a full owner database from this branch (see [Full-owner rollback qualification](../updates.md#full-owner-rollback-qualification)).

| Record | Stored as |
|---|---|
| Purpose agreement | `purpose`: mission ID, agreed revision, purpose, scope, approval boundary, review interval, creator, standing authority, and the exact receipt ID and digest that agreed it. |
| Work definition | `work[]`: `legacy-N` items under purpose revision N, each holding the exact approved one-shot agreement. |
| Work execution | The existing `unit.mission.execution` ledger, unchanged. It belongs to the work item whose receipt ID and digest match its embedded agreement. |
| Agent operation | `operation`: `closed` with reason `autonomy_not_approved`. No code opens it. |

Example: a database whose formation agreed revision 1 and whose stopped execution used revision 1, later amended to revision 3, imports as purpose revision 3 with work `legacy-1` (purpose revision 1) and `legacy-3` (purpose revision 3). The stopped ledger keeps its counters, intent and evidence.

Migration is an idempotent import, not a document upgrade. At owner start, `MissionControl.initialize` records the saved execution's agreement and the formation agreement if they are missing. New approvals are recorded in the same commit that saves the agreement. The import:

- never reads or writes the protected authority file and never creates receipts; the purpose reuses the receipt's own digest;
- sets standing authority to `workSelection: not-approved`, no grantable actions and `allowances: lifetime`, so an old approval approves no autonomous selection, extra actions or renewal;
- skips while maintenance holds the Session, leaving it byte-stable for backup;
- records nothing for an unapproved draft or a version-one deadline holder;
- after a rollback, records on the next start an amendment that the old reader agreed;
- fails closed on conflicting history (different approved content for an already recorded revision), on invalid stored records and on a newer purpose document, without blocking ordinary owner startup.

### Stored records are a trust boundary

Durable checks a document's address and version, then returns its fields as stored. So every read of the purpose document, and every agreement taken from formation or the execution ledger, is validated in full before use:

- An agreement must be exactly what its embedded receipt approved: complete terms, a well-formed receipt copy, matching mission ID and revision, and a digest that recomputes from the terms and the receipt's installation, session, authority revision and creator. No extra fields.
- The whole purpose document must equal what recording its own work agreements produces: each work item's ID, mission and purpose revision; the purpose built from the highest revision (or `null` with no work); the fixed standing authority; and a closed operation.

Example: a saved work item that keeps its receipt ID and digest but whose scope was changed fails the digest recomputation, so the import records nothing more and `readMissionPurpose` throws. Before this check, the import treated it as already recorded.

The receipt copy, not the protected authority file, is the reference. A creator reconfiguration that drops all receipts leaves imported history verifiable, and still approves nothing: admission checks the authority file.

### Approval while the purpose document is unreadable

Problem: issuing a receipt closes the agreed revision at once, because the authority file accepts only its latest receipt. If the approval commit then fails on the purpose document (for example, a version 2 left by a newer release), formation keeps revision 1, revision 1 is no longer authorized, and every restart retries the same failing commit.

- Before issuing a receipt, the owner reads and validates the purpose document. `approve-local` refuses a new receipt, and `propose` refuses, with "Mission purpose records are unreadable by this release; the agreed revision stays in force." The managed administrator command approves only a proposed draft, so the refusal to propose covers that path too.
- A receipt already issued (a crash after the receipt, a draft proposed before the document became unreadable, or a managed receipt) still reconciles. The commit records the formation agreement and leaves the purpose document as stored, a newer one included. The next owner start that can read the document imports the agreement from formation.

Proof: `test/missions/purpose.test.ts` and the crash fixture in `test/missions/control.test.ts`, which issues the receipt with both SQLite documents in their pre-approval state and asserts both after restart (real SQLite, closed restarts, faux provider with zero calls).

### Published reader round trip

Checked on 2026-11-21 with the published `unit-001-0.0.9-linux-x64.tar.gz` (SHA-256 `b7e6d3fcaa5ea357f0f7a754bcc1f93118157a466e79ef54cda19693cbcec617`), its app and bundled Node unchanged, in a network-disabled linux/amd64 container:

1. `node test/missions/fixtures/purpose-release-current.mjs seed FILE` (current build, after `npm run build`): the current mission owner agrees revision 1 and records purpose revision 1.
2. Copy `test/missions/fixtures/purpose-release-old.mjs` to the release's `app/`, then run `runtime/bin/node app/purpose-release-old.mjs FILE` in the container as the owner of `FILE`'s directory: 0.0.9 opens the database, shows revision 1 as agreed and agrees revision 2.
3. `node test/missions/fixtures/purpose-release-current.mjs verify FILE`: the full current owner opens the database and imports revision 2 as purpose revision 2 with work `legacy-1` and `legacy-2`.

All three steps passed. On 2026-11-22 the same sequence passed again with the slice-2 seed: the full current owner agrees one-shot revision 1, then runs a purpose loop (A's first attempt fails ambiguously and is acknowledged, A runs again, B runs) and closes it. Published 0.0.9 opens that database, ignores the purpose document and the terminal loop tasks, and agrees revision 2 through its own writer, which drops the purpose grant from the authority file. The current owner then finds the loop history, work digests, acknowledgment and ledger byte-identical, imports `legacy-2`, and no purpose receipt matches, so opening needs fresh consent. The slice-1 text below describes the original seed. Full-owner rollback is now qualified as well: `unit.memory` is back at version 1 with relations in a separate `unit.memory.relations` document, and `test/rollback/qualify.mjs` passed against the published 0.0.9 archive with both a fresh Session and one already holding version-2 memory, including the agreed mission, its purpose record and an amendment made by 0.0.9 ([Full-owner rollback qualification](../updates.md#full-owner-rollback-qualification)). That run used the checkout's `dist/`, so it cannot satisfy publication: before any release, rerun the qualification with `--candidate` set to the exact release archive, and pass one record per earlier published release to `scripts/update-repository.mjs prepare`, repeating `--rollback-qualification`.

Authority is still checked only against the protected receipt at admission. The purpose records are bookkeeping for later slices and grant nothing.

Not in slice 1, and still needing creator approval before any implementation: autonomous work selection, renewable allowances (period, ceiling, accounting), and whether a purpose agreement carries consent to begin continuous operation.

## Continuous operation (slice 2)

Implemented in source (not released). One purpose advances through bounded work items, waits between them with a persisted Durable sleep, and survives restart. Example: a purpose lists A (`reports/a.txt`) and B (`reports/b.txt`). The operator opens operation; A is written and verified; the loop sleeps until the next observation; the owner restarts; at the saved time B runs; the loop ends `idle`. Both runs draw on one lifetime ledger.

### Decided defaults

| Decision | Default |
|---|---|
| Work selection | Creator-listed. The loop takes the first listed work item whose digest is not done. No model call chooses work. |
| Allowance | Lifetime totals per mission (work items, cycles, requests, estimated spend, deadline). Never renewed or refunded: restart, reopen and amendment carry the ledger forward, and an amendment's ceiling is compared with what was already consumed. |
| Start consent | Separate protected step (`mission operate open`). Approving a purpose opens nothing. |
| Work kind | One: `artifact-digest`. A work item declares one workspace path and its SHA-256. The model may only call `unit_work_write`, which writes that run's declared path; the host verifies the digest. |
| Grant | A separate protected `purposeCeiling` (capability `artifact-digest`, path prefixes, caps). `unit_work_write` is never a one-shot tool name. A managed purpose receipt counts only with the creator's own assent (`approvedBy` `local-creator` with the creator's UID). |

### Records

`unit.mission.purpose` is version 2; version 1 migrates by adding an empty, closed `loop`. The slice-1 fields keep their meaning; a one-shot amendment adds `legacy-N` work and never replaces a purpose agreement. `loop` holds: purpose agreements (each with its full receipt copy), the proposed draft, the operation (state, applied intent, drain target, persisted next observation, activity), proposals, runs, and the ledger. Every read validates the whole document: the legacy part must be what recording its own agreements produces, agreements rebuild from their receipts, runs must name agreed work, and the ledger must equal what the runs consumed (at most 32 runs). Every ledger total, run counter, attempt ceiling and attempt cost must be a finite number (counters nonnegative integers; a priced attempt must carry its cost), because a missing or `NaN` value compares false in a spend or allowance check and would admit. Example: a saved ledger without `reservedCost` made `NaN >= cap` false, so B was charged a work slot and a cycle past the cap; it now fails validation. Status and execution use the same check (`readMissionPurpose`, `storedLoop`, `validPurposeLoop`), including every loop phase, admission, settlement, the work tool and drain: a document that fails validation runs and admits nothing, a woken loop ends without an effect, `open`, `acknowledge`, `suspend`, `close` and one-shot starts are refused, and status shows no purpose with `purposeError` set (text: `Purpose records are invalid: ...`). Malformed legacy history beside a valid loop counts as invalid too, so it cannot leave a loop running that status does not show.

Verified and settled are stored apart. A run is done only with accepted evidence and no uncertain effect (or an acknowledged one). Example: the provider writes A's exact bytes and the connection drops; A is `verified` but `unsettled`, and B waits until `mission operate acknowledge --run ID`. An acknowledged run without accepted evidence stays unfinished and its work is proposed again; its charges stay. Status lists every unsettled run, from any purpose revision, under `unsettled`, since the loop waits on all of them; an amendment that drops A from the work list does not hide A's run from acknowledgment.

### Admission and authority

Every admitting step reads the protected file inside the Durable commit that records it: open, acknowledgment rearm, proposal admission, cycle, provider reservation, tool intent, and the work tool's fence commit before its file write. Commits run one at a time, so the read is the ordering point: a revocation renamed before that read closes the step, even if the step was queued earlier. Example: an `open` or `acknowledge` request is queued behind another commit, and the receipt is revoked meanwhile; the commit reads the revoked file, so it creates no loop (an acknowledgment is still recorded, but nothing rearms). Dispatch and file writes happen only after that commit. An acknowledged suspend or close (its owner commit returned) admits nothing afterwards; a request already dispatched or a write already past its fence finishes and stays uncertain. Residual: a revocation written only to the file can miss one step whose read came just before the rename.

Each decision checks the newest purpose receipt, the exact applied open intent (request ID and sequence, so another intent that only reuses the sequence admits nothing), the authority revision, and the lifetime deadline. `open` applies the same decision in its own commit, so an expired purpose cannot be opened.

Each provider attempt is a record with its own ID and ceiling, settled at most once by that ID. Only a terminal response (stop, length or tool use) settles it: priced, or unpriced with the reservation kept. An error or abort may be a dropped transport after the provider received the request, and a stream that closes with a partial (`pending`) result proves nothing either, so these stay reserved, charged and blocking. The one-shot ledger also keeps a partial result unknown. A crash leaves the attempt reserved for the same reason. An attempt this process knows it never sent settles at zero cost and no longer counts as unbounded spend; the request stays charged. A spend cap introduced after attempts without a computable ceiling refuses further requests.

A work slot is never refunded, so it is charged only when the lifetime allowance can also pay for the item's first cycle and request (and the spend cap, if any, has room and no unbounded history). Example: A used the last lifetime cycle; the next observation blocks with `allowance_exhausted` and records no proposal, instead of charging B a slot that no cycle could use. Stored run history is bounded by each run's own approved work: no run may hold more cycles or attempts (released ones included) than its work allows.

### Operation, drain and restart

`suspend` and `close` commit the new state first and keep the loop as the persisted drain target; the loop is aborted afterwards and the target cleared only once its task is terminal. The commit that clears it first ends any run still marked running: aborted, and unsettled if it holds a reserved attempt or pending tool intent. This is needed because a phase can see the restrictive commit before the abort mark and end the loop normally, so no abort handler runs. An inhibited startup only abort-marks it. A new `open` or a one-shot start is refused until the drain ends. `acknowledge` records the decision even under a hold or inhibition; the loop is rearmed only with scheduling permitted, no hold or drain, and the current grant and open intent. The persisted next observation survives suspend, close and reopen.

Maintenance drain treats a loop sleeping for its next observation (or a maintenance re-sleep) with no live task in any run conversation as drained. Startup and hold-release scheduling rules are unchanged: a parked loop never lets a model-null owner schedule.

### Rollback

A release without the loop task leaves a live loop blocked and then defers its own updates. The mission status shows `rollback: live-loop` while a loop task is live; close operation before rolling back to such a release. The top-level `loopRollback` field answers the same question from live task inspection alone, so it stays correct when the purpose records fail validation and `purpose` is null (text: `Rollback: a loop task is still live.`). A rollback guard needs an affirmative `loopRollback: "no-live-loop"`; a null `purpose` or a missing field is no answer. The updater does not yet enforce this before activation; that check (`deploy/update-activation.mjs`, a feature flag in `release-compatibility.json`, and `agent-command.mjs` routing for `approve-purpose` and `operate`) is open work outside this slice.

## Acceptance

Use faux providers and real SQLite to prove two distinct bounded work items advance the same enduring purpose, with a persisted wait and restart between them. Complete one item and assert the purpose remains agreed. Exhaust an allowance and assert no additional work is admitted. Suspend operation during a request, drain it and preserve the purpose; a stale revision must not reopen work. Amend or revoke standing authority and reject previously planned actions. Prove old approvals do not enable the planner after migration. Inspect the actual 80×24 and 40×12 terminal flow and browser projection, in addition to logic tests.
