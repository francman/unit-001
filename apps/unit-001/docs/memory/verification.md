# Memory recovery verification

The implementation was checked with real SQLite and faux providers. Focused app tests cover admission, request evidence after restart and conversation compaction, session isolation, confirmed forgetting, maintenance holds and actual terminal input/rendering. Package tests cover lexical ranking, provenance, durable capture and consolidation, including process-kill recovery. No paid provider requests were made.

## Published rollback reader

The published `unit-v0.0.5` Linux archive, SHA256 `59d20c89644eb4e8f1ba172edab6b8ef6a8b64b80c9d7a2c3223449751bac356`, opened a closed copy of the new database, read the previous human conversation, appended a faux answer and closed successfully. Reopening with the new implementation preserved the explicit memory's ID, content, user provenance, working tier, scheduled consolidation and old reader's appended answer. The old release does not implement memory operations while selected.

To repeat from a built checkout, run `test/fixtures/memory-release-current.mjs seed PATH` from the app directory with Node. Copy the closed database and its `.expected` companion. Copy `memory-release-old.mjs` into the extracted old archive's `app` directory. In a Linux amd64 container with `--network none`, mount the archive and database copy, then run its bundled `runtime/bin/node app/memory-release-old.mjs COPY`. Run the current fixture's `verify COPY` afterward. Never use a live installation database for this test.

This verifies the current additive documents and background task checkpoints against the actual previous runtime. Future schema or task changes require another compatibility check before retaining the same reader declaration. See [latency measurements](../latency.md) for measured costs and capacity limits.
