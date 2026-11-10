# Inspect and control session memory

The running agent keeps structured memory alongside its durable conversation. Both survive restarts. Memory belongs to one session database; another named session or installation has a separate memory bank.

```bash
bob memory stats
bob memory recall "deployment approval"
bob memory remember "Deployment requires my approval"
bob memory forget <id>             # asks; defaults to No
bob memory forget <id> --yes       # explicit automation confirmation
bob memory sleep                  # schedule pending consolidation
```

These commands require [operator access](operations.md#operator-access-and-sudo), not sudo. In chat, use `/memory`, `/memory recall QUERY`, `/memory remember TEXT`, `/memory forget ID`, or `/memory sleep`. Forget asks you to type `yes`; another answer cancels. Copy an ID from recall results. These commands contact the existing owner without a model request or second SQLite writer.

Relevant memories automatically accompany requests as untrusted evidence. Human preferences and explicit “remember” statements are captured after answers. Background consolidation groups older statements without calling another model. `sleep` schedules work; it does not imply immediate completion. Stats expose pending and failed capture counts.

Forgetting removes recall evidence and invalidates derived summaries. Immutable conversation history remains. Memory cannot grant execution authority or establish current process facts. `/status` and the model's `unit_status` tool report the actual owner process and observation time. Autonomous mission scheduling remains separate work.

See [recovery verification and capacity limits](memory/verification.md).

See [practices taken from OMP, OpenClaw and Hermes](memory/reference-practices.md) for implemented patterns and proposed follow-ups.
