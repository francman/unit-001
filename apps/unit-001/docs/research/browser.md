# Give Bob a remote browser with bounded authority

**Recommendation:** keep Bob's mission owner on the small VPS and attach an optional, separately provisioned browser worker. Start with public-page research using semantic page observations and screenshots when needed. Add private sign-in and external actions only through an authenticated human handoff and mission-bound grants. Do not install a full browser stack on the 512 MB VPS by default.

Research/design for [#39](https://github.com/francman/unit-001/issues/39), checked 2026-11-09. Bob source reviewed through `edf7503a58ab3ea47f99578c96e27b3a6d1e9d1e`. No competitor/browser service was exercised, no account created and no paid requests made. The recommendation is architectural; its resource budgets and reliability still require measurement.

## Product identities and useful patterns

| Product | Primary evidence | Adopt or adapt for Bob |
|---|---|---|
| Meta Muse | Its official security article describes a browser broker outside the agent runtime and a controlled browser subagent interface. Its design article describes background goals and progress views. | Keep browser execution distinct from mission authority. Do not reproduce its entire proprietary VM/security stack or claim its isolation from a tool wrapper. [Security](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), [design](https://muse.ai/blog/how-we-designed-muse) |
| ChatGPT Dots | Official documentation identifies a separate cloud computer/browser, private sign-in and human take-over/return-control. Cloud and connected local sessions remain separate. | Explicit session identity, handoff and resumable ownership; connection is not blanket permission. [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps) |
| Dots controls | Official security guidance distinguishes browser, shell network and desktop controls. A read-only plugin does not prevent actions through a separately signed-in website. Some site rules are described as future controls. | Test every enabled route; do not declare a read-only connector a global write prohibition or present proposed vendor controls as shipped. [Security](https://learn.chatgpt.com/docs/enterprise/dots-security) |
| Claude Duet | Anthropic identifies a proactive research-preview app with a cloud browser; its launch says the preview cannot yet show users that browser. | Browser observability is a requirement for Bob, not assumed parity. [Launch](https://claude.com/resources/articles/claude-duet) |
| Duet browser boundary | Its security article describes a separate browser VM, fixed commands, isolated credentials, and page text/downloads as remaining untrusted input. It also describes identifying agent traffic to websites. | Keep secret entry outside model prompts, constrain browser operations and honor site access decisions. These are vendor claims, not a tested Bob boundary. [Security](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security) |

The names are verified: **Dots** is an OpenAI product and **Claude Duet** is Anthropic's singular product name. The reviewed product documentation does not establish a reusable browser-control API for Bob. Product documentation does not establish a transferable implementation license.

## Bob's current gap and implementation choice

The app package has no browser automation dependency. `src/interaction.ts` opens provider sign-in URLs in the user's browser; that is not an agent browser. Existing coding tools may launch arbitrary programs, but no browser session contract, bounded observation, action receipts or browser handoff is installed.

Prefer a Playwright-backed worker behind a narrow Bob adapter. Playwright supplies browser/context/page mechanisms rather than making Bob invent browser automation. Its documentation supports remote connections; CDP attachment is Chromium-only and explicitly lower fidelity than its native protocol. Browser contexts separate cookies/storage for reproducible sessions; they are not an OS boundary against a hostile browser or browser controller. [BrowserType](https://playwright.dev/docs/api/class-browsertype), [contexts](https://playwright.dev/docs/browser-contexts)

Use semantic accessibility observations and stable references first, with a bounded screenshot fallback for visual controls. Current Playwright documents AI-oriented ARIA snapshots; implementation must pin a released version and verify its installed types before selecting an API. Do not code against an unreleased main feature. [Page API](https://playwright.dev/docs/api/class-page)

Reference Playwright source snapshot `ce81b8028d1a4a2a9563b4598fba4a4f7d315d87` for reproducibility. It is Apache-2.0; maintain required notices if copying source. Browser distributions and any hosted worker/provider have separate licenses, terms, retention and pricing. No dependency selection or lockfile change is authorized by this proposal. [Pinned license](https://github.com/microsoft/playwright/blob/ce81b8028d1a4a2a9563b4598fba4a4f7d315d87/LICENSE)

## Proposed coding contract

Proposed app files: `src/browser/types.ts` for the adapter contract, `controller.ts` for mission admission/receipts and `extension.ts` for bounded model tools. A separate worker owns Playwright and browser state. Integrate through public Durable tool/task APIs, existing owner cancellation and #14/#17 principal/revision contracts. These files/interfaces are proposed, not existing exports.

```ts
type BrowserScope = {
  installationId: string;
  principalId: string;
  missionId: string;
  missionRevision: number;
};
type BrowserSession = {
  sessionId: string;
  scope: BrowserScope;
  generation: number;
  state: "ready" | "human_control" | "expired" | "closed";
};
type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "observe" }
  | { kind: "click"; reference: string }
  | { kind: "type"; reference: string; text: string }
  | { kind: "scroll"; direction: "up" | "down" };
type BrowserReceipt = {
  actionKey: string;
  sessionId: string;
  generation: number;
  result: "observed" | "applied" | "rejected" | "unknown";
  observedAt: number;
  evidenceRefs: string[];
};
```

The adapter authenticates the worker and installation. Server-generated session/action IDs bind scope; a model-supplied URL, reference or session ID conveys no authority. Observations carry URL, timestamp, page generation and bounded semantic references. Reject stale references after navigation or human takeover. Do not offer arbitrary evaluation, cookie export, raw CDP, shell or unrestricted filesystem operations in the browser API. That narrower API does not contain Bob's separately retained trusted shell tools.

Persist version-1 `BrowserSessionsDoc` and `BrowserReceiptsDoc` through the sole owner; store worker references, action digests, control state and evidence metadata, not cookies/passwords/full pages. Worker-side browser profiles are private and installation/principal scoped. Authenticate any reconnect and recheck mission revision/grants. Existing installations create no session or access grant automatically. Explicit migrations preserve completed/unknown action receipts; browser session loss does not erase effect uncertainty.

Public-page reading still sends traffic and can hit malicious destinations. Initial policy permits only approved HTTP(S) public destinations; network enforcement must reject loopback, link-local, private/metadata destinations, redirects and DNS rebinding at the actual connection boundary. A string hostname check or Playwright request callback alone is insufficient proof. Disable downloads/uploads initially. Isolate research context from authenticated profiles. Page content, screenshots and downloaded documents are evidence, never creator instructions.

Private sign-in happens through a trusted authenticated handoff surface identifying the exact origin; never ask the user to paste secrets into chat. Human takeover suspends automation; returning control increments the generation and requires a new observation. A domain allowlist is not authority for every purchase, submission or recipient on that domain. Bind external effects to the mission grant or an exact expiring approval, as defined in #14/#44. Do not classify every click as harmless: navigation itself may perform an effect on a poorly designed site.

## Failure, resources and acceptance

The owner commits the action key/digest before dispatch. Worker duplicate keys return the recorded result when available; conflicting payloads fail. If the browser/connection dies after a possible effect but before acknowledgement, mark `unknown` and reconcile observable state or ask for a decision. Never automatically replay a form submission, purchase or message. Cookies/profile persistence requires explicit retention/revocation policy; disconnecting a worker is not proof a site session was revoked.

Proposed initial limits: one browser action at a time, one active session, 16 KiB semantic observations, screenshots bounded to one viewport and 1 MiB, 30-second action deadlines and no continuous video. These are test targets, not measured SLOs. Abort frees outstanding worker operations; owner shutdown closes transport without forgetting unknown effects. Worker CPU/RAM, screenshot transfer, inference and hosted session charges remain separate cost dimensions under #42. No local Chromium or remote paid plan is a proven 512 MB solution until measured end to end.

Ordered slices:

1. **#39 fake adapter and public fixture.** Add contract, receipts, stale-generation rejection, cancellation and restart tests. Use a deterministic local site only in the disposable test boundary; do not weaken production private-address rules. No real sign-ins, external messages or paid calls.
2. **#39 real remote worker.** Pin and review Playwright/released types, authenticate transport, measure RSS/latency and exercise navigation, SPA updates, iframe references, visual fallback, resize and worker disconnect. Verify cross-installation and principal isolation. Render actual observations and handoff status in existing 80×24/40×12 PTYs; no raw secret material or debug socket URLs.
3. **#14/#17/#44 controlled private work.** Add secure sign-in/human takeover, tested destination/egress enforcement, upload/download grants and exact-effect approvals. Test wrong principal, stale revision, takeover race, malicious pages, credential leakage markers, redirects/rebinding and crash at every action boundary.
4. **#15/#40 autonomous use.** Let the agreed mission choose browser research as one action and produce source-backed outcomes. Notifications use the existing outbox contract. Browser availability must not become a second mission runtime or restart an already completed effect.

Final acceptance: Bob wakes for an agreed research mission, uses the fixture browser, records sources and a recommendation, survives restart, and reports an unavailable/blocked site honestly. A second fixture proves that an ambiguous submission is reconciled rather than repeated. Real target-host acceptance separately checks resource use and worker/session revocation; no anti-bot or site-access bypass is part of this design.
