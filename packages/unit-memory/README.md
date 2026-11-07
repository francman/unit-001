# unit-memory

Typed Pi Durable documents for unit-001 memory. The design contract is [the memory port specification](../../apps/unit-001/docs/memory/port-spec.md).

`MemoryDoc` stores one current session-wide value: working and episodic records, provenance, replay receipts, deletion tombstones, capture outcomes, and the active consolidation task. Every conversation and fork in the same Durable Session shares it; separate Session databases do not.

`MemoryInputsDoc` stores host recall queries and human/mission origin by submission ID. It belongs to one conversation and starts absent in a fork (`history: "latest"`, `fork: "initial"`). `MemoryInputEntry` gives the transcript the host's immutable origin marker. The host must admit inputs and write their metadata in the same commit.

This package currently provides document definitions and TypeScript contracts only. Mutation validation, replay enforcement, recall, capture, consolidation, and app admission wiring belong to issues #6–#9. Hosts must enforce the specification's content/query bounds and provenance rules; storing a typed record alone does not validate those rules at runtime.

Both documents begin at version 1 and checkpoint after 64 deltas. There is no earlier released schema to migrate. A future shape change must bump the version and provide a deterministic migration; persisted upgrade/rejection behavior is covered by SQLite fixture tests. Checkpoints bound replay depth, not total memory size. No memory latency budget is claimed by this foundation.

## Develop

From the repository root:

```bash
npm run build --workspace packages/unit-memory
npm run typecheck --workspace packages/unit-memory
```

From this package directory, run the focused tests:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/memory.test.ts test/inputs.test.ts
```

The tests use real temporary SQLite files and no provider calls. Upstream packages must be built before running against their default package exports.

The memory contract draws on concepts from [Mnemosyne at `bb854a5`](https://github.com/mnemosyne-oss/mnemosyne/tree/bb854a5b6539bcf640c5b83d7a5306d21fb7acf7) and [omp's mnemopi at `88a6958`](https://github.com/can1357/oh-my-pi/tree/88a69582c755bd000e8dc0290981fc787a4f400c/packages/mnemopi). This foundation does not copy their engine implementation. Preserve the applicable MIT notices if later slices copy or substantially adapt source, prompts, or tests, as specified in the port specification.
