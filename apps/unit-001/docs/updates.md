# Continuous updates and recovery

Public production downloads include the public verification keys and update settings. Install the bundle and start the agent normally; no GitHub account, download token, signing key, or `update configure` step is required. Signing keys belong to maintainers, never to users.

The updater is a privileged service separate from the agent. It accepts only releases authenticated by the bundled signing root. The agent cannot choose update URLs, replace trust, or enable updates itself.

An update stages verified files, closes new-work admission, and waits up to 30 seconds for admitted work to finish. Busy agents defer. With the owner stopped, it backs up state, starts the candidate without executing saved work, and checks identity, version and maintenance readiness. A durable commit precedes resuming work. Interrupted pre-commit activation restores the previous code and closed-state backup; after commit, recovery preserves current state.

Fresh public production installations configure automatic updates, with checks every six hours after the normal agent start. Stop/kill intent survives updates and reboot. Existing update preferences survive upgrades. Pinning holds an exact version; disabling the timer leaves manual updates available. Unsigned development bundles remain unconfigured.

## Operator commands

```bash
sudo agent update status
sudo agent update check
sudo agent update disable
sudo agent update enable
sudo agent update pin 0.0.5
sudo agent update unpin
sudo agent update apply
sudo agent update rollback
```

Use the installed name, such as `bob`, instead of `agent`. Public downloads and updates use `francman/unit-001-releases` directly over HTTPS, without GitHub API credentials. The initial installer comes from the trusted public download channel; future releases and key rotations must verify against its bundled trust.

The updater retains its own Node runtime, dependencies and previous recovery core. If the application launcher or runtime is broken, use `sudo /usr/local/sbin/unit-001-update UUID status` or `recover`. Obtain the UUID from the installation record under `/etc/unit-001/agents`. Recovery units run before and after application startup to repair interrupted activation.

If the selected updater itself fails, invoke the retained recovery core directly: `sudo /usr/lib/unit-001/updaters/UUID/recovery/runtime/bin/node /usr/lib/unit-001/updaters/UUID/recovery/lib/update.mjs --id UUID recover`. Use `rollback` there to return compatible code to the previous version. New updater releases must preserve the retained core's ability to read the activation journal.

If an operator stopped the agent during an interrupted update, recovery preserves that intent. Use `sudo agent update recover --start` when explicitly ready to recover and resume it.

## Compatibility and rollback

Version `0.0.2` introduces the maintenance protocol. Install this baseline manually before enabling automatic updates on an older installation. This slice supports the default managed session only; additional session databases defer updates.

The 0.0.6 updater retains the existing systemd definition when installing 0.0.7. Bob's private owner and automatic updates remain available, but normal-user operator access needs a one-time administrator step: `sudo bob stop`, `sudo bob operator add USER`, then `sudo bob start`. Reconnect SSH afterward. Only the missing runtime directory permits this compatibility path; an existing directory with unsafe ownership, mode or a symlink is rejected. Explicit 0.0.7-to-0.0.6 rollback restores the exact known legacy service definition before the old owner starts. Later template changes follow [Service template changes](#service-template-changes).

Releases declare state format, minimum reader and maintenance-protocol versions. Unsupported declarations hold for operator review. A release number alone never proves state compatibility. Explicit rollback drains again and changes compatible code while preserving current credentials, workspace and durable state. It never restores a historical backup after new work has been allowed to execute.

### Full-owner rollback qualification

"Compatible rollback" means the previous release opens and writes the whole owner database after the new release has worked in it, not only one document. Problem: builds from `edfa9d085` stored `unit.memory` as version 2, so published 0.0.9 failed at open with `Document 10 (unit.memory) has newer version 2 than 1`, while the manifest still declared `minReaderVersion: 1`. A manifest number alone did not catch that.

Fix and rule:

- `unit.memory` stays at version 1, the exact shape 0.0.9 reads. Relations live in a separate Session document, `unit.memory.relations` v1, which 0.0.9 never loads. Writes that touch both change them in one Durable commit.
- At open, before anything reads memory, the owner rewrites a stored version-2 memory document as version 1 plus the relations document, and drops relations whose endpoints are no longer live at their pinned revisions. Example: 0.0.9 forgets memory C; C's `contradicts` link stays in the relations document because 0.0.9 does not know it, and the next current owner removes it at open. Reads already ignore such a link because its pinned revision no longer matches.
- Other documents 0.0.9 does not know (`unit.side`, `unit.mission.purpose`, `unit.send.receipts`) are ignored by its typed access, and stay intact for the next current owner.

Qualification, `test/rollback/qualify.mjs`: in a disposable `linux/amd64` container with `--network none`, against the exact published reader archive. Two scenarios: a fresh Session, and a Session already holding version-2 memory. In the second, the current owner opens and converts the Session before the reader runs (step 1b), and the stored documents after conversion must equal the ones before the version-2 rewrite, field for field. Problem: a stats view cannot show a lost consolidation. Example: if conversion dropped the stored `scheduled` consolidation for task 13, the owner's open would schedule task 33, and stats would still read "scheduled" while task 13 sleeps orphaned. The stored comparison catches it.

1. Current owner seeds real work: operator memories with relations, a model `remember` tool call with a relation, a captured preference, a sleeping consolidation task (pending work), completed captures and generations (settled work), an ID-bearing send with its receipt, an agreed mission and its purpose record.
2. The published reader opens the database. It reads memory and the mission, and replays the ID-bearing send without a provider call. It then writes: remembers, forgets a relation endpoint, runs an ID-bearing model turn whose capture completes, and amends the mission.
3. Current owner reopens. It checks the reader's memories and forget, the pruned relation, that the surviving relations are intact, the send receipt binding (`exact` for its own send, `unverified` for the reader's), and the purpose import of the amendment. In storage, memory is version 1 and both endpoints of every stored relation are live at their pinned revisions; a revision match alone would accept a tombstone that kept its revision. It then writes again.
4. The published reader opens once more and replays the send that the current owner receipted after the rollback.

Negative control: the same version-2 Session without step 1b. A reader that loads memory must refuse it with `has newer version 2 than 1`; this shows that the second scenario passes because of the conversion, and that this reader checks stored document versions. The record states the result.

Run it with `node test/rollback/qualify.mjs --reader READER.tar.gz --candidate CANDIDATE.tar.gz --image IMAGE --work DIR --record RECORD.json`. Without `--candidate`, the current steps run from the checkout's `dist/` on the host. That record names the checkout and cannot satisfy publication.

Readers: `qualify.mjs` takes the reader version from the archive's `release.json` and passes it to `full-owner-reader.mjs`, which refuses a bundle of another version. What the reader exercises follows its own surface, and the record lists it as `reader.coverage`:

- `transcript`: every release. Replays the current owner's ID-bearing send without a provider call, and answers a new one over the current transcript.
- `memory`: releases with memory operations (0.0.6 onward, by source history). Reads stats and recall, remembers, forgets a relation endpoint, and captures a preference.
- `mission`: releases with mission operations (0.0.8 onward; they appear partway through the 0.0.7 commits, so 0.0.7 depends on its build). Reads the agreement and amends it.

The current owner's `verify` checks what the reader covered and that the rest is exactly as seeded. Only 0.0.9 has been run (coverage `transcript`, `memory`, `mission`; negative control refused). To qualify 0.0.1 to 0.0.8, run the same command once per archive, with each published `unit-001-0.0.N-linux-x64.tar.gz` as `--reader` and its own `--work` and `--record`. Those runs are unexercised: an older owner may differ in `Agent.open` options or request shapes. A failure there is a failed qualification, never a skipped one. Fix the reader fixture for that release under review, then rerun.

Readers before 0.0.6 have no memory operations, and 0.0.6 (possibly 0.0.7) has no mission operations. Their records therefore cannot show that memory or mission work survives a rollback to them. Two choices exist, and choosing between them is an owner decision: accept the narrower coverage for those readers, or enforce a reader floor (the updater refuses those releases as sources, then the gate drops them). The gate checks neither `coverage` nor `negativeControl` today.

Release gate: `scripts/update-repository.mjs` refuses a version new to the stable feed unless it has one `--rollback-qualification RECORD.json` per earlier release in the feed. Problem: the updater admits any installed release that declares the supported compatibility numbers, not only the newest one, so an installation on 0.0.1 can update straight to 0.0.3 and its recorded rollback target is 0.0.1. Qualifying only 0.0.2 would leave that path unproven. Example: with 0.0.1 and 0.0.2 published, 0.0.3 needs two records, one run with `--reader` 0.0.1 and one with `--reader` 0.0.2, repeating the flag. Each record must name:

- a passed run of both scenarios;
- these exact candidate archive bytes;
- the exact archive bytes of its reader, as pinned by the signed targets.

A missing, duplicated or extra reader refuses. The publisher cannot read an old archive's compatibility numbers from the signed targets, so every earlier release counts as a source. Dropping one from the gate needs the updater to refuse it as a source first, which is an owner decision.

`prepare` and `publish` both enforce this. `prepare` stores the validated records in `rollback-qualification.json` beside the plan. `publish` rereads it and repeats the check against the signed targets and the archive bytes it uploads, before any upload; a stage without the receipt, such as one signed by an older publisher, is refused and must be prepared again. `publish` also derives bootstrap and renewal from the metadata the feed authenticates now (the newest signed receipt when an interrupted replacement deleted `timestamp.json`), not from the stage: the stage must carry every release the feed serves, byte for byte, and its renewal mark is accepted only when that served metadata pins the identical archive, so an orphaned upload cannot pose as one. It copies the stage once into a private directory and validates and uploads from that copy, so a file swapped in the stage afterwards cannot change what ships; `qualify.mjs` likewise hashes and extracts the archive from one read, and `prepare` reads the archive once and takes the checked members, the signed digest and the download alias from those bytes.

Further publisher rules:

- A stage's releases are exactly the served releases plus the candidate. A release the feed never served is refused, and every earlier release and every record must carry a real SHA-256 digest.
- Only the live `timestamp.json` proves a release was promoted. Each publication uploads its numbered receipt before the live pointer, so after an interrupted replacement the newest receipt may belong to a publication that never went live. Example: a publisher that predates the gate uploaded 0.0.2 and its receipt, then lost the pointer; the newest receipt pins 0.0.2, but nothing proves 0.0.2 was ever served. Without a live pointer, a renewal therefore needs the same records as a new version; pass `--rollback-qualification` to `prepare` or `renew`. A metadata release with no timestamp at all never served anything and accepts only a first publication.
- Without a live pointer, only the newest receipt's own release may go out (same stable descriptor), with its records. Problem: a later version would carry that release into served history, and the gate checks only the later version. Example: 0.0.1 is live, 0.0.2's publication lost the pointer, and 0.0.3 arrives with records against 0.0.1 and 0.0.2. Publishing 0.0.3 would make 0.0.2 a signed, pinnable release that was never qualified as a candidate. So `publish` refuses 0.0.3. Run `renew --rollback-qualification` (one record for 0.0.2 against 0.0.1), or retry the interrupted stage, then prepare 0.0.3 from the live feed. A retry of the interrupted stage is that same release, so it goes out.
- Versions use one grammar and one order, shared with the installed updater (`deploy/release-version.mjs`). A version is three decimal components without leading zeroes. Components compare as digit strings, never through a JavaScript number. Problem: `0.0.01` read as numbers equals `0.0.1`, so a signed `0.0.01` target would stand in for reader 0.0.1 in the gate, while every client refuses that descriptor. Similarly, 2^53 and 2^53 + 1 are one JavaScript number. `prepare` refuses a non-canonical version, and the gate refuses a signed release target with a non-canonical name.
- A rotated root is the last immutable upload, right before freshness. Clients that see it reject the live timestamp signed under the previous root, so the feed fails closed (no rollback) until freshness lands. A retry finds the new root published and authenticates the old timestamp with the root one version below it, chosen by version rather than as the newest upload. A stage signed under the old root is refused once the new root is out.

The records are a maintainer's assertion that the run happened. The publisher checks that each one is well formed and names the exact archives, but it cannot prove the run took place. Proof needs a protected runner that signs the record, which is an owner decision and not built.

Renewing the version the live `timestamp.json` pins needs no record. If a later release cannot pass, do not raise `minReaderVersion` as a substitute. A reader-floor transition needs an owner decision and a compatible reader or updater bridge first.

### Mission loop and rollback

Releases that run continuous purpose operation declare `"features": ["mission-loop"]` in `deploy/release-compatibility.json`. Releases without it, including 0.0.9 and earlier, have no loop task. Problem: such a release sees a live loop task as unknown work. It never runs or finishes it, and its own drain then defers every later update. Example: a loop waiting for its next observation is rolled back to 0.0.9. 0.0.9 keeps the loop task forever, and no update can drain it.

So the updater refuses to activate a release without `mission-loop` while a loop is live. This applies to explicit rollback and to any install of such a release. A forward install between two loop releases asks nothing.

- Live owner: the updater runs the current release's `mission status --json` as the installation account. Only `loopRollback: no-live-loop` permits the drop; the owner derives it from its live tasks, not from the purpose document. Anything else is `deferred`: `live-loop`, an error, or an older owner without the field. Problem with reading the purpose instead: an unreadable purpose record reads as no purpose. Example: malformed legacy work beside a parked loop makes `purpose` null while the loop task is still live. An empty installation answers `no-live-loop`. The updater asks once before the update journal is written, and again under the maintenance hold, where no operation can open a loop before the stop. That closes the window after the first answer. A refusal at that point releases the hold without stopping the service.
- Closed owner: the updater cannot ask, so the result is `incompatible`. Start the agent, close the operation, then retry.
- Signed features: the guard reads the target's features from the verified release payload, and activation refuses, as `incompatible` and before any hold, a payload whose `features` differ from its signed descriptor's. The comparison is exact set equality, and a duplicate name in either list is refused: payload `["a", "a"]` and descriptor `["a", "mission-loop"]` have equal length and every payload name is in the descriptor, yet they differ. Problem without this: forward activation trusted the descriptor, so a descriptor claiming `mission-loop` could skip the guard for an archive without it. The descriptor carries the release's `compatibility` object unchanged, and the updater rejects a `features` value that is not a list of names.

A deferral never leaves sticky state. Before the hold, the updater keeps the journal of the last committed update in `journal-prior.json`, keyed by the attempt's operation ID. An attempt that defers after the journal is written (busy drain, or a loop opened between the two answers) stopped nothing, so it puts that journal back instead of completing its own. Recovery after power loss in that window does the same, and so does any recovery, boot or in-process, of a journal still at `holding`: that phase precedes the backup and every publication, so the attempt changed nothing even if the owner was stopped. Example: power fails during a rollback's hold, before `restored` is saved. Boot recovery sees `holding`, puts the committed journal back, and the rollback can be retried. Problem without this: the completed attempt journal named the unchanged release as the update's result, so `rollbackUpdate` refused every retry and `update rollback` pinned the current release. A journal written by an older core has no matching prior record and completes as before.

To roll back, run `sudo NAME mission operate close`. Wait until `NAME mission status` no longer shows `Rollback: close operation first`, then run `sudo NAME update rollback`.

A release with model review turns also declares `mission-review-turn`. Before switching to a predecessor that lacks it, the updater checks the running owner's identity, protected purpose restriction and review status. A plan-only owner can proceed without a purpose Close when it has no purpose or protected operation intent. A running or unresolved review defers the switch. A settled review task may still be parked between cadence windows. The matching maintenance hold must end it and return affirmative no-live-task status before the updater changes the selected release.

Qualify this downgrade with the actual current and recovery updater binaries and an exact v1 plan reader. A historical core may skip the review guard. A compatible predecessor must preserve the stored plan and review ledger through an owner write. Forward reopen must retain charges and keep admission closed if protected authority was lost.

A research-capable release declares `mission-research`. A target without that capability is eligible only when the running owner confirms that its purpose draft, retained agreements and research records contain no research, and the protected authority has no research grant. The updater checks before journaling and again under its matching drained hold. Existing or unreadable research records keep the older target blocked, including after the research run settles. Use a research-capable release for those stores. Qualify the actual current and recovery updater selections before deploying research state, since an older core may lack the check.

After rollback, the older release follows the purpose reader contract. The purpose history, work digests, acknowledgments and lifetime ledger are kept. Opening operation again needs fresh consent, because the older `deploy/mission.mjs` drops the purpose grant and operation intent when it rewrites the authority file. This was checked with the published 0.0.9 round trip ([Continuous operation](missions/purpose.md)).

Rollback pins the selected previous version before activation so the next timer check cannot reinstall the rejected release. The pin remains if rollback fails. Inspect `update status`, recover as needed, and explicitly `unpin` when ready to follow stable again.

Snapshots contain private agent data and remain root-protected. They are recovery material, not a replacement for off-host backups. The updater cannot undo an external effect already made by a tool.

State backup includes the workspace, so downtime depends on its size. Free-space checks can defer an update. Administrative operations share a lock; a stop or kill attempted during activation reports a busy operation and must be retried. Old application releases remain available for compatible rollback; monitor host disk usage. Updater cores retain only the selected current, previous and recovery versions, preserving unexpected files for inspection.

## Service template changes

Each release declares the version of its systemd service template (`deploy/unit-001.service`) as `serviceTemplate` in `deploy/release-compatibility.json`. Version 1 is the template shipped through 0.0.6; version 2 added the operator runtime directory in 0.0.7. Releases before this versioning declare nothing. A release that changes the template must raise the number. A changed template with a missing, unchanged or lower number is `incompatible`; only explicit rollback may return to a lower version, and only to the exact unit its journal recorded.

The updater decides after staging the verified release and before closing admission, so a refusal never stops work:

- Template unchanged: the installed unit stays byte for byte, including administrator edits and a legacy unit an operator has not migrated.
- Template changed, the installed unit is exactly the current release's template, and every changed directive is neutral or narrowing: the new unit is written with the new code, before the candidate starts. Neutral means description, documentation, ordering, restart pacing and the log tag (`SyslogIdentifier`). Narrowing means a stronger hardening value (`ProtectSystem=yes` to `strict`, adding `ProtectKernelTunables=yes`), fewer writable paths, groups, capabilities or managed directories, or more read-only or inaccessible paths.
- Anything else is `held`, and the reason names each directive: a different account, start commands, environment, pulled-in units, output destinations (`StandardOutput`, `StandardError`), weaker hardening, and new writable paths or capabilities. A template change also holds when the installed unit is not the current release's template.

The updater compares units only in a plain subset of systemd syntax, so it never reads a line differently from systemd. A unit outside the subset holds as `unreviewable unit syntax`:

- Every byte is printable ASCII or a newline. Example: a no-break space after `NoNewPrivileges=yes` makes systemd drop the setting, so it holds.
- No line continuations (including after comments), padding around lines or values, specifiers (`%`), or sections other than `[Unit]`, `[Service]` and `[Install]`.
- Each directive is assigned once. Repeated assignments merge or reset in order, which a per-line comparison cannot model.
- Lists narrow automatically only as plain sets: absolute paths, capability names, group names or relative directory names. Quotes, `-` or `+` path prefixes, `~` exclusions, `.` or `..` components and empty resets hold. Example: dropping one entry from `AmbientCapabilities=~CAP_SYS_ADMIN CAP_NET_ADMIN` grants it, so it holds.

The new unit also must be the effective policy. A template change holds while any other unit file or drop-in for this service exists in the systemd search path: instance, template (`unit-001@.service.d`), name-prefix (`unit-.service.d`) and service-wide (`service.d`) drop-ins, `systemctl set-property` overrides, and higher-priority unit files. The updater's own recovery drop-in (`update.conf`) is allowed only with its exact contents. After `daemon-reload`, activation checks that systemd loaded only the managed unit file and that drop-in; anything else restores the previous release and unit.

Example: a release whose template adds `ReadWritePaths=/etc` reports `held` with `[Service] ReadWritePaths` in `update status`. The agent keeps running the current release, and each timer check repeats the hold until an administrator acts.

The journal records the exact previous and new unit. The updater refuses an activation whose serialized journal would leave less than 4 KiB below the 64 KiB limit that every retained recovery core reads. Interrupted or failed activation before commit restores the previous unit with the previous code, and recovery reloads systemd before it records the restored phase, so a retry never starts the old release with the candidate's cached unit. After commit, recovery keeps the new unit. Writing a unit keeps the installed file's mode. Explicit rollback restores exactly the unit that the rolled-back update replaced, which grants nothing new. A later release cannot drop hardening automatically.

Applying a held template is an explicit administrator action. Read `deploy/unit-001.service` in that release's verified download, run `sudo bob stop`, run that release's installer for the same name, then `sudo bob start`. For a legacy unit, run the operator migration above first; the next check then evaluates the template change normally.

### Clients that skip the first versioned release

Updaters before this check select new code but keep the installed unit. Example: a client on 0.0.9 whose next check finds a release with template 3 runs that release under its template-2 unit. Lifecycle commands that check unit ownership, such as uninstall and `operator add`, refuse that unit until it is migrated.

The next update, now performed by the new updater, recognizes that unit when the last journal shows the older updater kept the previous release's exact unit. It evaluates the change from that unit to the candidate's template by the rules above: narrowing changes are applied, and anything else holds with a reason naming the kept release. The legacy 0.0.6 unit is excluded and keeps its operator migration. Without that journal evidence, the unit counts as edited by an administrator.

This migration can happen between two releases with identical templates. Explicit rollback of it still restores the exact kept unit, and its journal names the kept release, so the next update migrates that unit again. Example: an older updater moved a client from 0.0.9 to 0.0.10 and kept 0.0.9's unit. The update to 0.0.11, whose template equals 0.0.10's, migrates it. Rollback to 0.0.10 restores 0.0.9's unit, and updating to 0.0.11 again re-applies the migration. If an administrator edits the restored unit, it counts as edited.

Maintainers: the first release that carries this check must not change the template. Before publishing any later release that changes the template, qualify the skipped-release path:

1. The changed release must run correctly under the previous template's unit, because skipping clients start it under that unit.
2. Add a case with `skippedFixture` in `test/update-activation.test.mjs` that moves from the previous shipped template to the new one, and check that it applies or holds as intended.
3. Interrupt that transition at each phase and recover it with each updater core a client may retain as its recovery core (the cores of the last releases before the change), not only the current one. The boot hooks run the retained core, so it must restore the previous unit, reload systemd before it records `restored`, and start the previous release under that unit. Qualify this on a real systemd host as well as with the skipped-release fixture.
4. Then update the pinned template hash and `serviceTemplate` in the test `the shipped template stays pinned until a skipped-release migration is qualified`.

Expect narrowing-only changes to apply automatically; anything broader reaches users as an explicit reinstall.

## Native fixture evidence

On disposable Ubuntu 24.04.4 with systemd 255, an updater derived from published 0.0.9 authenticated a candidate under isolated test trust. A held template left the running owner and its journal unchanged. Pre-commit recovery restored the previous release, exact unit and closed snapshot while preserving stopped intent. Post-commit recovery retained the new unit and a workspace marker written after commit. Explicit rollback restored the prior unit and effective restart delay, pinned the prior version and retained the post-commit marker.

Cold `recover --start` failed on the earlier 0.0.10 fixture because `systemctl reset-failed` reported the inactive unit was not loaded. The updater had already persisted running intent, while the service and timer stayed disabled and the journal stayed restored. A separately scoped start through the fixture's installed recovery dependencies completed that operation. The updater now resets only a unit whose `ActiveState` is `failed`. [Original native update evidence](https://github.com/francman/unit-001/issues/18#issuecomment-7072133267)

The native cold retest interrupted a signed 0.0.14 update on the fixed 0.0.13 fixture. Plain recovery restored the stopped journal and exact 5-second restart policy. Immediately before the single installed `recover --start`, systemd listed no loaded fixture service and both unit files were disabled. The command returned `recovered`, completed the same operation, and left the 0.0.13 owner ready with its service and timer active and enabled. Final teardown removed the fixture and confirmed Bob's readiness, PID, invocation and environment checksum on the same boot. These results qualify the local fixtures. Production archive qualification remains open. [Native cold retest](https://github.com/francman/unit-001/issues/18#issuecomment-7072427672)

## Private testing

The previous private feed remains available for maintainers. `sudo agent update configure --root-file /secure/root.json --token-file /secure/github.token` selects that private path. Its download credential is stored root-only and never in the agent environment. Existing configured trust is preserved. This is an advanced testing option, not part of public installation.

## Publishing and key custody

This section is for maintainers. Users do none of these steps.

Create `francman/unit-001-releases` as a public releases-only repository with an initial README commit. Keep the private source repository's visibility and Git history unchanged. The public repository needs that initial commit before GitHub can create release tags.

GitHub Actions is disabled for this project, including manual, scheduled and self-hosted Actions. Workflow files remain inert historical definitions; they are not publication or renewal infrastructure. GitHub release assets and APIs still host the public feed. A trusted maintainer builds exact merged-main source on an isolated Linux build host, then uses the existing local publisher. See [standalone verification](operations.md#standalone-verification) for commands and required evidence.

The source repository stays private. TUF verifies signatures, expiry, lengths and hashes, and rejects metadata rollback. Clients support only top-level targets, without delegated signing roles.

Create keys explicitly with `node apps/unit-001/scripts/update-repository.mjs keygen --out /secure/unit-update-keys`; keep the root private key offline. Store the approved public root and online targets/snapshot/timestamp keys in protected maintainer storage, outside builds and downloads. The local GitHub credential needs Contents write access to the public releases repository; users never receive it. Do not copy a broad personal credential or private signing keys into a build container. Root rotation requires signatures from both the old and new root authorities.

Only trusted release maintainers should control online signing storage: its online keys authorize software that the privileged updater will execute. During root rotation, pass the approved old root with the publisher’s `--previous-root` option, update the root and online keys together, then publish or renew. Rotate one root version at a time and stop passing the previous root after successful publication. Publish a fresh bundle carrying the new root before the previously bundled root expires, so new downloads remain installable. Verification tries current trust first, so subsequent renewals also work while the previous root remains supplied.

The [standalone renewal service](maintainer-renewal.md) provides a twice-daily systemd timer, a process-released publication lock, bounded scratch cleanup and anonymous signed-metadata verification. It still needs a separate trusted publisher host and repository-scoped credential; no automatic schedule is currently installed. Timestamp metadata expires after 48 hours. Maintainers can still invoke `update-repository.mjs renew` and `publish` manually, taking the same publication lock as the scheduled job. Do not enable Actions or its old renewal variable to solve this gap. Expired or unavailable metadata fails closed and leaves the installed agent running. Serialize every publisher: GitHub release assets do not provide atomic compare-and-swap publication. Numbered receipts preserve recovery from interrupted timestamp replacement.

Retention runs only after freshness is published and read back: signed metadata remains until expiry plus seven days, with retained dependency chains and every root preserved. Unknown assets remain for operator inspection. This avoids exhausting GitHub's [1,000 assets per release](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) during ordinary renewal. Archive history is retained; reaching the client's 4 MiB targets-metadata limit requires a reviewed repository migration.

Investigate failed publication commands. A failure during retention can occur after the new timestamp is already live; inspect the reported step before retrying. Unexpected numbered metadata stops cleanup rather than authorizing deletion, so remove such assets only after operator review.

Production keys, protected maintainer storage and the initial signed feed must be configured before the public download is live. Merging the code does not provision those secrets or publish a download. Once published, the bundle configures users' trust and update policy automatically. See the [application comparison](update-assessment.md) for the design evidence.
