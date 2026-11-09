# Install and run your agent

Use **Ubuntu Server 24.04 LTS, x86-64**, on an always-on host. The bundle includes Node 24 and dependencies; no separate Node, npm or database installation is required.

For Lightsail, follow the [VPS guide](lightsail.md) and run `bash check-vps.sh` first.

1. [Download](distribution.md), extract, and run `sudo ./install.sh`. Add `--name bob` to name the agent Bob; the default is `agent`.
2. Run `sudo agent setup` to select a provider/model, sign in or enter a key, and start the service.
3. Reconnect SSH to refresh the new operator group. Existing installations first need `sudo agent operator add USER`.
4. Use `agent` for the terminal interface, `agent send "your task"` for scripts, `agent status` for runtime facts, and `agent memory stats` for memory.
5. Use `sudo agent stop`, `kill`, or `uninstall` for service administration. Confirmation defaults to No; automation uses `sudo -n` with `--yes`.

Each installation has its own account and private state. Stop/kill persists until explicit start; uninstall retains data and credentials.

Memory edits need no sudo; forgetting still asks for confirmation. Configuration, credentials, identity, access and updates require sudo. Operators retain the agent's coding-tool file authority; this is not a tool sandbox.

Public signed bundles include verification keys and update settings automatically. Updates preserve stopped intent. Autonomous mission decisions remain separate work.

See [operations](operations.md) for configuration, rename, upgrades, and recovery.
