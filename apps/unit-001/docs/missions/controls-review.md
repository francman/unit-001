# Lifecycle review and regression evidence

The initial independent Claude review found five blockers. The corrected implementation addresses each trace below. Passing tests support source acceptance; native systemd installation/update qualification remains separate. Claude's account is weekly-limited until November 15 at 13:00 America/New_York, so final independent peer review must cover the corrected head.

| Original blocker | Corrected behavior and regression |
|---|---|
| Revocation prevented stop | Restrictive root intent binds the existing execution without a continuation receipt. Creator changes preserve sequence; helpers also compare the applied sequence. Real in-flight request drainage after creator replacement is tested locally and with distinct Linux UIDs. |
| Startup resumed unrelated work | Gate-only initialization commits restrictive state and abort intent without scheduler-resuming APIs. Permitted startup then drains. Unconfigured/inhibited reopen with unfinished ordinary work makes zero requests. Held pending stop is applied before maintenance release. |
| Superseded request ID reopened work | Caller-supplied lifecycle IDs require their explicit captured policy revision on both CLI paths. Replaying resume R1 after pause P2 fails before rewriting authority. Current exact retries remain idempotent. Cancelling a pre-provider start also consumes a revision in the protected intent receipt; configured reopen rejects the original revision-zero start without allocating an execution. |
| Missing managed intent inherited permission | Managed admission requires matching protected/applied request ID and sequence, agreement digest/revision and current authority. Version-one migration preserves the entire ledger with `intent: null`, which cannot authorize managed dispatch. Missing, changed, revoked and expired receipts fail closed. |
| Recovery/security proof incomplete | SQLite tests cover live tool plus owned background drainage, uncertain-effect resume refusal, all cumulative counters across reopen/resume, amendment rejection, pending intent and held/inhibited startup. Network-disabled Ubuntu amd64 exercises actual root/helper/operator/service UID boundaries, SIGKILL recovery, persisted wake and sole ownership. |

The initial reviewer receipt is `/private/tmp/unit-mission-controls-review-initial.txt`; its blocker descriptions are retained in PR history. Review the corrected source and tests rather than treating that receipt as approval. Published rollback-reader acceptance covers formation-only state; it does not authorize rolling back an execution ledger into a reader without mission admission.

No GitHub Actions, upstream changes, provider credentials, paid provider requests or production rollout are required by these checks.
