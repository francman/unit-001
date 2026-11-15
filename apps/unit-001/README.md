# unit-001

A durable agent built on [Pi Durable](../../packages/durable). Its conversation lives in a SQLite file, so a process that stops, crashes, or is killed resumes unfinished work the next time it starts.

## Design goals

- **Always on and mission-driven.** The mission is the agent's enduring purpose, agreed with its creator. The agent proactively chooses tasks toward it, executes, verifies results, and adapts without waiting for another user prompt. A finished task or suspended execution does not end the mission. Purpose and unfinished work survive restarts. The agent asks for input when a decision exceeds its authority or requires missing information.
- **Simple to download and install.** One public download includes the runtime, dependencies and update verification keys. Users need no GitHub account, download credentials, signing keys or manual trust configuration. Model-provider sign-in remains separate.

The launcher resumes interrupted runs and retains session memory. Source includes a bounded execution engine; continuous work selection under an enduring mission remains to be built. The [purpose and work contract](docs/missions/purpose.md) defines that distinction and the required correction.

## Design tenets

- **Keep upstream Pi implementation unchanged.** Build on Pi Durable through its public APIs. Unit-specific work belongs in `apps/unit-*` and `packages/unit-*`. The upstream guard permits only the root product README and dependency lockfile as exceptions; it still rejects upstream implementation edits. The original Pi README is preserved in the root README's collapsed reference. Raise missing capabilities upstream instead of patching Pi locally.
- **Keep response latency minimal.** Keep recall, prompt assembly, hooks, and checkpoint commits within measured latency budgets. Run slow work, such as memory extraction and consolidation, in resumable background tasks so it does not delay responses.

The upstream guard and checkpoint/request-preparation benchmark budgets are in place. Memory recall uses an in-process lexical index; extraction and consolidation run as durable background tasks.

## Requirements

- Managed installation: Ubuntu Server 24.04 LTS, x86-64; the release includes Node 24
- Source development: Node.js 22.19 or later on macOS, Linux, or Windows
- A model provider: a Claude or ChatGPT subscription, or an API key

## Start it

Use the [one-minute deployment guide](docs/deployment.md). The default command is `agent`; `install.sh --name bob` creates `bob` instead. Each name is bound to a stable installation ID and its own account, service, credentials, sessions, and workspace. Releases can be shared between agents.

```bash
sudo agent setup                 # provider, sign-in or API key, model, optional service start
agent attach                    # authorized operator client of the running owner
agent send "Inspect the working repository"
agent status
sudo agent stop                 # asks for confirmation
sudo -n agent stop --yes        # no action or sudo prompt; fails if unauthorized
```

A new sudo installation grants its caller operator access; reconnect SSH to refresh groups. Existing installations need `sudo agent operator add USER` once. Normal commands and memory edits need no sudo; configuration, credentials, access, identity, lifecycle and updates remain privileged. Operators retain the agent's coding-tool file authority; see [access and its limits](docs/operations.md#operator-access-and-sudo).

`kill` immediately terminates the owned service and its tools. `uninstall` removes the installation's software while preserving its data and account. Both ask for confirmation and accept `--yes`. Stopped agents remain stopped until an explicit `start`; confirmation never silently succeeds without a terminal. See [operations](docs/operations.md) for rename, removal, and recovery.

Public releases require no GitHub account, download token, or manual verification-key setup. The signed bundle includes its public update trust and configures automatic updates; they start when you start the agent. Existing update preferences survive upgrades. See the [download flow](docs/distribution.md) and [one-minute update overview](docs/updates.md). Version 0.0.8 adds bounded, explicitly authorized work; continuous purpose-driven planning remains unfinished.

`attach` opens a full-screen terminal with Markdown conversation, live tool status, model/usage metadata, and a multiline composer. Enter sends; Ctrl+J inserts a newline. `/exit` or an SSH disconnect leaves work running; `/cancel` cancels shared work. Use `attach --plain` for basic terminals and `send` for pipes. Foreground chat remains separate. See [terminal behavior and comparison](docs/terminal.md) for controls, bounded history, cost estimates, and remaining gaps.

Use `/memory` in the terminal interface or `agent memory stats` to inspect structured memory. `recall`, `remember`, confirmed `forget`, and `sleep` operate through the running owner without a model request. Memory survives restarts within one session; separate sessions and installations stay isolated. See the [one-minute memory guide](docs/memory.md).

A macOS or Linux source client can open the same rich interface against a named remote installation: `remote add work --host unit-01 --agent agent`, then `remote connect work`. Provider credentials and storage stay with the remote owner. See [remote sessions](docs/remote-sessions.md) for client requirements, SSH trust and reconnect behavior.

## Subscriptions

In release `0.0.4` and later, `sudo agent setup` guides provider selection, subscription sign-in or hidden API key entry, and default-model selection. It preserves existing credentials unless you choose replacement. The installed command offers to start a stopped service after setup succeeds; a running service needs a stop and start to apply changed settings. Setup requires an interactive terminal and makes no paid model request. Source use supports `setup` without service management.

`sudo agent login anthropic` (Claude Pro or Max) and `sudo agent login openai` (ChatGPT Plus or Pro) open the provider's sign-in flow, with a paste-the-code fallback for machines without a browser. `sudo agent logout <provider>` removes a sign-in; `sudo agent status` reports provider configuration without secrets. Normal `agent status` reports the running owner. Authentication commands drop to the agent account; operator clients keep the caller's UID. Tokens refresh automatically in the owner.

Sign-ins are stored in `auth.json` in the data directory, readable only by the agent account (mode 0600 on macOS and Linux; on Windows it inherits your profile directory's access rules). A stored sign-in wins over an API key for the same provider.

Whether a provider lets third-party tools use a subscription is that provider's policy and has changed before; check the current terms of your plan before relying on it.

## Configuration

| Setting | Meaning |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | A provider is used when you are signed in to it or its key is set, checked in this order; the first picks the provider and its default model |
| `UNIT_001_MODEL` | `provider/model-id`; set in the named agent's environment file and restart the service |
| Saved setup model | Stored in `settings.json` beside credentials; used when neither `--model` nor `UNIT_001_MODEL` is set |
| Source CLI `--model` | Explicit `provider/model-id`, overriding `UNIT_001_MODEL` and the saved setup choice |
| Source CLI `UNIT_001_HOME` or `--data-dir` | Where development sessions are stored; the flag wins |

Managed paths come from the installation record; caller-supplied paths cannot redirect a named agent. Its state is under `/var/lib/unit-001/agents/<id>` and root-owned configuration under `/etc/unit-001/agents/<id>`. The installer reports the ID and configuration path.

For source use without `UNIT_001_HOME`, sessions live under `%APPDATA%\unit-001` on Windows, `~/Library/Application Support/unit-001` on macOS, and `$XDG_DATA_HOME/unit-001` (default `~/.local/share/unit-001`) elsewhere, one SQLite file per session.

The model is applied on every launch, so changing provider keys never strands an existing session. One process may run a session at a time; a second gets a clear error, and a lock left by a crashed process is taken over.

Exit codes: 0 success, 1 failed run or configuration problem, 2 usage error, 130 stopped by a signal. A graceful service shutdown exits 0 and preserves unfinished work.

## Develop

```bash
npm ci --ignore-scripts
node apps/unit-001/scripts/hydrate-model-data.mjs
npm run build:offline
npm run build --workspace apps/unit-001      # tsc to dist/
npm run typecheck --workspace apps/unit-001
node apps/unit-001/dist/bin.js --help
node apps/unit-001/dist/bin.js -p "what changed?"
```

Source execution also supports interactive chat, provider login, `--session`, and piped prompts with `-p -`. It uses the current directory and Pi Durable's coding tools; Windows additionally has PowerShell. `/help` lists chat commands and Ctrl+C stops a run. Source use has no managed installation to rename or uninstall. No global `u1` or `unit-001` command aliases are installed.

The tests use Pi's faux provider and real SQLite, including process-kill recovery, named installation isolation, and lifecycle operations with mocked system commands. See [AGENTS.md](../../AGENTS.md) for the permitted test commands.

Unit verification combines exact model data from a reviewed public release with one explicitly allowed historical Fireworks identity from an immutable upstream catalog, pinned in `model-data-pin.json`; it never regenerates model types from moving catalogs. `hydrate-model-data.mjs --archive PATH` reuses a verified release download; the historical catalog still downloads. This pin preserves existing fixtures, not a guarantee that a provider still serves every listed model. Updating it requires a reviewed pin change and all existing checks.

## Layout and upstream updates

`apps/unit-001` contains the launcher, operator interfaces, deployment and update infrastructure. `packages/unit-*` contains Unit-owned reusable packages, including memory. `reference/` holds local research checkouts; keep them out of Git through `.git/info/exclude`.

Fetch upstream with `git fetch upstream-pi --tags`. Review an upstream release tag and merge that tag into an isolated integration branch; do not track upstream's moving main branch. Keep Unit changes within the owned paths above. If dependency metadata conflicts, preserve the reviewed exact versions and regenerate `package-lock.json` with `npm install --package-lock-only --ignore-scripts`; review the result rather than hand-editing lock entries.

Before accepting an upstream release, check every persisted document version and registered task checkpoint against stored sessions. Add explicit migrations where needed, then verify SQLite reopen, interrupted-task recovery and the release's declared reader compatibility. Run the full checks and relevant local tests; Actions remains disabled. A passing build alone does not prove stored work can resume.

## Design attribution

The memory design draws on [Mnemosyne](https://github.com/mnemosyne-oss/mnemosyne) and [omp's mnemopi](https://github.com/can1357/oh-my-pi/tree/88a69582c755bd000e8dc0290981fc787a4f400c/packages/mnemopi) TypeScript adaptation. Both are MIT-licensed; their tiering, recall and consolidation patterns informed Unit's implementation rather than replacing Pi Durable's storage. See the [port specification](docs/memory/port-spec.md) for source provenance and differences, and [reference practices](docs/memory/reference-practices.md) for later comparisons.
