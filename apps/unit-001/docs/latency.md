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
| `request-preparation.bench.ts` | Calling `Agent.ask()` through entry into the faux provider's response factory | The actual unit-001 coding tools and preamble, a 4,480-character prompt section, and one `beforeRequest` hook. Includes submission admission, scheduler work, intervening commits, context/prompt assembly, hook dispatch, and pi-ai/faux request setup. Excludes generation and final-answer persistence. |

The request metric is a composite response-path measurement, not an isolated measurement of prompt assembly or hook dispatch. Its assertions verify that the section and hook reach the provider request and that each run finishes successfully. In the warm case, the same conversation grows: measured requests have 5 through 29 earlier user/assistant exchanges after the five warmups. Cold requests have no earlier exchange. This is a short-session baseline, not a long-history scaling claim.

Automatic memory recall is not implemented. Its benchmark and any isolated memory prompt/hook benchmarks must arrive with those implementations, using representative memory counts and request shapes. Do not substitute a dummy recall operation or treat the composite request budget as a memory retrieval budget.

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
