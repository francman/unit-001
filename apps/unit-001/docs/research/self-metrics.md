# The agent should report costs from receipts, not model guesses

Research proposal for [#42](https://github.com/francman/unit-001/issues/42), reviewed 2026-11-09. This reviewed research defines implementation work that has not shipped. Related: organization integration [#41](https://github.com/francman/unit-001/issues/41), mission controls #17, operational inspection #26, security posture #44 and voice #45.

## Decision in under one minute

Build a small, private accounting ledger inside the agent's existing owner process. Reuse Pi's usage types, Durable document families and telemetry; do not install a dashboard server or proxy on the 512 MB VPS. Expose one read-only `unit_metrics` tool and matching `agent metrics` command. The agent can then answer questions about cost, uptime and work from the same recorded facts the human sees.

Keep **provider-reported charges**, **API-price estimates**, **subscription allocation** and **configured hosting expenses** distinct. Missing receipts are unknown, never free. A subscription's public API-equivalent usage is not its bill. Start recording before advertising monthly coverage; old aggregate totals cannot reconstruct a complete month.

Implement receipts and reporting first, provider reconciliation second, and budget enforcement in the mission-controller slice. The remaining design risk is write latency: reliable attempt receipts add commits. Preserve the existing latency gates and measure that cost before release.

Illustrative answer, not the agent's actual spending: “For November in UTC, I recorded $8.40 in provider-reported charges and $0.70 in estimates. Two interrupted requests lack final receipts. Hosting is configured at $3.50/month; subscription allocation is unknown. I cannot give an invoice-complete total.”

## Existing building blocks and the actual gaps

The current code already has most of the measuring instruments:

- `packages/ai/src/types.ts`: `Usage` separates uncached input, output, cache read/write, one-hour cache writes and reasoning. Reasoning is a subset of output, not an additional billed bucket. `cost.totalFromProvider` distinguishes a provider-reported total from a catalog estimate. `AssistantMessage` includes request start time, provider response ID, actual response model and duration.
- `packages/durable/src/harness/usage.ts`: `UsageDoc` records conversation spend, including compaction; `Harness.usage()` sums the Session. These totals are stored with response commits, but they are not monthly records. `addUsage()` does not preserve trustworthy mixed cost provenance, and the document has no per-request auth mode or price snapshot.
- `apps/unit-001/src/service-view.ts`: the terminal correctly labels its conversation-model cost estimate/unknown. It excludes tool totals and is not an installation-wide bill.
- `apps/unit-001/src/orientation.ts`: `unit_status` supplies fresh owner identity, PID, start time, monotonic uptime and `observedAt`.
- Public `GenerationHooks.afterResponse` can observe generation responses but does not cover the compaction model call. An implementation using only this hook would undercount.
- `pi.ai.*` and `pi.durable.*` already instrument token counts, request latency, first chunk, active tasks, phase outcomes and reports. `@earendil-works/chord/telemetry-sqlite` already offers a bounded buffered recorder. It defaults to seven-day retention and can lose an unflushed buffer on a crash, so it is suitable for diagnostics, not authoritative monthly accounting.

Source inspection included the installed package exports/types under `node_modules/@earendil-works/pi-ai` and `pi-durable`; the proposed integration uses public interfaces. No upstream edits or runtime dependency additions are required for the first slice.

## What other agents already do

Main-branch pins below may include unreleased work. These are source-verified patterns, not production capacity claims.

| Reference | Useful behavior | Decision for the agent |
|---|---|---|
| [OMP stats](https://github.com/can1357/oh-my-pi/blob/c899a8a1695e50983830e70ccacad962b629d0e5/packages/stats/README.md) and [request-time pricing](https://github.com/can1357/oh-my-pi/blob/c899a8a1695e50983830e70ccacad962b629d0e5/packages/catalog/src/models.ts) | Incremental local ingestion, atomic cursors/aggregates, hourly rollups; subscription usage is explicitly API-equivalent, unpriced models are N/A. Prices use the request timestamp. | Adopt incremental rollups and frozen pricing provenance. Do not import its Bun/React dashboard and second runtime. |
| [OpenClaw usage](https://github.com/openclaw/openclaw/blob/6580679f718148c883b457da6a71f25e267e1bfc/docs/concepts/usage-tracking.md) | Separates account quotas/billing from session estimates, preserves unknown account attribution, reports stale/partial aggregates, supports explicit calendar time zones. | Adopt its separation and coverage labels. Avoid scraping browser session cookies or requesting broad billing credentials by default. |
| [Hermes usage persistence](https://github.com/NousResearch/hermes-agent/blob/9d97823a9bd19fcfb188fb2133be49b826de9c37/hermes_state_usage.py) | Records actual and estimated costs, pricing version, active model/billing route and auxiliary tasks. Avoids charging a whole mixed-model session to its initial model. Coalesces background writes. | Adopt per-call attribution and auxiliary accounting. Do not treat its best-effort in-memory write queue as crash-complete accounting. |
| [Paperclip reporting](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/docs/guides/agent-developer/cost-reporting.md), [cost schema](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/packages/db/src/schema/cost_events.ts), [finance schema](https://github.com/paperclipai/paperclip/blob/02bfe71a6bbd7c5676cb7e72778b361c5bc72765/packages/db/src/schema/finance_events.ts) | Distinguishes usage/cost events from finance entries, stores idempotency and provider request IDs, retains unpriced/accounting-pending records and supports organization attribution. | Adopt receipt identity and incomplete-cost reporting. Export existing receipts through the organization adapter once, rather than recording a second charge for an export. Keep infrastructure charges separate. |
| [Langfuse cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) | Provider/ingested costs take precedence over inferred costs; usage types support audio/cache; stored costs are not silently changed by later price updates. | Adopt the data contract. Optional remote export later; no mandatory hosted account or local stack. |
| [LiteLLM spend tracking](https://docs.litellm.ai/docs/proxy/cost_tracking) | Cross-provider spend attribution and explicit cost-map/billing reconciliation. | Support external gateway receipts if already used. Do not require an additional proxy, database or auth boundary merely to meter the agent. |
| [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/tree/e6658f14c9d9ea0760825f029cb82e7673f48fab/docs/gen-ai) | Standard vocabulary for agent/tool/model operations and token/latency observations. Conventions remain evolving. | Translate existing Pi telemetry at an optional exporter boundary. Version the mapping; do not couple billing correctness to trace sampling or a collector. |

OMP, OpenClaw, Hermes and Paperclip report MIT licenses at these pins; preserve notices if copying substantial code/prompts. OTel conventions are Apache-2.0. The recommendation reuses patterns, not their source. No comparative performance benchmarks were run.

## Implementation contract

### Components and interfaces

Keep the first implementation in `apps/unit-001/src/metrics/`, one concept per file: ledger/document definitions, model-operation adapter, report aggregation, and tool/IPC boundary. Introduce a separate package only when a second consumer requires it.

The model adapter implements the public `Models` interface and delegates unchanged operations. Observe all streaming/complete/deferred paths through one accounting path, including compaction and future auxiliary callers; do not count `completeSimple()` and its underlying stream twice. Preserve event ordering, cancellation and result identity. A public provider wrapper is an alternative if it can prove the same operation coverage; do not monkey-patch upstream classes or import their internals.

Proposed local contracts:

```ts
type Money = { currency: string; amount: string }; // canonical decimal, not rounded cents
type MissingReason = "not_reported" | "interrupted" | "unsupported_route" |
  "legacy_provenance" | "unavailable_session";
type Outcome = "completed" | "failed" | "aborted";

type Charge =
  | { kind: "provider_reported"; money: Money; receiptRef: string }
  | { kind: "estimated"; money: Money; pricingRef: string }
  | { kind: "subscription_included"; planRef: string }
  | { kind: "unknown"; reason: MissingReason };

type AttemptState =
  | { kind: "started"; startedAt: number }
  | { kind: "settled"; finishedAt: number; outcome: Outcome; charge: Charge }
  | { kind: "receipt_missing"; observedAt: number; reason: MissingReason };

interface MetricsQuery {
  period: { month: string; timeZone: string };
  scope: "session" | "installation";
}
```

These are proposal types, not existing exports. Runtime schemas must validate their closed tags at the tool/IPC boundary. Use decimal strings with exact decimal arithmetic or a documented fixed-point conversion; retain sub-cent charges and never sum different currencies without an explicit dated conversion. A zero **reported** charge is valid. A zero catalog value does not prove free usage.

### Durable receipt and aggregation design

Use version-1 Session-scoped `defineDocFamily()` members, not one ever-growing object:

1. `unit.metrics.attempt`, keyed by host-generated attempt ID: source installation/session, optional mission/task/parent/org, operation type, requested/actual model and provider/biller, non-secret billing-mode evidence, start/end times, optional provider response ID, normalized units, charge/provenance and state.
2. `unit.metrics.day`, keyed by UTC date: bounded aggregate buckets and source counters. Keep observed charges, estimates, subscription-included units and unknowns separate. Store result-revision/source receipts for rebuildability.
3. `unit.metrics.coverage`: collection start, schema/adapter version, interrupted attempts, known unsupported routes, historical backfill cursor and last reconciliation. Do not claim completeness from an empty counter.

Store price snapshots or a content-addressed pricing definition, currency, model/rate version and observation source when estimating. Preserve provider-reported money alongside the estimate used for comparison. Provider corrections replace a receipt revision and apply its old-to-new aggregate delta atomically; they do not append another charge.

Billing mode comes from the effective non-secret authentication selection, including per-request overrides, not provider name or the mere presence of a key in an environment. Public `AuthCheck`/credential metadata and provider subscription declarations are useful evidence; if the actual request's mode cannot be proved, retain `unknown`. Never read or store credential values to classify usage.

The new family schemas start at version 1. Existing sessions begin with explicit incomplete historical coverage; creation must not rewrite Pi's documents. Any later shape change needs a deterministic version migration. Include the new documents in upgrade/rollback compatibility fixtures and preserve them when older software temporarily runs. Snapshot-and-reopen tests must verify receipts, correction revision and rollups together.

Before issuing a new logical model operation, durably record its attempt ID. On a terminal result, persist its receipt and update the affected rollup in one owner commit. Identical receipts are no-ops; conflicting content under the same identity/revision is an error. An authorized correction supplies a new revision and expected prior receipt hash. New retry attempts have new identities. A provider response ID is a reconciliation key scoped by biller/account, not a globally unique string.

If accounting cannot persist a new start, do not issue the provider call. If persistence fails after the provider has replied, mark accounting degraded and block further metered work until recovery; do not turn an accounting retry into another model request. Preserve the original result where storage remains available and report the missing receipt explicitly. Read-only health reporting must remain available. This failure policy needs a deliberate acceptance test, not a swallowed background error.

Deferred submission/poll operations refer to one original charge identity. Pending polls do not repeatedly add cumulative usage; terminal or provider-reconciled final usage settles that identity. An abort/error can still have chargeable observed usage. Provider SDK-internal retries may not expose every physical attempt; record that limitation and reconcile rather than inventing costs.

A crash after transmission can leave the provider charging an operation whose final receipt never arrived. Reopen converts unfinished attempts to `receipt_missing`; it must not replay work merely to recover accounting. Import a late provider receipt idempotently when available. Provider account totals alone cannot assign a missing charge to the agent when the credential is shared.

Session documents fit existing public transactions. For installation-wide reporting, owners must aggregate **every registered session's own** receipts through owner IPC or read-only closed-session access, including explicit incomplete/unreachable sessions. Count origin receipt IDs once across forks and child-agent exports. Do not copy ancestral spend into a fork. No client opens SQLite, and no second writer opens a live conversation database. If future simultaneous independent session owners require a central installation ledger, implement one dedicated owner endpoint first rather than sharing mutable documents across processes.

### Time and scope semantics

Persist UTC instants. “This month” defaults to UTC, matching an explicit response label; a root-configured IANA timezone can select a different calendar. Derive `[start, end)` at month boundaries, including DST; never substitute rolling 30 days. Price usage at the original request instant. Record a late receipt against that original occurrence and identify the later reconciliation time. Keep request-usage periods separate from invoice settlement periods.

UTC daily rollups answer UTC queries directly. A non-UTC range reads complete interior UTC days plus exact boundary receipts; bound/paginate this work. A partial projection answers with an observed known subtotal and a coverage warning. Historical assistant entries can backfill recorded message usage/timestamps; old aggregate compaction totals and lost auth/pricing provenance remain unattributed, not retroactively guessed.

### What the agent and its human can read

`unit_metrics` and `agent metrics --month YYYY-MM --json` share one owner report. Add a compact `/metrics` terminal view after the same report works. Normal authorized operators can read it without sudo; billing credentials, allocation policy, exports and budget changes remain administrative. The agent must call the tool for present-tense operational/cost questions and explain missing data; recalled prose is not accounting evidence.

Every report includes `schemaVersion`, `observedAt`, period bounds/timezone, installation/session scope, included/excluded work, source/revision references, freshness, and coverage `complete | partial | unavailable`. Money is grouped by provenance, currency and billing mode. Shared observation metadata can later be extracted for the security report; do not create a generic facts service now.

Report runtime facts from the existing owner clock; live queue/task state from `Harness.inspect()` and the task graph; memory from its stats API; update health from the existing updater journal. Historical success/failure/retry totals must come from persisted events or committed task transitions. Telemetry measures latency and rates, not mission success: only a mission verification receipt establishes a completed outcome.

Voice/browser/tool adapters can report nonoverlapping units such as token classes, audio seconds, synthesized characters, image count or request count. Keep each adapter's provider receipt and pricing rule; do not force all services into token estimates.

## Coverage, privacy and resource constraints

Retained coding tools can launch external CLIs or call providers directly. A `Models` adapter cannot observe that traffic. Approved child/tool adapters should submit original receipts; otherwise report those routes as uncovered. This is also why an optional provider-scoped API billing reconciliation is useful. OpenRouter's [official usage-accounting response](https://openrouter.ai/docs/cookbook/administration/usage-accounting) supplies native token/cost data; use supported response fields rather than a custom invoice estimator.

For subscriptions, show reported quota/reset snapshots separately. A plan price, credit purchase or hosting estimate is not an inference charge. Optional root-configured allocations must identify whether the whole plan/VPS is dedicated or shared. Initial implementation should not request new organization-admin keys or scrape browser cookies. Broader provider billing integrations need explicit least-privilege credential setup and must not expose those credentials to model tools.

Record no prompts, completions, tool arguments/output, environment values, raw provider errors or credential identities by default. Keep opaque request references and non-secret attribution only. Private filesystem/IPC permissions remain unchanged. Trusted coding access already permits service-account file changes; this proposal does not claim a tamper-proof ledger against that authorized actor.

The durable start/result commits are a real latency cost. First measure them with the existing unchanged request/checkpoint gates on Linux and the VPS. Do not silently switch to a lossy asynchronous queue to pass the gate. If overhead fails, the implementation review must choose either an upstream atomic-observation capability or an explicitly weaker coverage contract. Optional buffered diagnostic telemetry can use the existing Chord recorder with bounded retention, dropped-record counters and failure visibility; never feed sampled diagnostic sums into the cost ledger. No new daemon, mandatory proxy or always-on full dashboard belongs in the first slice.

Existing numeric gates remain the starting acceptance contract: checkpoint p95 2 ms; ordinary submit-to-provider p95 10 ms; memory-enabled submit-to-provider p95 20 ms at 1,000 records and 150 ms at 10,000. No metrics-specific capacity guarantee exists yet. Measure an idle owner and long-running receipt workload on the actual 512 MB host, plus bounded cold/repeated month queries, before setting a separately reviewed query/RSS limit. Do not raise an existing gate to accommodate the ledger silently.

## Ordered implementation slices and acceptance

1. **Authoritative report and local receipts (#42 implementation child).** Implement tagged schemas, model adapter, idempotent ledger/day rollups, safe owner report/tool/CLI and orientation instructions. Cover all normal model operations including compaction, retries, errors, aborts and deferred polling. Initial report must state session versus installation coverage honestly. Add actual terminal rendering checks for partial/unknown/zero/sub-cent values.
2. **Installation history and reconciliation (#42 child, linked #26/#41).** Aggregate all registered sessions and child receipt origins; page backfill and mark irrecoverable legacy gaps. Add one supported provider reconciliation adapter before more providers. Export the same receipt identity to Paperclip; receipt retries must not start work. Provider organization totals stay separately scoped when agent allocation cannot be established.
3. **Operating expenses and mission budgets (#14/#15/#17, linked #42).** Add explicit subscription/hosting/tool allocations and organization attribution. Budget admission reserves estimated exposure before autonomous work and reconciles actual usage later. Reporting alone is not a hard spending cap; no budget guarantee covers unmetered shell traffic. Root/organization authority owns policy and threshold changes.
4. **Optional external observability.** Map content-free Pi telemetry to versioned OTel and optionally export to an existing Langfuse/LiteLLM environment. Preserve local operation if export fails. Choose this only when an actual consumer needs it.

Required tests: duplicate/conflicting receipt, correction delta, fork/child export dedup, mixed providers/auth/models, known zero versus unpriced, cache/reasoning subset arithmetic, price changes preserving history, month/DST boundaries, late receipts, provider-disconnect/cancellation, compaction, auxiliary calls, SIGKILL before send/during stream/after receipt-before-rollup, reopen without resubmission, inaccessible session coverage, malicious IPC frames and normal operator/admin boundaries. Use faux providers and real SQLite; no paid test calls. Run focused tests, full `npm run check`, release/package checks and actual terminal/UID tests. Benchmark hot-path commit cost, bounded month-query work, replay depth, database growth and peak RSS at realistic long-running event counts on the 512 MB VPS before claiming fit.

**Next step:** approve the receipt/provenance contract and the first slice's latency/coverage tradeoff, then create narrow implementation child tickets under #42. Research completion must not mark the cost-reporting feature implemented or Done.
