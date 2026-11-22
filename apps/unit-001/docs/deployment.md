# Install and run your agent

Use **Ubuntu Server 24.04 LTS, x86-64**, on an always-on host. The bundle includes Node 24 and dependencies; no separate Node, npm or database installation is required.

For Lightsail, follow the [VPS guide](lightsail.md) and run `bash check-vps.sh` first.

1. [Download](distribution.md), extract, and run `sudo ./install.sh`. Add `--name bob` to name the agent Bob; the default is `agent`.
2. Run `sudo agent setup` to select a provider/model, sign in or enter a key, and start the service.
3. Reconnect SSH to refresh the new operator group. For an existing installation, run `sudo agent stop`, `sudo agent operator add USER`, then `sudo agent start` first.
4. Use `agent` for the terminal interface, `agent web` for a paired private browser workspace, `agent send "your task"` for scripts, `agent status` for runtime facts, and `agent memory stats` for memory.
5. Use `sudo agent stop`, `kill`, or `uninstall` for service administration. Confirmation defaults to No; automation uses `sudo -n` with `--yes`.

Each installation has its own account and private state. Stop/kill persists until explicit start; uninstall retains data and credentials.

Memory edits need no sudo; forgetting still asks for confirmation. Configuration, credentials, identity, access and updates require sudo. Operators retain the agent's coding-tool file authority; this is not a tool sandbox.

Public signed bundles include verification keys and update settings automatically. Updates preserve stopped intent. Bounded work requires explicit creator authority; continuous work selection under an enduring mission remains unfinished. See the [purpose and work contract](missions/purpose.md).

See [operations](operations.md) for configuration, rename, upgrades, and recovery.

## Headless operation and recovery

The supported supervisor is **systemd on Ubuntu Server 24.04 LTS, x86-64**. Each installation runs as `unit-001@<id>.service` under its dedicated account, without terminal input. `sudo agent start` enables the unit for boot and starts it. The host must remain powered on and awake.

| Event | Configured behavior |
|---|---|
| Terminal exit, SSH disconnect or logout | The client detaches. The system service keeps running; reconnect with `agent` to inspect it. |
| Unexpected process failure | `Restart=on-failure` retries after five seconds. The new owner reopens durable state; it does not create a new mission or reset its allowances. |
| Repeated startup failures | The unit limits starts to five per 300 seconds. It can remain failed after hitting that limit; inspect the journal, correct the cause, then use `sudo agent start`. That command resets a failed unit before starting it and checks readiness. If that start itself fails, the installation is saved as stopped and the unit is disabled. |
| Machine reboot | A running installation's enabled unit starts at boot, ordered after `network-online.target`. Work cannot progress while the machine is off. Recovery observes stored deadlines and current authority. |
| `sudo agent stop` or `sudo agent kill` | Both save stopped installation intent and disable the unit. Logout, reboot and updates leave it stopped until explicit `sudo agent start`. Stop closes gracefully; kill can leave uncertain effects that require reconciliation. |
| `sudo agent mission stop` | Stops the bounded execution while leaving the service available. Restarting the service cannot resume that terminal execution. The agreed purpose remains saved. |

The unit allows 60 seconds for graceful shutdown before systemd can force termination. A clean process exit is not restarted by `Restart=on-failure`. Durable checkpoints preserve work, but neither the checkpoint nor a stored wake deadline restarts a dead process. An overdue wake is handled after the owner reopens; a future wake uses the saved deadline. Paused/stopped execution and invalid authority still prevent admission, and uncertain requests or tool effects can block recovery rather than being repeated.

Use `agent service-status` and `journalctl -u unit-001@<id>.service` to inspect recovery; use the installation ID reported by the installer. A live PID proves service availability, not mission progress. Check `agent mission status --json` for execution state, counters, blockers and the next wake.

These are the checked-in service and lifecycle policies. Faux-provider process fixtures cover persisted wake and sole ownership; they do not qualify systemd crash, logout or reboot behavior. The remaining [supervisor acceptance checks](missions/verification.md#native-supervisor-acceptance-for-16) require a disposable Ubuntu/systemd host before #16 can close.

The published 0.0.9 Linux x64 payload passed a controlled reboot after named stop on disposable Ubuntu 24.04.4 with systemd 255. The test installation remained stopped and disabled with PID 0 until explicit start. The same installation then passed readiness. The earlier native mission-recovery run used a source build and a local provider stub, so the next release candidate needs its own supervisor evidence. [Published baseline result](https://github.com/francman/unit-001/issues/16#issuecomment-7071745721)
