# Verify mission formation without executing a mission

The formation slice saves drafts and exact approval receipts. It starts no controller, allocates no execution task and makes no model request. Agreement is not evidence that autonomous execution exists.

Local acceptance on November 10, 2026 covered:

| Mechanism | Evidence |
|---|---|
| Stored version 1 → 2 | Real SQLite migration preserves legacy IDs, policy, tasks and paused/stopped intent. |
| Protected authority | Offline Ubuntu amd64 uses distinct human, elder, organization and service UIDs; normal clients cannot approve, and the service UID cannot write the root receipt. |
| Terminal | Actual 80×24 and 40×12 sessions edit/save/reopen a goal, show keyboard controls and restore terminal mode after leaving setup. |
| Published rollback reader | Exact 0.0.7 opens the mission-v2 database, answers through a faux provider, appends memory and performs maintenance; the new reader then verifies the unchanged agreement. |

The Linux permission test runs in a disposable container, without systemd. It does not establish native install/update/rollback acceptance. That proof remains pending until a guarded standalone disposable systemd host is available. GitHub Actions and the production VPS are not test runners.

## Run the local checks

From `apps/unit-001`, build first and run the explicit cases:

```sh
npm run build
node ../../node_modules/vitest/dist/cli.js --run test/missions/state.test.ts test/missions/control.test.ts test/missions/authority.test.ts test/missions/agent.test.ts test/missions/terminal.test.ts
node --test test/mission-management.test.mjs test/release.test.mjs
```

The terminal cases use an isolated tmux server. They remove their own sessions and make no network/provider calls. The broader existing attached/setup terminal tests remain regression requirements.

## Reproduce the old-reader round trip

Verify the published `unit-001-0.0.7-linux-x64.tar.gz` before extracting it. Its SHA-256 is `7c47febdc58f3e728fdb2dba90f9c50da4d3636ce3022d929f23bcefd54fae38`. Keep its `app/dist`, production dependencies and bundled Node unchanged.

In a disposable copy, put the current compiled app at `app/next/dist`; put `test/fixtures/mission-release-current.mjs` at `app/next/test/fixtures/mission-release-current.mjs`; put `test/fixtures/mission-release-old.mjs` at `app/mission-release-old.mjs`. Both readers resolve the published dependencies. Create a private writable `/fixture/state` directory.

Use the published bundled Linux Node in a network-disabled Linux amd64 container. Execute the current fixture with `seed /fixture/state/session.sqlite`, the published fixture with `/fixture/state/session.sqlite`, then the current fixture with `verify /fixture/state/session.sqlite`. The current fixture forms the agreement without a provider. The published fixture uses only a faux provider. A failed step must stop the sequence.

## Reproduce managed authority checks

Stage the current compiled app and `deploy/mission.mjs` with the verified runtime/dependencies in a separate disposable payload. Put `test/fixtures/mission-managed-owner.mjs` at its matching `app/test/fixtures` location. Run `scripts/verify-mission-access.py PAYLOAD` only in a fresh Ubuntu 24.04 amd64 container, with networking disabled, hostname `unit-001-mission-acceptance`, and `UNIT_001_DISPOSABLE_CONTAINER=1`.

The script requires root inside that container and refuses existing installations. It creates only fixture users/state there, runs the real provider-free owner and root metadata command, checks approval/replay/private-frame denials, and restarts the owner. Destroy the container afterward. Never run this account-creation test on an existing host or the VPS.

## Lifecycle and process recovery acceptance

November 15 source acceptance additionally covers revision-bound start/pause/resume/stop, revoked creator stop, delayed request replay, managed intent migration, amendment rejection, background drainage, all cumulative work/spend counters, inhibited ordinary work and held maintenance. See [review traces](controls-review.md).

For the extended Linux trace, stage `test/fixtures/mission-execution-owner.mjs` alongside the formation fixture and run the same guarded script as `python3 scripts/verify-mission-access.py PAYLOAD execution`. Both fixtures acquire the production SQLite session lock. The extended fixture uses an abortable local faux provider and forbids network access. The driver kills the owner with SIGKILL during a persisted retry, reopens it, checks the unchanged wake deadline and no polling, observes automatic wake, rejects a second owner, then exercises actual privileged lifecycle commands and stopped reopen under separate UIDs.

The Python driver supervises this fixture process; it does not boot systemd. Native systemd crash/logout/reboot and install/update/rollback qualification remains an explicit deployment gate. The published-reader round trip above remains formation-only; an old release without mission admission is not qualified to run an executable mission ledger.

For a local check of supervisor command sequencing, run from `apps/unit-001`:

```sh
node --test --test-name-pattern='#16|#20 stop and kill persist|#20 explicit start restores' test/management.test.mjs
```

These cases use temporary installation records and mock `systemctl`; they cover start-limit recovery, stopped intent and readiness failure without changing host services. They do not exercise a running supervisor or mission wakeup.

## Native supervisor acceptance for #16

The [deployment recovery policy](../deployment.md#headless-operation-and-recovery) names the supported target and expected behavior. Complete the following on a separately authorized disposable Ubuntu 24.04 x86-64 host with systemd as PID 1, using a local faux provider and no provider credentials or network calls. Follow the [standalone host requirements](../operations.md#standalone-ubuntusystemd-acceptance); the container driver above is not a substitute. This checklist records pending proof, not a completed qualification or a new fixture runner.

1. Start one approved bounded execution under the installed service with no attached terminal. Record installation/session, mission/controller identities, policy revision, counters and a future persisted retry deadline. Disconnect/logout, then reconnect and prove progress continues under the same service owner.
2. During that saved retry, terminate only the disposable service's owned process without using the administrative `agent stop` or `agent kill` commands: those intentionally disable restart. Observe systemd replacing the failed PID automatically, with the same installation/session and mission/controller identities. Before the saved deadline, assert unchanged counters and zero additional faux requests; after it, assert automatic wake without a client submission. Reject a competing owner without changing stored work.
3. Exercise graceful service stop while waiting, then explicit service start. Assert the saved deadline, execution identity and consumed allowances survive reopening. Separately stop the mission and reopen the service: the execution stays terminal and makes zero further requests. Repeat with paused execution and confirm it stays paused.
4. Reboot with running installation intent, including a deadline that elapses before the owner returns. A plain `systemctl reboot` is too fast for this: record which flavor you ran. Graceful: `systemctl stop` the unit (intent stays running), wait past the saved deadline by wall clock, then reboot. Crash: `sync; echo b > /proc/sysrq-trigger` about ten seconds before the deadline, so it falls due during boot. A provider power-off with the guest off through the deadline is a third, stronger flavor. Assert one owner returns without login, reconciles the overdue wake once and retains identity/allowances. Repeat after administrative stop and kill: each leaves the unit disabled and the installation stopped after reboot, until explicit start. For kill with a request in flight, prove from the faux log that the request was still open at the kill: a server that closes the socket once it has read the body settles the attempt as a failure, and the request after restart is then Durable's scheduled retry, not the unknown-outcome case.
5. Exercise a bounded startup-failure sequence that reaches the unit's start limit. Record the failed state and journal evidence (on systemd 255 the unit shows `Result=exit-code` with "Start request repeated too quickly", not `start-limit-hit`); correct the fixture cause and prove `agent start` resets failure, restores readiness and preserves mission state. As a separate negative check, a failed explicit `agent start` records stopped intent and disables the unit. If graceful drainage exceeds the unit's 60-second stop window, record the forced-termination outcome as interrupted work rather than claiming graceful completion.

Retain the exact source SHA and worktree state, payload hash, guest image/OS/kernel/systemd versions, unit contents, boot IDs, old/new PIDs, timestamped journal and mission snapshots, faux request counts and each assertion result. Disclose emulation. Keep secrets out of evidence. Installation/update/rollback qualification remains a separate deployment gate; a manually restarted fixture, mock `systemctl` trace or passing process-lock test cannot establish this supervisor acceptance.

## Continuous purpose acceptance (#72, native, for Codex)

Local evidence (2026-11-22, source only): `test/missions/loop.test.ts` (24 cases, real SQLite, faux provider, injected clock, closed restarts), the drain case in `test/missions/agent.test.ts`, the v1→v2 migration case in `test/missions/purpose.test.ts`, and the published 0.0.9 round trip with a purpose loop (`test/missions/fixtures/purpose-release-*.mjs`, [steps](purpose.md#published-reader-round-trip)). Local checks:

```sh
npm run build
node ../../node_modules/vitest/dist/cli.js --run test/missions test/agent.test.ts
```

Native acceptance still needed, on a disposable Ubuntu 24.04 x86-64 host with systemd as PID 1, a local faux provider, no credentials or network, never the installation named bob. `deploy/agent-command.mjs` routes `mission approve-purpose` and `mission operate` to the selected release's `deploy/mission.mjs` with the same root and fixed-identity rules as `approve` (`test/mission-management.test.mjs`). An operator or a `--id` override is refused before anything runs. Keep the same evidence as the #16 checklist above (source SHA, payload hash, unit, boot IDs, PIDs, journal, mission status JSON, faux request log).

1. Install the candidate under a test name. Provision the creator with a `purposeCeiling` (`artifact-digest`, `reports/`). As a non-root operator propose a purpose with works A and B (known SHA-256s), `reviewEveryMs` about 10 minutes and small lifetime caps. Approve it with `sudo` from the creator's own account; prove that the same command from another administrator is refused. Then `sudo NAME mission operate open`.
2. Record A `verified`/`settled`, activity `waiting` with its next observation, and the lifetime ledger. Disconnect and reconnect: same identities.
3. SIGKILL the owner process (not `agent stop/kill`) during the wait; systemd restarts it. Before the saved time: zero faux requests and an unchanged status. After it: B runs without a client submission and verifies; activity `idle`; no further request after another interval.
4. Repeat with a graceful stop past the saved time then start, and with a sysrq crash reboot about 10 s before it: one overdue wake, B once.
5. Update while waiting: the updater drains (parked loop), the candidate starts inhibited, commit, same next observation, zero early requests. Update with a faux request held open (stub keeps the socket open): `deferred`, hold released.
6. Revoke during the wait (root rewrites the authority file without the purpose receipt): after the saved time, activity `blocked` (`authority`), no new proposal, zero requests.
7. Kill during an in-flight faux request for A (prove from the log the request was open): after restart A is `unsettled`, B blocked. `sudo NAME mission operate acknowledge --run ID`; B runs after the next observation; the ledger still counts the unknown request.
8. `operate suspend`, then service stop/start and a reboot: stays suspended, no wake. Before `operate close`, `sudo NAME update rollback` to a release without the loop task returns `deferred`, and the journal and service are unchanged. `operate close`: status shows `rollback: no-live-loop`, and the same rollback then succeeds.
9. Restore and check the bob installation (running, enabled, environment SHA unchanged).
