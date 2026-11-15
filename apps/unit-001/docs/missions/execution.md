# Checkpointed mission execution

The execution engine can take several bounded steps from one agreed assignment. Each step uses a durable synthetic input, executes only approved tool names, and checks actual files before continuing. An assistant saying “done” cannot complete a mission.

This source slice registers the engine but does not automatically start existing agreements. Managed activation, operator controls and real supervised-process acceptance remain #16 and #17. The normal conversation and existing nonexecuting mission holder keep their behavior.

The first verifier accepts an exact criterion such as `sha256:EXPECTED_HEX_DIGEST:reports/result.txt`. The creator approves that literal requirement with the mission terms. Unsupported prose criteria or additional approval rules block before spending model tokens. This deliberately supports verifiable artifact work first; it does not interpret arbitrary goals as proof.

## Authority and limits

The owner rechecks the exact protected creator receipt before cycle admission, each provider attempt and each direct or nested tool call. Cycles, request attempts, no-progress steps, retry deadlines and wall-clock limits are durable. Waiting uses Durable sleeps and makes no model requests.

A tool-name grant retains that tool's service-account authority. In particular, `bash`, `write` and `edit` are broad capabilities; mission scope prose is not a filesystem or network sandbox. Developer-local authority is writable by the developer account and supplies no root attestation. Managed authority remains root-owned. Same-UID coding tools remain trusted, as in the existing installation security model.

Provider dispatch reserves an attempt before sending it. Mission requests disable provider SDK retries and abort at the mission deadline. With an estimated spend limit, the engine reserves a conservative full-context/output ceiling using the configured model's highest known rates. Unknown or zero pricing cannot admit a capped request. A settled error or unpriced response retains its reservation; a crash without a terminal receipt stays unknown and blocks further dispatch. These are accounting estimates, not a provider billing cap. External shell/tool spending is outside that estimate.

Executable missions accept only the reviewed built-in action catalog. Spawn-capable extensions, image/classifier helpers and new tool implementations need their own admission design before becoming grantable. The current catalog makes no auxiliary provider requests; direct model access from an unreviewed extension is not covered by these gates.

## Persistence and interruption

`unit.mission.execution` is a separate version-one session document. It preserves the formation document and legacy task schema. One activation atomically creates one controller and its task-owned execution conversation. Every cycle saves its stable request ID and submission in the same commit. Reopening observes that submission rather than admitting another.

Tool intent is recorded before execution. Successful completion and known pre-dispatch rejections settle it. Failed or interrupted effects stay uncertain: the verifier may accept independently observable completion, otherwise the engine blocks rather than repeating an uncertain action. This includes an ordinary tool failure whose partial effects cannot be proved absent. An explicit controller abort closes mission intent before owned work finishes draining. Task termination alone is not mission success; the execution document and evidence are authoritative.

File observations reject escaping paths, symlinks, directories, changing files and files above 4 MiB. Each observation has a timestamp. It proves the observed content at that point, not that a separately running process can never change it afterward.

## Local evidence and remaining work

Focused faux-provider tests use real SQLite and the real coding write tool. They cover two autonomous verified steps, false completion, finite cycles and requests, receipt revocation, maintenance sleeps across reopen, interrupted request recovery, pause during dispatch, racing activation, explicit abort and verifier boundaries. No paid provider calls are used.

Before enabling installed-agent execution, #17 must add a protected, revision-bound lifecycle intent and owner controls; ordinary operator messages must not start work. #16 must prove process kill/restart, persisted wakeup and single-owner behavior under supervision. Research/ticket delivery remains #27. New verifiers need explicit host semantics and tests; model judgment does not silently become verification.
