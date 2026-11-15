# Standalone signing-metadata renewal

Run renewal on a separate trusted Linux publisher host, twice daily. The provided systemd service renews the existing signed release, verifies the public metadata anonymously and records `last-success.json`. It never builds software or changes the agent VPS. Users still download one bundle without keys or accounts.

The templates are not installed yet. Activation needs a publisher host and a credential restricted to Contents write on `francman/unit-001-releases`. Keep the three online signing keys there; keep the root private key offline. GitHub Actions remains prohibited. A host unavailable for 48 hours can leave the feed expired; installed agents keep running and reject stale updates.

## Provision the publisher

Use a dedicated `unit-publisher` account, trusted Node >=22.19, `gh`, `flock` and a reviewed source checkout with `npm ci --ignore-scripts`. Keep immutable reviewed code under `/opt/unit-001-publisher/versions/COMMIT` and make `current` select it. The account must read that code but cannot modify it. This is a signing host, never an untrusted build or agent tool environment.

Create these paths through administrator-controlled provisioning:

| Path | Ownership and contents |
|---|---|
| `/etc/unit-001-publisher/root.json` | Root-owned approved public root, unchanged bytes |
| `/etc/unit-001-publisher/online-keys` | Root-owned directory, publisher can traverse; only `targets.pem`, `snapshot.pem`, `timestamp.pem`, each publisher-owned mode 0600 |
| `/etc/unit-001-publisher/credential` | Root-owned mode 0600; `GH_TOKEN` restricted to the public release repository |
| `/var/lib/unit-001-publisher` | Publisher-owned mode 0700; lock, temporary downloads and last successful receipt |

Do not put `root.pem` on this host, copy a broad personal token, or pass token values in process arguments. The service receives the protected credential through systemd. Keep signing material outside the checkout and all downloadable artifacts.

Install the reviewed [service](https://github.com/francman/unit-001/blob/main/apps/unit-001/maintainer/unit-001-metadata-renewal.service) and [timer](https://github.com/francman/unit-001/blob/main/apps/unit-001/maintainer/unit-001-metadata-renewal.timer) under `/etc/systemd/system`. Their code path assumes the layout above. Verify the units on that host, reload systemd and run the service once before enabling its timer:

```bash
sudo systemctl daemon-reload
sudo systemctl start unit-001-metadata-renewal.service
sudo systemctl status unit-001-metadata-renewal.service
sudo systemctl enable --now unit-001-metadata-renewal.timer
systemctl list-timers unit-001-metadata-renewal.timer
```

The timer uses UTC calendar times with up to 15 minutes jitter and persistent catch-up. The service has a 20 minute timeout that terminates its whole service cgroup. These templates still require actual target-host activation acceptance; shell tests do not establish a running schedule.

## Serialization and evidence

Every manual publisher on this host must acquire the same `/var/lib/unit-001-publisher/publication.lock` with `flock`, as the scheduled wrapper does. Do not run another publisher host concurrently. A process exit releases the lock; never delete a lock file to force publication. Existing stale-state checks remain an additional safeguard, not an atomic cross-host lock.

A run downloads and authenticates the current release, prepares higher metadata versions, publishes freshness last, then verifies the public timestamp, snapshot, targets and stable descriptor. The receipt includes observation time, expiry, source and archive hash. It explicitly says `metadataOnly`: archive download equality and installation remain separate release checks. The wrapper removes scratch archives on ordinary exit and removes a killed predecessor's protected scratch directories after acquiring the lock on its next run. It replaces the last successful receipt only after exact prepared/public timestamp equality.

Inspect failures with `journalctl -u unit-001-metadata-renewal.service` and the age of `last-success.json`. No external notification channel is configured. After a failure, inspect the public feed before retrying: publication may have succeeded before readback or retention failed. Root rotation remains a separate reviewed maintenance operation. To suspend renewal, disable the timer; keep the current release and signing files intact.
