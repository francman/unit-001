# Checkpointed bounded work

The execution engine can take several bounded steps from one agreed assignment. Each step uses a durable synthetic input, executes only approved tool names, and checks actual files before continuing. An assistant saying “done” cannot prove the work is complete. Completing this assignment does not complete the agent's enduring mission. The current schema still combines purpose and work terms; the [purpose and work contract](purpose.md) defines the required separation and continuous-planning gap.

The engine does not automatically start existing agreements. [Bounded-work controls](controls.md) provide protected activation and inspection. Native supervised-process qualification remains #16. The normal conversation and existing nonexecuting mission holder keep their behavior.

The first verifier accepts an exact criterion such as `sha256:EXPECTED_HEX_DIGEST:reports/result.txt`. The creator approves that literal requirement with the mission terms. Unsupported prose criteria or additional approval rules block before spending model tokens. This deliberately supports verifiable artifact work first; it does not interpret arbitrary goals as proof.

## Authority and limits

The owner rechecks the exact protected creator receipt before cycle admission, each provider attempt and each direct or nested tool call. Cycles, request attempts, no-progress steps, retry deadlines and wall-clock limits are durable. Waiting uses Durable sleeps and makes no model requests.

A tool-name grant retains that tool's service-account authority. In particular, `bash`, `write` and `edit` are broad capabilities; mission scope prose is not a filesystem or network sandbox. Developer-local authority is writable by the developer account and supplies no root attestation. Managed authority remains root-owned. Same-UID coding tools remain trusted, as in the existing installation security model.

Provider dispatch reserves an attempt before sending it. Mission requests disable provider SDK retries and abort at the mission deadline. With an estimated spend limit, the engine reserves a conservative full-context/output ceiling using the configured model's highest known rates. Unknown or zero pricing cannot admit a capped request. A settled error or unpriced response retains its reservation; a crash without a terminal receipt stays unknown and blocks further dispatch. These are accounting estimates, not a provider billing cap. External shell/tool spending is outside that estimate.

Executable missions accept only the reviewed built-in action catalog. Spawn-capable extensions, image/classifier helpers and new tool implementations need their own admission design before becoming grantable. The current catalog makes no auxiliary provider requests; direct model access from an unreviewed extension is not covered by these gates.

## Persistence and interruption

`unit.mission.execution` is a separate version-two session document with an explicit version-one migration. It preserves the formation document and legacy task schema. One activation atomically creates one controller and its task-owned execution conversation. Every cycle saves its stable request ID and submission in the same commit. Reopening observes that submission rather than admitting another.

Tool intent is recorded before execution. Successful completion and known pre-dispatch rejections settle it. Failed or interrupted effects stay uncertain: the verifier may accept independently observable completion, otherwise the engine blocks rather than repeating an uncertain action. This includes an ordinary tool failure whose partial effects cannot be proved absent. An explicit controller abort closes mission intent before owned work finishes draining. Task termination alone is not mission success; the execution document and evidence are authoritative.

File observations reject escaping paths, symlinks, directories, changing files and files above 4 MiB. Each observation has a timestamp. It proves the observed content at that point, not that a separately running process can never change it afterward.

## Local evidence and remaining work

Focused faux-provider tests use real SQLite and the real coding write tool. They cover two autonomous verified steps, false completion, finite cycles and requests, receipt revocation, maintenance sleeps across reopen, interrupted request recovery, pause during dispatch, racing activation, explicit abort and verifier boundaries. No paid provider calls are used.

Protected, revision-bound execution intent and owner controls are implemented; ordinary operator messages cannot start work. Real process-kill, persisted-wakeup and single-owner fixtures pass, while native systemd installation/update/rollback qualification remains #16. Research/ticket delivery remains #27. Continuous purpose-driven planning requires the separate purpose/work model above. New verifiers need explicit host semantics and tests; model judgment does not silently become verification.
