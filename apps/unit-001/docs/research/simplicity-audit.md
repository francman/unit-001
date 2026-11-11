# Simplify repeated workflows while preserving Bob’s behavior

**Recommendation:** use small refactors, not a rewrite. First bypass a redundant memory-maintenance phase for new work. Then share terminal command and cancellation state across the rich and plain interfaces. Finally separate initial installation orchestration from reusable installation primitives, preserving the deployed updater’s fixed helper inventory.

The recovery journal, exact ownership checks, memory tombstones, bounded views, plain terminal support and trusted coding tools are intentional features. Removing them would make the code shorter by changing the product. No release-blocking defect was identified in this audit, and this proposal does not authorize feature removal.

Audit for [#48](https://github.com/francman/unit-001/issues/48), against `edf7503a58ab3ea47f99578c96e27b3a6d1e9d1e`, merged through PR #43 as `d7f4690b354dc562e4470beb945506f2fc2bae23`. Findings are refactoring opportunities, not claims that the proposed code already exists. No repository or production files were changed.

Publication follow-through: refactor A subsequently merged in [PR #52](https://github.com/francman/unit-001/pull/52) as `c6c75dbff4a2f926295ff03631381210a2961ce6`, completing implementation issue #50. That is merged source, not a new production release. The traces below describe the audited baseline; the remaining refactors are still proposals.

## 1. Bypass a validation-only consolidation phase

**Problem.** `packages/unit-memory/src/consolidation.ts:86` schedules `summarize`, but that handler at line 92 does not create a summary. It snapshots the selected sources, checks their revisions, and commits a transition to `publish`. `publish` immediately repeats that snapshot validation at line 109, builds deterministic text outside the transaction, then validates the sources again inside its publication transaction at line 120.

**Concrete trace.** A credential-free, real SQLite observation with one aged synthetic memory produced `select → summarize → publish → select`, four task-phase invocations. Each handler performs one task-state commit. The final select clears the scheduled guard and ends the task; it is necessary. The separate summarize pass provides no durable evidence that publication can rely on: a source may still be forgotten immediately afterward, so publication must revalidate anyway.

**Minimal implementation.** New selections should transition directly to the existing `publish` checkpoint with source IDs and revisions. Keep the existing version-one `summarize` checkpoint handler unchanged for already-persisted tasks; do not delete it or rename the task. Keep both publication validations: the first protects computation from a stale snapshot, and the transaction check protects the actual write. No content, provenance, summary identity, source revision, age threshold or forget behavior changes.

This removes one phase invocation and one checkpoint commit from a successful new batch. It is an execution simplification, not an immediate line-count reduction. No millisecond improvement has been measured. Retaining the old handler is required by persisted work and rollback compatibility; retiring it later needs a deliberate compatibility decision.

**Coding task.** Change only the new-selection transition in `consolidation.ts`; add tests in `test/background.test.ts` for direct publication and reopening a seeded legacy summarize checkpoint. Keep the current checkpoint union/version so both old and new releases can read the selected shape. No document migration or new dependency is proposed.

**Acceptance.** Same exact sources, summary content/IDs and provenance; no resurrection after forget; source change between snapshot and transaction retries selection; legacy summarize and publish checkpoints reopen; shutdown/maintenance preserves work. Count successful-batch phases and persistence work, retain all latency gates, and run the existing new-to-old-to-new archive compatibility fixture when this ships.

## 2. Make terminal command state have one implementation

**Problem.** Plain `attach.ts` and rich `terminal-controller.ts` independently maintain the same semantic state: pending send, active cancellation, cancellation requested before admission is visible, pending forget confirmation, startup timeout and detach. Both parse the same memory slash command and generate stable retry IDs. `repl.ts:153` contains a third memory-command/confirmation branch for the plain foreground interface.

**Concrete trace.** The plain client sets `cancelAfterAdmission` at `attach.ts:72` and dispatches when the watch becomes busy at line 234. The rich controller performs the same sequence at `terminal-controller.ts:274` and line 300. Memory parsing and pending confirmation appear at `attach.ts:143`, `terminal-controller.ts:217` and `repl.ts:153`. A new command or cancellation correction therefore requires multiple implementations and parallel regression cases. This is duplication of behavior, unlike the necessary independent server authorization check.

**Minimal implementation.** Reuse the existing conversation transport/controller seam rather than add a generic event framework. Keep `AttachedOutput` and readline editing in the plain frontend; keep `RichAttachView`, Markdown, keybindings and bracketed paste in the rich frontend. Move only command/admission/cancellation/confirmation ownership into one controller. Expose explicit controller notices with stable identities or a callback so a plain frontend does not lose important messages to the rich view’s eight-notice retention policy. Do not infer new notices by comparing strings.

Use a short intermediate step if direct frontend reuse would mix presentation into control: define a shared command state reducer in `terminal-controller.ts`, consumed by its existing controller and the plain adapter. Its typed result must distinguish a normal prompt, a local command and rejected input; pending confirmation stores the existing memory ID/request ID. Rendering, prompt repaint, cursor handling and output sanitization remain frontend responsibilities. Choose one approach after implementing a parity fixture; do not create both abstractions.

**Coding tasks.** First make plain attached operation use the shared semantic owner. Preserve the public `runAttach` entrypoint and its exit codes. Only afterward adapt plain foreground memory commands, retaining foreground close/cancel ownership differences and `/quit`. Leave `runPrint` as a one-shot scripting path. Public `Agent`, credential and provider APIs remain unchanged.

The first PR need not unify every terminal. In particular, ordinary foreground line input may remain serial, while rich/attached controls remain responsive during active work. Sharing parsing must not silently change that contract.

**Acceptance.** The same scripted service scenarios must prove one admitted send, stable retry identity, cancellation before/after admission, no duplicate committed answer, EOF/signal detach without cancellation, correct busy state, and confirmed-forget semantics in both frontends. Retain plain streaming/truncation, draft/cursor preservation during asynchronous output, terminal escape stripping, rich paste bounds, configured keybindings, monochrome mode and 40×12/80×24 resize. Run actual PTYs and real operator UID isolation, not just controller unit tests. Keep the watch as transcript authority.

The two socket-peer factories in `test/attach.test.ts` and `test/terminal-controller.test.ts` are nearly identical. A small test-only fake owner can support these parity scenarios. Keep explicit raw-frame injection for malformed-peer tests; do not hide transport behavior behind a mock of the production parser or build a universal test harness.

## 3. Separate installer orchestration without breaking retained helpers

**Problem.** `deploy/installation.mjs` contains record/path/ownership primitives, initial release installation, update-trust bootstrap and its executable CLI. It imports `update-activation.mjs` at line 26. That updater module imports the installation primitives back at its line 27. The module cycle currently works because calls happen after initialization; it is a responsibility and maintenance issue, not an observed startup failure.

**Concrete trace.** Root dispatch loads installation primitives to read an installation. That also loads updater activation, which imports the same primitives. Initial installation then invokes updater installation/scheduling from `installation.mjs:699`. The four named management helpers are copied by both `activate.sh:89` and `update-activation.mjs:600`. A seemingly simple extraction of a new shared runtime helper could break automatic upgrade: a retained old updater would not copy that new required file into `/usr/lib/unit-001/agents/ID`.

**Minimal implementation.** Keep the four existing runtime management filenames and their self-contained dependency graph. Move initial-install-only orchestration and trust-bootstrap orchestration into a separate archive-side installer entrypoint, for example `deploy/install-entry.mjs`. `install.sh` invokes that entrypoint; reusable `installation.mjs` no longer imports updater activation. The installer entrypoint imports installation primitives and update activation in one direction. Do not put the new file on the managed dispatcher’s runtime import path.

This relocation preserves install, preflight, dry-run and reinstallation behavior. It changes internal source/test import locations where appropriate, not delivered command behavior. Confirm any intentional external consumers of the deployment module before relocating its exports; do not delete an API merely because repository search finds no production caller. Existing retained updater cores keep their own files unchanged.

**Coding tasks.** Document the allowed deployment import graph and fixed helper boundary, move initial installer coordination, update the archive-side launcher and source tests, and retain byte-exact ownership/migration templates in the runtime layer. Do not fold the installer’s rollback policy into the signed updater’s durable journal; they have different supported entry conditions. Do not replace both with a new general activation framework.

**Acceptance.** Current clean install, stopped/running intent, SUDO identity validation, recoverable operator-grant warning, checksum inventory, public trust bootstrap, name/account collision checks and failure restoration must stay intact. Native acceptance must exercise actual installed old updater → new archive, private-only fallback → explicit stopped bootstrap, signed update/recovery/rollback, and exact-owned uninstall while preserving unrelated files. The new installer-only file must appear in release checksums, while retained helper imports remain resolvable using the existing four-file copy contract.

## Keep these complexities

| Mechanism | Why it remains necessary |
|---|---|
| Separate operator/admin endpoints and private storage | CLI restrictions alone are not a server authorization boundary. Trusted coding-tool authority is still explicit; this is not a sandbox. |
| Raw-wire validation, byte/count bounds and terminal sanitization | The peer and terminal output are separate trust boundaries. Do not remove one because another layer validated a value. |
| Update journal phases, independent core and inhibited readiness | They protect work and state across process death. The exact 0.0.6/0.0.7 migration checks are intentional compatibility, not general fallback clutter. |
| Capture dispatcher and background tasks | Foreground admission and resumable extraction have different ownership. Collapsing them into an asynchronous untracked callback would lose restart guarantees. |
| Recall heap, structural-sharing cache and source checks | Their complexity supports measured retrieval budgets and stale-evidence exclusion. A shorter full-bank sort/rebuild is not equivalent. |
| Tombstones, receipts and first-admission provenance | They prevent replay, compaction and background work from restoring deleted content or changing authorship. |
| Mission foundation | It is intentionally nonexecuting and scheduled for extension, not proven dead code. The autonomy controller is not shipped. |

The installed public `pi-ai` validation API is not a drop-in replacement for the strict IPC parsers. Its `validateToolArguments` clones/coerces values and returns `any`; using it for frames could change rejection semantics and add copying. Likewise the inspected public Durable `Tx` has no general sleeping-task wake operation: deleting the consolidation minute wake without a replacement would change how a new memory-count threshold is noticed. No upstream patch or new schema framework is proposed for these issues.

## Refactor sequence and feature-preservation gates

| PR | Scope | Primary risk | Required proof |
|---|---|---|---|
| A | Bypass new validation-only consolidation phase; retain legacy handler | Persisted task/forget race | Real SQLite checkpoints, phase counts, forgotten-source publication rejection, rollback reader compatibility |
| B | Shared attached terminal command/admission state | Changed cancellation, output or editing semantics | Shared behavioral scenarios plus real plain/rich PTYs and operator UID tests |
| C | Plain foreground command reuse if B remains simpler | Foreground ownership drift | Ctrl+C/EOF/recovery/print exit behavior and confirmation tests |
| D | Installer-only entrypoint separation | Old updater import/inventory failure | Actual published-old artifact migration, packaging, native rollback/uninstall |

Each PR should preserve public behavior, touch only Unit paths, use top-level imports, add no dependency without a separate justification, and keep full `npm run check` and the relevant focused/native tests. Run the existing latency gates; benchmark changed counted work before claiming performance gains. Stop and ask before removing intentional functionality. Do not combine these refactors with new browser, voice, messaging, accounting or mission features.

## Evidence and coverage

Full-file reads covered the terminal/control path (`agent`, `args`, `attach`, `cli`, `interaction`, `maintenance`, `memory-control`, `named`, `repl`, `service`, `service-view`, `terminal-controller`, `terminal-ui`, `setup`, public index), the existing mission state, every `unit-memory/src` file, deployment `installation`, `agent-command`, `lifecycle`, `update-activation`, installer activation shell and release builder. Relevant terminal and memory tests were read, and installed public Durable task/transaction and pi-ai validation/tool types were inspected. This is a mechanism-focused audit, not a claim to have audited every upstream/package/security line.

Executed on the unchanged audited tree: three terminal/memory-control files, **43/43 tests passed**; two consolidation/background files, **7/7 passed**. A disposable real SQLite phase observation produced four phases and two live source/summary records with an idle final consolidation guard. No proposed implementation was run, no provider call was made, and no new PTY/native acceptance is claimed. No code change means a new full repository check was not required; the refactor PRs still require it.

The canonical audit ticket stays In Progress until the reviewed report has a durable repository link and the implementation tasks are recorded. Completing this audit does not mark any refactor or future capability implemented.
