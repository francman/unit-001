# Agent and host introspection

The agent should answer “what are you running, what can you access, and what is happening?” from current host records. Today its coding tools can inspect files and run commands as the service account, but those results are not a consistent self-report. Add one typed, read-only inspection dispatch; keep authority and secret handling outside model interpretation. This is the implementation definition for [#57](https://github.com/francman/unit-001/issues/57), building on metrics [#42](https://github.com/francman/unit-001/issues/42) and posture [#44](https://github.com/francman/unit-001/issues/44).

For example, `inspect({topic:"channels"})` returns registered adapters, exact setup state and the timestamp of the last successful health observation. A configured Telegram adapter is not proof of a connected bot. A denied system service query is `unavailable: permission`, not “no services are running.” Monthly cost remains unknown until the #42 ledger exists.

## Small first implementation

The first code slice is `src/introspection/os.ts` with its read-only `extension.ts`. Extend that directory with `contract.ts` for bounded request/result unions, `inspect.ts` for dispatch and `host.ts` for further platform observations. Use existing host/controller state and public Durable APIs. No polling daemon, second storage owner, generic shell evaluator or new external dependency is required. The broader dispatch below is a coding definition, not a claim that every collector is implemented.

```ts
type InspectionRequest =
  | { topic: "runtime" | "capabilities" | "channels" | "mission" | "tasks" }
  | { topic: "host"; section: "os" | "resources" | "processes" | "services" }
  | { topic: "source"; path: string; offset: number; limit: number }
  | { topic: "configuration" };
type Observation<T> = {
  observedAt: number;
  source: string;
  access: "service-account";
  evidence:
    | { kind: "available"; value: T; truncated: boolean }
    | { kind: "unavailable"; reason: "permission" | "unsupported" | "missing" |
        "invalid_metadata" | "limit" | "timeout" };
};
```

Wire parsing rejects unknown topics and fields. Host selects identity, roots, credentials policy and available ports; request text cannot claim a principal or select an executable. Results name the running installation/session/release. Time each section independently because a multi-section report is not an atomic host snapshot.

## Authoritative sources and bounds

- OS comes first: Node supplies platform, architecture and kernel; bounded public `os-release` supplies Linux userland distribution/version, while a fixed `sw_vers -productVersion` call supplies macOS product version. Accept legitimate protected `os-release` symlinks and use `/usr/lib/os-release` only when `/etc/os-release` is missing, following the [official format](https://www.freedesktop.org/software/systemd/man/latest/os-release.html). Report the current process namespace and unknown physical-host/container identity. Never substitute kernel version for userland version. The collector and renderer are shared by the tool, CLI and strict local fact-question router; this path makes no provider call.
- Runtime: reuse `RuntimeFacts`, actual provider/model selection and release identity. Report provider configuration presence and credential source category only; never read or serialize credential values. Do not infer identity from an assistant's introduction.
- Capabilities: snapshot registered tool names/descriptions and declared enforcement profile from the actual registry. Distinguish installed, offered and permitted actions. The current trusted coding conversation has broad service-UID tools; a narrower channel grant cannot restrict that conversation without enforced admission and tool policy.
- Work: reuse owner mission/control state, channel registry and public `Harness.inspect()`. Return at most 100 task/submission summaries, identifiers, state and next wake where available. Exclude prompts, tool arguments, document payloads and transcript text. Do not claim an autonomous loop is implemented when its controller reports otherwise.
- Resources: use Node OS/process APIs for uptime, architecture, memory, load and the current process RSS. Linux `/proc` may provide bounded PID/name/UID/state observations; omit environment, command lines, open-file contents and other users' private paths. Return at most 100 entries and an explicit truncation flag.
- Services: use a fixed Linux `systemctl show` argument list for this installation's manifest-owned units, a fixed sanitized environment, a three-second deadline and a 64 KiB output cap. No request-controlled unit name or shell. Systemd absence and permission denial are observations. General service discovery is a later explicit scope, not silently granted root visibility.
- Configuration: render an allowlisted view of effective nonsecret settings, precedence and configured source categories. Do not dump process environment, dotenv, authentication stores, arbitrary JSON, URLs containing credentials or raw provider errors.
- Source: allow only the running, verified source/bundle root and its manifest-owned code/docs. Resolve the trusted installation's `current` selector once; then resolve child paths against that root and reject traversal/symlinks/nonregular files, open with `O_NOFOLLOW` and check the opened descriptor. Read at most 16 KiB per request with explicit offsets; report exclusion for files beyond the one-MiB limit, including large generated code. Deny credential/config/state directories, database files and unknown installed files. Label source excerpts untrusted input rather than operational authority. If source is absent from the installed bundle, report missing; do not substitute an unrelated checkout. Arbitrary workspace browsing remains the existing coding-tool capability.

## Authority, persistence and failure

Routine inspection requires no new confirmation and never invokes sudo. The service UID defines visibility; this is not compromise detection or an isolation boundary against tools running under the same UID. A security posture conclusion cites observed controls and unresolved evidence from #44 rather than certifying the host secure.

Inspection returns ephemeral facts; persist only normal conversation/tool receipts through the current owner. No new database schema or migration is needed for the first slice. A historical answer remains historical until queried again. Channel setup/mission operations keep their own durable records; inspection reads their projections and cannot mutate approval receipts.

Cancellation stops pending reads and child processes. One failed section must not erase successful observations or masquerade as zero. Bound concurrent inspection calls to two per owner; reject excess work visibly. Never return caught exception strings from secret-adjacent operations. Count and measure response preparation without introducing full transcript scans.

Bounded lists return page offset, returned count, known total when actually available and truncation/exclusion reasons. A partial process page does not establish complete host coverage.

## Deterministic boundaries

| Decision or answer | Source and rule | Model's role |
|---|---|---|
| OS, architecture, kernel, uptime | Actual host collectors, source and observation time | Ask for or explain facts; never infer them |
| Provider configuration, tools, channels and mission state | Current owner APIs and protected configuration projections | Propose work within actual capabilities |
| Memory contents and update/cost receipts | Existing durable evidence; missing remains unknown | Summarize evidence, label estimates |
| Creator identity, grants, sudo and approval | Exact host principal, protected receipt and policy checks | Request permission; cannot issue it |
| State transitions, replay, budgets, signatures and expiry | Typed state machines, stable identifiers and exact comparisons | Choose a candidate action, not authorize it |
| Mission choices and researched recommendations | Cited evidence, goals and deterministic admission | Apply judgment, then verify outcomes |

Strict known OS questions and canonical inspection commands route before the model through one renderer. Unrecognized phrasing may use the model and authoritative tool; do not claim arbitrary language is deterministically classified. Host replies need explicit host provenance and normal idempotent history, without fabricated assistant messages or provider usage.

## Ordered delivery and acceptance

1. Implement OS collector, shared renderer and read-only tool first, then strict local question/command routing with host-authored history. Extend dispatch against existing runtime, tool catalog, channel and mission ports. Faux-provider tests prove the answer comes from current facts, with no paid requests needed for direct inspection.
2. Add resource/process and manifest-owned service observations. Actual UID tests cover denied reads, unavailable systemd, bounded output, timeout and cancellation. Avoid production host mutation.
3. Add safe source and configuration views with traversal, symlink swap, special file, credential fixture, oversized file and unknown-setting tests. Every secret fixture must be absent from tool output, errors and persisted transcript.
4. Add `agent inspect` and an existing-TUI inspection view after coordinating command routing. Real 80×24 and 40×12 terminal tests cover truncation, unavailable evidence and readable timestamps. Run local full checks, focused tests and latency budgets; use no GitHub Actions.

The first slice does not implement cost billing, security remediation, remote administration or a general process manager. Those remain the owners of #42/#44 and existing lifecycle controls. Later collectors extend the tagged request union with explicit bounds and tests.
