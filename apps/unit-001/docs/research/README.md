# Research definitions for the agent

Prioritize the mission agreement and durable decision loop. The other capabilities attach to the same owner; they do not replace it. These reports are proposed implementation definitions, not evidence that the features are shipped or external actions are authorized.

Research sources were checked on November 9, 2026. Prices, product availability and API types must be rechecked when coding. Source reviews, vendor claims, measured behavior and proposed limits are distinguished in each report. Publication review occurred on November 10, 2026; it did not rerun vendor benchmarks or inspect the live VPS.

| Board work | Recommendation and coding definition |
|---|---|
| #14–#17 mission foundations | [OpenClaw adaptations](openclaw-practices.md), [Muse and predecessor qualities](agent-qualities.md) |
| #39 browser | [Optional remote browser worker](browser.md) |
| #40 messaging | [One authenticated mission-control adapter](messaging.md) |
| #41 organizations | [Thin Paperclip adapter around the agent's owner](organizations.md) |
| #42 self-metrics | [Recorded charges, estimates and coverage](self-metrics.md) |
| #44 security | [Observed controls and residual exposure](security-posture.md) |
| #45 voice | [Hosted speech ports and device audio](voice.md) |
| #46 peer collaboration | [Team contracts and delegation receipts](peer-collaboration.md) |
| #48 simplicity | [Small behavior-preserving refactors](simplicity-audit.md) |

Each definition identifies components/interfaces, durable state, migrations, authority, recovery, resource limits, acceptance tests and ordered coding slices. Shared mission authority remains canonical under #14; adapters must not create parallel mission stores or interpret conversation text as a permission grant. The [scope briefs](requests.md) preserve the requirements behind the short board tickets.

## Validation and completion

Use [standalone verification](../operations.md#standalone-verification), never GitHub Actions. Historical native evidence applies only to its recorded source; it cannot stand in for changed code. A missing local native host, security schedule or renewal mechanism remains a coverage gap. Do not install a CI/build workload on the agent's production VPS.

Before implementation, check the current public APIs and exact dependency/license terms. Preserve upstream Pi and the existing owner's storage and lifecycle boundaries. Proposal-specific numbers are evaluation targets until measured. A closed research item means its reviewed report and coding tasks are published; it does not mean the proposed feature is implemented. The board remains the live work record.
