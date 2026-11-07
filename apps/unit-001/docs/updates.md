# Continuous updates and recovery

The updater is a privileged service separate from the agent. It accepts only releases authenticated by a locally installed signing root. The agent cannot choose update URLs, replace trust, or enable updates itself.

An update stages verified files, closes new-work admission, and waits up to 30 seconds for admitted work to finish. Busy agents defer. With the owner stopped, it backs up state, starts the candidate without executing saved work, and checks identity, version and maintenance readiness. A durable commit precedes resuming work. Interrupted pre-commit activation restores the previous code and closed-state backup; after commit, recovery preserves current state.

Automatic updates start disabled. Configure trust and private-repository credentials explicitly, check the offered release, then enable the six-hour timer. Stop/kill intent survives updates and reboot. Pinning holds an exact version; disabling the timer leaves manual updates available.

## Operator commands

```bash
sudo agent update configure --root-file /secure/root.json --token-file /secure/github.token
sudo agent update check
sudo agent update enable
sudo agent update status
sudo agent update disable
sudo agent update pin 0.0.2
sudo agent update unpin
sudo agent update
sudo agent update rollback
```

Use the installed name, such as `bob`, instead of `agent`. The repository is fixed to `francman/unit-001`. The GitHub token needs read access to release assets; it is copied into a root-only file, never passed as a token argument or stored in the agent environment. Bootstrap `root.json` must come from a separately trusted operator channel. Downloading it beside an unverified archive does not establish trust.

The updater retains its own Node runtime, dependencies and previous recovery core. If the application launcher or runtime is broken, use `sudo /usr/local/sbin/unit-001-update UUID status` or `recover`. Obtain the UUID from the installation record under `/etc/unit-001/agents`. Recovery units run before and after application startup to repair interrupted activation.

If the selected updater itself fails, invoke the retained recovery core directly: `sudo /usr/lib/unit-001/updaters/UUID/recovery/runtime/bin/node /usr/lib/unit-001/updaters/UUID/recovery/lib/update.mjs --id UUID recover`. Use `rollback` there to return compatible code to the previous version. New updater releases must preserve the retained core's ability to read the activation journal.

If an operator stopped the agent during an interrupted update, recovery preserves that intent. Use `sudo agent update recover --start` when explicitly ready to recover and resume it.

## Compatibility and rollback

Version `0.0.2` introduces the maintenance protocol. Install this baseline manually before enabling automatic updates on an older installation. This slice supports the default managed session only; additional session databases defer updates.

Releases declare state format, minimum reader and maintenance-protocol versions. Unsupported declarations hold for operator review. A release number alone never proves state compatibility. Explicit rollback drains again and changes compatible code while preserving current credentials, workspace and durable state. It never restores a historical backup after new work has been allowed to execute.

Rollback pins the selected previous version before activation so the next timer check cannot reinstall the rejected release. The pin remains if rollback fails. Inspect `update status`, recover as needed, and explicitly `unpin` when ready to follow stable again.

Snapshots contain private agent data and remain root-protected. They are recovery material, not a replacement for off-host backups. The updater cannot undo an external effect already made by a tool.

State backup includes the workspace, so downtime depends on its size. Free-space checks can defer an update. Administrative operations share a lock; a stop or kill attempted during activation reports a busy operation and must be retried. Old application releases remain available for compatible rollback; monitor host disk usage. Updater cores retain only the selected current, previous and recovery versions, preserving unexpected files for inspection.

## Publishing and key custody

The [publication workflow](../../../.github/workflows/unit-publish.yml) builds from trusted main and publishes immutable versioned archives with signed TUF metadata. TUF verifies signatures, expiry, lengths and hashes, and rejects metadata rollback. Clients support only top-level targets, without delegated signing roles.

Create keys explicitly with `node apps/unit-001/scripts/update-repository.mjs keygen --out /secure/unit-update-keys`; keep the root private key offline. Configure the `unit-release` environment with `UNIT_UPDATE_ROOT_JSON` and separate `UNIT_UPDATE_TARGETS_KEY`, `UNIT_UPDATE_SNAPSHOT_KEY`, and `UNIT_UPDATE_TIMESTAMP_KEY` secrets. These are publication credentials, separate from each host's read-only token. Root rotation requires signatures from both the old and new root authorities.

Only trusted release maintainers should control that environment: its online keys authorize software that the privileged updater will execute. During root rotation, also supply the approved old root as `UNIT_UPDATE_PREVIOUS_ROOT_JSON`, update the root and online keys together, then publish or renew. Rotate one root version at a time and clear the previous-root variable after successful publication. Verification tries current trust first, so subsequent renewals also work while that variable remains set.

The workflow renews metadata every six hours without rebuilding application code. Timestamp metadata expires after 48 hours; environment approval rules must permit timely renewal. Expired or unavailable metadata fails closed and leaves the installed agent running. Publish through the serialized workflow: GitHub release assets do not provide atomic compare-and-swap publication. Numbered receipts preserve recovery from interrupted timestamp replacement.

After the initial successful publication, set repository variable `UNIT_UPDATES_ENABLED=true` to activate scheduled renewal. It defaults off. Retention runs only after freshness is published and read back: signed metadata remains until expiry plus seven days, with retained dependency chains and every root preserved. Unknown assets remain for operator inspection. This avoids exhausting GitHub's [1,000 assets per release](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) during ordinary renewal. Archive history is retained; reaching the client's 4 MiB targets-metadata limit requires a reviewed repository migration.

Investigate failed publication jobs. A failure during retention can occur after the new timestamp is already live; inspect the reported step before retrying. Unexpected numbered metadata stops cleanup rather than authorizing deletion, so remove such assets only after operator review.

Production keys, the protected environment and the initial signed feed must be configured before continuous delivery is live. Merging the code does not provision those secrets or enable a host timer. See the [application comparison](update-assessment.md) for the design evidence.
