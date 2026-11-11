# Organization integration: proposed implementation definition

Research proposal for #41, not an implemented adapter. Reviewed source baseline: 2026-11-09. Depends on the mission authority contract in #14 before production admission. Access release work remains separate.

## Decision in under one minute

Keep unit-001 as the persistent execution owner. Integrate Paperclip through a small external adapter that admits or inspects a mission through an authenticated, bounded control port. Run Paperclip on another adequately sized host; do not place its control plane, database and UI on the 512 MB VPS as part of this slice. A successful adapter call means an admission or observation succeeded, not that the mission completed.

Start with one organization binding per installation. Preserve local private memory; share explicit result artifacts and evidence. Root-owned policy binds the creator and maximum authority. Organization goals, comments, role names and remembered statements cannot expand that policy. Use public Durable documents/tasks and the existing owner; add no second agent loop or SQLite writer.

The first adapter can use the existing SSH reachability, with a separately provisioned forced-command principal and no arbitrary shell/forwarding. It must use a mission-only endpoint, not the broad trusted-operator chat socket. This is a proposed transport, not a current feature. The contract can later support an outbound-only transport without changing mission semantics.

## Verified sources and decisions

Paperclip is [paperclipai/paperclip](https://github.com/paperclipai/paperclip/tree/02bfe71a6bbd7c5676cb7e72778b361c5bc72765), MIT. Its official organization links to this repository. Pin used here: `02bfe71a6bbd7c5676cb7e72778b361c5bc72765`.

| Evidence | Decision |
|---|---|
| [Agent authentication](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/docs/api/authentication.md) defines run JWTs, agent API keys, self-identity and company boundaries. | Adapt verified company/agent/run identity. Keep Paperclip credentials in its adapter host; never forward board cookies or a company-admin credential to the unit. |
| [Task workflow](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/docs/guides/agent-developer/task-workflow.md) defines atomic checkout, conflict handling, run attribution, child issues and revision-bound confirmation. | Adopt claim-before-work, do not retry ownership conflicts, bind approvals to exact revisions, and preserve parent/goal IDs. |
| [HTTP implementation](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/server/src/adapters/http/execute.ts) returns successful execution after an HTTP success response. | Reject generic HTTP success as proof of durable mission completion. Its webhook is a delivery mechanism, not our mission store. |
| [External adapters](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/docs/adapters/external-adapters.md) expose an external `createServerAdapter`/`execute` extension seam. | Prefer a small plugin over modifying Paperclip or importing its runner. Validate actual pinned SDK types before implementation; the informal root `adapter-plugin.md` is development notes, not the integration contract. |
| [Cryptographic identity](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/doc/AGENT-IDENTITY.md) distinguishes persistent identity from bearer authentication and states that independently hosted HTTP agents do not receive those private keys in v1. | Do not assume an organization UUID or signing key grants authority. Do not request/export Paperclip private identity keys to enable this adapter. |
| [External Task Protocol](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/docs/specs/external-task-protocol.md) is explicitly Draft v1 and concerns external task-manager synchronization. | Use its claim/provenance ideas as reference only; do not promise it is a released unit-agent execution interface. |

## Components and interfaces

1. `OrganizationBinding`: administrator-owned configuration. Fields: schema version, binding ID, local installation ID, organization/provider IDs, remote agent ID, trusted creator/parent identity, authenticated transport principal, policy revision, maximum delegated scope and limits, allowed control operations, and enabled/revoked state. V1 admits one organization per installation; other tenants need separate installations. Root administration creates or changes this record.
2. `MissionAdmissionPort`: owner-side implementation of `propose`, `revise`, `approve`, `inspect`, `cancel`, `readReports` and `ackReport`. Every request carries binding ID, request ID, mission/expected revision where applicable, external company/agent/issue/run IDs, deadline and bounded body. The transport supplies authenticated principal evidence separately; JSON cannot assert it. Admission intersects requested scope with the binding and #14 policy. Approval is valid only for the exact draft/revision and authorized creator. Changing the binding or expanding authority is never a remote operation. A report acknowledgment records remote delivery; it cannot alter the execution outcome.
3. `PaperclipAdapter`: a package outside upstream Pi, using Paperclip's external adapter seam. It validates company/agent/run context, obtains task checkout, normalizes goal/parent/document references, calls the mission port, and reports admitted/running/waiting/verified-terminal state accurately. Each execution is a bounded synchronization step; ending that step does not destroy the locally persisted mission. It does not launch another unit owner.
4. `OrganizationLinkDoc`: version-1 session document with local mission/revision, external IDs, current claim/run association, last acknowledged remote revision, input receipts, pending effect receipts, result/artifact references, conflicts and last reconciliation outcome. Mutating requests commit their receipt with local admission through Durable transactions. The external request ID plus binding is the replay key.
5. `OrganizationProjectionTask`: durable background phases `read-progress`, `prepare-report`, `wait-ack` and `reconcile`. It checkpoints a bounded mission-progress cursor and writes report intents atomically; the adapter on the Paperclip host performs remote API writes and returns acknowledgments. Paperclip API credentials never need to cross into the unit. Network work stays out of `beforeRequest`; there is no second in-memory scheduler. Check binding revision, mission revision, limits and deadline before each new admission/effect.

The mission document/controller is still owned by #14–#17. The link document is a translation ledger, not a competing source of mission truth. Paperclip remains authoritative for its assignment/claim and approval records; unit-001 remains authoritative for admitted local execution and evidence. A conflict pauses new work and surfaces both revisions rather than silently choosing one.

## Authentication and transport

Provision a dedicated, noninteractive SSH identity for this integration, with pinned host keys, forced fixed command, no PTY and no forwarding. Its Unix principal maps to the administrator-owned binding. It must not join the full operator group or use a generic `runuser`/shell helper. The gateway accepts bounded JSON on stdin and forwards only mission-port operations to the sole owner. Never interpolate received strings into shell commands or accept remote executable paths, environment variables or arbitrary URLs.

Paperclip run credentials remain on the control-plane host. The adapter uses actual pinned SDK/runtime types to carry authenticated run context and API authority; an API request must be attributed to that run. Credentials, cookies and private keys never enter mission text, memory, artifacts or logs. This does not claim to sandbox the unit's existing coding tools: host-approved mission authority and tool enforcement must be established by #14. A compromised control plane retains only the local permissions explicitly granted to its binding.

## State, schema and recovery

Initial state is `unbound`; service startup alone cannot create an organization binding or mission. A bound creator completes the versioned mission handshake. Link states are `proposed`, `awaiting-approval`, `admitted`, `running`, `waiting`, `verified`, `failed`, `cancelled`, `conflict` and `unknown-effect`. Domain state is separate from task scheduler state.

The existing `apps/unit-001/src/missions/state.ts` already defines session-scoped `unit.mission` version 1, `MissionIdentity` (mission ID, policy revision and controller task ID), bounded `MissionPolicy`, separate control/execution conversations and a nonexecuting deadline holder. Extend the shared mission contract under #14 rather than adding an independent organization-owned mission document.

Proposed shared version-2 migration: preserve existing mission IDs, policies, conversations and task references; add explicit creator/agreement state without treating any version-1 record as agreed. Existing `waiting/execution_support`, paused or stopped records remain nonexecuting and require explicit creator binding/agreement before new autonomous admission. A null current record stays null with an unconfigured handshake. Retain compatible version-1 hold-task definitions until their persisted tasks terminate; do not silently reinterpret them as executing controllers. Golden SQLite reopen/migration tests must prove these properties. The final shared version-2 type belongs to #14, not this adapter.

`OrganizationLinkDoc` version 1 starts absent and is created only during an explicit organization binding handshake, referencing the shared `MissionIdentity`. Do not migrate private memory into organization-owned data. Future shape changes need deterministic migration/rejection tests. Root bindings survive signed updates; upgrade rollback must preserve already-admitted mission/link data under the declared reader compatibility policy.

Persist outbound effect intent before sending. A lost acknowledgment triggers inspection/reconciliation using the stable request/correlation ID. If completion or absence cannot be proven, record `unknown-effect` and request review; do not blindly repeat external writes. Checkout 409 means another owner, not a retry. A stale approval or revoked binding blocks new admission. Cancellation means a recorded request until the actual local task settles; it cannot undo external work already performed.

An SSH disconnect only ends the synchronization call. A locally approved mission continues within its agreed authority/expiry, independently of an attached human. Each organization grant carries an explicit `leaseExpiresAt`, renewal identity and maximum renewal horizon fixed by administrator policy; no implicit infinite lease is allowed. Lease renewal binds the exact binding and mission-policy revisions. After expiry, stop new admissions/tool actions, checkpoint admitted work at its defined safe boundary and retain resumable state. Use monotonic elapsed time during a process and persisted wall-clock expiry on reopen; a detected clock rollback requires reconciliation rather than extending authority.

Remote revocation is not observable while disconnected. The lease bounds that gap; do not promise instant remote revocation. Observed revocation commits a binding-revision/revocation receipt and a mission control event before further admissions. In-flight work follows the contract's explicit safe cancellation boundary; an external effect already sent is reconciled, not undone. Root-local revocation is checked immediately by the owner before its next admission. After reconnect, fetch current binding/approval state and inspect existing receipts before renewing or starting anything.

## Resource and disclosure contract

Proposed acceptance targets, not measured guarantees: no Paperclip/database/UI process on the VPS; one bounded gateway request at a time; 64 KiB control frames; 5-second connect and 15-second request bounds; one 60-second idle adapter synchronization cadence on the control-plane host with exponential failure backoff capped at 15 minutes; no polling model calls. Measure incremental peak RSS and CPU under a real 512 MB host before selecting final numerical budgets.

Artifacts are explicit immutable objects with ID, digest, size, media type, producing mission/revision and approved disclosure scope. Initial proposed caps: 1 MiB per object and 10 MiB per mission export. Remote file paths are never opened directly. Private transcript/memory is retained locally; only selected evidence is published. Limits must fail clearly rather than silently evict records or truncate an artifact while claiming completeness.

## Acceptance and ordered coding tasks

1. Finalize #14 authority/creator/mission revision contract; define typed local binding and admission schemas. Root and peer review precede production adapters.
2. Add versioned link documents and replay/effect receipts with real SQLite tests: atomic rollback, reopen, duplicate admission, stale revision, revoked binding, migration rejection and cross-installation isolation.
3. Implement a fake `PaperclipPort` and mission-port adapter. Test checkout conflict, exact approval revision, parent/task mapping, mixed tenant IDs, lost response, unknown effect, cancellation, expiry and restart. No paid provider requests.
4. Implement the fixed-command gateway and external adapter against a pinned Paperclip version. Verify actual SDK exports, company/run authority and bounded input/output; never infer API types. Preserve upstream Pi unchanged.
5. Run credential-free Paperclip fixture acceptance, then administrator-approved staging against a real company. Prove admitted is not completed, no duplicate work after disconnect, no unauthorized cross-company action, no key logging, and continued mission execution without an attached person.
6. Measure 512 MB host startup/steady/peak memory, CPU, backpressure and update/recovery behavior; document unsupported workloads. Only then enable a production binding.

Follow-ups: #46 defines peer-team contracts and protocol adapters; #40 messaging carries mission control/approvals, not a new agent runtime; #39 browser is a separate capability. No implementation is claimed by this report.
