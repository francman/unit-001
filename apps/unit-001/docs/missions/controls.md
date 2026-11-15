# Mission lifecycle controls

An approved mission stays idle until explicitly started. Source commands are:

```sh
agent mission status
sudo agent mission start
sudo agent mission pause
sudo agent mission resume
sudo agent mission stop
```

Use the installation's chosen name in place of `agent`. Inspection needs operator access; installed lifecycle changes require sudo. Developer-local source instances use the same commands without sudo because the developer owns that instance's authority. These are source features; availability on an installed machine depends on its release. [Review and recovery evidence](controls-review.md) records the acceptance checks.

Pause closes admissions and drains the mission's requests, tools and background work. Resume creates a fresh controller after drainage and preserves consumed work/spend limits. Stop remains terminal across owner restart. These commands leave the service and ordinary conversations available. Cancelling a conversation and stopping the installed service retain their separate meanings.

Status shows observed evidence, current policy revision, waiting/blocking reason, next wake and consumed allowances. Costs are estimates; reserved, unpriced and interrupted requests remain explicit. The initial engine verifies approved file digests. Unsupported completion requirements stay blocked.

## Protected intent and replay

The administrator client writes the latest `executionIntent` into the existing root-owned mission authority file. It binds a sequence, request ID, action, agreement identity/revision/digest, authority revision and expected mission policy revision. The existing owner reconciles that intent; neither a socket frame nor a remembered instruction grants authority.

An explicitly supplied `--request-id ID` requires `--policy-revision N`. Retry both values printed by an uncertain command; never infer a new revision for an old request. Plain interactive commands generate a fresh ID and capture the current revision. A repeated current intent does not allocate another controller or reset counters. An old sequence, forged ID or changed agreement is rejected. Pending activation can be cancelled with stop even before a provider is configured.

`unit.mission.execution` version two adds the applied intent receipt. Its explicit version-one migration preserves counters, evidence, controller identities and paused/stopped state. Formation remains version two and an agreement alone never becomes startup permission. Ordinary operator endpoints cannot issue or reconcile lifecycle changes.

## Revocation, startup and recovery

Pause and stop remain available after creator replacement, approval revocation or expiry. They bind the existing execution, rather than requiring permission to continue it. Authority rewrites preserve the intent sequence. Start/resume still require the exact current approval and, on managed installations, matching protected and applied intent receipts. Version-one execution migration supplies no implicit permission.

Stop the current execution before approving amended terms. Drafting an amendment does not replace active terms. New mission replacement after a terminal execution is outside this initial single-execution slice.

Startup first applies restrictive gates without starting the scheduler. Drainage occurs only after configuration, maintenance and startup inhibition permit scheduling. A held owner applies pending stop before maintenance release can enable work. Unsupported or uncertain effects remain visible and require deterministic evidence before resume.

Acceptance uses real SQLite, faux providers, owned background tasks, actual 80×24 and 40×12 terminal sessions, and the installed root helper under distinct Ubuntu UIDs. A network-disabled Linux fixture kills and reopens the real process, checks the persisted retry deadline, and rejects a competing storage owner. This container proof does not qualify native systemd installation/update/rollback. No production installation changed. #27 research automation remains separate.
