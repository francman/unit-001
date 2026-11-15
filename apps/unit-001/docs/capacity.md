# Small-host capacity evidence

Use 1,000 retained memories as an initial operational review trigger, not an enforced limit or a proven VPS capacity. Disposable measurements found substantially higher latency at 10,000 records and memory pressure at 30,000. Native Ubuntu 24/x64 measurements remain required before promising a supported production capacity. No existing benchmark threshold changed.

Keep memories, replay receipts and forget tombstones until a reviewed retention policy can preserve replay safety. There is no automatic expiry or eviction. At the review trigger, inspect `agent memory stats`, back up closed state and evaluate a larger host or a storage redesign. Do not delete records merely to make a resource graph look healthy.

## November 15, 2026 UTC experiment

Each case ran in a fresh, disposable Docker container: x64 emulation on DockerDesktop's ARM Linux VM, Node 22.23.4, two CPUs, 412 MiB RAM plus a 1 GiB swap allowance, network disabled. The runtime was merged source `b74b87d309de3ac16441e64f1222ca48b4a147f1`; only the profiler and build/docs tooling were new. [Raw samples and compiled-file hashes](capacity/2026-11-15-emulated-x64.json) preserve the exact evidence. No production host, Actions or paid model was used.

| Records | Appended receipt commits | Process peak RSS MiB | Cgroup peak MiB | Open/read/close p95 ms | Warm owner startup maximum ms | Submit-to-provider p95 ms | Closed DB MiB |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 63 | 121.4 | 90.2 | 6.19 | 31.18 | 4.82 | 1.88 |
| 5,000 | 63 | 186.0 | 167.7 | 19.00 | 119.33 | 91.38 | 8.40 |
| 10,000 | 63 | 251.5 | 243.8 | 37.10 | 250.00 | 175.04 | 14.34 |
| 30,000 | 63 | 441.7 | 412.0 | 109.01 | 712.19 | 795.60 | 32.19 |
| 10,000 | 0 | 259.2 | 251.8 | 40.68 | 210.54 | 174.26 | 14.33 |

No case was OOM-killed. The 30,000-record case reached the 412 MiB cgroup limit and used approximately 120 MiB peak swap; its higher request latency includes that pressure. Shared pages and emulation mean process RSS and cgroup charging differ. Neither number alone proves a VPS memory margin. Disk bytes cover the closed synthetic database, not a forecast for long-lived transcripts, workspaces, backups or update archives.

Every memory contains approximately 500 characters and matches the same broad query. The seed is one real SQLite commit followed by 0 or 63 content-free receipt commits. The memory document checkpoints after a bounded delta interval; this exercises a long application-level receipt tail, not arbitrary unbounded Durable history. Each case performs 30 open/read/close cycles (five warmups), six owner opens on fresh closed copies, and 31 foreground faux requests (first request plus five warmups, 25 retained samples). Normal background memory maintenance remains enabled. Startup's five retained observations are reported as a maximum, not a reliable p95 estimate. Request/replay medians, MAD and every sample are in the JSON.

The process peak includes fixture creation and repeated reopen workloads; it is a conservative experiment peak, not steady-state owner allocation. The cgroup I/O counter includes writes, but Docker's virtual disk is not the production VPS SSD. The short 31-request transcript does not establish long-conversation capacity. The 0-versus-63 receipt-tail comparison did not produce a controlled CPU/storage benchmark; do not subtract the rows to infer an isolated replay cost.

## Reproduce and finish qualification

Build prerequisites with the reviewed model-data hydrator and `npm run build:offline`, then build `apps/unit-001`. In an isolated disposable host, invoke:

```bash
node apps/unit-001/scripts/profile-capacity.mjs --records 1000 --tail 63 --out result.json
```

Repeat in separate processes at representative sizes and record the host, CPU, effective memory/swap limits, Node version, source SHA and storage. Keep raw failed-run output and OOM counters. Run the unchanged original latency gates separately; this profiler deliberately does not replace them or raise their thresholds.

To close #64, repeat on a native disposable Ubuntu 24/x64 system with the target memory limit and real disk. Add long conversation/task histories and repeated reopen measurements across realistic memory mutations and checkpoint boundaries. Define an actual supported capacity from that evidence. Any bounded retention implementation must preserve durable receipts/tombstones and require explicit authority for destructive memory changes.
