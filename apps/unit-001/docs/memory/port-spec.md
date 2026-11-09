# Memory port specification

Implement memory as a Pi Durable extension in `packages/unit-memory`, using Durable documents and tasks rather than embedding the Mnemosyne or mnemopi database engines. The first slice provides deterministic recall and replay-safe writes within one Durable Session. Extraction and consolidation run in background tasks. Neither Python, Bun, a model download, nor a network call is required for basic memory.

This is the implementation contract proposed by [issue #3](https://github.com/francman/unit-001/issues/3) for issues [#5](https://github.com/francman/unit-001/issues/5)–[#9](https://github.com/francman/unit-001/issues/9). Source behavior and unit-001 decisions are distinguished below. Numeric response-time budgets belong to [#4](https://github.com/francman/unit-001/issues/4); no latency or quality result is claimed by this source audit.

## Goal and boundaries

Memory must support an always-on agent pursuing a mission without repeated user prompts. It retains useful decisions, preferences, observations, and outcomes across runs and process restarts. It is supporting evidence for the agent, not the authoritative mission record or a source of additional execution authority. A recalled instruction cannot override the mission's current operating boundaries.

For the initial slice, choose **Durable Session scope**: every conversation and fork in one Harness sees the same current memory. This is a storage boundary, not a claim that all useful memory should ultimately be session-local. The current CLI stores each named `--session` in a separate SQLite file, so those sessions do not share memory. Project-wide and user-wide sharing need an explicit host ownership and isolation design; do not silently share via a default global bank. A future mission host can place related conversations in one Session without changing this memory contract.

Keep upstream Pi unchanged. All implementation belongs in `packages/unit-memory` and app wiring in `apps/unit-001`. Use only public exports, and raise missing Durable capabilities upstream instead of reaching into its SQLite tables.

## Audited source revisions

| Source | Revision | Relevant mechanisms |
|---|---|---|
| [Mnemosyne](https://github.com/mnemosyne-oss/mnemosyne/tree/bb854a5b6539bcf640c5b83d7a5306d21fb7acf7) | `bb854a5b6539bcf640c5b83d7a5306d21fb7acf7` | `mnemosyne/core/beam.py`: schema initialization, remember, recall, additive sleep; `memory.py`: facade; `weibull.py`: decay; `docs/integrations/pi.md`: tool surface |
| [omp mnemopi](https://github.com/can1357/oh-my-pi/tree/88a69582c755bd000e8dc0290981fc787a4f400c/packages/mnemopi) | `88a69582c755bd000e8dc0290981fc787a4f400c` | `src/core/beam/{schema,store,recall,consolidate,index,types}.ts`, `memory.ts`, `extraction.ts`, `mmr.ts`, `aaak.ts`, package README and manifest |
| Local Pi Durable | Repository base `8b5f8df867d9c282a084c365b39e7dbb5e916816` | `src/{types,documents,entries}.ts`, `src/harness/{types,define}.ts`, SQLite schema identifiers, examples `10-extension-state.ts` and `32-tests-after-edits.ts` |

Mnemosyne was read from the local `reference/mnemosyne` checkout. Mnemopi was inspected in a temporary sparse checkout; it is not a new dependency or a tracked reference directory. These are comparisons of the pinned snapshots, not a claim of complete historical parity between the two projects.

## What the reference engines do

### SQLite schema and memory tiers

The Python engine's `beam.py` owns working and episodic memory, alongside structured fact projections and optional vector indexes. `memory.py` also maintains a legacy `memories` table and a facade over BEAM. The TypeScript port keeps the working/episodic schema in `core/beam/schema.ts` and uses `bun:sqlite`.

| Relation | Reference shape and purpose | Unit-001 treatment |
|---|---|---|
| `working_memory` | Text ID; content, source, timestamp, session ID, importance, JSON metadata, veracity, memory type; recall counters; expiry/supersession; scope and author/channel provenance; `consolidated_at`. Python also tracks consolidation claims and pinning. Mnemopi adds a separate `embed_text`. | Preserve the two-tier concept and provenance in typed documents; no copy of this SQL schema. |
| `episodic_memory` | Integer row ID plus unique text ID; summary content and comma-separated `summary_of` source IDs; importance and provenance; degradation tier 1–3, time, optional binary vector. | Store source IDs as an array, preserve originals, and treat a summary as derived evidence. Degradation is deferred. |
| `fts_working`, `fts_episodes` | FTS5 lexical indexes. Episodic FTS uses external content keyed by row ID; triggers synchronize inserts, deletes, and content updates. | Start with an in-process lexical index derived from documents. SQL FTS is a later scaling decision. |
| `memory_embeddings` | Memory ID, serialized float vector, model identity, creation time; also a fallback when native vector indexes are absent. | Deferred. Any future vector must identify model, dimension, and the exact content revision. |
| `vec_working`, `vec_episodes`, `vec_facts` | Python uses optional `sqlite-vec` virtual tables and validates stored dimensions/formats. Mnemopi retains optional vector plumbing but also scores stored JSON float embeddings. | Skip native vector tables in the initial port. |
| `memoria_facts`, `memoria_timelines`, `memoria_instructions`, `memoria_preferences`, `memoria_kg`; `facts`/`fts_facts` | Structured extraction projections with links back to source memories; facts retain confidence and some version/validity information. | Retain a small record kind and source references, not duplicate fact stores. Graph and temporal reasoning are later. |
| `scratchpad`, `consolidation_log` | Temporary session notes and maintenance history. | A mission's working state belongs in its own documents. Record consolidation outcomes through durable task results and bookkeeping entries. |
| Persona, validation, annotation, graph, sync/event tables | Broader identity, attestation, graph traversal, and synchronization features. Python's initialization includes persona and sync-event tables absent from mnemopi's BEAM schema. Mnemopi initializes graph/annotation stores separately. | Outside issues #5–#9. Do not create unused equivalents. |

Working memory holds individually retained items; episodic memory holds summaries derived from older items. In both inspected engines, sleep is additive: it marks source working rows consolidated rather than deleting them. Recall can return originals and summaries, so the engines explicitly deduplicate summary/source overlap. Their age/overflow trimming and later episodic degradation are separate, potentially destructive policies; unit-001 must not inherit them accidentally.

### Reference recall scoring

Both snapshots combine lexical evidence, optional dense-vector similarity, importance, and recency. Their formulas are related but not identical; a TypeScript port is not an exact behavioral oracle for the Python revision.

The linear path collects candidates from working and episodic FTS, unions optional vector hits, and uses bounded recent-row fallbacks when indexed candidates are absent. Recall excludes expired and superseded records and applies session/channel/source filters. Mnemopi normally fetches at least `max(3 * topK, 50)` lexical candidates and uses at most 500 recent rows per tier in its fallback. It normalizes FTS rank within the candidate set, computes lexical token coverage, and rejects a candidate with insufficient lexical relevance unless its dense similarity is at least `0.65`.

With normalized vector/FTS/importance weights `v`, `f`, `i` (defaults `0.5`, `0.3`, `0.2`), mnemopi's core scoring is:

```text
episodic base = max(dense * v + fts * f + importance * i, lexical * 0.8)
keyword = max(lexical, fts * 0.6)
working base = keyword * (1 - i) * 0.6 + importance * i + keyword² * 0.08
if a working vector exists: base = base * 0.8 + dense * 0.2
score = base * (0.7 + 0.3 * exp(-ageHours / 72))
```

Additional multipliers account for veracity, episodic degradation, optional temporal intent, and current-versus-stale wording. `recallEnhanced` adds synonym expansion, intent-adjusted weights, and maximal marginal relevance (MMR): greedily prefer relevance while penalizing similarity to already selected results. Its optional polyphonic path combines several rankings by reciprocal rank. Results include signal scores and a clipped content preview, and recall normally writes usage counters.

Python's linear recall has additional entity/fact bonuses, literal CLI-flag handling, dense-pool exclusions for raw conversation captures, and a working-memory recency factor derived from the importance weight. Its optional polyphonic engine combines vector, graph, fact, and temporal signals. Both projects contain Weibull decay helpers (memory-type-specific survival curves); their existence does not mean every linear recall path uses them.

These mechanisms explain the references; they are **not** all requirements for the first unit-001 slice. In particular, basic recall must neither embed a query remotely nor write counters before a response.

### Reference capture, sleep, and fallbacks

Python can summarize sleep batches with a configured LLM, chunking inputs to fit its context. If unavailable or unsuccessful, it joins source text and applies AAAK phrase/structure compression. It detects possible conflicts, but similarity-only detection does not authorize invalidation. Originals remain available. It claims rows before summary creation, leaving a possible orphan claim after a crash; a separate reclaim path repairs these.

Mnemopi keeps additive sleep and grouping by source, but the inspected `beam/consolidate.ts` sleep path is deterministic: bounded chunks, AAAK compression, `llm_used: false`. Do not infer LLM-based sleep from the presence of its general LLM adapters. It also keeps degradation: older episodes are shortened at roughly 30 and 180 days, with obsolete vectors invalidated. Those are reference defaults, not unit-001 retention requirements.

Mnemopi's extraction supports configured/host/remote completion and deterministic English heuristics when no LLM is available. It retains category-preserving facts, instructions, preferences, timelines, and graph triples. Its `extractText` and `embedText` let a host avoid mining assistant prose as user instructions while retaining a larger transcript. Background extraction/embedding promises are process-local; they are not crash-resumable tasks.

Mnemopi drops Python's bundled local GGUF inference route: optional local ONNX embeddings use `fastembed`, while LLM access uses host or OpenAI-compatible endpoints. It keeps banks, explicit tool dispatch, graph/fact modules, diagnostics, and broad compatibility aliases. Unit-001 adopts the useful behaviors, not Bun/native dependencies, process-global configuration, SQL migrations, or compatibility aliases.

## Initial implementation contract

### Durable data and ownership: issue #5

Use a version-1 `defineDoc` singleton with `scope: "session"`, kind `unit.memory`. **Do not specify `history` or `fork`: Durable explicitly forbids them for session documents.** Conversation-only documents support those properties. A fork shares the live session memory; it does not get an as-of copy, and forgetting takes effect for every conversation in that Session. Update issue #5's acceptance criteria to reflect this distinction.

Use one current document initially, with these logical fields:

| Field | Required meaning |
|---|---|
| `revision` | Monotonically increasing integer on every memory mutation; invalidates derived indexes. |
| `records` | Map of stable memory IDs to the tagged record shapes below. |
| `receipts` | Map from deterministic write keys to their result IDs or deletion result; a repeated tool execution returns the same result. |
| `captures` | Map from run identity (`conversationId` plus generation task ID) to capture task ID and terminal outcome. Bounds duplicate scheduling and makes failures visible. |
| `consolidation` | Tagged state: `idle`, or `scheduled` with the active task ID. Allows at most one consolidation task per Session. |

Each live record contains `id`, `revision`, `content`, `kind` (`fact`, `preference`, `decision`, or `observation`), `importance` in `[0,1]`, `createdAt`/`updatedAt` as UTC epoch milliseconds, and host-owned provenance: origin (`user`, `agent`, or `tool`), conversation ID, source entry IDs, and derivation (`explicit`, `capture`, or `summary`). A record revision changes when its content, provenance, or liveness changes; a consolidation marker alone does not change it or its `updatedAt`. The document revision still advances on every mutation. The caller's optional `source` string is a descriptive label; it cannot establish authorship or trust. Source entry IDs always refer to the same Session.

The tier is a tagged value: `working` with consolidation state `pending` or `done` (summary IDs), or `episodic` with `summaryOf` IDs and the source revisions used. A forgotten record is a tombstone containing only its ID and next revision. Keeping the tombstone prevents an already scheduled background task from recreating it. Do not retain forgotten content in receipt payloads or derived indexes. Durable's immutable transcript still exists: `forget` removes memory retrieval, not historical transcript or disk-level data erasure.

Use `tx.doc(MemoryDoc)` inside the same commit as each write's receipt and optional `unit.memory.changed` bookkeeping entry. Bookkeeping entries carry IDs and operations, not model messages; they must not recursively trigger capture. Reads use `snapshot(MemoryDoc, context)` and treat an absent document as empty. Memory commits use immediate persistence, not streamed-progress deferral.

Start with a checkpoint after 64 deltas (`info.deltasSinceBase >= 63`), then measure reopen and commit cost under #4 before changing that policy. This bounds delta replay depth; it does not bound document size. Retain receipts/tombstones for the Session lifetime initially, because pruning them without a replay horizon can reintroduce duplicates or forgotten content. Benchmark growing stores; a document-family/index redesign is later work if measured cost requires it. Never hide a failing budget with silent eviction or an unreported recent-only search window.

Increment the document definition version whenever the stored shape changes and supply a deterministic migration from each supported older version. A newer stored version must fail clearly, as Durable already enforces. Do not alter Durable's schema or import reference databases implicitly. Test migration with a persisted older fixture and reopen, not only an in-memory object.

### Deterministic recall: issue #6

The first retrieval engine is lexical and read-only. No embeddings, LLM, subprocess, network, full-transcript scan, or per-request memory mutation belongs in this path. Build an in-process inverted index from the current document, keyed by memory owner and revision; update it only when committed memory changes. A cold rebuild is measured separately from warm lookup. If cached, scope its lifetime to the owning memory service and release it on Harness close; no process-global strong cache.

Normalize query and indexed text with Unicode NFKC and lowercase. Extract leading-hyphen CLI flags first as atomic tokens matching `--?[\p{L}\p{N}][\p{L}\p{N}_-]*`; exclude their spans from generic word tokenization. Thus `--force` matches only `--force`, not bare `force` or `-force`. Tokenize the remaining Unicode letters/numbers/underscores; keep the whole identifier and its underscore-separated parts. Match whole tokens, not arbitrary substrings (`redis` must not match `redistribution`). Remove this finite stop-word set: `a an and are as at be by for from how i in is it of on or that the this to was what when where who with`. Deduplicate tokens. No stemming or synonym expansion initially.

Index only live records. For query token set `Q` and record token set `D`, require at least one exact match and use this deliberately simpler ranking:

```text
coverage = |Q ∩ D| / |Q|
ageHours = max(0, (now - updatedAt) / 3_600_000)
recency = exp(-ageHours / 72)
score = coverage * (0.8 + 0.2 * importance) * (0.7 + 0.3 * recency)
```

Read `now` once from the operation's clock. Rank by descending score, then descending `updatedAt`, then ascending ID for deterministic ties. Empty queries, stop-word-only queries, or queries with no matching records return no results. Importance and recency cannot admit an irrelevant record. This formula borrows the reference lexical/importance/recency structure; it is a unit-001 starting policy requiring quality fixtures, not numerical parity with either engine.

Merge working and episodic candidates before top-K. When a matching working source is selected, omit an episodic summary covering that source so a fact does not consume two slots. A summary remains eligible when none of its matching source records was selected. Never return forgotten records or summaries that depend on forgotten/changed source revisions. Expose IDs, provenance, tier, and score with the bounded text.

Use the same retrieval implementation for automatic and explicit recall. Automatic recall takes at most five results with at most 500 Unicode code points each, and a total injected block of at most 3,000 code points including metadata; append an ellipsis when clipped. Pack whole results in ranking order. This is a content-size bound, not a claim about tokenizer counts or measured latency.

Register `hook(GenerationTask, { beforeRequest })`. Return request-local messages, leaving the persisted system sections stable. Append one clearly delimited recall block to the latest input message in the request copy; never mutate the original message array, rewrite existing tool results, or persist the injected block. Mark it as retrieved evidence with source IDs, not instructions from the user. Recompute once per request attempt against the latest committed memory so a later forget takes effect; no stale ranking memo across attempts.

The hook cannot identify input provenance from `messages` alone. Wire an additional `unit.memory.inputs` conversation document (`history: "latest"`, `fork: "initial"`) through the app's submit path. In `Conversation.commit`, call `conversation.submit(tx, draft)` before other table writes, obtain its submission ID, and store a bounded query plus `origin: "human" | "mission"` under that ID in the input document in the same commit. Human queries come from the submitted text; mission queries come from the host's current objective/task. Store at most 2,000 query code points. Use a custom input entry kind `unit.input` with the same host-established origin in `data` so background capture can inspect immutable provenance. Neither origin nor query is chosen by the model.

In `beforeRequest`, read the public `LiveDoc` and the input document through `api.snapshot`. Select the newest metadata record whose submission ID is in `live.run.inputs`; queued future inputs cannot replace the active run's query. Tool-loop attempts retain the same placed inputs. This performs two document reads and a lookup over the active run's input IDs, never a history scan. The query remains available after compaction removes the original input from model context. If there is no matching metadata (including a legacy run or an unsupported continuation), inject nothing. Retain admitted metadata across restart; the short after-run dispatcher may remove metadata for that settled run after it has copied the needed bounds/provenance to durable capture work.

App wiring therefore includes admission metadata, not only `AgentOptions.extensions`. Capture reads `unit.input` entries tagged human; legacy `pi.user` entries require an explicit host migration policy before being treated as human. Starting retrieval when an input arrives is an optional later optimization; any prefetched result must revalidate its memory revision before use.

### Background capture: issue #7

The run-end hook may read at most three raw entries within the completed run's inclusive bounds through one public `api.entries` call. Only when that page covers the entire interval may the existing deterministic extractor prove there are no candidates or oversized skipped candidates and return without creating work. An incomplete page or any candidate/skipped candidate retains the original dispatcher path. This bounded exception avoids empty-learning task and receipt commits that otherwise add SQLite checkpoint contention between consecutive requests; it does not permit a full-history scan or extraction before a provider request.

When work remains, the hook returns one `runEndTask` carrying only the run bounds (`first`, `answer`, `last`), conversation ID, and generation task ID.

Durable commits the answer and settles its inputs before calling `afterRun`, but the returned tasks are children that **keep the run and conversation busy until they finish**. The child must therefore be a short dispatcher: in one `runtime.commit`, check `captures`, create a **conversation-owned** task with `background: true` and `abandonOnRestart` unset, record its ID, and finish the dispatcher. Background applies only to conversation-owned tasks; setting it on an ordinary child is not the solution.

```text
answer committed → afterRun dispatcher created
dispatcher commit: capture receipt + background task + dispatcher terminal
next foreground run may proceed
background capture: read bounded history → extract → commit memories + completion
```

Read raw entries through `runtime.entries({ minEntryId: first, maxEntryId: last, order: "ascending" }, 100, cursor, context)`, beginning with `cursor` undefined and passing each page's `next` as the next call's cursor until it is absent. Compaction and resets change model context, not these immutable entries. Commit a completed page's candidates/receipts and next cursor in the same task checkpoint before moving on. Use source entry IDs to identify candidates. A restarted phase may repeat extraction, but stable keys and atomic completion prevent duplicate committed memories. External LLM calls are at-least-once; do not promise exactly-once model billing.

The deterministic initial extractor keeps user statements explicitly beginning `remember that `, `remember:`, or `remember ` (case-insensitive), storing the remaining text verbatim after trimming. It also recognizes complete user statements `I prefer ...` and `I dislike ...` as preferences, retaining the statement verbatim. Split at newlines and sentence boundaries outside code blocks; ignore quoted lines and fenced code. Use fixed fixtures for these rules. If a rule cannot identify a candidate confidently, retain nothing. Each candidate is at most 2,000 Unicode code points; skip longer candidates with a recorded reason instead of silently changing their meaning.

Only host-established human input entries qualify for these user rules. Assistant output, tool text, compaction summaries, synthetic mission prompts, and previous recall blocks cannot become user preferences or instructions. Record agent/tool observations only through an explicit remember call initially; later semantic extraction may propose them with the correct provenance. Synthetic mission submissions must use a distinct custom entry kind or host provenance before automatic capture is enabled for them. The memory layer must never guess authorship from prose.

Use default importance `0.5` for captured candidates. Identical content may be deduplicated within one origin, but do not merge contradictory statements or distinct authors automatically. The stable capture write key includes generation task ID, source entry ID, and candidate ordinal. Once dispatched, record a completed receipt even when no candidates were found; proven-empty short runs create neither task nor receipt. A fault is visible through Durable reports and the capture record; the next ordinary user response must not wait for retry.

An optional future LLM extractor must run as durable background work, validate a bounded structured result, retain source citations and provenance, report its spend, and fall back to these deterministic rules when unavailable or malformed. It cannot promote extracted prose to authority or silently enable paid calls.

### Explicit tools: issue #8

Register `remember`, `recall`, `forget`, and `stats` with schemas; all execute in-process. Names mirror the ticket rather than introducing reference-prefix aliases.

| Tool | Parameters | Result and replay contract |
|---|---|---|
| `remember` | Non-empty `content` (at most 2,000 code points); optional `source`; optional finite `importance` in `[0,1]`, default `0.5`. | Return memory ID. Use a write key from the tool's durable task ID and persist receipt plus record in one `api.commit`. `replay: "safe"` only with this idempotency. Preserve host provenance; a source label cannot claim human authorship. |
| `recall` | `query`; optional integer `top_k` in `[1,20]`, default 5. | Return ranked bounded records. Read-only, `replay: "safe"`. This tool may observe newer committed memory when replayed. |
| `forget` | Existing or absent `id`. | Return whether the first execution removed a live record. Tombstone the target and all dependent summaries, invalidate derived indexes, and persist the result receipt atomically. Replay returns that same result; a later independent forget returns false. `replay: "safe"` once implemented this way. |
| `stats` | None. | Live working/episodic counts, tombstone count, pending/failed capture counts, active consolidation task ID. Read-only, `replay: "safe"`. No content or credentials in diagnostics. |

Schema validation and tool-call boundaries enforce input sizes and numbers; internal modules use typed values. A tool failure must not leave half a memory update. Forget and its dependent-summary invalidation are atomic; a background capture or consolidation commit rechecks tombstones/source revisions before publishing derived content.

### Resumable consolidation: issue #9

Implement `sleep` as a durable task in the extension, callable by the host on demand. After capture or explicit remember publishes a pending working record, create the maintenance task in the same commit if `consolidation` is idle. On each eligibility check, select a batch when at least 100 unconsolidated records exist or the oldest pending record is at least 12 hours old. Process at most 50 source records per batch. If no pending records remain, atomically set `consolidation` to idle and finish the task.

When pending records are not yet eligible, sleep until the earlier of `oldest.createdAt + 12 hours` and `now + 60 seconds`, storing the next `select` checkpoint with `sleepUntil`. A capture arriving during that sleep does not wake it; a threshold crossing is observed within the next check, at most 60 seconds later while the host is running. This bounded polling avoids pretending Durable exposes an early-wake primitive. On-demand consolidation creates a task when idle; if one is already scheduled, return its task ID rather than replacing it or claiming it ran immediately. Twelve hours follows the references' half-of-24-hour eligibility rule; these are initial maintenance policies, not measured response budgets.

The document's `consolidation` field guards one active task. The task is conversation-owned and background, so ordinary foreground aborts and idle waits do not include it. Its normal completion and abort handler clear its matching active ID in the same commit as the terminal outcome. On host open and before admitting replacement maintenance, reconcile a stored ID against its public task record; a scheduler-faulted/orphaned terminal task must not strand the guard forever. Keep a failed outcome visible before creating a replacement. Explicit shutdown closes the Harness and a later open resumes unfinished work. The always-on host is responsible for keeping the Harness running or waking it; a CLI that exits after `-p` cannot continue background work until restarted.

Use phases `select`, `summarize`, and `publish`. `select` commits the source IDs/revisions and deterministic batch identity to the checkpoint. Group only compatible provenance and record kinds; never widen scope. `summarize` runs outside a commit. The initial deterministic summary is a source-labeled, deduplicated list of the original statements in their creation order, divided into chunks of at most 3,000 Unicode code points without splitting a statement. Preserve original statements; do not apply AAAK phrase substitutions or destructive paraphrasing. A singleton still gets a source-linked episode so age-based scheduling can make progress.

`publish` rechecks that every source is live and has the selected revision. If any changed, discard that chunk's candidate and reselect; never resurrect forgotten material. In one commit, insert the episode under its stable batch ID, mark sources consolidated with the summary ID, record a non-model bookkeeping entry, and advance the checkpoint. A crash before that commit leaves all sources pending; after it, the task resumes at the next chunk. There is no separate durable "consolidated" marker without its summary, unlike the reference orphan-claim tradeoff.

Keep original working records recallable. A summary's importance is the maximum source importance; its provenance identifies it as derived and lists source IDs/revisions. Do not automatically resolve contradictions, expire facts by similarity, or shorten old episodes. An optional later LLM summarizer must checkpoint its candidate before publication, validate source links, report usage, and use the deterministic list when unavailable. Mission completion and approval boundaries remain separate from memory consolidation.

## Feature disposition

`Must-have` means required by the first memory implementation across #5–#9, not already implemented. `Later` requires separate acceptance criteria and measured benefit. `Skip` is intentionally not part of this port.

| Feature | Disposition | Reason |
|---|---|---|
| Working and source-linked episodic records | Must-have | Retain exact evidence while enabling background summaries. |
| Session-wide memory shared across conversations/forks | Must-have | Uses an existing atomic boundary; no implicit cross-project leakage. |
| Project/user-wide memory and migration between named sessions | Later | Needs ownership and cross-Session coordination decisions. |
| Deterministic lexical recall, stable ranking, bounded injection | Must-have | Useful offline baseline with testable latency and abstention. |
| Automatic recall before requests | Must-have | Relevant context should not depend on the model remembering to call a tool. |
| Replay-safe explicit tools and background capture | Must-have | Survive crashes without duplicate committed memories. |
| Conservative provenance and dependent-summary forgetting | Must-have | Prevent assistant speculation or forgotten content resurfacing as user intent. |
| Durable sleep, additive summaries, deterministic fallback | Must-have | Maintenance must progress and resume without blocking responses. |
| Numeric hot-path budgets and cold/warm benchmarks | Must-have | #4 must measure actual document/index/commit cost. |
| Semantic embeddings and remote/local model adapters | Later | Adds startup, installation, cost, and latency; lexical memory must work without it. |
| LLM extraction/summarization | Later | Requires bounded prompts, validated output, spend policy, quality fixtures, and retry accounting. |
| FTS5/vector indexes or per-record document families | Later | Adopt only when measured store size exceeds the initial document/index approach. |
| Synonyms, stemming, MMR, Weibull decay, temporal intent | Later | More ranking behavior needs quality evidence, not assumed parity. |
| Graph/triple/fact voices and reciprocal-rank fusion | Later | Large extra surface unrelated to the first memory acceptance criteria. |
| Automatic contradiction resolution and attestation | Later | Similarity is not proof; requires an explicit evidence and correction policy. |
| Usage-driven eviction, TTL deletion, episodic degradation | Later | Destructive retention needs an explicit policy; preserve evidence first. |
| Persona/canonical self-model, cross-device sync/federation | Later | Separate identity and replication designs. |
| Python/Bun subprocess wrapper or direct mnemopi dependency | Skip | Violates the in-process Node/Durable integration and replay requirements. |
| Reference SQL migrations, legacy mirror, compatibility aliases | Skip | This is a new Durable store, not an existing reference database upgrade. |
| Fire-and-forget extraction promises | Skip | Process-local completion is insufficient for an always-on durable agent. |
| Reference AAAK compression and destructive age-based truncation | Skip | Exact statements and their provenance are preferable in the first port. |

## Durable compatibility and required ticket corrections

No upstream change is required for session-local documents, before-request recall, explicit tools, capture dispatch, or durable sleep. Public APIs provide atomic document/task writes, bounded raw-history reads, background conversation tasks, task checkpoints, and timers.

Three proposals in the current tickets need qualification before implementation:

1. **#5:** `history`/`fork` cannot be chosen for a session-scoped document. Use shared current memory; a per-conversation rewindable alternative would be a different visibility contract.
2. **#7:** `runEndTask` work delays the next run until it ends. Use the short dispatcher/background task pattern above; do not put slow extraction in the returned child.
3. **#6:** `beforeRequest` is request-local and runs per attempt. It exposes no early input-admission callback. Early prefetch belongs in the app's submit path and must not become a dependency for correctness.

Cross-Session atomic memory shared by multiple named SQLite sessions is **not** supplied by `defineDoc`. If that becomes a hard requirement, decide between a single mission Harness containing related conversations and a host-owned shared memory service with explicit coordination. If neither public approach meets the requirement, raise the exact missing transaction/ownership capability upstream; do not patch Durable's schema or write into its tables from a second connection.

An LLM used directly from a custom task is not automatically accounted as a built-in generation request. Its usage reporting and storage must be designed explicitly before enabling paid enrichment. No provider terms or subscription compatibility were tested in this audit.

## Acceptance and implementation order

Implement #5 first, then #8 and #7; #6 also depends on the measured budgets from #4. Add #9 after the record/provenance/capture contracts are stable. Keep the package importable without optional LLM or embedding dependencies. Wire it into the app through `AgentOptions.extensions`, registry installation, and the atomic input-metadata admission path described above, leaving upstream code untouched.

Required verification per mechanism:

- Documents: real SQLite close/reopen, atomic rollback, migration, shared visibility across two conversations and a fork, isolation between two Sessions, and immediate persistence.
- Writes/tools: crash before/after receipt commit, replayed remember and forget, absent ID, invalid sizes/numbers, and no duplicate memory or inconsistent replay result.
- Recall: exact identifier/flag matching, irrelevant abstention, Unicode normalization, deterministic ties, recency clock, top-K/content bounds, summary/source deduplication, and immediate removal after forget. Assert no embedding/network/subprocess calls or recall writes.
- Capture: crash before dispatcher creation, after background task admission, during history pagination/extraction, and after publication; concurrent foreground runs remain responsive. Human text may produce preferences; assistant/tool/mission/quoted/code text may not. Compaction cannot erase the input range.
- Consolidation: clock-triggered and threshold-triggered scheduling, one active task, bounded chunks, restart between every phase, source mutation/forget during summarization, atomic summary/source publication, retained originals, and foreground abort versus explicit background abort.
- Performance: cold index/reopen, warm recall, hook formatting, write/checkpoint cost, and growth of records, receipts, and tombstones. Budgets come from #4. A benchmark passing without an implemented stage is not evidence for that stage.

Run the repository's required checks for implementation changes and the specific tests changed. Use faux providers and real SQLite for recovery tests; no live provider credentials or paid calls are required by this contract.

## Attribution

Mnemosyne is MIT-licensed, copyright **2026 Abdias J**. Mnemopi's package license is MIT, copyright **2025–2026 Can Bölük** and **2026 Stencil Labs, Inc.** Preserve the applicable copyright and full MIT permission/disclaimer text alongside any copied or substantially adapted implementation, prompts, or tests in `packages/unit-memory`. Do not rely on this design document as the sole notice for copied source. Credit both projects in the package README and identify the source revision for any adaptation.
