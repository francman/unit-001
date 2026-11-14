# Peer collaboration: proposed implementation definition

Research proposal for #46, not implemented team support. Prerequisite: reviewed shared mission/creator authority contract #14. Organization adapters remain #41 and research fan-out/selection remains #27.

## Decision in under one minute

Use the same persistent mission owner for temporary, standing, formal and ad hoc teams. Add an explicit team contract and durable delegation receipts, not another orchestrator. A peer can propose work; it cannot make itself a parent or grant permissions. Each participant accepts the exact contract revision within its own administrator-approved authority. Only explicit artifacts cross the boundary; private memory stays private.

Use A2A as an optional interoperability adapter after the local contract works. Keep Agent Client Protocol for client/agent UI integration and MCP for tools/context. None replaces our mission authority, budget or verification records. Start with manually provisioned peer bindings, one coordinator and a bounded team size. Automatic discovery, dynamic consensus and marketplace membership are later work, not prerequisites.

## Primary-source comparison

| Protocol | Current verified role/status | Recommendation |
|---|---|---|
| [A2A 1.0](https://a2a-protocol.org/v1.0.0/specification/) | Independent-agent messages, tasks, artifacts, status/cancellation and async delivery. Official source pin [9fff3e08](https://github.com/a2aproject/A2A/tree/9fff3e08ab33bb7674e7d98fc7c08ae8592bb4bd), Apache-2.0. | Adapt task/message/artifact transport; add local authenticated-principal, contract and receipt mapping. Remote completed/cancelled status is evidence to inspect, not a guarantee about external effects or success criteria. |
| [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview) | Client/agent initialization, sessions, prompt turns, progress and permission requests. Official docs label v1 latest and v2 draft. Source pin [5731ad95](https://github.com/agentclientprotocol/agent-client-protocol/tree/5731ad9591f447c9034ae78f392533019b08a187), Apache-2.0. | Useful front-end interoperability; do not mistake client/agent turn exchange for peer-team governance. |
| [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) | Tool, resource and context integration with transport authorization and optional extensions. Source pin [632a0c9a](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/632a0c9a65c9b4fbc889d8aface5c9cf5edef3b7). | Reuse tool adapters where appropriate; do not encode team authority as a tool description. The pinned repository [license](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/632a0c9a65c9b4fbc889d8aface5c9cf5edef3b7/LICENSE) is in MIT/Apache transition with separate documentation terms; inspect applicable notices before copying. |
| IBM/BeeAI Agent Communication Protocol, also called ACP | [Archived source](https://github.com/i-am-bee/acp/tree/e5265ca9fa06c55cd011b1e81ee927f6d80af8f6); its README directs users to A2A. Apache-2.0. | Do not start a new integration with this legacy ACP or conflate it with Agent Client Protocol. |

This is a source review, not a live interoperability certification. No protocol implementation or licensed source was copied.

## Shared mission and authority contract

Reuse `MissionIdentity`, `MissionPolicy` and session-scoped `unit.mission` from `src/missions/state.ts`. It currently has a version-1 nonexecuting holder, not a general mission executor. The proposed shared version-2 creator/agreement migration belongs to #14: preserve existing IDs/policies/conversations/task references and require explicit agreement. Do not make a separate team-owned mission document or auto-approve legacy records.

Classify a principal as human, parent/elder, organization or peer from authenticated host provisioning, not message content. A parent may delegate only within its own granted limits. A peer is not implicitly a parent. An organization role, A2A Agent Card or model name is a claim to verify, not an authorization grant. Fundamental binding/security changes remain administrator operations; an agreed creator can approve work only within that provisioned ceiling.

Every grant has a finite authority lease even when the team is standing. Disconnect does not prove revocation or continuing permission. New actions stop at expiry; renewals bind the current principal, policy and contract revisions. Observed revocation persists a receipt/control event before new admission. Already sent effects remain subject to reconciliation; no instant remote-revocation guarantee is made.

## Components, persisted state and interfaces

1. `PeerBinding` is administrator-owned: binding ID/revision, local installation, authenticated remote identity, tenant/organization, pinned endpoint/issuer and audience, permitted operations and resource/authority ceiling. Initial endpoints are manually configured; no arbitrary Agent Card URLs or caller-selected network destinations.
2. `TeamContractDoc` version 1 is a session document referencing the shared mission identity. Fields: team ID/revision, coordinator principal, objective/success evidence, members and roles, disclosure policy, authority leases, proposed/accepted/left/revoked membership, creation/exit receipts, and duration. Temporary contracts require an explicit end; standing contracts retain membership until explicit exit but never imply unlimited authority or spend.
3. `DelegationDoc` version 1 maps team/contract revision and stable delegation ID to producer/assignee, scope, reserved limits, local/remote task IDs, request receipts, checkpoints, artifact references and verified outcome. Reserve limits in the same commit that admits delegation. A retry reuses the reservation and request ID rather than charging or admitting twice.
4. `TeamPort` accepts bounded `propose`, `accept`, `delegate`, `inspect`, `report`, `submitArtifact`, `requestCancel` and `leave` requests. Each includes binding ID, request ID, team/delegation ID and expected revision. Transport-authenticated principal evidence is a separate host argument. Wrong revision returns conflict; it is never repaired by trusting remote text.
5. `PeerAdapter` translates A2A or the initial local fixture transport into `TeamPort`. It negotiates supported capabilities/version explicitly, validates wire input and scopes remote task/context IDs to binding+tenant. It never exposes a generic shell, private control socket or automatic memory-export operation.
6. `DelegationTask` uses public Durable custom tasks/transactions for `prepare`, `await-acceptance`, `dispatch`, `wait-result`, `verify`, `reconcile` and terminal outcomes. Durable sleep handles timeouts. There is one storage owner; network work and artifact preparation run outside request assembly.

V1 has one explicit coordinator, not leader election. Each member independently accepts the exact contract revision before receiving work; membership does not transfer its administrator authority to the coordinator. A team amendment requires a new revision and acceptance for changed obligations. A member may leave, but in-flight effects remain tracked until settled or marked unknown. Team completion requires verified evidence against the contract, not a count of members saying done.

## Artifacts, failure and privacy

Share immutable artifact references containing ID, digest, length, media type, producing task/revision and authorized recipients. Resolve them through a controlled store, never remote filesystem paths. V1 shares no private memory/transcript automatically. Imported statements retain peer provenance and are untrusted evidence; they do not become human instructions or durable authority.

Write effect intent before dispatch. After connection loss, query the known task/request before resending. If the peer cannot prove whether the action occurred, retain `unknown-effect` and escalate rather than creating another delegation. Cancellation is requested until acknowledged/settled; it cannot reverse an already executed external action. Completion claims with missing or altered artifacts fail verification. Budget exhaustion, lease expiry or stale revisions stop new admissions without deleting checkpoints.

A permanently unavailable peer is not automatically replaced with another writer. A new assignee requires an explicit revision and reconciliation of the old assignment. Release unused budget reservations only when absence of spending/effects is proven; otherwise keep an uncertain reservation visible. Report provider cost as observed/estimated, never a guaranteed external billing total.

## Resources, schema and acceptance

Proposed MVP targets, to measure rather than present as existing guarantees: at most four members per team, one running local delegation and two queued delegations per owner, 64 KiB control frames and 1 MiB artifact objects. Bound connections, retry attempts, request time and retained receipts. Fail explicitly above limits; do not silently evict private memory. Add no browser or full control plane to the VPS. Measure incremental peak RSS/CPU and hot-path overhead under #4 before accepting 512 MB deployment.

New team/delegation docs start absent. Schema changes require versioned deterministic migration or explicit rejection. The shared mission v1→v2 migration must not convert an old holder into an executing team controller. Reopen must preserve bindings, revisions, reservations and unknown effects; application downgrade follows the release's declared reader compatibility, not assumptions about semver.

Ordered coding work:

1. Review shared mission/creator v2 and typed principal/policy rules under #14. Finalize the explicit MVP limits and lifecycle semantics above.
2. Add team/delegation documents and real SQLite tests for atomic membership acceptance, reservation+admission, migration/reopen, stale revisions and isolation.
3. Implement two local faux peers through the typed port: formal/ad hoc and temporary/standing contracts, accepted obligations, exit, disclosure and verification. No paid providers.
4. Add restart/SIGKILL fixtures at dispatch, acknowledgment and artifact publication; prove stable IDs, no duplicate admission/spending and visible unknown outcomes.
5. Implement a pinned A2A adapter with authenticated identity/capability negotiation and denied cross-tenant, forged-card, oversized, stale-approval and untrusted-content cases. ACP/MCP support is optional separate work, not bundled parity.
6. Measure 512 MB resource behavior, backpressure, lease/revocation delay, graceful update/quiescence and reconnects; only then enable an administrator-approved production team.

This defines a research-selected first implementation, not approval to enable autonomous external collaboration today. Persistent mission execution and authority enforcement must exist before activating the adapter.
