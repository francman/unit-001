# Bounded research, proposal selection and ticketing

Design for [#27](https://github.com/francman/unit-001/issues/27), 2026-11-21. Nothing here is implemented. It grants no authority, selects no live source, spend amount or GitHub write, and changes no existing command. Those remain operator choices, listed under [open owner decisions](#open-owner-decisions).

Research is one kind of bounded work under the [purpose and work contract](purpose.md). It reuses the existing sole storage owner, Durable scheduler, protected creator receipts and request/tool admission ([design](design.md), [execution](execution.md), [controls](controls.md)). It adds no gateway, worker runtime or second SQLite writer. Record names below use the names slice 1 of #72 shipped in `src/missions/purpose.ts` ([purpose.md, Slice 1 status](purpose.md#slice-1-status)): the `unit.mission.purpose` document holds the purpose agreement (`purpose`), work definitions (`work[]`, IDs `legacy-N` so far) and agent operation (`operation`). Work execution is the existing `unit.mission.execution` ledger.

## Problem

The agent can execute approved built-in tools and verify file digests. It cannot gather outside evidence, compare alternatives and turn a choice into actionable work without a new prompt for each step. Adding that naively breaks three guarantees the mission engine already keeps:

- **Authority.** A research conversation that holds `bash` or `read` can read the provider key or exfiltrate workspace files through a fetched page's instructions. Remote content is attacker-controlled text.
- **Accounting.** Fan-out multiplies model requests and network fetches. A restart must not re-spawn finished children, refund uncertain requests or forget which child owed a result.
- **External effects.** Posting a GitHub issue is a write outside the host. A timeout after sending does not say whether the issue exists. Blind retry creates duplicates.

Example. Purpose: "keep this repository's dependencies secure". Work: "compare three ways to replace the deprecated `request` dependency and draft a ticket for the best one". The agent plans three branches, one per candidate library. Each branch fetches two or three pages and proposes one candidate with cited quotes. The process is killed while branch 2 waits for a model reply. After restart, branches 1 and 3 must keep their results, branch 2 must resume its saved submission rather than start over, and the parent must synthesise exactly once. The ticket draft is stored locally. If posting is enabled and the GitHub call times out, the next step looks for the ticket's marker instead of posting again.

## Solution in one trace

1. A research work definition (question, source policy, finite allowances) is admitted through #72 work admission. The coordinator's planning turn proposes branches; the host validates them and stores a **plan receipt** before any fetch or child exists.
2. The **coordinator** task (the parent and sole completion owner) creates at most `maxConcurrentChildren` **child** tasks, each with a stable ID fixed by the plan.
3. Each child runs in its own task-owned conversation whose tool list is exactly `research_fetch` and `research_submit_candidate`. Fetches pass the **source policy** and store content-addressed **source artifacts**. The child submits one **candidate record** with quotes.
4. When every child is terminal, the host **verifier** checks each candidate's citations against stored artifacts and writes a **verifier decision** per candidate.
5. The coordinator submits one synthesis input. The model calls `research_select` with one accepted candidate and ticket text. One commit stores the **selection receipt** and the **ticket draft**.
6. Draft-only policy (the default) ends the work here. With an approved posting policy, the host (never a model tool) records a **post intent**, calls GitHub once and settles a **post receipt**, or marks the outcome uncertain and reconciles by marker.

A child result is evidence, not authority: it cannot grant tools, change allowances, select itself or trigger a post.

## Components and interfaces

| Component | Kind | Responsibility |
|---|---|---|
| `ResearchDoc` (`unit.research`) | Session document | Plan receipts, children, artifact index, candidates, verifier decisions, selections, ticket drafts and post receipts. Metadata only. |
| Artifact store | Files under the installation state directory | Content-addressed fetched bodies, one directory per run. |
| `unit.research.coordinator` | Durable task, owned by the work execution's controller | Plans children, spawns them in a bounded window, waits, runs the verifier, admits synthesis, settles the run. Only writer of run outcome. |
| `unit.research.child` | Durable task, non-background, owned by the coordinator | One branch: one task-owned conversation, one stable synthetic input, at most one candidate. |
| `research_fetch` | Host-owned tool | Source policy, address checks, bounded GET, artifact write, returns extracted text as quoted data. |
| `research_submit_candidate` | Host-owned tool | Schema-validates a candidate and stores it under the calling child. |
| `research_plan`, `research_select` | Host-owned tools, coordinator conversation only | `research_plan` proposes branches for the plan receipt. `research_select` selects one accepted candidate and drafts the ticket in one commit. |
| Research verifier | Host function | Deterministic citation and bounds checks. Model judgment may rank; it never accepts evidence. |
| Ticket poster | Host step in the coordinator | Draft-only by default. With policy: intent, one dispatch, receipt or uncertainty, marker reconciliation. |
| Source adapter | Interface `fetch(url, limits, signal) → FetchResult` | `fixture` (faux map, used by every test and the default) and `live` (network, disabled until an owner decision). |

Children never submit to the parent's conversation and never write the run record. Tools are registered by a host extension in the same way `orientation.ts` registers `unit_status`; they are not added to `MANAGED_MISSION_ACTIONS` and cannot be granted to ordinary or bounded-execution conversations.

### Coordinator phases

The checkpoint is a tagged union; every phase rereads the document and the current policy revision before committing, as `controller.ts` does.

| Phase | Work | Restart behaviour |
|---|---|---|
| `plan` | Submit one planning input (request ID `RUN:plan`); the model calls `research_plan`. The host validates branch count, allowances and source policy, then commits the plan receipt. | Reopens the saved submission; never re-plans. |
| `spawn` | In one commit, create children up to the window and record each task ID beside its fixed child ID. | Children already recorded are not created again. |
| `await` | `waitForTask` on the oldest live child; spawn the next pending child when one settles. No model polling. | Recomputed from the children table. |
| `verify` | Run the verifier over every candidate; commit decisions. | Deterministic; rerunning yields the same decisions. |
| `synthesize` | Submit one input (request ID `RUN:synthesis`) listing accepted candidates as quoted data and naming children that ended without a result. | Reopens the saved submission. |
| `post` | Only with posting policy: see [ticketing](#ticket-drafts-and-posting). | Intent decides: reconcile, never resend. |
| `settle` | Record the run outcome and its evidence on the work execution. | Terminal; idempotent. |

### Child

A child is created with ownership `{ kind: "task", taskId: coordinator }` and is not background, so Durable's abort cascade (spec section 5.4) reaches it, its conversation and its in-flight tool tasks. Its conversation has `agent.tools = ["research_fetch", "research_submit_candidate"]`, a `maxTurns` equal to its tool-round allowance and a provider session under `MISSION_PROVIDER_PREFIX`. It submits one synthetic input with request ID `RUN:child:INDEX:GENERATION` (generation 1 unless resumed after cancellation). Children cannot create tasks or conversations, so lineage has depth one.

A child is terminal with one of: `candidate` (one stored candidate), `no_result` (run ended without a valid candidate), `cancelled` (abort cascade), `failed` (allowance, deadline or authority). The coordinator reports each non-`candidate` child once, in the synthesis input.

### Tool contracts

`research_plan({ question, branches: [{ focus, sources?: string[] }] })`: branches at most `maxChildren`; each `sources` entry must match the source policy now, so a plan cannot reserve a host the policy will refuse.

`research_fetch({ url })` returns `{ artifact: sha256, url, finalUrl, contentType, bytes, text }` or a typed refusal (`source_denied`, `address_denied`, `redirect_denied`, `too_large`, `timeout`, `content_type`, `allowance`). A refusal is a known non-effect and is recorded; it costs one fetch attempt.

`research_submit_candidate({ title, summary, approach, claims: [{ text, citations: [{ artifact, quote }] }], risks, effort })`: at most 8 claims, 4 citations per claim, quotes 1 to 500 characters, whole record at most 8 KiB. One candidate per child; a second call is refused.

`research_select({ candidate, rationale, ticket: { title, body } })`: candidate must have an `accepted` decision in this run; title at most 256 bytes, body at most 16 KiB. One selection per run.

## Authority and denied actions

The research conversations hold no `bash`, `read`, `write`, `edit`, memory-write or status tools. Admission enforces the list on direct and nested calls through `beforeTool`, as `MissionAdmission` already does for execution conversations; tool lists are not trusted alone. Every request and tool call re-checks the protected creator receipt, the agent-operation intent and the policy revision. A restarted child gets fresh admission against current authority; a stored task or request ID never revives a closed scope.

Prompt text cannot widen any of this. Fetched text is placed in tool results and synthesis input inside a labelled data block naming its artifact and URL. It is never placed in system or instruction positions. Research conversations do not capture memory input: quoted remote text must not become remembered owner intent. A later slice may store the selection receipt as a memory record with research provenance; memory remains evidence, not authority.

This is command authorization, not containment. The owner process performs the fetches with the service account's network access. Stronger isolation for arbitrary code is separate work, as #27 states.

## Source policy and fetching

The policy is part of the work definition and is digest-bound with it. Its default is `{ kind: "fixtures" }`: no network. A live policy has the shape `{ kind: "allowlist", hosts: string[], schemes: ["https"], ports: [443] }`; whether any live policy may be approved, and which hosts, is an owner decision.

Each fetch, in order:

1. Parse the URL. Refuse userinfo, non-`https` schemes, non-443 ports, IP-literal hosts and hosts not exactly on the allowlist (no suffix wildcard in the first version).
2. Reserve one fetch and the byte allowance in a commit before any socket opens. A crash after reservation keeps it consumed.
3. Resolve every address. Refuse if any is loopback, private, link-local, CGNAT, multicast, unspecified, unique-local, documentation or an IPv4-mapped form of those. Connect to the vetted address with the original host name for SNI and `Host`, so a second lookup cannot rebind.
4. Send `GET` with a fixed header set: generic `User-Agent`, `Accept` for text types, no cookies, no `Authorization`, no proxy credentials. Ignore `HTTP(S)_PROXY` environment variables.
5. Follow at most 3 redirects manually, applying steps 1 and 3 to each target. A redirect to a refused target ends the fetch with `redirect_denied`.
6. Stream with a 5 s connect timeout, 20 s total timeout and 1 MiB cap on decoded bytes (compression cannot exceed the cap). Accept `text/html`, `text/plain`, `text/markdown`, `application/json`.
7. Write the body to `research/RUN/SHA256` (temp file, fsync, rename), then commit the artifact index entry. Extract text deterministically (strip `script` and `style`, decode entities, collapse whitespace); the verifier uses the same extractor.

A fetch is a read with no intended external effect, so an interrupted fetch is never "uncertain" for recovery: it is consumed accounting and may be retried within the allowance. An artifact file without a committed index entry is deleted at owner start. A committed entry whose file is missing marks that artifact `lost`; citations to it fail verification.

## Verifier and selection

The verifier accepts a candidate only if: the candidate passed schema bounds; every claim has at least one citation; every cited artifact was fetched in this run, is present and matches its digest; every quote occurs verbatim in that artifact's extracted text after whitespace normalisation. Otherwise it records `rejected` with the failing rule per claim. Nothing else is judged by the host: relevance and quality stay with synthesis.

The selection receipt binds run ID, plan digest, policy revision, the sorted IDs and decision digests of all candidates compared, the chosen candidate and the model's rationale (stored as untrusted text). The host refuses a selection of a rejected or absent candidate and a second selection. With no accepted candidate the run settles `no_selection` and drafts nothing.

If the work definition's approval boundary names selection, the coordinator waits (no model polling) for a protected creator command naming the candidate instead of calling `research_select`. That path reuses the existing protected-intent mechanism; it adds no browser operation.

## Ticket drafts and posting

The ticket draft is stored in the same commit as the selection. Its body ends with a correlation marker `<!-- unit-001-ticket:TICKET -->`, where `TICKET` is the first 32 hex characters of `sha256(installationId, runId, selectionDigest)`. The draft is complete local output; draft-only work settles successfully with it.

Posting runs only if the work definition carries an approved policy `{ repository: "owner/name", credential: NAME }`. The model never sees the token, never calls GitHub and never chooses the repository. The credential is stored with the other installation credentials, never in a conversation document. The host:

1. Commits `post: { state: "dispatching", at }` before the request.
2. Sends one `POST /repos/OWNER/NAME/issues` with client retries disabled.
3. On a response with an issue number, commits `posted` with number and URL.
4. On a definite refusal (4xx before creation, such as 401, 403, 404, 422), commits `refused` with the status; the draft stays.
5. On anything else (timeout, reset after send, 5xx, crash before step 3), commits `uncertain`.

`uncertain` blocks every later post for this run. Reconciliation lists the repository's issues created by the token's account since `at` minus 10 minutes, newest first, at most 3 pages of 100, and scans bodies for the marker. Listing is used instead of search because the search index lags. Found: commit `posted`. Not found: stay `uncertain` and block; absence in a bounded listing is not proof. Only a protected operator command asserting "not posted" (or naming the issue number) resolves it; a later post reuses the same marker, so reconciliation still finds a duplicate.

## Persistence

`unit.research` is a Session document, version 1, with explicit migrations from its first change onward. It holds metadata only, at most 64 KiB per run, and retains the 16 newest runs; pruning a terminal run deletes its artifact directory in a following step, and a crash between them leaves files the owner-start sweep removes. Large bodies stay out of the document to keep each commit and checkpoint small.

| Record | Key | Fields |
|---|---|---|
| Run | `runId` (from work definition ID) | work definition ID and digest, purpose revision, policy revision, plan receipt, allowances, consumed counters (`children`, `requests`, `fetches`, `fetchBytes`, `unknownRequests`), coordinator task ID, coordinator conversation ID, state |
| Plan receipt | run | question, ordered branches, source policy digest, plan digest, planned at |
| Child | `runId:INDEX` | generation, task ID, conversation ID, provider session, request ID, allowance share, consumed counters, terminal outcome |
| Artifact | `runId` + sha256 | requested URL, final URL, redirect chain, resolved address, content type, bytes, fetched at, child, state (`present`, `lost`) |
| Candidate | `runId:INDEX` | child, validated candidate body, digest |
| Verifier decision | candidate | `accepted` or `rejected`, per-claim reasons, decided at |
| Selection receipt | run | compared candidates and decision digests, chosen candidate, rationale, selection digest, policy revision |
| Ticket draft | run | title, body, marker, repository if any |
| Post receipt | run | `dispatching`, `posted` (number, URL), `refused` (status), `uncertain`, resolved by (operator request ID) |

Run states: `planning`, `running`, `verifying`, `synthesizing`, `posting`, `waiting` (reason, until), `blocked` (reason), `settled` (`selected`, `no_selection`), `stopped`. The work execution records the run's outcome as its evidence; research never completes or suspends the purpose.

## Allowances and concurrency

Every research allowance is finite, part of the approved work definition and checked against standing authority: `maxChildren`, `maxConcurrentChildren`, `maxRequests`, `maxFetches`, `maxFetchBytes`, `maxToolRoundsPerChild`, `deadlineAt`, optional `maxEstimatedCost`. Missing values are refused, never defaulted.

Request admission extends `MissionAdmission`: a provider session maps to its run and child, and one commit reserves the attempt on the work execution, the run and the child. Each child gets a share fixed at spawn; its unused share returns to the run only when the child ends with no unknown requests. Unknown or unpriced requests keep their reservation, as today. An exhausted run blocks new children and requests; live children finish their current request and stop at their next admission.

Bounded concurrency is enforced durably: the coordinator only creates a child when fewer than `maxConcurrentChildren` are live, so a restart cannot exceed the window. Each child runs at most one fetch at a time. Proposed starting values for the 512 MB target are 2 concurrent children, a hard ceiling of 3, and 1 MiB per fetch (at most 2 MiB of fetch buffers in flight). These are proposals, not measurements: no native 512 MB result exists ([capacity](../capacity.md)), and source reviews of other agents are evidence for the shape, not Bob's capacity. Slice R2 must measure peak RSS, commit count per child and submit-to-provider latency with the capacity harness before the defaults are documented as supported.

## Cancellation and uncertain effects

Pause or stop of the work closes admission first, then aborts the coordinator. The cascade reaches every child, conversation and running tool task. Results:

| In flight | Outcome after cancellation | Resume requirement |
|---|---|---|
| Model request | Existing rules: reserved attempt kept; crash without receipt counts as unknown and blocks dispatch | Reconcile like any execution request |
| Fetch | Aborted; allowance consumed; no uncertainty (read only) | None |
| Artifact write | Temp file removed at start; committed entries valid | None |
| Candidate submit | Committed or not; never half-written | None |
| Ticket post | `uncertain` if dispatching | Marker reconciliation or operator resolution |

Resume creates one new coordinator after the old one is terminal. The new coordinator keeps the children table: settled children stay settled, a child whose task ended by cancellation is respawned only if the plan still lists it and allowances remain, under a new task ID and the next generation beside the same child ID; its request ID becomes `RUN:child:INDEX:GENERATION` so the old submission is not reused. Stop is terminal for the run; the draft and receipts stay.

## Mapping to the pinned OpenClaw invariants

The [pinned handoff contract](https://github.com/openclaw/openclaw/blob/f947b3caf5d0fb04c780205dfeff509d87cd2527/docs/concepts/subagent-yield-handoff.md) motivates four invariants. This design keeps them with fewer moving parts because there is no yield and no mailbox:

| Invariant | Here |
|---|---|
| One completion owner | The coordinator task writes run outcome and owns synthesis; children write only their own record. |
| Stable child lineage | Child IDs are fixed in the plan receipt; task IDs are recorded beside them in the creating commit. |
| Bounded findings | Candidate schema and size caps; synthesis input lists candidates, not transcripts. |
| Fresh admission after restart | Every request and tool call re-checks current receipt and policy revision; stored IDs grant nothing. |

## Ordered vertical slices

Each slice ships code, tests on real SQLite with the faux provider, terminal output and docs together. None needs a live source, paid provider or GitHub write.

| Slice | Depends on | Deliverable | Acceptance |
|---|---|---|---|
| R0 | #72 slices 1 to 3 | Purpose/work records, separate operation intent, work admission with preserved accounting. | As purpose.md. |
| R1 single branch | R0 | `unit.research` v1, research work kind, plan receipt, one child, fixture adapter, artifact store, `research_submit_candidate`, verifier, `mission status` lines. | Faux run produces an accepted candidate; forged quote rejected; `bash` from the child blocked; kill after plan and after fetch, reopen, no second plan or fetch. |
| R2 fan-out | R1 | Coordinator window, child lineage, admission extension, cancellation, resume. Capacity measurement. | 3 children with window 2: never more than 2 live, including across kill/reopen mid-child; exhausted request allowance spawns no child; pause during a child request drains and resume keeps settled children. |
| R3 selection and draft | R2 | Verifier decisions, synthesis, `research_select`, selection receipt, ticket draft, creator-selection boundary. | Selecting a rejected candidate refused; second selection refused; kill during synthesis reopens the same submission; draft identical after reopen. |
| R4 live fetch | R3, owner decisions 1 and 2 | `live` adapter behind source policy. | Local HTTP/HTTPS fixture servers: allowlist, IP-literal, private address, rebinding resolver, redirect to private and to off-list host, oversize and slow bodies, gzip bomb, header capture proving no `Authorization`/`Cookie`, canary provider key absent from requests, artifacts and tool results. |
| R5 posting | R3, owner decision 3 | Ticket poster and reconciliation against a faux GitHub server. | No policy: zero calls. Timeout after create: `uncertain`, reconciliation finds marker, no second create. Not found: stays blocked until operator resolution. 401/422 refused without retry. |

Terminal acceptance for R1 to R5: actual 80×24 and 40×12 sessions on an isolated tmux server showing run state, child states, consumed and remaining allowances, candidates with decisions, selection, draft title and post state. The browser shows the same facts read-only through the existing `mission status` projection; no browser operation is added, and draft bodies render as text nodes.

These cover #27's acceptance text: restart-safe fan-out (R1, R2), bounded consumption (R2), evidence-based selection (R1, R3), denied actions without authority (R1, R4, R5) and no duplicate tickets after ambiguous results (R5). Measure added admission and checkpoint cost under #4.

## Out of scope

Search engines or paid source APIs, research by ordinary chat or side conversations, nested children, agent-created repositories or labels, editing or closing posted issues, organization integration (#41) and messaging channels (#40).

## Open owner decisions

1. **Live sources.** May any research work fetch the network? Default: no (`fixtures` only). If yes: allowlist only (recommended) or open web with address filtering, and which hosts.
2. **Spend per run.** Ceiling for requests, fetches, fetch bytes and estimated cost per research run, and whether these come from the existing creator ceiling or a separate research ceiling. Default: none approved, so no run is admissible outside tests.
3. **Ticket posting.** May the agent post issues itself? Default: draft only. If yes: which repository, and a fine-grained token limited to Issues read/write on that repository.
4. **Selection authority.** May the agent select a candidate itself, or must the creator select? Default proposed here: agent selects, because selection alone only produces a local draft; posting stays behind decision 3.
5. **Concurrency defaults.** Accept 2 concurrent children (ceiling 3) as provisional until R2's measurement, or wait for #64's native result.
6. **Retention.** Keep the 16 newest runs and their artifacts, or a time-based limit.
