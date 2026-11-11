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

The 0.0.6 updater retains the existing systemd definition when installing 0.0.7. Bob's private owner and automatic updates remain available, but normal-user operator access needs a one-time administrator step: `sudo bob stop`, `sudo bob operator add USER`, then `sudo bob start`. Reconnect SSH afterward. Only the missing runtime directory permits this compatibility path; an existing directory with unsafe ownership, mode or a symlink is rejected. Explicit 0.0.7-to-0.0.6 rollback restores the exact known legacy service definition before the old owner starts. General service-template evolution remains follow-up work in #18.

Releases declare state format, minimum reader and maintenance-protocol versions. Unsupported declarations hold for operator review. A release number alone never proves state compatibility. Explicit rollback drains again and changes compatible code while preserving current credentials, workspace and durable state. It never restores a historical backup after new work has been allowed to execute.

Rollback pins the selected previous version before activation so the next timer check cannot reinstall the rejected release. The pin remains if rollback fails. Inspect `update status`, recover as needed, and explicitly `unpin` when ready to follow stable again.

Snapshots contain private agent data and remain root-protected. They are recovery material, not a replacement for off-host backups. The updater cannot undo an external effect already made by a tool.

State backup includes the workspace, so downtime depends on its size. Free-space checks can defer an update. Administrative operations share a lock; a stop or kill attempted during activation reports a busy operation and must be retried. Old application releases remain available for compatible rollback; monitor host disk usage. Updater cores retain only the selected current, previous and recovery versions, preserving unexpected files for inspection.

## Private testing

The previous private feed remains available for maintainers. `sudo agent update configure --root-file /secure/root.json --token-file /secure/github.token` selects that private path. Its download credential is stored root-only and never in the agent environment. Existing configured trust is preserved. This is an advanced testing option, not part of public installation.

## Publishing and key custody

This section is for maintainers. Users do none of these steps.

Create `francman/unit-001-releases` as a public releases-only repository with an initial README commit. Keep the private source repository's visibility and Git history unchanged. The public repository needs that initial commit before GitHub can create release tags.

GitHub Actions is disabled for this project, including manual, scheduled and self-hosted Actions. Workflow files remain inert historical definitions; they are not publication or renewal infrastructure. GitHub release assets and APIs still host the public feed. A trusted maintainer builds exact merged-main source on an isolated Linux build host, then uses the existing local publisher. See [standalone verification](operations.md#standalone-verification) for commands and required evidence.

The source repository stays private. TUF verifies signatures, expiry, lengths and hashes, and rejects metadata rollback. Clients support only top-level targets, without delegated signing roles.

Create keys explicitly with `node apps/unit-001/scripts/update-repository.mjs keygen --out /secure/unit-update-keys`; keep the root private key offline. Store the approved public root and online targets/snapshot/timestamp keys in protected maintainer storage, outside builds and downloads. The local GitHub credential needs Contents write access to the public releases repository; users never receive it. Do not copy a broad personal credential or private signing keys into a build container. Root rotation requires signatures from both the old and new root authorities.

Only trusted release maintainers should control online signing storage: its online keys authorize software that the privileged updater will execute. During root rotation, pass the approved old root with the publisher’s `--previous-root` option, update the root and online keys together, then publish or renew. Rotate one root version at a time and stop passing the previous root after successful publication. Publish a fresh bundle carrying the new root before the previously bundled root expires, so new downloads remain installable. Verification tries current trust first, so subsequent renewals also work while the previous root remains supplied.

Renewal currently requires a trusted standalone maintainer invocation; no replacement automatic schedule has been established. Timestamp metadata expires after 48 hours. Run `node apps/unit-001/scripts/update-repository.mjs renew --out RENEWAL --root APPROVED_PUBLIC_ROOT --keys PROTECTED_ONLINE_KEYS`, then `node apps/unit-001/scripts/update-repository.mjs publish --out RENEWAL/publication --root APPROVED_PUBLIC_ROOT`. Do not enable Actions or its old renewal variable to solve this gap. Expired or unavailable metadata fails closed and leaves the installed agent running. Serialize every publisher: GitHub release assets do not provide atomic compare-and-swap publication. Numbered receipts preserve recovery from interrupted timestamp replacement.

Retention runs only after freshness is published and read back: signed metadata remains until expiry plus seven days, with retained dependency chains and every root preserved. Unknown assets remain for operator inspection. This avoids exhausting GitHub's [1,000 assets per release](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) during ordinary renewal. Archive history is retained; reaching the client's 4 MiB targets-metadata limit requires a reviewed repository migration.

Investigate failed publication commands. A failure during retention can occur after the new timestamp is already live; inspect the reported step before retrying. Unexpected numbered metadata stops cleanup rather than authorizing deletion, so remove such assets only after operator review.

Production keys, protected maintainer storage and the initial signed feed must be configured before the public download is live. Merging the code does not provision those secrets or publish a download. Once published, the bundle configures users' trust and update policy automatically. See the [application comparison](update-assessment.md) for the design evidence.
