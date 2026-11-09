# unit-memory

Persistent in-process memory for unit-001, built on public Pi Durable documents and tasks. The design contract is [the memory port specification](../../apps/unit-001/docs/memory/port-spec.md).

`MemoryDoc` stores one current session-wide value: working and episodic records, provenance, replay receipts, deletion tombstones, capture outcomes, and the active consolidation task. Every conversation and fork in the same Durable Session shares it; separate Session databases do not.

`MemoryInputsDoc` stores host recall queries and human/mission origin by submission ID. It belongs to one conversation and starts absent in a fork (`history: "latest"`, `fork: "initial"`). `MemoryInputEntry` gives the transcript the host's immutable origin marker. The host must admit inputs and write their metadata in the same commit.

`createMemoryExtension()` returns the registry extension, a host-owned `MemoryRecall` cache, and `close()` to release it. Select the extension on each agent. Its `remember`, `recall`, `forget`, and `stats` tools run locally without model calls. Mutations validate input and store replay receipts atomically with records; replaying a forgotten remember returns its original ID without restoring content. Forget also tombstones dependent summaries. Transcript history remains.

Recall uses whole Unicode words, identifier parts, and exact command flags. Empty or irrelevant queries return no records. Before each model request, the hook uses the current run's placed submission metadata and adds bounded, untrusted evidence to a request copy. It does not alter stored messages. Model-written memories retain agent authorship even if their source label says human; current host identity and runtime facts outrank stored claims.

Capture runs in conversation-owned background tasks after a short run-end dispatcher. It extracts only explicit remember statements and preference statements from host-marked human inputs. Mission inputs and assistant/tool output are excluded. Deterministic background consolidation retains source records and links summaries to source revisions. The host must reconcile memory tasks when opening the session and drain or quiesce them before closing storage for an update.

Host admission calls `conversation.submit(tx, draft)` before other table writes, sets `draft.entry` to `{ kind: MemoryInputEntry.kind, data: { origin } }`, then calls `recordMemoryInput(tx, conversationId, submissionId, origin, query)` in the same commit. Explicit operator mutations use `rememberMemory`/`forgetMemory` on the transaction's `MemoryDoc` draft. Pass immutable operator entry IDs as user provenance, then schedule consolidation inside that commit. Never open another SQLite writer.

A custom extension clock must match the Harness clock. Each recall cache belongs to one Harness and must be cleared when that owner closes.

After reconciliation, call `service.recall.prepare(await harness.snapshot(MemoryDoc, context))` before enabling scheduling or advertising owner readiness. This moves initial cold indexing into startup. Requests still revalidate current snapshots; receipt-only commits reuse Durable's structurally shared record map. This removes repeated indexing work without hiding startup cost.

Both documents begin at version 1 and checkpoint after 64 deltas. There is no earlier released schema to migrate. A future shape change must bump the version and provide a deterministic migration; persisted upgrade/rejection behavior is covered by SQLite fixture tests. Checkpoints bound replay depth, not total memory size. See [measured latency and capacity limits](../../apps/unit-001/docs/latency.md).

## Develop

From the repository root:

```bash
npm run build --workspace packages/unit-memory
npm run typecheck --workspace packages/unit-memory
```

From this package directory, run the focused tests:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/memory.test.ts test/inputs.test.ts test/operations.test.ts test/recall.test.ts test/injection.test.ts test/extension.test.ts test/capture.test.ts test/background.test.ts test/consolidation.test.ts
```

The tests use real temporary SQLite files and local faux providers; they make no paid or network provider calls. Upstream packages must be built before running against their default package exports.

The memory contract draws on concepts from [Mnemosyne at `bb854a5`](https://github.com/mnemosyne-oss/mnemosyne/tree/bb854a5b6539bcf640c5b83d7a5306d21fb7acf7) and [omp's mnemopi at `88a6958`](https://github.com/can1357/oh-my-pi/tree/88a69582c755bd000e8dc0290981fc787a4f400c/packages/mnemopi). This foundation does not copy their engine implementation. Preserve the applicable MIT notices if later slices copy or substantially adapt source, prompts, or tests, as specified in the port specification.
