# Open a remote agent in your local terminal

Remote sessions keep the editor and rich interface on your computer. The existing remote owner keeps its provider credentials, memory, SQLite and running work. Detaching leaves it running.

Requires a macOS or Linux source client, OpenSSH, and a running managed installation with operator access. The existing Linux server release does not install a macOS client. Build the source client as described in the README, then use:

```bash
node apps/unit-001/dist/bin.js remote add work --host unit-01 --agent agent
node apps/unit-001/dist/bin.js remote connect work
```

`unit-01` is an alias you already configured in `~/.ssh/config`; `agent` is the installation's command name. For a named installation, pass its actual name. Verify the SSH host identity and make key authentication work first. Use an alias without additional LocalForward, RemoteForward or DynamicForward entries. Remote commands never prompt for SSH passwords or accept unknown host keys.

```bash
node apps/unit-001/dist/bin.js remote list
node apps/unit-001/dist/bin.js remote connect work --session research
node apps/unit-001/dist/bin.js remote connect work --plain
node apps/unit-001/dist/bin.js remote status work
node apps/unit-001/dist/bin.js remote send work --request-id review-1 -- "Review the deployment"
node apps/unit-001/dist/bin.js remote cancel work
node apps/unit-001/dist/bin.js remote remove work
```

Session selection attaches to an already running owner; it does not create one. `/memory` works through that owner. Removing a bookmark affects only your computer. Bookmarks live in your per-user unit-001 data directory, under `remotes`, with private permissions and no keys.

The client reconnects observations up to five times per outage and preserves the draft. It never automatically retries prompts, memory edits or cancellation. If a reply is lost, retain the printed request ID, inspect the owner, and explicitly retry the same prompt with that ID. The rich terminal keeps unconfirmed IDs visible, lists them with `/status`, and prints them when detaching. A fresh send with a new ID is new work.

The SSH user needs the installation's operator group; an administrator grants it once with `sudo agent operator add USER`. A fresh SSH connection picks up the group. Remote chat has the same trusted coding-tool authority as that operator, including file access; it is separate from restricted messaging integrations. The SSH account and its configuration remain trusted.

No agent TCP listener, remote terminal, sudo, agent forwarding, X11 forwarding or copied provider keys are used. SSH forwards a private local Unix socket to the installation's UUID-bound operator socket. The UUID remains pinned after renaming the installation. Changed SSH host keys and mismatched installation IDs are refused.

If connection fails, check the owner is running, the selected session exists, operator access is granted, and SSH permits local Unix-socket forwarding. Some OpenSSH versions also require their default `AllowTcpForwarding` policy for Unix forwarding. The client does not alter SSH server policy. See the [implementation and local verification](remote-sessions-implementation.md).
