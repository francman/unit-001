# Inspect and control session memory

The running agent keeps structured memory alongside its durable conversation. Both survive restarts. Memory belongs to one session database; another named session or installation has a separate memory bank.

```bash
bob memory stats
bob memory recall "deployment approval"
bob memory remember "Deployment requires my approval"
bob memory remember "Staging may deploy automatically" --relation updates:memory:operator:previous
bob memory graph                  # bounded view of live memories and links
bob memory forget <id>             # asks; defaults to No
bob memory forget <id> --yes       # explicit automation confirmation
bob memory sleep                  # schedule pending consolidation
```

These commands require [operator access](operations.md#operator-access-and-sudo), not sudo. In chat, use `/memory`, `/memory recall QUERY`, `/memory remember TEXT`, `/memory forget ID`, or `/memory sleep`. Forget asks you to type `yes`; another answer cancels. Copy an ID from recall results. These commands contact the existing owner without a model request or second SQLite writer.

The CLI accepts repeated `--relation <kind>:<id>` options on `memory remember` (also `--relation=<kind>:<id>`). Replace the example ID with an existing live memory ID from recall. Kinds are `relates`, `supports`, `contradicts`, and `updates`; directed kinds read “the new statement supports/contradicts/updates the target.” `relates` is symmetric. IDs may contain colons. The slash command stores plain text; use the CLI to supply typed relations.

A remember call may name at most 8 distinct live targets, including memories from other conversations in the same session. Existing limits remain 32 relations touching one memory and 4,096 stored relations per session. Invalid targets or exhausted capacity reject the whole write. Relations pin both endpoint revisions and retain explicit user provenance. Use `--request-id <stable-id>` to retry a CLI mutation safely; replay returns the original result and does not add relations or restore forgotten content.

Relations are stored in their own Session document, `unit.memory.relations`, so `unit.memory` keeps the version-1 contract that published 0.0.9 opens and writes. A write that adds or removes relations changes both documents in one commit. Opening the owner converts memory stored as version 2 by earlier builds of this branch, keeping every other field as stored, including the scheduled consolidation and its task ID. It then drops relations whose endpoints a relation-unaware writer forgot or changed: a relation holds only while both endpoints are live at their pinned revisions, so a tombstone that kept the pinned revision also ends it. See [full-owner rollback qualification](updates.md#full-owner-rollback-qualification).

`memory stats` reports the full session's live relation count, including explicit and consolidation links whose endpoints still match their pinned revisions. The agent's `stats` tool uses the same count. Summary links are excluded; `memory graph` can show fewer relations because its display is bounded. Forgetting either endpoint removes its relations along with links touching invalidated summaries.

Relevant memories automatically accompany requests as untrusted evidence. Human preferences and explicit “remember” statements are captured after answers. Background consolidation groups older statements without calling another model. `sleep` schedules work; it does not imply immediate completion. Stats expose pending and failed capture counts.

Forgetting removes recall evidence and invalidates derived summaries. Immutable conversation history remains. Memory cannot grant execution authority or establish current process facts. `/status` and the model's `unit_status` tool report the actual owner process and observation time. Autonomous mission scheduling remains separate work.

See [recovery verification and capacity limits](memory/verification.md).

See [practices taken from OMP, OpenClaw and Hermes](memory/reference-practices.md) for implemented patterns and proposed follow-ups.

## Input metadata growth: measured baseline and proposed cleanup (design only, nothing implemented)

Problem. Each conversation keeps one `MemoryInputsDoc` entry per admitted submission, `{origin, query}` with the query cut to 2,000 code points, and nothing ever removes it. The query text is only needed while the submission is queued or placed in a run. Example: a conversation of 5,000 messages with 2,000-character queries holds a 10.2 MB document, and every 64th admission rewrites the whole document as a checkpoint. A chat that learns nothing still grows this document, because the run-end hook skips capture for empty runs and so never touches `MemoryDoc` (`createMemoryBackground`).

Baseline, measured locally (Darwin arm64, real SQLite, one commit per admission shaped like `agent.submit`; a throwaway script, not the profiler, and not a native result):

| Admissions | Query chars | Document JSON | Closed database | Commit p50 / p95 / max (ms, last interval) |
|---|---|---|---|---|
| 1,000 | 200 | 0.24 MB | 0.6 MB | 0.17 / 0.34 / 1.6 |
| 5,000 | 200 | 1.2 MB | 2.7 MB | 0.43 / 0.79 / 4.0 |
| 20,000 | 200 | 4.8 MB | 10.8 MB | 1.8 / 3.4 / 23 |
| 1,000 | 2,000 | 2.0 MB | 2.5 MB | 0.22 / 0.52 / 8.5 |
| 5,000 | 2,000 | 10.2 MB | 11.9 MB | 0.50 / 0.80 / 40 |

Growth is linear at about 36 bytes plus the query length per admission, and the database keeps only the latest base, so the file tracks the document size. The mission controller sends long prompts (objective, scope, criteria and host observations, cut at 2,000), so autonomous cycles sit near the 2,000-character rows, not the chat rows.

Capture and forget churn (`MemoryDoc`, modeled by committing the same writes as capture, a capture receipt and a forget, one cycle per commit; not the capture task itself): about 325 bytes per cycle. After 10,000 cycles the document is 3.3 MB with 10,000 tombstones, 20,000 write-key receipts and 10,000 capture receipts. Commit p50 rose from 0.56 ms at 500 cycles to 11 ms at 10,000 (p95 16 ms), because forgetting scans every record. Receipts and capture receipts are never removed, so this growth is permanent until a retention rule exists.

Four lifetimes share one entry today (full map in beads `unit-dsh.4`):

1. Queued and placed provenance: from admission to run end. The entry must match the immutable `MemoryInputEntry` that capture trusts, and it rolls back with the submission.
2. Live recall query: from placement to run end. `memoryBeforeRequest` reads it on every provider attempt of that run.
3. Terminal replay identity: for as long as Durable dedupes the `requestId`, which is forever. A retry returns the same submission ID, and `recordMemoryInput` must still accept the same input and reject a different one.
4. Legacy bounded query check: the comparison uses the query cut to 2,000 code points, and entries already stored as full text must keep comparing by text.

Proposed cleanup, to be built only after the native cells below show it matters and after the admission and rollback owners agree:

- Two entry states. Active, `{origin, query}`, while the submission is queued or placed. Settled, `{origin, digest}`, once it is done or unanswered, where `digest` is the SHA-256 of the same bounded query. A settled entry is about 100 bytes instead of up to 2,000.
- Compaction runs inside `recordMemoryInput`, in the admission transaction: it reads the status of each active entry with `tx.submission(id)` and compacts the settled ones. No new task, scheduler or storage. The active set is only the queued plus placed submissions, so the reads are bounded by real pending work.
- A retry of a settled submission compares the digest (or the text, for a legacy full entry) and never re-adds text. Deleting the entry at settlement would be wrong: a crash retry would re-insert a full entry that nothing cleans up, and the conflict check would be lost.
- Do not rely on object key order for any eviction rule, and do not change `MemoryInputEntry`: it is the immutable transcript provenance.
- Optional, not proposed now: dropping the oldest settled identities beyond a cap. Durable keeps the submission record forever, so a dropped identity would only lose the check that a retry carries the same input; it never allows a second execution. At 20,000 settled admissions the identities cost about 2 MB, so a cap is not needed for the 512 MB target on this evidence. Decide with the admission owner.
- Rollout constraint: a document version bump with a migration cannot be read by the published 0.0.9 owner. An additive shape without a bump is readable by 0.0.9 but its `recordMemoryInput` throws "conflicts" when it retries a settled entry that has no `query`. Pick one with the rollback decision; do not choose here.

Retention of capture receipts and write-key receipts is a separate decision that needs the owner, because `forget` replay depends on them. This pass does not propose deleting them.
