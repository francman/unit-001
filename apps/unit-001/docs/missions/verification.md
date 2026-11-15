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
