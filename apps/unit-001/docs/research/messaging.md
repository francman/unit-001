# Mission control messaging for Bob

Recommend **Telegram Bot API long polling for personal control**, or **Slack Socket Mode when the creator operates in a Slack organization**. Start with one adapter. Both can receive events without exposing an inbound VPS port and can deliver mission progress or escalation independently of an incoming prompt. Neither replaces Bob's durable mission controller.

Research date: 2026-11-09. Scope: research/design for [#40](https://github.com/francman/unit-001/issues/40), not implementation approval. First-run mission agreement belongs to #14, control APIs to #17, organization/creator orchestration to #41; browser research is #39. No accounts, apps, channels, messages or dependencies were created.

## Transport comparison

Resource judgments are relative, unmeasured incremental costs. None establish that Bob plus an adapter fits a 512 MB VPS. Initial scope should be bounded text/events, no media downloads, voice, member caches or local messaging server.

| Adapter | Setup and inbound path | Proactive outbound / recovery | Fit and recommendation |
|---|---|---|---|
| **Telegram Bot API** | Create a bot with BotFather, protect its token, bind explicit numeric creator/user and chat IDs. Long polling needs outbound HTTPS only; a webhook instead needs public HTTPS and a secret token. | Once the user starts the bot or adds it to a group, Bob can send approved notifications. Persist each `update_id` before advancing the polling offset. Treat callbacks/edits as distinct events. Bot API retention is finite, so offline gaps need visible reconciliation. | **First personal adapter.** Small HTTP transport, no sidecar required. Bots cannot see other bots' messages; do not use it as elder-agent-to-child authority transport. Separate authenticated owner API remains necessary. [API](https://core.telegram.org/bots/api), [setup/initiation](https://core.telegram.org/bots/), [bot-to-bot restriction](https://core.telegram.org/bots/faq#why-doesn-t-my-bot-see-messages-from-other-bots). |
| **Slack Socket Mode** | Install a scoped workspace app; bot token for Web API and app-level token for Socket Mode. Outbound WSS receives events/interactions without public ingress. Bind workspace/team plus native user ID; organization rollout needs its own admin setup. | Post to an authorized channel/DM, subject to membership/scopes. Acknowledge the transport envelope after durable bounded admission; use business `event_id` for Events API dedup, not just `envelope_id`. Reconnect and delivery retries are not a durable mission queue. | **First organization adapter.** One WSS connection, bounded queues; avoid broad history/member syncing. More setup than Telegram; Socket Mode apps currently cannot list in the public Slack Marketplace. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [Events API](https://docs.slack.dev/apis/events-api/), [outbound API](https://docs.slack.dev/reference/methods/chat.postMessage/). |
| **Discord** | Create/invite a bot with minimal guild/channel permissions. Receive through Gateway WSS or interactions; prefer slash commands/interactions rather than consuming every message. Message-content access can require a privileged intent. | Bot REST messages support proactive status in permitted destinations. Gateway sequence/session/resume state recovers connections; message/interaction IDs still need durable application dedup and per-mission ordering. | **Defer unless creator already uses Discord.** Reasonable text-only transport, but reconnect/intents/rate-limit handling add surface. Do not build member caches. [Official Gateway](https://docs.discord.com/developers/events/gateway), [interactions](https://github.com/discord/discord-api-docs/blob/da52492ced82d375981c46618cc3e182daada9a2/developers/platform/interactions.mdx). |
| **Matrix** | Dedicated account on an existing homeserver; HTTPS `/sync` with persisted `next_batch`/`since`. Bind full Matrix user IDs and room IDs. Encrypted rooms require proper device/crypto/key persistence rather than stripping encryption. | Proactive room sends work with appropriate room membership. Stable event IDs and client-generated transaction IDs provide useful protocol support for deduplication; sync gaps and room state still need reconciliation. | **Adapt later for open/federated deployments.** Use a remote homeserver; do not host one on Bob's 512 MB VPS. E2EE adds libraries/state and operational burden. [Current stable v1.19 spec](https://spec.matrix.org/v1.19/client-server-api/). |
| **Signal** | No official bot API selected. The reviewed OpenClaw path uses unofficial `signal-cli`, a separate/linked account, native/JVM daemon or container, JSON-RPC/SSE or REST/WebSocket. Registration/linking and rapid upstream compatibility changes are additional operations. | Can send proactively from its account; dedup must use verified backend envelope identity, with persisted receive state. Do not promise arbitrary replay/history recovery. | **Defer; remote sidecar if later needed.** Extra runtime/process and account custody are poor first fits for 512 MB. `signal-cli` is GPLv3; review redistribution obligations separately from OpenClaw's MIT license. [Upstream README](https://github.com/AsamK/signal-cli/blob/48a0a5e90cb0c36153f0276c0affff090e588290/README.md), [license](https://github.com/AsamK/signal-cli/blob/48a0a5e90cb0c36153f0276c0affff090e588290/LICENSE). |
| **WhatsApp Business Platform** | Business/account/number/app onboarding and webhook ingress. Prefer official Cloud API over treating a personal WhatsApp Web session as a bot API. | Opt-in is required; business-initiated/out-of-window messages require approved templates. Free-form responses have a 24-hour service window. Record message/status IDs and keep delivery acceptance distinct from recipient receipt. | **Defer.** Phone/business setup, templates, pricing and policy constraints obstruct the first low-burden autonomous escalation adapter. OpenClaw's Baileys/Web approach is not evidence of official Cloud API approval. [Current official business policy](https://whatsappbusiness.com/policy/), [Meta API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api). Meta developer overview was inaccessible during this review, so exact webhook API/version setup remains unverified. |
| **Email** | Dedicated mailbox; provider OAuth/API or IMAP over TLS. SMTP/provider API for outbound. An email address/display name alone is not an authenticated creator principal. | Good asynchronous reports/escalations. Persist mailbox+`UIDVALIDITY`+UID for IMAP; Message-ID is useful correlation, not sufficient trust or universal dedup. SMTP acknowledgement is not proof the human read the result; uncertain sends need reconciliation. | **Outbound reports first, inbound control later.** No local mail server. Provider-specific OAuth and MIME/attachment parsing add scope. Do not accept emailed “approve” as high-authority consent without a separate authenticated bound action. [IMAP standard](https://www.rfc-editor.org/rfc/rfc9051.html), [SMTP standard](https://www.rfc-editor.org/info/rfc5321/). |

## One owner, durable events and bounded authority

Messaging is an adapter around the existing sole owner. Proposed trace: platform event → authenticated principal mapping → durable inbox receipt → mission/control admission → committed outcome → durable outbound obligation → transport receipt. The service continues pursuing its agreed mission when no message arrives. Channel outages do not silently cancel an authorized mission; approval waits and delivery failures remain visible state.

Ingress should carry adapter/account/tenant, native sender, destination/thread, native event ID, receive time and bounded payload references. The host assigns ordering per mission/control stream. Commit the inbox receipt before acknowledging or advancing the transport cursor. Duplicate events reuse the same operation; edits do not overwrite an already approved command. Bound inbox retention, event size, burst concurrency and retry/backoff. If durable admission cannot complete within platform acknowledgement limits, fail visibly/rely on redelivery; never acknowledge unrecorded work as accepted.

Use a durable outbox keyed to the exact mission/run/result and allowed recipient. Persist provider acceptance IDs and expose `pending`, `accepted`, `delivered` where reported, `failed` and `unknown` distinctly. A network timeout after submission is not proof of failure. Do not blindly replay external sends or claim exactly-once delivery across platforms. Matrix transaction IDs can strengthen one transport operation; they do not establish exactly-once arbitrary tool effects.

## Creator, elder and organization identity

Provisioned identities remain the source of authority. Map verified platform account+tenant+sender IDs to an existing local human/elder/organization principal with explicit scope. Display names, message text, forwarded material, bot metadata and remembered claims do not establish identity. A relay authenticates its peer; it does not automatically authenticate the original end user. A bot-authored message must not inherit a human creator's authority.

The initial adapter should accept private creator control only. Groups later require both room allowlisting and sender authorization; mentions route attention but do not grant permission. Treat quoted text, fetched pages, attachments and other participants' messages as untrusted evidence. Explicitly authorized elder-agent automation needs loop/depth/rate budgets and delegation receipts; Telegram bot-to-bot limitations make owner IPC/API the appropriate first path.

Mission approvals bind an unpredictable single-use action ID to installation, principal, mission revision, exact proposed effect/arguments, destination and expiry. Render that proposal before confirmation; resolve the stored proposal server-side, not text supplied by a button. Reject stale/replayed/mismatched approvals and record the decision atomically. Ordinary already-authorized mission work does not need another confirmation. Administrative OS/security configuration still follows the sudo/provisioning boundary; a channel button cannot manufacture root authority.

## OpenClaw patterns to adapt

Pinned source: [`f947b3caf5d0fb04c780205dfeff509d87cd2527`](https://github.com/openclaw/openclaw/tree/f947b3caf5d0fb04c780205dfeff509d87cd2527), possibly unreleased. Its [Telegram access controls](https://github.com/openclaw/openclaw/blob/f947b3caf5d0fb04c780205dfeff509d87cd2527/docs/channels/telegram/access-control.md) distinguish numeric sender IDs, group IDs, DM pairing and group authorization. Its [Slack identity boundary](https://github.com/openclaw/openclaw/blob/f947b3caf5d0fb04c780205dfeff509d87cd2527/docs/channels/slack/access-control.md) distinguishes verified native sender identity from asserted relay/metadata identity. Its [Slack transport guide](https://github.com/openclaw/openclaw/blob/f947b3caf5d0fb04c780205dfeff509d87cd2527/docs/channels/slack/transports.md) separates Socket Mode and public HTTP ingress and documents bounded reconnect behavior.

Adopt those boundaries and explicit transport health. Do not copy broad open-DM/group defaults, bot-triggered authority, a new gateway runtime or every channel at once. OpenClaw is MIT; copying substantial code/docs requires its notices. No channel SDK is selected here: review exact pinned dependencies and their licenses before implementation. Platform API access and messaging policies remain separate from an SDK's open-source license.

## Small proposed acceptance slice

Implement only after #14/#17 define mission/control receipts: one text-only adapter, explicit creator binding, inbound durable dedup, status/approval control, and approved proactive escalation through the same owner. Simulated platform/faux-provider tests should cover duplicate delivery, restart after inbox commit, out-of-order edit, wrong user/tenant/room, stale approval, unknown send outcome, revoked grant, unavailable channel and bounded resource use. Run actual terminal/operator checks and measure incremental idle/peak RSS on the 512 MB target before release. A real opt-in delivery check requires explicit channel credentials and authorization; none was performed here.

## Coding definition for the first adapter

This is a proposed interface, not an existing exported API. Current integration anchors are `src/agent.ts` (`submit`, `ask`, `status`, `memory`, conversation watches), `src/service.ts` (bounded owner requests), `src/orientation.ts` (observed runtime facts), and the public Durable document/task APIs already used by unit-memory. Do not forward remote platform events into today's trusted local operator socket: #17 must admit a separately authenticated principal and permission scope.

Proposed new app components: `src/channels/types.ts` for the wire-independent contract; `inbox.ts` and `outbox.ts` for durable receipts/tasks; `telegram.ts` for the single initial transport; `control.ts` for principal-bound owner admission; and focused tests matching each mechanism. Slack replaces only the transport if selected instead. No transport imports another agent runtime.

```ts
type ChannelPrincipal = {
  adapter: "telegram" | "slack";
  accountId: string;
  tenantId: string;
  senderId: string;
};
type IngressEvent = {
  eventKey: string;
  principal: ChannelPrincipal;
  destinationId: string;
  threadId: string | null;
  receivedAt: number;
  payload: { kind: "text"; text: string } |
    { kind: "approval"; actionId: string; decision: "approve" | "reject" };
};
type InboxReceipt =
  { kind: "admitted"; operationId: string; missionRevision: number | null } |
  { kind: "rejected"; reason: string };
type DeliveryState =
  { kind: "pending"; attempt: number; nextAttemptAt: number } |
  { kind: "accepted"; providerMessageId: string; acceptedAt: number } |
  { kind: "failed"; reason: string } |
  { kind: "unknown"; attemptId: string; reason: string };
```

`eventKey` is derived by the adapter from native identity, never from model text. Bind it to a canonical payload digest; identical retries return the recorded receipt, conflicting payloads reject. Host provisioning maps `ChannelPrincipal` to the #14 creator/delegation principal; that map is administrator-owned, versioned and never writable through ordinary channel commands. Tenant/account/sender/destination must all match before admitting an approval.

Persist a version-1 `ChannelInboxDoc` and `ChannelOutboxDoc` through the existing sole owner's public Durable commits. Store bounded canonical text, receipt IDs, source IDs, cursor and outbox state; do not duplicate full media or credentials in documents. Root-owned per-installation credentials/config remain separate. New documents start empty; upgrading from 0.0.7 creates no channel or grant automatically. Future schema migrations must preserve dedup/outbox receipts and reject unsupported readers rather than replay effects.

The inbox admission commit atomically records receipt plus the #17 mission/control operation; a service response alone is not that commit. Outbox tasks own retry state, persist an attempt ID before an external send, and retain unknown outcomes for reconciliation. Telegram polling advances only after all earlier accepted/rejected events are durable. Bound a received text to 8 KiB, one event payload to 16 KiB, a provider batch to 100, and initial active adapter executions to one. These are proposed guard values, not measured performance SLOs. Do not prune receipts within the promised replay window; at capacity reject/pause intake and expose the reason. #14 must decide mission receipt retention before implementation.

Ordered slices: (1) #14/#17 principal+mission approval port and fake transport, including duplicate/conflicting/stale-approval tests; (2) #40 one outbound-only progress/escalation adapter with unknown-send recovery; (3) #40 private inbound status and bound approvals with durable cursor restart tests; (4) optional ordinary mission instructions and organization/elder mapping after #41. Add a read-only `/channels` projection in the existing TUI only after owner facts exist, with actual 80×24 and 40×12 PTY checks. Require zero provider/model calls in adapter tests, no new response-path history scans, the existing latency suite unchanged, and measured idle/peak RSS on the target before enabling it by default. Group activation, media, voice and additional transports remain separate slices.
