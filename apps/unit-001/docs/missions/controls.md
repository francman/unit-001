# Mission lifecycle controls

An approved mission stays idle until explicitly started. Source commands are:

```sh
agent mission status
sudo agent mission start
sudo agent mission pause
sudo agent mission resume
sudo agent mission stop
```

Use the installation's chosen name in place of `agent`. Inspection needs operator access; installed lifecycle changes require sudo. Developer-local source instances use the same commands without sudo because the developer owns that instance's authority. These changes are a blocked draft source checkpoint, not a released VPS feature. [Independent review findings](controls-review.md) must be resolved before merge.

Pause closes admissions and drains the mission's requests, tools and background work. Resume creates a fresh controller after drainage and preserves consumed work/spend limits. Stop remains terminal across owner restart. These commands leave the service and ordinary conversations available. Cancelling a conversation and stopping the installed service retain their separate meanings.

Status shows observed evidence, current policy revision, waiting/blocking reason, next wake and consumed allowances. Costs are estimates; reserved, unpriced and interrupted requests remain explicit. The initial engine verifies approved file digests. Unsupported completion requirements stay blocked.

## Protected intent and replay

The administrator client writes the latest `executionIntent` into the existing root-owned mission authority file. It binds a sequence, request ID, action, agreement identity/revision/digest, authority revision and expected mission policy revision. The existing owner reconciles that intent; neither a socket frame nor a remembered instruction grants authority.

Use `--request-id ID` to retry an uncertain command and `--policy-revision N` when a script needs compare-and-set behavior. A repeated current intent does not allocate another controller or reset counters. An old sequence, forged ID or changed agreement is rejected. Pending activation can be cancelled with stop even before a provider is configured.

`unit.mission.execution` version two adds the applied intent receipt. Its explicit version-one migration preserves counters, evidence, controller identities and paused/stopped state. Formation remains version two and an agreement alone never becomes startup permission. Ordinary operator endpoints cannot issue or reconcile lifecycle changes.

## Verification and remaining release gates

Local tests exercise the actual owner with faux providers and real SQLite: explicit start, pause during a dispatched request, drainage, budget-preserving resume, terminal stop across reopen, stale/forged controls and pending activation cancellation. Management tests verify root-only dispatch through the selected release. Actual 80×24 and 40×12 terminal sessions retain editing and restore terminal mode.

Before merging or releasing this checkpoint, resolve the independent review findings; run the root helper end to end with distinct Linux UIDs; cover pause/stop with owned background work and update maintenance; reconcile pending intent before maintenance release; and prove the supervised process-kill/wake path from #16. No production installation has changed. #17 remains open until these gates pass; #27 has not started.
