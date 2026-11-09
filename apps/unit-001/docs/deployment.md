# Install and run your agent

Use **Ubuntu Server 24.04 LTS, x86-64**, on an always-on machine or VM. The release includes Node 24 and locked dependencies; no separate Node, compiler, GPU, or database server is required.

For Amazon Lightsail, use the [VPS setup guide](lightsail.md) and run the bundled `check-vps.sh` before installing.

1. Download the public Linux bundle, extract it, and run `sudo ./install.sh`. The installer verifies the bundled file inventory. The command defaults to `agent`; use `sudo ./install.sh --name bob` for `bob` instead. Existing command names are never overwritten. See [download availability](distribution.md) for the stable link and publication state.
2. Run `sudo agent setup` to choose a provider, sign in or enter an API key, select a model, and optionally start the service. Existing credentials can be kept. On release `0.0.3`, use `sudo agent login anthropic` (or `openai`), then `sudo agent start`; the guided setup arrives in the next release.
3. Submit work with `sudo agent send "your task"`; inspect it with `sudo agent service-status`.
4. Use `sudo agent stop`, `kill`, or `uninstall`. Each asks for confirmation. For unattended use, append `--yes` and use `sudo -n` so authorization failure cannot prompt.

Each agent has its own stable ID, account, service, sessions, credentials, and workspace. Renaming preserves that identity. Stop/kill remains effective until an explicit start. Uninstall preserves data, configuration, and account ownership, and leaves another agent's software untouched.

Public signed bundles include verification keys and update settings automatically; users do not configure signing keys or GitHub credentials. Updates begin with the normal agent start and preserve stopped intent. Maintainers must publish the initial signed release before the public download is live. Autonomous mission decisions and memory remain roadmap work.

See [operations](operations.md) for configuration, rename, upgrades, and recovery.
