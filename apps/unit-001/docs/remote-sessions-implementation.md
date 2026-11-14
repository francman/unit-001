# Remote session implementation and verification

Issue [#55](https://github.com/francman/unit-001/issues/55) adds a local client of an existing remote owner. It does not transfer ownership, expose administrator controls, or create another model runtime.

## Patterns taken from OMP

Reviewed [oh-my-pi at b9b3cc4](https://github.com/can1357/oh-my-pi/tree/b9b3cc4d69962e492197178155dd95216cd9c21b), including `remote-agent-session.ts`, `rpc-client.ts`, SSH CLI/controller, `join.ts`, `session.ts`, help and MIT license. OMP's `RemoteAgentSession` mirrors a local worker thread. Its named SSH host support runs remote tools; its collaboration relay and explicit session-move commands are separate mechanisms. Those are not evidence that OMP uses this exact SSH owner protocol.

The reused patterns are an explicit transport seam, named host selection, request IDs, and clear detach/owner semantics. This implementation copies no OMP source and adds no dependency or terminal engine.

## Boundaries

`remote/args.ts` exports the typed command catalog and exact parser. `remote/profiles.ts` validates and atomically creates per-user bookmarks: schema, label, SSH alias, installation UUID, session and display name. Files are private regular files, bounded to 64 KiB; symlinks, public permissions and duplicate identity replacement are rejected. Nothing is loaded from a project directory.

`remote/ssh.ts` launches `/usr/bin/ssh` with strict known-host checking, batch authentication, no connection sharing, no remote terminal, no agent/X11 forwarding, a bounded connect timeout and keepalives. Discovery runs only a validated and quoted `<agent> service-status --session <session>` command. Tunneling uses `-N` and a private temporary Unix socket; the remote socket is derived from UUID and validated session. Saved remote paths and arbitrary command strings are not accepted.

`remote/client.ts` checks the owner UUID through the existing status parser before admission and checks every streamed view. Renaming an installation does not require its old launcher command on reconnect. The SSH account authenticates normally and its fresh server-side groups control access to the existing 0660 operator socket. Private storage and administrator socket permissions remain unchanged.

`service-client.ts` adapts the existing protocol to the existing rich and plain interfaces. The owner remains authoritative for transcript, work status and memory. A reconnect retains the last view as stale under CONNECTING, preserves the editor, refuses writes until a fresh view, and discards queued cancellation and pending forget confirmation. Five attempts use bounded backoff. Writes remain single attempts; uncertain sends retain request IDs for explicit recovery. Detach closes client processes/sockets only.

Windows clients, automatic SSH key provisioning, remote session creation, relay transport, file transfer and narrowed messaging principals are outside this slice. SSH configuration is user-controlled and trusted, including identity helpers and jump hosts. The agent does not edit it.

## Local checks

Run root `npm run check`, the app typecheck and focused `remote-args`, `remote-profiles`, `remote-client`, `terminal-controller`, `terminal-ui`, `attach` and `service` tests. Build before tests that execute `dist`. No real provider or GitHub Actions is required.

The explicit acceptance fixture uses a disposable container: real OpenSSH, separate owner/operator/outsider users, real SQLite and the faux provider. It never reads the developer's SSH configuration or contacts production. From the repository root:

```bash
npm run build --workspace apps/unit-001
docker build -t unit-remote-ssh-test:20261111 - < apps/unit-001/test/fixtures/remote-ssh.Dockerfile
docker run -d --network none --name unit-remote-ssh-20261111 -v "$PWD:/repo:ro" -w /repo unit-remote-ssh-test:20261111 sleep infinity
docker exec unit-remote-ssh-20261111 node /repo/apps/unit-001/test/fixtures/remote-ssh-bootstrap.mjs
# Wait for /home/owner/state/default.ready and research.ready inside the container.
docker exec unit-remote-ssh-20261111 node /repo/apps/unit-001/dist/bin.js remote add fixture --host remote-fixture
docker exec unit-remote-ssh-20261111 node /repo/apps/unit-001/test/fixtures/remote-ssh-acceptance.mjs
cd apps/unit-001
node ../../node_modules/vitest/dist/cli.js --run --config test/remote-acceptance.config.ts
docker rm -f unit-remote-ssh-20261111
```

Acceptance checks discovery, session binding, memory, private DB denial, unauthorized operator denial, transport loss, no write replay, explicit same-ID retry, cancellation and changed-host-key refusal. Real tmux terminals check draft retention across loss/reconnect and 80×24 to 40×12 resize, a completed faux reply, detach, restored terminal modes and the still-running owner. The Docker/SSH test is explicit rather than part of the ordinary offline unit suite.

The same checks passed against the published `unit-001-0.0.7-linux-x64.tar.gz` archive (SHA256 `7c47febdc58f3e728fdb2dba90f9c50da4d3636ce3022d929f23bcefd54fae38`). Its bundled Node and unchanged app/SDK code ran the owner; only the faux-provider fixture harness came from this checkout. Mount the extracted release at `/published:ro`, use `--platform linux/amd64` for both Docker commands, and pass `--published-0.0.7` to bootstrap and acceptance. That mode also checks that unsupported mission requests leave status usable; the rich editor's initial mission probe does not cause reconnects. This is Linux x64 emulation on Docker Desktop, not native systemd acceptance.

OpenSSH 9.2's [session permission setup](https://github.com/openssh/openssh-portable/blob/V_9_2_P1/session.c#L314) shares forwarding permissions: `AllowTcpForwarding no` can also deny Unix forwarding despite `AllowStreamLocalForwarding yes`. Use an approved server policy; the product does not change it. The fixture uses the normal default forwarding policy and publishes no port.
