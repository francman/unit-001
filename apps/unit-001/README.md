# unit-001

A durable agent built on [Pi Durable](../../packages/durable). Its conversation lives in a SQLite file, so a process that stops, crashes, or is killed resumes unfinished work the next time it starts.

## Design goals

- **Always on and mission-driven.** Given a mission and operating boundaries, the agent proactively decides what to do next, executes, verifies results, and adapts without waiting for another user prompt. Missions and unfinished work must survive restarts. It asks for input when a decision exceeds its authority or requires missing information.

The current launcher resumes interrupted runs, but autonomous mission execution and persistent memory remain to be built.

## Design tenets

- **Keep upstream Pi unchanged.** Build on Pi Durable through its public APIs. Unit-specific work belongs in `apps/unit-*` and `packages/unit-*`; never modify upstream files. The upstream guard enforces this, with `package-lock.json` as the sole exception. Raise missing capabilities upstream instead of patching Pi locally.
- **Keep response latency minimal.** Keep recall, prompt assembly, hooks, and checkpoint commits within measured latency budgets. Run slow work, such as memory extraction and consolidation, in resumable background tasks so it does not delay responses.

The upstream guard and checkpoint/request-preparation benchmark budgets are in place. Memory-specific budgets arrive with the memory implementations.

## Requirements

- Managed installation: Ubuntu Server 24.04 LTS, x86-64; the release includes Node 24
- Source development: Node.js 22.19 or later on macOS, Linux, or Windows
- A model provider: a Claude or ChatGPT subscription, or an API key

## Start it

Use the [one-minute deployment guide](docs/deployment.md). The default command is `agent`; `install.sh --name bob` creates `bob` instead. Each name is bound to a stable installation ID and its own account, service, credentials, sessions, and workspace. Releases can be shared between agents.

```bash
sudo agent login anthropic
sudo agent start
sudo agent attach                   # interactive client of the running service
sudo agent send "Inspect the working repository"
sudo agent service-status
sudo agent stop                 # asks for confirmation
sudo -n agent stop --yes        # no action or sudo prompt; fails if unauthorized
```

`kill` immediately terminates the owned service and its tools. `uninstall` removes the installation's software while preserving its data and account. Both ask for confirmation and accept `--yes`. Stopped agents remain stopped until an explicit `start`; confirmation never silently succeeds without a terminal. See [operations](docs/operations.md) for rename, removal, and recovery.

`attach` opens a full-screen terminal with Markdown conversation, live tool status, model/usage metadata, and a multiline composer. Enter sends; Ctrl+J inserts a newline. `/exit` or an SSH disconnect leaves work running; `/cancel` cancels shared work. Use `attach --plain` for basic terminals and `send` for pipes. Foreground chat remains separate. See [terminal behavior and comparison](docs/terminal.md) for controls, bounded history, cost estimates, and remaining gaps.

## Subscriptions

`sudo agent login anthropic` (Claude Pro or Max) and `sudo agent login openai` (ChatGPT Plus or Pro) open the provider's sign-in flow, with a paste-the-code fallback for machines without a browser. `logout <provider>` removes the sign-in and `status` reports provider configuration without printing secrets. Application commands run as the named agent's account, including when invoked through `sudo`, so credentials retain the correct ownership. Tokens refresh automatically.

Sign-ins are stored in `auth.json` in the data directory, readable only by the agent account (mode 0600 on macOS and Linux; on Windows it inherits your profile directory's access rules). A stored sign-in wins over an API key for the same provider.

Whether a provider lets third-party tools use a subscription is that provider's policy and has changed before; check the current terms of your plan before relying on it.

## Configuration

| Setting | Meaning |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | A provider is used when you are signed in to it or its key is set, checked in this order; the first picks the provider and its default model |
| `UNIT_001_MODEL` | `provider/model-id`; set in the named agent's environment file and restart the service |
| Source CLI `--model` | Explicit `provider/model-id`, overriding `UNIT_001_MODEL` |
| Source CLI `UNIT_001_HOME` or `--data-dir` | Where development sessions are stored; the flag wins |

Managed paths come from the installation record; caller-supplied paths cannot redirect a named agent. Its state is under `/var/lib/unit-001/agents/<id>` and root-owned configuration under `/etc/unit-001/agents/<id>`. The installer reports the ID and configuration path.

For source use without `UNIT_001_HOME`, sessions live under `%APPDATA%\unit-001` on Windows, `~/Library/Application Support/unit-001` on macOS, and `$XDG_DATA_HOME/unit-001` (default `~/.local/share/unit-001`) elsewhere, one SQLite file per session.

The model is applied on every launch, so changing provider keys never strands an existing session. One process may run a session at a time; a second gets a clear error, and a lock left by a crashed process is taken over.

Exit codes: 0 success, 1 failed run or configuration problem, 2 usage error, 130 stopped by a signal. A graceful service shutdown exits 0 and preserves unfinished work.

## Develop

```bash
npm ci --ignore-scripts
npm run build
npm run build --workspace apps/unit-001      # tsc to dist/
npm run typecheck --workspace apps/unit-001
node apps/unit-001/dist/bin.js --help
node apps/unit-001/dist/bin.js -p "what changed?"
```

Source execution also supports interactive chat, provider login, `--session`, and piped prompts with `-p -`. It uses the current directory and Pi Durable's coding tools; Windows additionally has PowerShell. `/help` lists chat commands and Ctrl+C stops a run. Source use has no managed installation to rename or uninstall. No global `u1` or `unit-001` command aliases are installed.

The tests use Pi's faux provider and real SQLite, including process-kill recovery, named installation isolation, and lifecycle operations with mocked system commands. See [AGENTS.md](../../AGENTS.md) for the permitted test commands.
