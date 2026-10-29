# unit-001

A durable agent built on [Pi Durable](../../packages/durable). Its conversation lives in a SQLite file, so a process that stops, crashes, or is killed resumes unfinished work the next time it starts.

## Requirements

- Node.js 22.19 or later, on macOS, Linux, or Windows
- An API key for one model provider

## Start it

From the repository root:

```bash
npm install
npm run build
cd apps/unit-001 && npm link         # once: puts `u1` (and `unit-001`) on your PATH
export ANTHROPIC_API_KEY=...         # or OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
u1
```

On Windows PowerShell, set the key with `$env:ANTHROPIC_API_KEY = "..."`.

```text
u1                        chat interactively
u1 -p "what changed?"     answer one prompt and exit
echo "summarize this" | u1 -p -
u1 --session work         open or create another session
u1 --model openai/gpt-5   pick a model (provider/model-id)
```

In the chat, `/help` lists commands, `/exit` or Ctrl+D quits, and Ctrl+C stops the current run (and quits when idle). The agent works in the directory you start it from, with Pi Durable's `read`, `write`, `edit`, and `bash` tools, plus `powershell` on Windows. On Windows the `bash` tool needs a bash installed, such as Git Bash; `powershell` does not.

## Configuration

| Setting | Meaning |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | Detected in this order; the first one set picks the provider and its default model |
| `UNIT_001_MODEL` or `--model` | `provider/model-id`; the flag wins |
| `UNIT_001_HOME` or `--data-dir` | Where sessions are stored; the flag wins |

Without `UNIT_001_HOME`, sessions live under `%APPDATA%\unit-001` on Windows, `~/Library/Application Support/unit-001` on macOS, and `$XDG_DATA_HOME/unit-001` (default `~/.local/share/unit-001`) elsewhere, one SQLite file per session.

The model is applied on every launch, so changing provider keys never strands an existing session. One process may run a session at a time; a second gets a clear error, and a lock left by a crashed process is taken over.

Exit codes: 0 success, 1 failed run or configuration problem, 2 usage error, 130 stopped by a signal.

## Develop

```bash
npm run build --workspace apps/unit-001      # tsc to dist/
npm run typecheck --workspace apps/unit-001
npm test --workspace apps/unit-001           # needs the upstream packages built first (npm run build at the root)
```

The tests use Pi's faux model provider on real SQLite storage, including a test that kills a process with SIGKILL mid-request and resumes the run.
