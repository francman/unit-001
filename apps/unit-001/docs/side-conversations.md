# Slice 1: visible owner-created side conversations

2026-11-21. Design for `feat/web-workspace-v5` at `edfa9d085` (beads `unit-uah`, `unit-31t.1`).

## Decision and implementation boundary

Build a named, owner-created fork of main chat, backed by a Session-scoped registry. A side chat inherits main history through the selected reply, then keeps its own transcript. Bob shares memory, tools, working directory and host access across chats. Allow one active foreground chat conversation across main and the registered sides. Preserve existing same-conversation input queuing for terminal/API callers.

This is an engineering design, not authorization to implement it. In particular, **widening the browser operation set requires explicit owner approval**. That includes adding side list/start, adding a conversation selector to send/cancel, and selecting a conversation on the SSE endpoint. Existing chat permission does not imply permission to add those fields. Phase 3 below is blocked on that decision; do not tunnel side commands through prompt text, reuse inspection, or expose a generic conversation API to avoid it.

Slice 1 has list, start from a completed main reply, select, send and targeted cancel. Creation itself performs no model call and starts no run. No agent-created chats, title generation, background side work, automatic summaries, automatic archiving, transcript merge, main-chat posts, approval forwarding, or channel routing are added. Rename, archive and an owner-confirmed summarize-back proposal remain follow-ups. Main remains the fixed first chat destination.

The research offers conflicting context suggestions: side-products recommends an empty/summary seed, while side-fit recommends Durable's full history fork. Choose the latter for slice 1, as HANDOVER section 5 recommends. UI copy must say what it actually does: “Includes main chat through this reply. Bob remembers across chats, and every chat has the same access and working folder.” Do not say empty, private, isolated, or summarize-only.

## Problem, example and source contracts

Today a browser sends a prompt without a target. The service calls `Agent.ask`, which submits to `#root`; the root watch supplies the entire visible chat. Adding another transcript to the sidebar alone cannot change where a message lands. Worse, accepting any existing Durable conversation number would expose mission control/execution conversations through an owner-chat interface.

Example after the change: main has reply E42 followed by E58. The owner explicitly creates “Supplier research” from E42. One transaction creates child C, its model configuration and a registry row. C's initial history includes E42 and its predecessors, excludes E58, and has no runnable input. Selecting C opens its bounded watch. A later human message is admitted into C, with C's memory provenance. Main's transcript remains unchanged; subsequently captured shared memory may be recalled from either chat.

Current code is the authority where the old research differs:

| Contract | Evidence in this checkout | Consequence |
| --- | --- | --- |
| One Session, multiple conversations | `packages/durable/src/harness/harness.ts`, `ConversationImpl`, `#create`; `harness/types.ts:524`, `:797` | Handles are stateless; `fork` and raw transaction creation run the built-in creation hook. No new Durable runtime is needed. |
| Fork history and document policies | `packages/durable/src/session/forks.ts`; `harness/agent.ts:49`, `createAgent` | History is fork-aware, not copied. `pi.agent` is `asOf`; Session docs are shared; initial-fork docs start fresh. Existing tasks are not copied into a new run. |
| Atomic transaction API | `packages/durable/src/types.ts:986`; `session/transaction.ts:277`; `harness/types.ts:524` | `Tx` has `forkConversation`, `scanEntries`, `submissionByRequest`, `doc`. Table reads after the first table write throw `ReadAfterWrite`; document access still works. |
| Root-only application | `apps/unit-001/src/agent.ts:146`, `:292`, `:315`, `:335`, `:435`, `:440`, `:536` | Open, submit, ask, host facts, watch, cancel and busy status need target-aware paths. Defaults stay main. |
| Reads versus execution | `packages/durable/src/harness/harness.ts`, `ConversationImpl.abort/waitForIdle`; `harness/submissions.ts`, `#traced` and `wait`; `harness/types.ts`, `Harness.resume` | Submit, wait and abort can enable scheduling. List, watch, bootstrap inspection and navigation must not use them. |
| Socket boundary | `apps/unit-001/src/service.ts`, `ServiceRequest`, `runService`, `handleRequest`, `streamViews`, `watchService` | One storage owner. Request cap 64 KiB; response cap 1 MiB. Watch currently bypasses ordinary request dispatch, so it needs its own strict target parser and registry check. |
| Browser boundary | `apps/unit-001/src/web/contract.ts`; `src/web/gateway.ts` | Closed request fields; loopback/origin, pairing, CSRF and CSP remain. Actual limits: four in-flight requests, two SSE streams, 32 retained mutations/session; graph alone gets a 1 MiB browser response limit, other replies 128 KiB. HTTP body is 64 KiB. |
| Shared client path | `apps/unit-001/src/service-client.ts`; `src/remote/client.ts` | Target must survive local and pinned SSH clients and observation reconnects. Writes stay single attempts. |
| Bounded projection | `apps/unit-001/src/service-view.ts`; `packages/durable/src/harness/view.ts` | One selected watch uses `{min:20,max:20}`. Projection keeps 20 displayed entries, 4,096 characters/entry, 8,192 live characters and 32 tools. Usage is selected-conversation usage, not installation spending. |
| Shared memory and local input provenance | `packages/unit-memory/src/memory.ts:89`; `inputs.ts`; `capture.ts`; `extension.ts`; `injection.ts`; `background.ts` | One current `MemoryDoc`; `MemoryInputsDoc` is conversation-local with `fork:"initial"`. Human capture depends on host metadata and the run range. |
| Existing mission boundary | `apps/unit-001/src/missions/state.ts`; `controller.ts:303`; `admission.ts:102`; `deploy/agent-command.mjs` | Missions create their own conversations. Mission capability/paid-request gates apply to the mission execution identity. Side chat remains ordinary main-like chat, with no mission approval rights. Managed mission authority stays root/terminal. |
| Browser state is currently singular | `apps/unit-001/web/{contract,state,port,shell}.ts`; `web/views/chat.ts` | Drafts, unknown sends, tools, view, scroll and completion callbacks must be keyed or guarded by target. Changing only the watch URL is insufficient. |

The side-fit report predates organization removal. There is no organization request or implementation to extend now. Its gateway cap of six and text implying HTTP accepts 128 KiB are stale. Its suggestion that shared memory is the only cross-chat effect is also too strong: ordinary coding tools share the filesystem and external capabilities.

## Authority and data boundaries

The registry is the owner-chat address allowlist. Resolve only main or a registered side; “exists in Durable” is insufficient. Apply the same resolver to every targeted operation, including socket watch, send, cancel, ask's host-fact shortcut, answer lookup and any target-aware idle/status helper. Unknown IDs and mission IDs produce the same bounded unavailable-target result. Never silently fall back to main.

Side rows contain metadata, not authority grants. Neither a title, memory statement, inherited transcript, model-produced number nor browser field can approve a mission, change channels, alter budget, select credentials or acquire administrator access. No side lifecycle tool is registered for the model. Human control-plane operations do not get inferred from chat prose such as “open another chat.” Bob may suggest a terminal command in text, but nothing runs it automatically.

The service remains the sole SQLite writer. Gateway and browser hold projections, opaque request IDs and a selected target, never storage handles, provider credentials, authority receipts or raw mission conversation records. A numeric side ID is an address, not a secret; membership is checked by the owner. This feature adds no security sandbox around coding tools and no promise that a side chat cannot affect files main uses.

All existing mission approval/configuration UI remains copyable terminal commands. The proposed “Side chat” control is a new chat-lifecycle mutation and is displayed only after the owner approves that browser surface. It is not justified by calling it a read. No browser Approve/Start/Retry/Configure/Join/Accept/Leave authority controls are introduced.

## Durable state and wire shape

Add `src/side.ts` for registry/lifecycle and `src/side-control.ts` for bounded wire parsing and presentation. Keep the concepts separate; do not add a generic conversation administration layer.

`SideDoc` v1 is Session-scoped, current metadata, initially empty. Each row stores:

```text
conversationId
parent: { conversationId: mainId, at: EntryId }
title
createdAt
creation: { requestId, fingerprint }
```

Maximum 16 sides total in slice 1. Titles contain 1–80 Unicode code points and at most 320 UTF-8 bytes, after trimming, with control characters rejected. Missing title becomes `Side chat from message E`. No model generates it. IDs and fork entry IDs must be positive safe integers; the target resolver distinguishes main from side membership. Request IDs use the existing bounded 1–200-character convention and must also fit the frame byte limit. Do not accept owner, model, tools, cwd, credentials, archive flags or arbitrary parent IDs from callers.

The creation receipt stays on its row, so at most 16 receipts are retained and replay survives process or pairing-session restart. The fingerprint is a canonical encoding of the parsed start operation, including exact normalized title and source entry. No unbounded dedupe map is needed. If archive is later added, retain receipts and establish explicit 16-live/64-archived caps then; do not silently evict old receipts to make space.

Minimal proposed socket requests:

```text
{ type:"side", request:{ operation:"list" } }
{ type:"side", request:{ operation:"start", from:E, title?:T, requestId:R } }
{ type:"send", prompt:P, requestId?:R, conversation?:C }
{ type:"cancel", conversation?:C }
{ type:"watch", conversation?:C }
```

Omitted target means main. Normalize explicit main ID to that same target before gateway fingerprinting. `start` always forks main; side-of-side and fresh chats are deferred. Preserve root defaults in current CLI/terminal callers. Add `side list`, `side start --from E [--title T] --request-id R`, and `--conversation C` for explicit send/cancel. The CLI generates a request ID once when omitted and prints/retains it before dispatch. No “latest” fork point: a concrete entry prevents a retry from selecting a different history.

Side results use a tagged union, with list/start result variants. List returns main busy/queued state and at most 16 rows with id, title, parent entry, createdAt and derived `idle|busy|queued` state. Do not invent summaries, unread counts, completion, needs-input or approval state from the last assistant sentence. A fixed creation title is sufficient for this slice. Return the durable created ID for start and the same ID on replay.

Add a selected conversation field to `ServiceView` and `WorkspaceView`, validated by both parsers. Project a host-derived `canStartSide` flag on each displayed entry. The current projection discards stop reasons and tool calls, so the browser cannot identify eligible fork points from the assistant role alone. The owner revalidates the entry on start. Keep `status.busy` scoped to main and report aggregate foreground state separately. The UI distinguishes selected-chat work from scheduled mission work and maintenance.

Browser proposals, requiring approval before implementation:

| Change | Exact scope |
| --- | --- |
| `side list` | Bounded metadata only; no generic conversation scan or transcript dump. |
| `side start` | Main completed-reply anchor, optional bounded title, gateway envelope request ID reconstructed into owner request. |
| `send/cancel` target | Main or allowlisted side only; no authority-related fields. |
| `GET /api/v1/events?c=C` | One selected side watch; missing query selects main. Reject duplicate/unknown parameters and noncanonical unsafe numbers. |
| Target and anchor eligibility in streamed views | Let the browser reject stale frames and show the fork action on eligible main replies. |

Do not add archive, rename, summarize, arbitrary inspection, history paging or mission targeting to this approval request. The design chooses a small named surface; approval of it must be recorded separately from approval of this document.

## Phase 1: registry and atomic creation

First implement and test the owner lifecycle without changing the web parser or gateway.

Use a raw `root.commit` with `tx.forkConversation`, rather than `root.fork(... init ...)` for the public idempotent start operation. The convenience method always creates a conversation before `init`, so an `init` receipt lookup cannot return an old conversation without already creating an unwanted new one. The raw transaction is public Durable API and still runs the built-in creation hook, as the mission creation code demonstrates.

Inside that one transaction, in this order:

1. Check `requireActive()` at entry and again inside the callback; read `MaintenanceDoc` and reject held execution. Read `SideDoc`.
2. Look up the start receipt. An exact match returns its old ID without making anything; a conflicting fingerprint rejects. Capacity/busy checks must not defeat a valid replay. A held service still rejects start; read-only list remains available.
3. For a new start, check the 16-side cap and that main and all registry sides are idle with empty inboxes. Read live and inbox documents for at most 17 conversations. This includes queued work that a live-run snapshot could miss.
4. Read the source with a fork-aware bounded `tx.scanEntries` over main at exactly E. Require a committed assistant reply with text, no tool calls, and a successful normal terminal answer, not a live partial, tool round, host-fact display entry or arbitrary session-global entry. For this slice accept normal `stop` answers; failed/aborted/pending/cut-off answers get no branch action. Do not rely on `tx.entry(E)` alone: that lookup is session-wide. No requirement that the reply still be in the browser's last-20 window when the request arrives.
5. Read current main `AgentDoc` before the first table write. Fork at E with `{ownership:{kind:"ownerless"}}`. The fork's main ancestry stays immutable; no owner task is attached.
6. Access the child's staged `AgentDoc` and normalize its execution configuration to current main settings, with this launch's model overriding historical model state. Use the declared public `AgentDoc` fields; clear historical optional overrides absent from current main. This includes tools/extensions/instructions/cwd/maxTurns and model-tool selection, so choosing an old reply cannot restore old execution policy. Do not copy `ProviderDoc`: the built-in hook supplies a fresh provider session identity.
7. Write the registry row and creation receipt. Return the child ID. All reads of tables occurred before forking; only document access follows it. Reacquire the conversation handle with `harness.conversation` after the commit, never inside it.

Throwing at any point rolls back registry and conversation together. A commit with uncertain acknowledgment is resolved by replaying the same request ID through the owner or inspecting the list; never create again with a new ID automatically. Main transcript, shared memory and task tables get no new user/model input from creation. A sidebar entry and explicit successful response make creation visible without injecting a synthetic main-chat message.

## Phase 2: target routing, foreground admission and recovery

Parameterize the internal Agent path with an optional target in its options, default main. Resolve the target once, then carry that exact handle through submit, ask, host facts, answer lookup, watch, abort and target-aware idle. A shared resolver reads registry membership, not a caller-supplied handle. Keep operator memory commands Session-wide and rooted for provenance, as today; opening a side does not silently retarget `memory remember`.

### Admission and concurrency

The invariant is one active **chat conversation** among main plus registered sides, not one provider call across the installation. Durable independently schedules missions, memory maintenance and tool tasks. This slice does not promise mutual exclusion against scheduled missions or external tools/processes; they already share the directory. That residual boundary must be stated in operations docs. A global filesystem lock or changes to mission scheduling would be a separate design/owner decision.

All foreground admission routes must use the same transaction-level check. Outside-the-transaction `status()` or JavaScript checks race: two sockets can both see idle and admit into different chats.

For a send, check `requireActive`, configuration and maintenance; resolve the target; inside its commit read the registry and every other chat's `LiveDoc` and `InboxDoc` before the first table write. An unfinished run or nonempty inbox in another chat rejects with a structured busy result identifying the accessible blocking chat. Then call `target.submit(tx, ...)` and `recordMemoryInput` in that same transaction. The Session serializes commits; the second racing caller observes the first caller's staged run/inbox after commit. No process-local lease or timer is needed.

Preserve same-target admission semantics. Durable currently queues input on a busy conversation; changing that would remove existing intentional functionality. The browser may continue disabling Send while its selected conversation is busy. A different busy conversation blocks sending and shows a link to that chat; do not provide a global “Stop current work” button that silently targets whichever run happens to be active.

Look up an existing target-scoped `submissionByRequest` before cross-chat busy rejection. An exact retry of a previously admitted submission may retrieve its result even while another chat is now busy; it must not create work or be mistaken for a fresh admission. Keep Durable's current dedupe and `recordMemoryInput` conflict checks. Do not claim Durable compares the entire original prompt: it dedupes by request ID/type; memory metadata compares a bounded query. Gateway canonical fingerprints compare the complete operation within its pairing session. Expanding owner-wide prompt fingerprint retention is not required for side routing.

`ask`'s host-fact path must use the selected transcript and target-scoped request receipts, with the same foreground/hold checks for a new display-only answer. It must not bypass the resolver or append to main while the UI shows a side. Host facts retain their current display-only semantics and do not start a generation or become human memory-capture entries.

Targeted cancel calls only that resolved conversation's `abort` with existing default background semantics. Ownerless sides are not children of main's task ownership scope: cancelling main is not “cancel all.” Existing background memory tasks may survive cancel. Disconnect, page switch, logout and watch teardown never cancel work. Cancel is not given a new durable exactly-once guarantee: the gateway caches it within a pairing session, but callers must not automatically replay a lost cancel after restart against a potentially later run.

### Cold start and restart ordering

`Harness.open` reconciles surviving running tasks but does not itself enable scheduling. Preserve that staging window. Before advertising the owner socket or calling any progress-enabling API:

1. Load/initialize `SideDoc`; an old installation gets an empty registry. Never classify all non-root conversations as sides and never adopt mission or unknown conversations automatically.
2. Resolve each registered ID, verify its stored parent and ownerless ownership against the registry, and load its execution documents. A missing or inconsistent registered record is a startup error, not a reason to recreate it or remap its ID. Keep persisted evidence intact.
3. Reconcile current model on main and every side, even when the historical fork stored another model. When this launch has `model:null`, explicitly clear stored models using the supported `AgentChange.model:null` semantics. Do not leave a stale model merely because the existing root-only code skips the null case. Reapply current main execution policy to sides; no per-side configuration is offered in slice 1.
4. Read persistent maintenance/startup inhibition and inspect main plus side live/inbox state. Collect interrupted chat identities for status/logging instead of keeping only the current root-only `interrupted` boolean.
5. If more than one chat contains pending foreground work, fail startup before resume with bounded conflicting IDs and an operator recovery diagnostic. This state cannot be produced by the new admission transaction, so do not discard inputs, choose a winner or auto-abort. Recovery requires owner-reviewed repair/restore while the service is stopped; this slice provides no generic mutation endpoint for inconsistent storage.
6. Complete existing mission initialization, memory reconciliation and `canSchedule` checks. Preserve the current unconfigured-provider rule: pending submissions/non-memory foreground work prevent scheduling when no provider is configured. Then resume only if all existing gates and the new registry checks pass.

List, status and watches remain observational while held/inhibited; they must not call `waitForIdle`, `Submission.wait`, `submit`, `abort` or `resume`. A normal interrupted run resumes under the existing Durable recovery semantics after these gates pass; disclose “resuming chat X” in owner logging/status. There is no extra watchdog, recurring task, hidden retry queue or automatic new conversation.

Apply the same registry/configuration validation before existing maintenance release enables the scheduler. Maintenance entry continues to inspect all Harness submissions and non-background tasks, so side work is included in draining. A new side start/send that races the hold must see the hold inside its commit and reject. Existing work drains under existing semantics; the side feature does not terminate it.

## Memory capture and retention

Use exactly the existing human admission path, substituting the selected ID:

```text
target.submit(tx, {
  type:"input", content:prompt,
  entry:{kind:MemoryInputEntry.kind, data:{origin:"human"}},
  requestId
}) -> submissionId
recordMemoryInput(tx, target.id, submissionId, "human", prompt)
```

Both operations commit or roll back together. `MemoryInputsDoc` starts empty in a fork. Never seed it from parent pending inputs and never relabel inherited history as newly received human input. The after-run dispatcher reads that run's range; deterministic capture uses source entry/task keys and writes provenance with the side conversation ID. Choosing a completed answer as the fork point also avoids recreating a dangling parent's unfinished exchange.

`MemoryDoc` stays Session-scoped. Side and main recall consult the same current value; no fork snapshot of memory is created. Agent `remember` remains agent-origin evidence, while explicit deterministic human capture remains user-origin. Background capture is asynchronous: a finished answer is not proof capture has finished, and tests must await the capture receipt rather than sleep. Existing consolidation keeps per-conversation provenance and can relate different conversations. No memory schema or graph change is needed for side creation.

The memory graph keeps its opaque per-process cluster keys; new side IDs do not replace those keys or expose raw provenance through the graph. Shared memory may include information learned after the fork point, so the fork is not a historical snapshot of Bob's knowledge. Forget retains its existing confirmation and invalidation behavior; it does not erase transcripts. Future archive must also retain history and memory unless the owner explicitly chooses a separate deletion design.

## Phase 3: approved browser surface and selection lifecycle

Do not begin this phase until the owner approves the exact operation table above. Backend/operator support can be reviewed independently while browser behavior remains unchanged.

Extend `ServiceClient.watch`, local `watchService`, the service watch-frame parser and pinned remote watch reconnects to carry the selected target. The socket must reject malformed extra fields and check membership before creating a watch mount. Gateway syntax validation is not registry authorization. Defer the successful SSE response until owner attachment succeeds; unavailable targets must not produce an empty apparently successful main stream. Preserve the two-stream cap, detach in `finally`, release owner mounts and keep slow-consumer bounds.

Add side start to gateway mutation fingerprinting and session dedupe. Reconstruct request IDs at the gateway, as memory forget does; never trust an inner browser credential or a second conflicting request ID. Preserve unknown outcomes and sanitized owner errors. A bounded `foreground_busy` result can carry only a registry-validated target/name; do not expose arbitrary internal diagnostics merely to show useful busy text.

Keep the four-request limit. Schedule and coalesce details, list, and graph reads together. Preserve room to send from idle and to cancel while a send is outstanding. A three-read batch can still block cancellation if a send already occupies the fourth slot, so verify the combined read and mutation limit with both cases. Reads may retry with visible connecting or stale state. Mutations keep their existing single-attempt behavior.

Keep `Section` as Chat/Mission/etc. Add a fixed Main chat row and a plain Side chats list under it. Main stays first. A main reply with `canStartSide: true` has a “Side chat” action with fork-context copy and optional title input. The current reply toolbar uses `pointer-coarse:hidden`, so the new control needs a touch and keyboard path.

Selecting a chat is a local navigation action. It performs no admission. The shell closes the previous EventSource, increments a selection generation, clears the visible old transcript, and opens the new selected watch. Until the first validated matching view arrives, show loading and disable send/cancel. Bind callbacks to both target and generation; closing an EventSource alone does not remove queued browser events.

Keep per-target in-memory drafts, unknown-send records, request IDs, sending/cancelling flags, scroll/following state and tool summaries for main plus at most 16 sides. Include target in transcript render signatures and action keys: inherited main entries have the same entry IDs in a side, so the current history signature can otherwise leave the wrong chat rendered. Reuse the existing composer element while loading the selected draft. Do not persist prompt text in localStorage.

Capture target and request ID at action time. If send-to-A completes after navigation to B, update A's state only; never restore A's prompt into B's composer or attach A's tools to B's reply. Unknown notices name their chat. Cancelling A remains a request about A even if the owner opens main before the result returns. An old stream's error cannot mark the new stream expired/offline. Suppress all late results after sign-out/unmount.

After creation succeeds, select the returned side only if that creation action still owns the navigation generation; always refresh the list. If its outcome is unknown, preserve source/title/request ID and inspect the list. The current gateway may retain an unknown result for that request for the rest of the pairing session; do not pretend retrying it necessarily refreshes the owner result. The terminal can explicitly replay the same start request ID after inspection. Never invent a new ID to work around uncertainty.

List refresh on mount, navigation, explicit refresh and selected-run transitions is sufficient for slice 1. Do not mount all 16 transcripts for sidebar status. Show stale/unknown state when list reads fail; no inferred needs-you badge. Existing mission attention remains its existing global item. All model/owner/title text uses text nodes, existing focus primitives and CSP-compatible classes. Verify light/dark, 390/1440/1920 widths and no horizontal scrolling.

## Security gates before Phase 2

From the security review (beads `unit-mei.10`). Phase 1 is owner-internal and unreachable from any socket, so these are recorded, not built.

- Every target-taking path must call `resolveSideConversation`: send, cancel, watch, ask's host-fact shortcut and answer lookup. Never call `harness.conversation(id)` with a caller-supplied number; ids are small sequential integers and mission conversations would be readable. Each entry point needs a test that mission ids and unregistered ids get the same "Chat is unavailable." result, and that the socket rejects a target before creating a watch mount.
- The registry has a hard cap of 16 and no archive or delete, so the feature is permanently full after 16 starts. Document this in operations docs until archive (16 live, 64 archived, receipts retained) is built.
- A stored inconsistency (or lowering `SIDE_LIMIT` below a stored count) makes `Agent.open` fail by design. Document the recovery path (stop the owner, review or restore stored chat records) and never lower `SIDE_LIMIT` without a migration.
- `Agent.open` writes `SideDoc` even under startup inhibition or a maintenance hold. This is metadata only and schedules nothing. If holds are used for consistent backups, initialize after the hold check or write lazily on first start.
- **One active chat.** Every foreground admission (send, host-fact answer, replay, side start) decides in its own commit, before the first table write: resolve the target through the registry, check the maintenance hold, then read the target's send receipt (`SendReceiptsDoc`, per chat). A replay whose digest matches returns the existing submission even if another chat is now busy; a different digest is refused. Only a fresh admission then reads `LiveDoc.run` and `InboxDoc` of main and every other registered side and rejects with a structured busy result naming the blocking chat if any has a run or queued input. Same-chat queueing stays. No process-local lock, lease or outside-the-commit `status()` check counts. Startup refuses to resume when more than one chat holds foreground work (Phase 2, step 5). Test two sockets racing fresh sends into main and a side: exactly one is admitted.
- The `admission` lookup and its receipts are per chat. Receipts start empty in a fork, so a side never inherits main's request IDs. When the lookup takes a target it must resolve it like send, give mission and unregistered IDs the same "Chat is unavailable." result, and stay observational (no `wait`, `resume` or `abort`). The full-prompt receipt supersedes the bounded memory query as replay identity for new sends.
- Cancel stays chat-wide inside its chat: a targeted cancel aborts the resolved chat's run, tools and queued inputs, and is labelled that way. A Stop limited to one observed run needs an atomic run-scoped primitive from Durable; a read of the active run followed by `abort` is not acceptable, because a later run can start in between.

## Implementation sequence and acceptance gates

| Phase | Intended files | Completion condition |
| --- | --- | --- |
| 1. Registry and creation | New `src/side.ts`, `src/side-control.ts`; owner tests | Atomic bounded fork/registry/receipt; read-only listing; invalid addresses rejected; zero provider calls on start/list. |
| 2. Owner routing and recovery | `src/agent.ts`, `service.ts`, `service-view.ts`, `service-client.ts`, `remote/client.ts`, `args.ts`, `cli.ts`, command catalog/help; relevant deploy/CLI allowlists | Every foreground path targets the resolved handle; startup reconciles sides before resume; concurrent cross-chat admission excluded; terminal operator path works without another storage owner. |
| 3. Browser contract, approval required | `src/web/contract.ts`, `src/web/gateway.ts`, `web/{contract,port,state,shell}.ts`, `web/views/chat.ts`, preview and fixtures | Recorded owner approval precedes changes. Closed parsed operations, selected watch, safe navigation, bounded list and visible fork semantics. |
| 4. Acceptance and documentation | Owner/service/remote/web tests, `docs/operations.md`, `docs/web-ui.md` | Tests below pass; documented authority, memory, recovery, serial-chat limit and residual mission/file concurrency. No source/lockfile changes outside the agreed implementation scope. |

Keep existing terminal attach/repl main defaults. CLI side creation and targeted one-shot send/cancel suffice for slice 1; a rich-terminal side navigator is deferred. Update operator dispatch allowlists and managed command tests, not just the argument parser. Inspect those files fully before implementation changes. No new dependency is needed.

## Tests and verification plan

Use SQLite reopen tests and the local faux provider pattern already in `apps/unit-001/test/agent.test.ts`. Do not use real providers, credentials, network targets or vulnerability reproductions. Add contract/behavior tests using ordinary well-formed fixtures and bounded invalid input.

| Mechanism | Required cases |
| --- | --- |
| Registry/bootstrap | Empty legacy installation; no adoption of mission/unknown conversations; 16th succeeds/17th rejects; bounded title parsing; row survives reopen; missing/inconsistent row blocks before scheduling; multiple pending chats block without discarding either. |
| Fork semantics | Completed main reply includes history through E and excludes later entries; child has empty input/live/inbox and a distinct provider identity; existing tasks are not duplicated; host fact/tool/live/failed reply anchors rejected; main transcript unchanged and no provider request on creation. |
| Atomic creation/replay | Inject a throw after fork but before row publication, then reopen: neither side nor row committed; identical request returns same child across reopen; different normalized fields with same request reject; simultaneous equal starts create one row; simultaneous different starts at cap cannot exceed cap. |
| Routing | Main remains default; side send/watch/cancel/host fact/answer lookup all use side; unknown and mission targets rejected on every entry point; root and side observe shared mission state without acquiring approval rights. |
| Configuration/recovery | Fork from old model and reopen with new model; first resumed side request uses current model; model-null reopen never dispatches a stale provider; startup-inhibited and persistent hold permit list/watch but no execution; release validates before resuming. |
| Foreground race | Two socket requests synchronized before admission into different chats: exactly one newly admitted; loser has no input/submission/memory metadata. Repeat root→side and side→side. Same-target queue behavior remains. Existing request replay is found before another chat's busy guard. Queued inbox work also blocks another chat. |
| Holds and cancel | Hold racing new start/send rejects atomically; maintenance sees side submissions and drains; targeted cancel leaves main and sibling transcript/work alone and preserves current background-memory behavior; detach/logout/switch do not abort. No automatic lost-cancel replay. |
| Memory | Human side input has `MemoryInputEntry.origin:"human"` and matching side `MemoryInputsDoc` in one admission commit; failed admission leaves neither. Await capture receipt, then recall side evidence from main and vice versa. Fork does not recapture parent human entries. Agent-origin memory stays agent-origin. Forget invalidates existing relations/summaries while transcript remains. |
| Socket/remote | Strict watch target parsing (watch's separate dispatch path included); membership checked by owner; local and SSH observation reconnect retain exact target and pinned installation identity; late/wrong-target frames rejected; requests never replay automatically. |
| Gateway/port | Existing closed set unchanged before approval. After approval, only the named additions accepted; extra authority fields, duplicate query params and unsafe IDs rejected. Creation dedupe/fingerprint includes normalized target/anchor/title; body/frame/in-flight/mutation/SSE bounds retained; failure releases stream count and mounts. |
| Browser switching | Type in A, switch B, preserve drafts and scroll independently; inherited entry IDs do not retain wrong transcript; late A send/failure/cancel/stream events cannot alter B; rapid A→B→A ignores stale generations; selected busy cancel targets correct chat; unknown start/send stays visible and never auto-replays. |
| Browser acceptance | Pair, create from main reply, see fork note and side row, send, cancel, Back to main, reload/reopen list. Keyboard and touch entry points, focus/selection, sign-out teardown, current terminal-only authority assertions, zero CSP violations and 390 px overflow checks remain. |

Run targeted tests from the package root with the repository Vitest binary; add side tests to the existing explicit app test groups. For built imports, build `packages/unit-memory` before app tests. For browser acceptance, rebuild production web assets first. Relevant commands from repo root:

```text
npm --prefix packages/unit-memory run build
node node_modules/vitest/dist/cli.js --run --root apps/unit-001 test/side.test.ts test/agent.test.ts test/service.test.ts test/web-owner.test.ts test/web-gateway.test.ts
node node_modules/vitest/dist/cli.js --run --root apps/unit-001 --config web/vitest.config.ts
node node_modules/typescript/bin/tsc -p apps/unit-001/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/unit-001/web/tsconfig.json --noEmit
node apps/unit-001/scripts/build-web.mjs
UNIT_001_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node --conditions=source --test apps/unit-001/test/web-browser.test.mjs
```

Add focused remote/args/CLI and deployment test files to the validation command when changed. Run modified tests; never `npm test` or unfiltered full Vitest. The handover says root `npm run check` rewrites repo-wide and fails on pre-existing pinned dependencies; the implementer must resolve the conflict between that behavior and the mandatory project check requirement before running a repo-wide write in a shared worktree. Do not bypass checks, claim a full green check from partial commands, or silently modify unrelated files. None of those checks is required to generate this design-only file.

## Follow-ups and checks performed for this report

Deferred: fresh/summary-seeded chats; side-of-side forks; rename; owner-triggered archive with retained receipts/history/memory; approved summarize-back proposal; model-created chats with visible announcement; accurate per-chat attention state; concurrent foreground chats; mission/file conflict policy; history paging/search; channel routing. Automatic archive and automatic main-chat updates from side-products are explicitly not slice-1 behavior.

Read AGENTS.md and HANDOVER.md fully, plus the full section-5 side-fit and side-products reports. Read the current owner, service, gateway/parser, view/client, web state/port/shell/chat, Durable conversation/admission/view/fork and memory capture contracts cited above; checked mission creation/admission and managed authority routing. Contract references are repository paths so the design can be reviewed without the temporary research directory.

The design was reviewed against the current source contracts. The runtime and browser checks above are acceptance criteria for the implementation.
