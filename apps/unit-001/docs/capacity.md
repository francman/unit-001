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

Build prerequisites with the reviewed model-data hydrator and `npm run build:offline`, then build `apps/unit-001`. In an isolated disposable host, invoke one cell by hand:

```bash
node apps/unit-001/scripts/profile-capacity.mjs --records 1000 --tail 63 --out result.json
```

For the native run, use the matrix driver (next sections) rather than hand-run cells.

To measure relation-bearing state, keep the record count and tail fixed and run a separate process with an explicit relation count:

```bash
node apps/unit-001/scripts/profile-capacity.mjs --records 1000 --relations 999 --tail 63 --out relations.json
```

`--relations` defaults to zero and accepts up to `min(records - 1, 4096)`. The seed uses the public remember operation to link each of the first requested records after record zero to its predecessor with `supports`. This chain keeps endpoint degree at most two; it measures additional relation state without changing record content or query selectivity. Every storage replay checks the exact relation count and endpoint liveness before owner startup or background work can change the fixture. Those checks are included in replay timing. Reports identify the requested relation count and topology alongside the existing RSS, startup, replay, foreground and disk observations.

This workload does not establish dense-graph, relation-only retrieval, relation mutation or checkpoint-boundary capacity. All records still match the same lexical query, and background maintenance remains enabled during owner measurements. Process peak RSS includes seed construction and verification. Compare repeated separate-process runs on the same host; a single subtraction does not isolate relation allocation or CPU cost. The November 15 evidence above predates this option and contains no seeded relations. Local Mac smoke checks validate the harness only; they do not qualify a 512 MB native Linux host.

Repeat in separate processes at representative sizes and record the host, CPU, effective memory/swap limits, Node version, source SHA and storage. Keep raw failed-run output and OOM counters. Run the unchanged original latency gates separately; this profiler deliberately does not replace them or raise their thresholds.

To close #64, repeat on a native disposable Ubuntu 24/x64 system with the target memory limit and real disk. Add long conversation/task histories and repeated reopen measurements across realistic memory mutations and checkpoint boundaries. Define an actual supported capacity from that evidence. Any bounded retention implementation must preserve durable receipts/tombstones and require explicit authority for destructive memory changes.

## Profiler options (result `schemaVersion` 2)

Defaults reproduce the earlier behavior: phases `seed,replay,startup,foreground`, no mutation, `--sample-ms 250`. Version 2 keeps every version 1 field and adds the ones below.

| Option | Meaning |
|---|---|
| `--phases a,b` | Any of `seed`, `replay`, `startup`, `foreground`, `mutate` or the opt-in phases below; always run in profiler order. With `--mutate`, only `seed,mutate` (fresh fixture) or `mutate` (`--reuse`) is allowed. |
| `--keep DIR` | With `seed`, publish a closed baseline, or with `grow`, publish a closed grown copy. Writes `DIR/fixture.json` only after close. `DIR` must not already hold a fixture. |
| `--reuse DIR` | Copy the closed `DIR/state.sqlite` into a disposable directory, or into a new `--keep` directory for `grow`. A conflicting fixture flag or an unflushed WAL is refused. |
| `--forgotten N` | Forget `N` seeded records (taken from the top, so no relation breaks) in one commit before the receipt tail. Replay checks total records (tombstones included) and live records. |
| `--topology chain\|dense` | `chain` is the earlier workload. `dense` makes `ceil(relations / 32)` hub records, each with the maximum degree 32, and one relation per spoke record; it needs `hubs + relations <= records`. |
| `--mutate remember-heavy\|forget-heavy\|mixed` | Phase `mutate`: one session issues remember, forget and recall (`mixed` is 60/20/20, fixed seed). Needs `--duration-s N` and/or `--mutate-ops N`; `--mutate-interval-ms` paces operations (default 1000, 0 is flat out). Reports per-operation latency, max RSS after each operation, base-revision changes seen (`checkpoints`, any document), then closes and reopens ten times asserting exact counts. |
| `--background-burst N` | Run `seed,background` (fresh) or `background` (`--reuse` a closed quiescent baseline). `N` is the number of statements in one live learning turn (100–500); `--background-pairs N` repeats the idle/active pair (1–30, default 5). No growth, mutation, startup or ordinary foreground phases run on the benchmark copies. |
| `--sample-ms N` | Sampler interval, 0 disables. |

With `--mutate` and no `--phases`, the profiler selects the applicable mutation-only workload. Foreground requests can write memory records and move the checkpoint boundary, so run owner measurements separately from mutation. For example, to exercise the tail-62 boundary without owner activity:

```bash
node apps/unit-001/scripts/profile-capacity.mjs --records 1000 --tail 62 --mutate remember-heavy --mutate-ops 3 --mutate-interval-ms 0 --out mutation.json
```

Evidence fields: `status` (`running`, `complete`, `failed`, `interrupted`), `host` (including `oomScoreAdj`, the result of raising the profiler's own OOM score to 1000 on Linux), `phases[].proc` and `phases[].cgroup`, `samples`, `diskPhases`. The result file is rewritten atomically at every phase start and end, so a run killed by the OOM killer leaves `status: "running"` and the phase it died in (`currentPhase`) instead of nothing. SIGTERM and SIGINT write `interrupted`.

- `samples`: `{t, phase, rss, heapUsed, external, arrayBuffers}` plus, when available on Linux, `vmRSS`, `rssAnon`, `rssFile`, `rssShmem`, `vmSwap`, `cgroupCurrent` and untagged `vmHWM`. Synchronous work can delay the sampler and hide short spikes. `peakRss` and `proc.vmHWM` are process high-water marks; `cgroup.memory.peak` is the cgroup high-water mark. They are read at phase boundaries, not reset for each phase. A higher reading means a new high was reached since the previous read; an unchanged reading does not measure the intervening phase's peak.
- `diskPhases`: at seed (writer open and closed), replay, startup, foreground (owner open and closed), mutate and the end: sizes of `state.sqlite`, `-wal` and `-shm` (`null` when absent), directory bytes, `statfs` (free/available bytes, plus mount point and filesystem type on Linux, so tmpfs is visible), and a read-only second connection reporting `journal_mode`, `page_size`, `page_count`, `freelist_count`, `document_revisions` rows and bytes by kind (`base` rows are checkpoints) and the `entries` row count.
- Linux-only readers (`/proc/self/status`, `/proc/meminfo`, `/proc/self/mountinfo`, cgroup files) report `"unavailable"` or are omitted on other platforms; none can throw.

Use a separate process per measurement. `--keep` then `--reuse` gives a measurement process whose peak excludes fixture construction. For an owner-only run use `--reuse DIR --phases startup,foreground`; replay's 30 reopens are excluded, not subtracted.

Set `TMPDIR` to a directory on the real data volume: `os.tmpdir()` is often tmpfs on Ubuntu, which hides disk behavior and charges the fixture to memory. `diskPhases[].filesystem.fsType` records what was used.

### Disk and WAL

The Durable Node SQLite adapter (`packages/chord/src/sqlite/node.ts`) opens every database with `journal_mode=WAL`, `synchronous=NORMAL` and `wal_autocheckpoint=1000` pages, and `close()` runs `wal_checkpoint(TRUNCATE)`. So the `-wal` file is a real quantity while a database is open (a 50-record fixture reached 4 MB during 31 faux requests on Darwin) and is zero after a clean close. Measure it at the `*-open` disk phases; the closed-storage numbers undercount a running owner. A killed process leaves the WAL behind.

## Matrix driver

`apps/unit-001/scripts/run-capacity-matrix.mjs` runs the cells in `apps/unit-001/scripts/capacity-matrix.default.json`. The shipped matrix is the research-64 list scaled to the target host `unit-001-herdr`, which has 412 MB RAM plus 1 GB swap. That is stricter than the 512 MB target, so every result is labeled `hostClass: "412 MB host (stricter than the 512 MB target)"` in `manifest.json` and in each cell file; do not quote these numbers as 512 MB results.

Problem: a cgroup limit above physical RAM never binds first. With `MemoryMax=512M` on a 412 MB host the kernel would reclaim sshd, journald and the existing agent before it killed the profiler, and the evidence would still say "limit enforced". Solution: the shipped limits are `MemoryMax=224M`, `MemoryHigh=200M` and, for swap cells, `MemorySwapMax=256M`, which leaves about 190 MB of physical RAM for the kernel, sshd and systemd. The existing agent must be stopped for a run (the preflight below refuses otherwise). Baseline is 1,000 records, no relations, tail 63. Records 1,000 to 10,000 run at swap 0 and 256M. The relation (0/1,000/4,096 and dense 4,096), tail (0/32/63), tombstone (25% and 50%), mutation (remember-heavy, forget-heavy, mixed, 300 s; plus the checkpoint-boundary run) and `--max-old-space-size=156` (70% of the limit) cells use 5,000 records, because 10,000 records already peaks near 244 MiB in the November 15 experiment and would only measure the limit. Expect the 10,000-record cells to hit `MemoryMax=224M`: that is the measured result for this host. Cells the host cannot hold or enforce safely (20,000 and 30,000 records, and 40,000) and cells the harness cannot run yet are in the file with a `disabled` reason and appear as `skipped` results; `--only` runs one anyway, for a larger host.

```bash
export TMPDIR=/var/tmp/unit-capacity      # root-owned, on the data volume, not tmpfs
node apps/unit-001/scripts/run-capacity-matrix.mjs --out-dir results/native-1 --tmpdir "$TMPDIR" --require-scope --dry-run   # review commands and the preflight
node apps/unit-001/scripts/run-capacity-matrix.mjs --out-dir results/native-1 --tmpdir "$TMPDIR" --require-scope
node apps/unit-001/scripts/run-capacity-matrix.mjs --out-dir results/native-1 --only 'records-5000-*' --repeat 5   # variance runs
```

Options: `--matrix FILE`, `--only ID[,ID...]` (`*` is the only wildcard; an explicit match also runs a disabled cell), `--repeat N`, `--scope auto|system|user|none`, `--require-scope`, `--keep-fixtures`, `--step-timeout-s N`, `--reserve-mb N` (default 64), `--min-free-disk-mb N` (default 2048), `--allow-overcommit`, `--meminfo FILE` (read memory facts from FILE instead of `/proc/meminfo`; used by the tests) and `--dry-run`. A matrix cell takes `records`, `relations`, `topology`, `tail`, `forgotten`, `mutate`, `durationS`, `mutateOps`, `mutateIntervalMs`, `memoryMax`, `memoryHigh`, `swapMax`, `nodeArgs`, `repeat`, `split` (default true), `seedUnderLimit` (default true) and `disabled`. The matrix may also carry a `hostClass` label that the driver copies into the evidence.

### Safety checks

The driver runs as root on the host and executes whatever the matrix and the repository say, so it checks before it starts anything:

- Preflight (Linux). It reads `MemTotal`, `MemAvailable` and `SwapFree`, the free space and filesystem type of the work directory, and refuses with exit 2 when a runnable cell has `memoryMax` at or above `MemTotal`, or above `MemAvailable` minus `--reserve-mb`; when `swapMax` exceeds free swap; when the work directory has less than `--min-free-disk-mb` free; or when it is on tmpfs or ramfs. It runs before any file is created. Example: on the host with the existing agent running, `MemAvailable` is about 223 MiB, so `MemoryMax=224M` is refused. Stopping the agent frees its memory, but the real `MemAvailable` after the stop has not been measured: confirm with `--dry-run` on the host, and lower the matrix limits if the preflight still refuses. `--allow-overcommit` runs anyway, prints the problems, and records `limit.reachable: false` on each affected step and `limits.reachable: false` on the cell. The preflight result (facts, problems, unreachable cells) is in `manifest.json` under `preflight`; `--dry-run` prints it as its first line.
- OOM priority. The profiler writes `1000` to `/proc/self/oom_score_adj` before it allocates (an unprivileged process may raise its own score), so the kernel picks it before sshd or journald. The result is recorded in `host.oomScoreAdj`.
- Signals. SIGINT, SIGTERM and SIGHUP stop the running step (SIGTERM, then SIGKILL after 10 s; a second signal kills at once), remove the fixtures and the run directory, mark the cell `interrupted`, write `interrupted` into the manifest and exit 130, 143 or 129. A dropped ssh session therefore does not leave a profiler running under its scope. For a long run, start the driver as a transient service (`systemd-run --unit=capacity-driver --collect ...`) and use `systemctl stop` as the kill switch.
- Private directories. Fixtures live in a fresh `unit-capacity-run-XXXXXX` directory (mode 0700) created inside `--tmpdir` (default the system temporary directory). A `--tmpdir` must be a directory that is either sticky (`/var/tmp`) or owned by the caller and not group/world-writable. `--out-dir` is refused if it is a symlink, owned by someone else, or writable by group or others. Temporary result files are removed and recreated exclusively, so a planted symlink is never written through. The profiler also refuses a symlinked `--keep`.
- Root and repository code. When the driver runs as root on Linux it refuses to start unless the scripts directory, the profiler and its background module, the matrix file, `dist/` and `dist/agent.js` are owned by root and not writable by group or others. Install them under a root-owned directory such as `/opt/unit-acceptance/capacity`, not into an account's home. The check does not cover `node_modules`; install it root-owned too. As root the driver also skips `git`, because repository config and hooks are code.
- Child environment. Profiler children, the journal reads and the host probes get only `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and their own `TMPDIR`. Shell credentials and `NODE_OPTIONS` are not passed.
- Matrix validation. A matrix file is code. Cell ids must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; numeric fields must be numbers; `topology` and `mutate` must be known values; `memoryMax` must be a size such as `224M`, `memoryHigh` and `swapMax` a size or `infinity`; `nodeArgs` may only be `--max-old-space-size=N` or `--max-semi-space-size=N`. An invalid matrix exits 2 before anything runs. Still keep matrix files root-owned on the host.
- Dry run. `--dry-run` probes no scope, starts no unit and runs no `git`; with `--scope auto` it names the scope it would try. The real scope probe and every `systemd-run` command pass `--no-ask-password`, so a non-root run fails fast instead of waiting 30 s for a polkit prompt.

By default each cell runs a seed process (`--keep`) and a measurement process (`--reuse`), so the measurement peak excludes seed construction. Ordinary cells measure replay, startup and foreground; cells with `mutate` measure only mutation and its exact-count reopen checks. `split: false` runs seed and the chosen workload in one process. When limits are configured, measurement and (by default) split seed steps run under `systemd-run [--user] --scope --unit=capacity-... -p MemoryMax -p MemoryHigh -p MemorySwapMax`.

Scope selection: with `--scope auto` the driver tries a user scope, then a system scope (system only when root), and accepts one only if a probe inside it reads back `memory.max` equal to the requested value. When no scope passes, the driver warns and labels results unlimited; `--require-scope` exits 2 instead. Each step's `limit.verified` compares every explicitly requested limit (`memory.max`, `memory.high`, `memory.swap.max`) with the profiler's readback. Under `--require-scope`, a missing or mismatched readback fails the step. `--dry-run --scope user` prints the command without starting a scope, even off Linux.

Output in `--out-dir`: `manifest.json` (host class, matrix hash, git SHA, branch and dirty-file count, sha256 of `dist/agent.js`, scope decision, preflight, host facts, cell list; rewritten after each cell), one `<cell>.json` per cell (or `<cell>.rN.json` with repeats), and `raw/` with each step's profiler JSON and combined stdout/stderr log. A cell file holds the resolved cell, host (`uname`, `lscpu`, `free -b`, `swapon --show`, `df -B1`, `findmnt`, cgroup filesystem type, `/proc/meminfo`, swappiness), git, limits, and per step: command, exit code, signal, timeout flag, duration, the profiler result, the last cgroup snapshot read while the process ran (`memory.events`, `memory.peak`, swap peak and so on, polled every 200 ms because an OOM-killed scope vanishes with its process), stderr tail and `oom`.

Cell `status` is `complete`, `failed`, `timeout`, `oom-killed`, `interrupted` or `skipped`; a seed step that fails or times out reports `failed-in-seed` or `timeout-in-seed`, and the measurement step is not run. `oom.suspected` is set when any of these hold, with the reasons listed: the process died by SIGKILL (exit 137), the last observed or final `memory.events` shows `oom_kill`, or the kernel log has OOM lines that name this step's scope. The kernel log is read best-effort with `journalctl -k` (then the unit's journal), and a line counts only if it names the step's `capacity-*.scope` (or its observed cgroup path), for example `oom_memcg=` or `task_memcg=`. OOM lines about other processes (the existing agent, journald, sshd) are only counted, in `oom.kernel.unrelatedOomLines`, so they cannot turn a cell into `oom-killed`. There is no `dmesg` fallback: it cannot be limited to the step's time window, so one old OOM line since boot would mark every later cell. Missing privileges are recorded under `oom.kernel.sources`, not hidden. A SIGKILL alone is a suspicion, not proof; check `memory.events` and the kernel lines before calling a cell an OOM. The driver exits 1 if any cell is not `complete` or `skipped`.

Suggested order, from research-64: validate the driver on a native arm64 or larger x86-64 Linux host (numbers are not transferable; use a matrix with larger limits there), then run the shipped 412 MB matrix on `unit-001-herdr` with the existing agent stopped. A cgroup `MemoryMax` does not include the 60 to 100 MB of kernel and userland a real VM loses, so a result from the 412 MB host is stricter than the 512 MB target and must be labeled as a 412 MB result. Provisioning needs explicit owner authorization.

## Native results

Measured on 2026-11-21 on the disposable host (EC2, Ubuntu 24.04, kernel 7.0.0-1017-aws, systemd 255, x86-64, Xeon Platinum 8259CL, 2 vCPUs, 412 MB RAM plus 1 GB swap, ext4 on the root disk, existing agent stopped), with the pinned Node 24.22.2 runtime and the driver above under `--require-scope` (every step: `limit.verified: true`). Source `edfa9d08` plus a dirty tree. **This is a 412 MB host, stricter than the 512 MB target; do not quote it as a 512 MB result.** The shipped 224M limit was refused by the preflight (`MemAvailable` was about 216 MiB with the agent stopped), so the run used `MemoryMax=144M`, `MemoryHigh=129M` (same 224/200 ratio), swap 0 or 256M. Anything above 4,000 records at swap 0 therefore failed at a 144 MiB cgroup, not at 412 MB.

Seed, replay and startup are measured separately from the foreground requests. Records are about 500 characters; every record matches the same query. Swap 0 is pass/fail; `anon+swap` is the process's anonymous memory plus its swapped pages (the part that grows with records); a cgroup also charges about 50 MiB of file-backed runtime and cache.

| Records | Swap | anon+swap MiB | Cgroup peak MiB | Replay p95 ms | Owner start first / warm p95 ms | Request median / p95 ms | DB / WAL open MiB | Result |
|---:|---|---:|---:|---:|---:|---:|---:|---|
| 1,000 | 0 | 67 | 79 | 15 | 107 / 75 | 5 / 13 | 2 / 4 | pass |
| 2,500 | 0 | 83 | 128 (5 runs: 112 to 128) | 27 (26 to 28) | 211 / 130 | 7 / 296 | 4 / 5 | pass |
| 3,000 | 0 | 83 | 121 | 27 | 225 / 153 | 9 / 330 | 5 / 6 | pass |
| 3,500 | 0 | 95 | 129 (throttled) | 34 | 249 / 179 | 14 / 429 | 6 / 6 | pass |
| 4,000 | 0 | 99 | 129 (throttled) | 38 | 267 / 199 | 31 / 495 | 7 / 7 | pass |
| 5,000 | 0 | | 144 | 41 | 346 / 258 | | | OOM-killed in the request phase |
| 5,000 | 256M | 99 | 129, swap 36 | 41 | 330 / 258 | 607 / 694 | 8 / 10 | completes, swapping |
| 7,500 | 256M | 118 | 129, swap 104 | 68 | 1,299 / 2,897 | 992 / 1,231 | 12 / 14 | completes, swapping |
| 10,000 | 0 | | 144 | 85 | 1,685 / 47,949 | | | OOM-killed in the request phase |
| 10,000 | 256M | 126 | 129, swap 146 | 85 | 1,884 / 3,701 | 1,410 / 1,561 | 14 / 16 | completes, swapping |

- Memory: anon+swap is about 65 MiB plus 6.5 MiB per 1,000 records (1,000 to 10,000). The peak is reached in the request phase, not in replay or startup. For a 512 MB host (about 100 MB more RAM) the same fit predicts a cgroup of roughly 175 MiB at 10,000 records; that is an extrapolation, not a measurement, because no run here had more than 144 MiB.
- Knee on this host: memory pressure starts at about 3,500 records (`MemoryHigh` throttling, 95 events), swap-0 survival ends between 4,000 and 5,000, and past 5,000 swap makes startup and requests seconds slow. The 20,000-record swap-0 seed was OOM-killed.
- Interactive: request median stays under 10 ms to 3,000 records, but p95 is 13 ms at 1,000 records, 17 ms at 1,250 live, 188 ms at 1,875 live and 296 ms at 2,500. The existing 150 ms request budget (latency.md) is therefore exceeded from roughly 1,900 live records on this host; memory is not the cause (those cells peaked at 93 MiB). No threshold was changed.
- Startup (replay plus owner open): replay p95 15, 27, 38, 85 ms at 1,000, 2,500, 4,000, 10,000 records; owner start 107, 211, 267 ms first and 75, 130, 199 ms warm p95 at 1,000, 2,500, 4,000 (swap 0).
- Receipt tail 0, 32, 63 at 2,500 records: no difference (replay p95 27, 26, 26 ms).
- Relations: chain 0, 1,000, 2,499 at 2,500 records: replay p95 27, 34, 41 ms. At 5,000 records with swap 256M, 0, 1,000, 4,096 and dense 4,096 relations: replay p95 43, 48, 73, 72 ms and swap 42, 41, 69, 56 MiB, so the 4,096 cap costs about 70% more replay.
- Tombstones: forgetting half of 2,500 records cut anon memory from 83 to 67 MiB and request p95 from 296 to 17 ms, but left replay p95 unchanged (25 ms). Forgetting a quarter gave 188 ms.
- Mutation (historical, contaminated fixture): foreground added about 490 records to the 2,500-record seed. The run recorded remember median 7 ms, p95 17 ms; forget 24 and 47 ms; recall 4 and 7 ms; checkpoint commits 68 to 729 ms. Cgroup peak 113 to 120 MiB, process peak RSS 153 to 159 MiB, database 4.5 MiB, WAL empty after close. The exact-count reopen check failed; these timings are not isolated mutation capacity evidence.
- Disk: database 2 MiB at 1,000 records and 14 MiB at 10,000; the open `-wal` was 4 to 16 MiB. Disk is not the constraint (10 GiB free). Workspaces, transcripts and backups were not measured.
- Background work was not separated in this historical run. Foreground p95 is not an estimate of capture or consolidation time.

Recommendation for the 512 MB target (measured on a 412 MB host with a 144 MiB cgroup, so conservative on memory; the interactive result is not memory-bound and carries over):

- Supported: up to 1,250 live memories and 2,500 retained records including tombstones. Every measured gate passes there: request p95 at most 17 ms, replay p95 about 25 ms, owner start under 0.25 s.
- Review band: 1,250 to 4,000 retained records. It runs without swap at 144 MiB, but request p95 passes the 150 ms budget. Keep 1,000 live as the early warning.
- Not supported: 5,000 retained records and above. At swap 0 and 144 MiB they are OOM-killed; a 512 MB host may hold more, but no run measured it.
- Retention: no automatic deletion. Tombstones are cheap in memory but not in replay. Capture outcomes and write-key receipts were not measured over long use; do not design eviction from this run.

The historical checkpoint-boundary cell did not hit its seeded boundary after foreground writes. The harness now runs mutation without replay or owner phases; isolated mutation still needs a native rerun. Raw evidence from the historical run: `evidence-64/` in the working scratchpad (201 files with sha256), not committed.

## What is still unmeasured

Harness gaps (research-64 spec items not implemented):

- General conversation and task histories (item 6): the old `transcript-*` cells remain disabled. The opt-in matrix below measures one root with settled no-learning chat; it does not model task or mission history.
- Controlled tail position (item 4): there is no `--checkpoints C` or `--tail-offset`. The boundary cell reaches a checkpoint through `--tail 62` plus mutations, and `mutate` reports base-revision changes it saw; it does not drive many full checkpoint cycles before the tail.
- Background isolation (item 8): the [paired faux-owner workload](#isolated-background-work) is available locally; no native background timings have been collected. `mutate` and the growth fixtures bypass the owner's capture and consolidation tasks.
- Mutation runs commit directly through the memory operations on one session, not through a tool call in a running owner.
- Every record is about 500 characters and matches the same query, so recall selectivity is unrealistic.

Not covered by the native results: workspaces, backups, update archives, capture outcomes and write-key receipts growth under long use, and any real provider latency.

Everything measured on Darwin or in an emulated or arm64 container validates the harness only. The native run above is the only x86-64 evidence; it comes from a 412 MB host and no 512 MB host has been measured.

## Isolated input and receipt growth fixtures

The native run did not cover growth of `MemoryInputsDoc` (one entry per admitted submission, never removed) or of capture and write-key receipts under long use. A local Darwin baseline is in [memory.md](memory.md#input-metadata-growth-measured-baseline-and-proposed-cleanup-design-only-nothing-implemented): about 36 bytes plus the query length per admission (10.2 MB at 5,000 admissions of 2,000 characters), and about 325 bytes per capture, remember and forget cycle (3.3 MB at 10,000 cycles). Those numbers size the cells; they are not capacity evidence.

`apps/unit-001/scripts/capacity-matrix.growth.json` is an opt-in run card, not a qualification result or authorization to run a host. The default matrix is unchanged. For a cheap local control run according to the same shape:

```bash
node apps/unit-001/scripts/run-capacity-matrix.mjs \
  --matrix apps/unit-001/scripts/capacity-matrix.growth.json \
  --only control --scope none --out-dir results/growth-control
```

Growth cells accept `settledTurns` (0–20,000) with `queryChars` (40–2,000 ASCII characters per positive turn), or `captureCycles` (0–30,000). The common zero-growth control represents both arms. The candidate matrix uses 1,000 live `redis` records, no relations or preexisting tombstones, and 63 distinct receipt-tail commits. The seed creates the normal Durable root without an owner, initializes empty input metadata, and marks working records consolidated without summary links to remove background backlog without disabling recall.

- **Settled chat:** one Durable commit appends numbered neutral user text and a fixed answer, creates and settles the unkeyed input, and records its recall query. Reopen checks every submission, metadata row and raw transcript pair, including the first and last IDs. It also checks that memory and write receipts are unchanged and that there are no capture receipts or tasks. This is settled storage shape, not scheduler throughput or keyed-send receipt growth.
- **Capture/forget:** one Durable commit remembers a fixed candidate, records a synthetic completed capture receipt, then forgets that memory in the same transaction using the separate relations document. Reopen checks one content-free tombstone, one completed capture receipt and two write receipts per cycle without changing live records, relations, or chat. First/last remember and forget keys are retried on a throwaway copy; they must return their original results and not resurrect or recall the forgotten candidate. This does not drive the live capture task or model its commit count.

Comparable cells share a single closed baseline within a repetition. The writer starts on a copy and publishes a new closed artifact; exact checks, replay, owner startup and the request probe run in separate processes on copies of that artifact. No `foreground` or `mutate` step runs on it. Standalone equivalent: `--quiescent --keep BASE` seeds; `--reuse BASE --keep GROWN --phases grow` accepts `--settled-turns N [--query-chars L]` or `--capture-cycles N`. Use `--reuse GROWN --phases fixture-check`, `replay`, `startup` or `probe`, one phase per process.

- `fixture-open-snapshots`: SQLite open plus `unit.memory`, `unit.memory.relations` and `unit.memory.inputs` snapshots (25 retained samples after 5 warmups). Close, history scans and count checks are outside this timer. `owner-startup` has the first and five warm opens on fresh copies.
- `fixture-submit-to-chat`: first `redis` submission, five warmups and 25 retained samples. Each submission starts with a fresh copy of the same grown root. The timer stops at the chat callback, not at a Durable compaction callback. Compaction calls and their elapsed times are reported separately; blocking compaction remains part of chat latency. The callback checks retrieved seed evidence without serializing the request. All 31 submissions must settle with answers. The final probe's open and closed disk snapshots are labeled separately from the grown fixture.
- `fixture-commits` and `operationLog`: a line per commit (including past 5,000), with latency and a checkpoint flag for the relevant document. The report gives untrimmed nearest-rank p95 and max for ordinary commits, checkpoints, and the last up to 1,000 operations. The timer excludes the SQL probe and log writes. `diskPhases[].sqlite.revisionsByDocument` shows byte lengths and latest sequence by document kind, revision kind, and version; use the current `base` and `delta` rows to compare tail positions. `entryBytes` tracks serialized transcript rows separately.

For an authorized native run, review the candidate on pinned Node 24.22.2, Ubuntu 24/x64, SSD-backed `TMPDIR`, with `--require-scope --dry-run` first. Do not override preflight. Keep the exact matrix, source, build/script hashes and all raw results; use five sequential blocks with rotated arm order (one driver invocation per block, with a reviewed matrix ordering for each). Treat missing scope limits, swap, OOM, timeouts or failed invariants as non-passing; distinguish invalid runs from attributable capacity failures. Compare each repetition against the zero control using the proposed 100 ms replay and 150 ms request p95 screens, and report throttling, headroom, startup, checkpoint maxima and disk growth independently. These are not changes to [latency gates](latency.md); no native measurements for these growth cells have been made.

## Isolated background work

Run after the build prerequisites above; no live service, systemd, provider credentials or network are needed. For a local smoke run:

```bash
node apps/unit-001/scripts/profile-capacity.mjs \
  --records 1000 --tail 63 --background-burst 250 --background-pairs 5 --out /tmp/capacity-background.json
```

To exclude seed allocation from the measurement process, first use `--records 1000 --tail 63 --quiescent --keep BASE --out SEED.json`, then `--reuse BASE --background-burst 250 --background-pairs 5 --out RESULT.json`. `BASE` must be a closed quiescent seed, not a grown artifact. The baseline is never opened by the owner. Each arm gets its own copy, owner and faux provider. Order alternates, starting idle-first; odd pair counts give idle-first one extra turn. No warm-up pair is discarded, so the first arm can still pay initialization and cache costs. Use even planned pair counts for native comparisons and report the realized order of the qualifying pairs. No default matrix cells or latency gates change.

Both arms start with the same quiescent `redis` recall anchors, submit the same learning prompt through the owner, and wait for the triggering foreground run to drain. The actual run-end hook dispatches a durable capture task. Capture writes the distinct human statements and schedules real consolidation. Both arms then issue the same neutral `redis` probe and require the same foreground history shape and seeded recall evidence. The probe targets the seeded anchors, not the newly captured statements; it can see index changes but does not measure recall of the larger learned set.

- **Active:** wait for the first durable consolidation `running` record. This is consolidation overlap only; capture has already finished. A pair qualifies if the active probe submits before consolidation sleeps and either the faux callback occurs before sleep or a durable publication occurs between submission and callback.
- **Idle:** wait until consolidation persists its first sleeping checkpoint; then submit. This is a quiescent control at the end of the same burst, not a disabled-maintenance run.

Each verified pair is written to the result JSON as an `owner-background-pair` record before the next pair starts. A missed overlap window leaves a full `windowMissed: true` record and does not stop later pairs. The `owner-background` summary counts valid pairs and overlap misses; its arm distributions and active-minus-idle submit-to-faux deltas use only qualifying pairs. If none qualify, the step exits nonzero with `background.failure: "no-overlap"` and the raw pairs are still available. Failed assertions (`"invariant"`), arm deadlines (`"timeout"`) and other errors (`"execution"`) stop the step, preserving previously checkpointed pairs. A sudden process kill can lose the in-progress pair but not earlier checkpoints. A miss is not a failed durable-state check or evidence of OOM, and its timings do not measure active-versus-idle overlap.

Pair records separate owner open (including SQLite open), trigger foreground, probe submit-to-faux and submit-to-settled, and both tasks' queue and run time. Queue time runs from the first observed task write to the first `running` write; run time starts there and ends at capture terminal or consolidation sleep. Consolidation also reports each publication and time to first publication. Task timestamps are offsets from trigger submission; the observer timestamps entry to Durable's adoption callback, after SQLite `COMMIT` returns and before in-memory adoption. It does not hold tasks or change writes. Wall times include scheduler and storage waits, not task CPU time. The probe can see a different memory/index revision in each arm. Do not attribute background time by subtracting foreground quantiles. The arm's timed workload has a 30-second deadline.

Resource samples carry `pair` and `arm`. Direct `milestone` samples are taken before copying, after owner open, before the probe timer starts, at quiescence, after owner close and after reopen verification and cleanup, even with `--sample-ms 0`. They show current process `rss` and, when available, Linux anonymous RSS and swap (`rssAnon`, `vmSwap`), `cgroupCurrent` and `cgroupSwapCurrent`. These are readings taken during each arm, not memory owned by the arm. Both arms share the process and cgroup; retained heap and filesystem cache from earlier work can carry over, and the cgroup can charge the copy's page cache. The samples can miss transient spikes and the before-probe read is outside the probe timer but can affect the observed window. Process and cgroup high-water marks cover the whole process or cgroup, never a single arm.

Close and reopen checks require both answered submissions, one completed learning capture with exact source entry and write receipts, and published summaries with pinned source revisions. Concurrent publication entries can cause the neutral probe's run-end hook to dispatch an extra empty capture; if present, it must complete without adding memories and is reported separately. The last planned pair has open and closed SQLite/WAL snapshots for each arm, taken after the timed work; these are not peak WAL measurements. A fresh consolidation backlog of at least 100 processes batches of 50 until fewer than 100 young records remain: for 250 statements that means 4 publication batches, 200 consolidated sources and 50 pending at sleep. The run does not wait for age-based wakeup, measure cross-conversation relation publication, deep transcript compaction, multi-page capture, sustained background churn, or a real model.

For the matrix driver, add `backgroundBurst` and optionally `backgroundPairs` to an opt-in cell with `records`, `tail` and reviewed memory limits. The driver runs `seed` and `background` as separate steps under the same limits. Background cells cannot mix with growth, mutation, relations or forgotten records.

Use local results only to validate the harness. On an authorized disposable Ubuntu 24/x64 host with the 512 MB target, use pinned Node 24.22.2 and real-disk `--tmpdir`. Review the opt-in matrix with `--require-scope --dry-run`, then run it with `--require-scope` and require `limit.verified: true` on both steps; do not enable the legacy disabled cell or override preflight. Repeat at representative seed sizes and burst depths, keeping raw observations, build and script hashes, RSS/cgroup peaks, OOM/swap/throttling and WAL evidence. Compare paired foreground probes separately from capture and publication. No new capacity or retention recommendation follows from this local workload.
