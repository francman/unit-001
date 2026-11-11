# Channel setup

The channel foundation lets an agent discover adapters, record setup requests and complete creator-granted setup. It does not enable remote conversation ingress. Telegram uses outbound HTTPS and its official managed-bot workflow; there is no public listener or second agent loop.

The agent proposes an exact destination, capability list and expiry. A separate protected creator grant permits that request. Setup checks permission before each external step and records its outcome. A stale creator revision, expired grant or disabled channel prevents new steps. Status shows last observed health, not continuous connectivity.

Telegram needs an existing management bot with Bot Management Mode enabled in BotFather. After secure bootstrap, the agent provides Telegram's confirmation link. The creator confirms there; the agent verifies the resulting managed-bot event, retrieves the token and verifies its bot identity. It cannot silently create a bot or sign into the creator's account. Never paste tokens into conversation.

## Current integration boundary

The core exports `channelExtension`, `handleChannelCommand`, protected channel authority helpers and the real Telegram HTTP client/setup adapter. Tests install them into the existing owner and reopen real SQLite. Default application registration, installed administrator commands and secure interactive bootstrap are the remaining integration slice. No live account has been enabled or delivery tested. [#56](https://github.com/francman/unit-001/issues/56) tracks that work; messaging delivery remains [#40](https://github.com/francman/unit-001/issues/40).

## Records and authority

`ChannelDoc` version 1 is session-scoped. It stores at most 16 channels and 1,024 setup receipts, with exact request revisions/digests, setup attempts and observed health. Fresh installations start empty; upgrading creates no grant. Unsupported document readers must reject rather than replay setup. Capacity exhaustion stops new requests visibly; do not prune replay receipts automatically.

The adapter catalog is host-registered metadata. `available` means implemented adapter support, not a configured destination. `awaiting_creator` names the missing grant, manager bootstrap or Telegram confirmation. `ready` records successful setup and identity verification at its timestamp. `failed`, `unknown` and `disabled` remain distinct in the outcome; uncertain attempts require explicit reconciliation. No external creation call is automatically retried.

`channel-authority.json` lives beside protected mission authority. It binds the same installation/session, creator and authority revision, with a separate adapter/destination/capability ceiling, disabled-channel list and exact request grants. Mission approval is never channel approval. Managed writes require Linux root; the agent's model tools and ordinary local commands cannot issue grants. The model can propose permissions; deterministic checks decide whether they apply.

Credentials stay in an owner-private directory, under host-derived references. They never enter channel documents, model tool output or provider error strings. This profile does not isolate credentials from coding tools running as the same service UID; the existing trusted local operator already has that authority. It is not a privileged secret broker. Remote untrusted text must not be forwarded into that coding conversation under a narrower-looking channel grant.

## Telegram setup and recovery

The private `telegram-manager` reference contains the manager token, numeric Telegram creator ID, manager username and optionally the exact managed bot ID. The adapter supplies a deterministic suggested username and public creation link. It accepts only a provider `managed_bot` event matching the provisioned creator and the requested bot ID or suggested username. If the creator edits that username, secure bootstrap must bind the chosen bot explicitly.

Telegram's update retention is finite. This first setup client uses a dedicated manager and does not advance a shared delivery cursor. Lost confirmation evidence leaves setup pending; it does not assert ownership from model text or silently create another bot. Existing credential retrieval and `getMe` verification are read-only protocol operations. Token rotation, general messaging cursors, inbox/outbox delivery and proactive notifications need their separate reviewed slices.

The setup journal commits an attempt before external work. After interruption, normal setup reports the saved unknown attempt. Explicit reconciliation may repeat only the adapter's safe read/verification steps. Each step rereads current authority; changing creator revision or revoking the grant stops later effects. Private credential publication is atomic and remains outside SQLite. Final status commits only after another permission check.

## Verification

Focused tests cover two adapter contracts, request conflicts, stale revisions, wrong principals, grant expiry/revocation/disable, protected file/symlink permissions, actual current-UID managed-write denial, restart reconciliation, SQLite reopen and faux model tools. Local HTTP tests exercise the real Telegram request paths and response parsing, wrong bot identity, bounded batches and secret-redacted errors. These checks use no external credentials, paid models or GitHub Actions. Native Linux root issuance and installed terminal bootstrap require separate integration acceptance before release.

Primary protocol references: [managed-bot creator workflow](https://core.telegram.org/bots/features#managed-bots), [Bot API token methods](https://core.telegram.org/bots/api#getmanagedbottoken), [user-only lower-level creation](https://core.telegram.org/api/bots/managed-bots).
