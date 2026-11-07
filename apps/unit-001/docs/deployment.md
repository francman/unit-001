# Install and run your agent

Use **Ubuntu Server 24.04 LTS, x86-64**, on an always-on machine or VM. The release includes Node 24 and locked dependencies; no separate Node, compiler, GPU, or database server is required.

For Amazon Lightsail, use the [VPS setup guide](lightsail.md) and run the bundled `check-vps.sh` before installing.

1. Verify the downloaded archive's checksum, extract it, and run `sudo ./install.sh`. The command defaults to `agent`; use `sudo ./install.sh --name bob` for `bob` instead. Existing command names are never overwritten.
2. Run `sudo agent login anthropic` (or `openai`), then `sudo agent start`.
3. Submit work with `sudo agent send "your task"`; inspect it with `sudo agent service-status`.
4. Use `sudo agent stop`, `kill`, or `uninstall`. Each asks for confirmation. For unattended use, append `--yes` and use `sudo -n` so authorization failure cannot prompt.

Each agent has its own stable ID, account, service, sessions, credentials, and workspace. Renaming preserves that identity. Stop/kill remains effective until an explicit start. Uninstall preserves data, configuration, and account ownership, and leaves another agent's software untouched.

Persistent hosting and submitted work are implemented. The [independent updater](updates.md) adds authenticated releases and recovery; configure signing and host trust before enabling its timer. Autonomous mission decisions and memory remain roadmap work.

See [operations](operations.md) for configuration, rename, upgrades, and recovery.
