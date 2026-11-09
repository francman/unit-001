# Run a named agent on Lightsail

**Check [public release availability](https://github.com/francman/unit-001-releases/releases) before installing.** The commands below require an initially published signed release; see the [download flow](distribution.md). VPS acceptance also needs an authenticated AWS profile, a chosen deployment region, and an explicitly approved target host.

Choose Linux/Unix → OS only → [Ubuntu 24](https://docs.aws.amazon.com/lightsail/latest/userguide/compare-options-choose-lightsail-instance-image.html), **x86-64**. The initial sizing assumption is **2 GB RAM**, not a measured minimum. Keep the instance running.

Restrict TCP 22 to your administrator IPv4/IPv6 addresses in [each firewall](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-editing-firewall-rules.html); delete SSH rules for an unused address family and remove unwanted inbound rules. The agent uses a private Unix socket, so open no agent port. Allow outbound HTTPS for downloads, providers, and research. On IPv6-only hosts, verify those destinations and download redirects are reachable; the preflight does not test network access.

Replace the example key and host; verify the SSH host fingerprint through your trusted AWS access:

```bash
KEY=~/.ssh/lightsail.pem
HOST=203.0.113.10
chmod 600 "$KEY"
ssh -i "$KEY" ubuntu@"$HOST"
```

After publication, download directly on the server. No GitHub account, download token, or manual verification-key setup is required:

```bash
curl --fail --location --output unit-001-linux-x64.tar.gz \
  https://github.com/francman/unit-001-releases/releases/latest/download/unit-001-linux-x64.tar.gz
tar -xzf unit-001-linux-x64.tar.gz
cd unit-001-0.0.4-linux-x64
bash ./check-vps.sh
sudo ./install.sh --name bob
sudo bob setup
sudo bob service-status
```

Use the extracted release directory if its version differs. The installer verifies its payload; bundled public trust configures automatic updates, which begin when the service starts. Setup guides provider sign-in or API key entry, model selection, and optional service start. The protected provider environment remains available as described in [operations](operations.md).

For acceptance on the approved host, record the UUID printed by installation; substitute it for `UUID`:

```bash
ID=UUID
sudo journalctl -u "unit-001@$ID.service" -n 50 --no-pager
sudo bob stop
sudo install -d -m 0700 /var/backups/unit-001
sudo tar -C / -czf "/var/backups/unit-001/$ID-$(date +%Y%m%d-%H%M%S).tgz" "var/lib/unit-001/agents/$ID" "etc/unit-001/agents/$ID"
sudo bob start
sudo reboot
```

After reconnecting, run `sudo bob service-status` and inspect logs again. Backups contain credentials; keep them protected and copy them securely off-host. Only back up closed SQLite state. See [operations](operations.md) for upgrades, isolation, and recovery.
