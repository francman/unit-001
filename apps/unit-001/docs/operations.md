# Named agent operations

Read the [one-minute overview](deployment.md) first. Managed installations target Ubuntu Server 24.04 LTS on x86-64. Source development remains available on macOS, Linux, and Windows.

## Build and verify a release

From the repository root, with network access, `curl`, and `tar` available:

```bash
npm ci --ignore-scripts
node apps/unit-001/scripts/build-release.mjs --out .artifacts/unit-001-release
```

The builder hydrates Pi model data, compiles the app and required Pi packages, installs locked production dependencies without lifecycle scripts, and bundles a pinned Node 24 runtime. It verifies Node's checksum and hashes the complete payload. This development build stays unconfigured. Public production builds also pass `--update-root /secure/root.json`; the separate publication workflow supplies that approved public metadata automatically. The installer then configures public updates without asking users for keys or credentials. See [continuous updates](updates.md) for maintainer setup and recovery.

Download the public Linux archive from the [stable download channel](distribution.md). For the current app version:

```bash
tar -xzf unit-001-linux-x64.tar.gz
cd unit-001-0.0.7-linux-x64
sudo ./install.sh
```

Use your release's extracted directory if its version differs. The installer verifies its complete file inventory. The trusted public download channel establishes which installer you initially receive; the bundled public root authenticates future updates. `--dry-run` verifies without installing. `--root DIRECTORY` stages an image without creating host accounts or managing host services. Symlinked destination ancestors are rejected.

## Choose a name and configure a provider

The default command is `agent`. `sudo ./install.sh --name bob` chooses `bob`. Names must be safe command names without collisions; the installer never silently substitutes a name or overwrites another command. No `u1` alias is installed.

Each installation gets a UUID and dedicated unprivileged account. Its root-owned record is under `/etc/unit-001/agents/<id>`; private sessions, credentials, and workspace are under `/var/lib/unit-001/agents/<id>`. Its selected release pointer is under `/opt/unit-001/agents/<id>`. Release files can be shared while data and process ownership remain separate.

Run `sudo agent setup` for guided provider selection, subscription login or hidden API key entry, and model selection. The chosen model is saved in the agent-owned `settings.json`. Command-line `--model` and the administrator's `UNIT_001_MODEL` override it. No paid request is made during setup. Successful setup offers to start a stopped service; changing a running service requires a stop and start. Cancellation never starts the service. Guided setup is available in release `0.0.4` and later; the individual login and start commands below remain available.

Finish or cancel setup before issuing another installation, update, stop or kill command. Setup holds the management lock while credentials and settings change, so those operations report busy. An interrupted update must be recovered before setup can begin.

The installer reports the ID and configuration path. Complete sign-in before starting:

```bash
sudo agent login anthropic
sudo agent start
agent service-status
agent send "Inspect the working repository"
```

Use `openai` for ChatGPT sign-in. API keys and `UNIT_001_MODEL=provider/model-id` can instead go in the agent's root-owned `environment` file; keep it mode `0600` and restart after changes. Subscription login and refresh still require verification with your provider account.

Even through `sudo`, application commands drop to the recorded agent account before accessing credentials or executing tools. Only administrative lifecycle operations retain root. A named command's environment or data-path arguments cannot redirect it to another installation.

`send` contacts the existing owner, never a second SQLite writer. For a leading-hyphen prompt, use `agent send -- "- explain this failure"`. Use `--request-id` when retrying after a disconnected client to avoid duplicate admission.

For interactive use, run `agent` or `agent attach` in an SSH terminal. It shows bounded recent conversation and live progress without opening storage. `/exit`, EOF, and SSH disconnect detach; `/cancel` or Ctrl+C while busy cancels the shared session's run. Reattach after a service restart. Use `send` for pipes and scripts. See [terminal behavior](terminal.md) for output limits and shared-session controls.

## Operator access and sudo

| Normal authorized operator | Administrator with sudo |
|---|---|
| Chat, attach, send, cancel, runtime status, memory stats/recall/remember/forget/sleep | Install, setup, login/logout, model configuration, identity/access changes, start/stop/kill/uninstall, updates and maintenance |

Help and version are public. Normal `agent status` reports the running owner; `sudo agent status` retains the provider-configuration summary. Source `agent status` also retains that summary. Explicit foreground-owner options require administrator access on installed commands.

A new installation grants the nonroot account that invoked `sudo ./install.sh` membership in this installation's dedicated group. Reconnect SSH or log out and back in afterward. Direct-root installs and upgrades do not guess an operator. For an existing Bob installation:

```bash
sudo bob operator add ubuntu
# Reconnect SSH before running normal-user commands.
bob status
bob memory stats
bob
```

Use `sudo bob operator remove USER` to remove membership. Existing login processes retain their groups and connected clients remain attached until closed; end those sessions to complete revocation. Grants belong to one installation and survive rename and upgrades.

The operator client stays under the caller's UID and connects to `/run/unit-001-UUID/default.sock`. The directory is mode `0750`, owned by the service account and its dedicated group; the socket is `0660`. Private state remains `0700`, credentials `0600`, and the administrator socket stays inside private state at `0600`. The owner rejects maintenance and administrative messages on the operator socket. Clients never read provider environment/credentials, enter the private workspace, or open SQLite.

Grant access only to trusted operators. Their chat retains the existing coding tools, which can read or modify files accessible to Bob, including Bob-owned settings and credentials. OS permissions prevent direct client access; they do not sandbox tool execution. Administrative command checks do not constrain arbitrary work delegated to those tools.

## Stop, kill, and start

```bash
sudo agent stop
sudo agent kill
sudo -n agent stop --yes
sudo agent start
```

`stop` gracefully closes the harness and preserves unfinished work. `kill` immediately terminates the owned process group and tools; interrupted external effects may need reconciliation. Both preserve durable state and prevent reboot or updates from restarting the agent until explicit `start`.

`agent cancel` instead aborts the current run while leaving the service available. Durable memory maintenance remains background work. `service-status` reports identity, PID, release version, busy state, and observed owner-process start time/uptime. Logs belong to `unit-001@<id>.service` in the system journal. The host must stay on and awake for work to progress.

Stop, kill, and uninstall default to **No**. Decline or EOF makes no changes. Without a terminal, they require `--yes`; that skips action confirmation, not authorization. Use `sudo -n` or an already-root process for deterministic automation. There is no hidden privilege escalation.

## Rename and isolate agents

```bash
sudo agent rename bob
bob service-status
```

Rename preserves UUID, account, credentials, sessions, workspace, and service identity. It changes the command and record, then gracefully restarts a running service to refresh its cached name. No old-name alias remains. Collisions fail without overwriting their target; interrupted rename is recoverable from the authoritative record.

Install another unused name for another agent. Stopping, renaming, or uninstalling Bob must not affect Alice. Keep projects in the selected agent's workspace initially; external writable repositories need account permissions and a systemd write-path override. Project toolchains are separate from the bundled runtime.

## Uninstall and upgrade

```bash
sudo bob uninstall
sudo -n bob uninstall --yes
```

Uninstall disables the selected agent and any installed update/recovery scheduling before removing its owned command, service registrations, helpers, and release pointer. Failed stopping prevents removal. Data, credentials, configuration, workspace, and account ownership remain. Software referenced by another agent is preserved; unexpected files are reported rather than recursively erased. There is no data-purge mode.

Administrative operations share a process-released management lock. They use recorded installation ownership, never guessed PIDs, broad `pkill`, or deletion of the source checkout.

A failed first installation retains a stopped record so retrying the verified installer with the same `--name` reuses its UUID, account, and state. The command may be unavailable until activation succeeds; preserve the record and retry installation.

The management lock now lives under protected `/run/unit-001`. Older releases use a different lock path. Complete upgrades of all named installations before running their administrative commands concurrently; an old helper cannot coordinate with the new lock.

Before upgrading, stop the agent and back up its state directory while SQLite is closed. Verify and install the bundle under the same name, preserving identity. Keep a compatible previous release and state backup until verified. A running-service upgrade checks expected identity, version, and systemd PID within 30 seconds; failed readiness stops the candidate before restoring the previous release.

Rollback requires code that understands the stored documents and task checkpoints. Otherwise restore a matching closed-state backup. Never copy live SQLite without a SQLite-aware backup method or run two owners against one session.

## Scope

Named installations, submitted work, lifecycle controls, session memory and the independent update infrastructure are implemented. Published bundles configure host trust automatically. See [memory commands](memory.md) for inspection, capture, recall and confirmed forgetting. Autonomous mission decisions remain separate work in #14–#17. Old singleton installations are not automatically migrated. Source execution has no managed-system administrative behavior.
