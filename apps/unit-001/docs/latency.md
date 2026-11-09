# Latency baselines and budgets

`npm run bench --workspace apps/unit-001` typechecks and runs the standalone benchmarks in `bench/`. Any case whose measured p95 exceeds its fixed budget makes the command exit non-zero. No provider credentials, network requests, subprocess tools, or paid model calls are used by the measurements.

## Method

Each case discards five warmup measurements and retains 25 measurements. Output is JSON with the raw samples, median, nearest-rank p95, median absolute deviation (MAD), and normalized MAD noise (`1.4826 × MAD / median`). With 25 measurements, p95 is the 24th sorted value. Slow samples are never removed: MAD describes noise; the untrimmed p95 determines acceptance.

The approach follows omp's [LLM assembly benchmark](https://github.com/can1357/oh-my-pi/blob/88a69582c755bd000e8dc0290981fc787a4f400c/packages/coding-agent/bench/llm-assembly.bench.ts): separate workload setup from timing, distinguish fresh and reused state, and report robust statistics. This harness uses Node's `performance.now()` rather than Bun APIs and adds a p95 exit-code gate.

Cold means the first measured operation in a fresh SQLite database and freshly opened Harness. Creating the directory, opening storage, installing extensions, and opening the root conversation happen before timing. It does not mean a new Node process, cold JIT, or an uncached operating-system filesystem. Warm means repeated operations on one open fixture. Each case closes its Harness and removes its temporary database afterward.

## Measured paths

| Script | Timing window | Workload |
|---|---|---|
| `checkpoint-commit.bench.ts` | Entering `TaskRuntime.commit()` through its resolution | A real task replaces its checkpoint with a 4 KiB payload, including serialization, SQLite persistence, and publication. Creation of the task and its final completion are outside timing. The next phase verifies the committed payload. |
| `request-preparation.bench.ts` | Calling `Agent.ask()` through entry into the faux provider's response factory | The actual unit-001 coding tools and preamble, a 4,480-character prompt section, and one extra benchmark `beforeRequest` hook alongside default memory recall and durable capture bookkeeping. Includes submission admission, scheduler work, intervening commits, context/prompt assembly, hook dispatch, and pi-ai/faux request setup. Excludes generation and final-answer persistence. |

The request metric is a composite response-path measurement, not an isolated measurement of prompt assembly or hook dispatch. Its assertions verify that the section and hook reach the provider request and that each run finishes successfully. In the warm case, the same conversation grows: measured requests have 5 through 29 earlier user/assistant exchanges after the five warmups. Cold requests have no earlier exchange. This is a short-session baseline, not a long-history scaling claim.

Automatic memory recall has separate growth measurements below. The composite request budget is not a memory retrieval budget.

## Memory growth measurements

`node --conditions=source --experimental-strip-types apps/unit-001/bench/memory-recall.bench.ts` measures the actual memory index, evidence formatter, forgetting, and SQLite document commits without providers. Each record contains approximately 500 characters and matches the broad query `redis`. Cold starts with a new index over an existing in-memory document; warm reuses that index. Forget includes tombstoning a successive record and reconciling changed index postings. SQLite commits add a content-free receipt to the growing document. Setup and storage opening are outside timing. These are component measurements, excluding full request assembly, document replay on reopen, and network latency.

Independent verification on 2026-11-09, Apple M5 Pro, macOS arm64, Node v24.15.0, working branch `feat/durable-memory`:

| Records | Cold index + evidence p95 / budget ms | Warm recall + evidence p95 / budget ms | Forget + reconcile p95 / budget ms | SQLite receipt commit p95 / budget ms |
|---:|---:|---:|---:|---:|
| 100 | 0.750 / 2 | 0.067 / 1 | 0.060 / 2 | 0.144 / 2 |
| 1,000 | 5.921 / 20 | 0.142 / 2 | 0.236 / 20 | 0.471 / 5 |
| 10,000 | 66.681 / 200 | 1.120 / 10 | 3.362 / 200 | 3.008 / 20 |

Budgets were fixed before this verification run from calibration p95 values of 0.794/6.086/61.032 ms cold, 0.070/0.129/0.719 ms warm, 0.580/6.003/62.318 ms after forget, and 0.139/0.478/2.461 ms for receipt commits. Cold/rebuild budgets allow approximately three times the calibrated duration, rounded upward; warm/commit budgets leave additional scheduling headroom. They are provisional local regression guards, not a VPS or CI performance guarantee. The script emits all samples, MAD, and environment metadata and fails above each budget.

At 10,000 records the serialized document was 8.93 MB after 30 forget receipts, compared with 0.87 MB at 1,000. This is serialized state size, not process resident memory or SQLite file size. Checkpoints bound replay depth; records, receipts, tombstones and capture outcomes continue growing. Cold indexing remains proportional to live content. Revision reconciliation scans records and updates changed postings; broad warm queries still visit matching records. Ranking references and copying only selected evidence reduced the earlier 10,000-record warm p95 from approximately 42 ms to 1.12 ms. This does not establish constant-time retrieval or bounded total storage.

`memory-request.bench.ts` covers the complete `Agent.ask()` path through entry into the faux provider, asserting that retrieved evidence reaches the actual request. Its fixture has pending working memories, so default background consolidation runs concurrently; these results include that maintenance workload. It measures 25 requests after the first request and five warmups. It also measures 25 storage-open/first-document-read operations after five warmups. The database has a document checkpoint without a long delta tail; this does not measure worst-case replay. Before startup index preparation was added, fixed-budget verification on the same host produced:

| Records | Open + first snapshot p95 / budget ms | Submit-to-provider p95 / budget ms | First request ms (one observation) |
|---:|---:|---:|---:|
| 1,000 | 1.722 / 20 | 1.935 / 20 | 20.655 |
| 10,000 | 14.428 / 100 | 35.763 / 150 | 98.334 |

Budgets were fixed before verification from initial open/read p95 values of 2.53/15.79 ms and request p95 values of 2.07/34.86 ms, with conservative scheduling headroom. First-request observations are single measurements, not percentiles or acceptance guarantees. Network/provider generation remains excluded.

The owner now prepares its index before readiness and reuses the index across receipt-only document changes. The benchmark reports that startup work separately: five warmups and 25 measured `Agent.open()` calls, each on a fresh copy of the same closed seed database. Copying and closing are outside timing; opening SQLite, document replay, owner setup and index preparation are inside. Each copy may schedule normal background maintenance, and no faux provider calls occur during startup. Startup currently has no acceptance threshold. A subsequent measurement on the same host produced:

| Records | Owner open + replay + prepare p95 ms | Submit-to-provider p95 ms | First request ms (one observation) |
|---:|---:|---:|---:|
| 1,000 | 9.961 | 1.018 | 13.009 |
| 10,000 | 89.924 | 32.438 | 34.012 |

The existing request/read budgets remain unchanged. Preparation moves work from the first request into startup; it does not eliminate indexing cost. Background consolidation still contributes to this workload's request timings. Production SQLite WAL checkpoints remain enabled; periodic persistence stalls count in end-to-end samples rather than being removed as noise.

Run `node --expose-gc --conditions=source --experimental-strip-types apps/unit-001/bench/memory-request.bench.ts 10000` for a separate process with one fixture size. An earlier run, before startup preparation and its extra startup samples, observed RSS of 286 MB before requests, 501 MB afterward, and 461 MB after explicit garbage collection. RSS includes the process, storage replay, retained heap pages and background work; it is not memory-index allocation or a measured peak. The corresponding 1,000-record separate run observed 160/191/191 MB. These macOS measurements do not establish Linux capacity, and **10,000 memories are not guaranteed to fit the 512 MB VPS plan**. Linux/VPS latency and memory calibration, long replay tails and a total-storage retention policy remain outstanding.

## Unit-001 measurements

Measured on 2026-11-04 (America/New_York), Apple M5 Pro, macOS arm64, Node v24.15.0, source checkout `b3d18bcbf9844d4fd2ab9ee4ba5b89b953479123` plus the benchmark files in this change. All durations below are milliseconds.

| Case | Median | p95 | MAD | Normalized MAD noise | Budget |
|---|---:|---:|---:|---:|---:|
| Checkpoint, cold | 0.0915 | 0.1026 | 0.0043 | 7.0% | 2 |
| Checkpoint, warm | 0.0733 | 0.0905 | 0.0035 | 7.0% | 2 |
| Request preparation, cold | 0.8090 | 1.0649 | 0.0663 | 12.1% | 10 |
| Request preparation, warm | 0.4770 | 0.9796 | 0.0437 | 13.6% | 10 |

The fixed budgets were set before the verification run above: take ten times the greatest p95 in the initial calibration runs, then round up to a whole millisecond. Those maxima were 0.1292 ms for checkpoint commits and 0.9363 ms for request preparation, producing 2 ms and 10 ms. The headroom is deliberately conservative for shared-runner scheduling and differences between this host and CI. It does not establish a CI performance guarantee: these thresholds are provisional regression guards until measurements from the Linux CI runner are available. Preserve samples and host metadata when investigating a failure; change a budget only with new measurements and an explanation.

## Upstream Pi Durable baseline

Before adding the unit benchmarks, ran the existing full `bench:storage` script on this checkout. Then repeated the write/reopen cases below without another build or check running. The seed comes from Durable's public storage benchmark helpers: 1,000 entries, 300 tasks, 300 documents, document replay tails through 1,024 changes, and eight levels of conversation forks. Write cases use separate seeded storage per sample. Upstream uses Vitest/Tinybench statistics; these figures are its reported mean and p99, not this harness's median and p95.

```bash
npm run bench:storage --workspace packages/durable -- --run
npm run bench:storage --workspace packages/durable -- --run -t 'commit one entry|commit mixed entry/task/submission/document|reopen and first exact read'
npm run bench:scheduler-fanout --workspace packages/durable -- 250
```

| Upstream case | Backend | Mean ms | p99 ms | Samples |
|---|---|---:|---:|---:|
| Commit one entry | Memory | 0.0053 | 0.0238 | 20 |
| Commit one entry | SQLite | 0.0355 | 0.0579 | 20 |
| Commit one entry | JSONL | 0.1005 | 0.1229 | 20 |
| Commit mixed entry/task/submission/document | Memory | 0.0064 | 0.0216 | 20 |
| Commit mixed entry/task/submission/document | SQLite | 0.1625 | 0.2627 | 20 |
| Commit mixed entry/task/submission/document | JSONL | 0.3312 | 0.3922 | 20 |
| Reopen and first exact read | SQLite | 0.3249 | 0.4479 | 20 |
| Reopen and first exact read | JSONL | 45.5471 | 52.4437 | 20 |

The existing scheduler fan-out script completed 250 immediate nested tool calls in 66 ms over 767 commits (0.26 ms per nested call). That script reports one aggregate run, not a latency percentile or an enforced budget. These upstream results provide context; they are different workloads from the unit checkpoint and request benchmarks and cannot be subtracted to infer isolated component costs.

## Verification and remaining calibration

`test/latency.test.ts` checks that tail regressions remain visible even when median and MAD stay low, and launches a real Node process to verify exit code 1 above budget and exit code 0 exactly at budget. Unit latency CI already discovers the workspace's `bench` script, so no workflow changes are required.

The benchmarks and typecheck pass on Node 24. Node 22.19 compatibility uses the same source conditions and strip-only TypeScript invocation as Durable's own scripts; execution on Node 22 and Linux CI still needs verification. Disk behavior, virtualized runners, large histories, memory growth, provider network latency, and tool execution are outside this initial calibration. Establish separate representative workloads before making claims about those costs.
