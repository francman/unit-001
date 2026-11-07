# Run a named agent on Lightsail

Choose Linux/Unix → OS only → [Ubuntu 24](https://docs.aws.amazon.com/lightsail/latest/userguide/compare-options-choose-lightsail-instance-image.html), **x86-64**. Start with **2 GB RAM provisionally**; this is not a benchmark or minimum. The preflight checks architecture. Keep the instance running.

Restrict TCP 22 to your administrator IPv4/IPv6 addresses in [each firewall](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-editing-firewall-rules.html); delete SSH rules for an unused address family and remove unwanted inbound rules. The agent uses a private Unix socket, so open no agent port. Allow outbound HTTPS for your provider.

From a trusted release directory, replace the key/IP below; verify the SSH host fingerprint through your trusted AWS access:

```bash
KEY=~/.ssh/lightsail.pem
HOST=203.0.113.10
chmod 600 "$KEY"
scp -i "$KEY" unit-001-0.0.1-linux-x64.tar.gz{,.sha256} ubuntu@"$HOST":
ssh -i "$KEY" ubuntu@"$HOST"
```

On the server:

```bash
sha256sum --check unit-001-0.0.1-linux-x64.tar.gz.sha256
tar -xzf unit-001-0.0.1-linux-x64.tar.gz
cd unit-001-0.0.1-linux-x64
bash ./check-vps.sh
sudo ./install.sh --name bob
sudo bob login anthropic
sudo bob start
sudo bob service-status
```

Use `openai` instead, or the protected provider environment described in [operations](operations.md). Record the UUID printed by installation; substitute it for `UUID`:

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
