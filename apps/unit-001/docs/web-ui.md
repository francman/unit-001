# Browser workspace

Run `agent web` in an authorized operator terminal, without sudo. On a developer-local installation, open the printed `http://127.0.0.1:4317` address on your trusted workstation. The browser shows conversation, mission, memory and connection state. It can send direction, cancel the current run and explicitly forget selected memories. The owner retains storage and execution authority.

For managed Bob, configure the `unit-001` SSH profile to forward to the operator-only socket before opening Bob in your browser. Add this line under `Host unit-001` in the trusted workstation’s SSH config:

```sshconfig
    LocalForward 127.0.0.1:4317 /home/ubuntu/.unit-001/web/9b461de0-05b6-41d7-9847-06709353bd44.sock
```

Then start the gateway:

```sh
ssh unit-001
bob web
```

Then open the printed address locally. To set up a profile on another trusted workstation, forward local `127.0.0.1:4317` to the printed Unix socket path. If that local port is occupied, use `--port 4318` and change the local forward to match. Managed installations use only the filesystem socket.

Use the exact `Browser workspace` URL printed by the command. Direct browser navigation may omit `Origin`. Writes require the exact origin.

Ctrl+C or disconnecting the SSH terminal stops the browser gateway. Keep operator-owned socket paths in place while the launcher is running or shutting down. Owner work continues, including when you close a tab. After restarting the gateway, the browser reconnects without a code. Each deliberate action uses the new gateway’s request metadata.

## Authority and access

The gateway runs in a separate process as the operator. Managed installations reject owner/root web launches; the launcher resolves only the installation's existing operator socket. It never opens SQLite or private credentials. Creator approval, connection grants, security changes, updates and lifecycle administration have no browser endpoints. Source-checkout launches use the developer's existing owner socket and authority.

Every request checks Host and any supplied Origin against the printed loopback URL and rejects forwarded headers. POST requests also require same-origin JSON and a gateway-scoped CSRF token. On the managed host, OS permissions on the operator’s socket enforce access. The workstation listener is TCP loopback, so any process that can reach it is trusted as the operator. Use this flow only on a trusted workstation. Developer-local TCP uses the same trust model. Host, Origin and CSRF address browser requests across origins.

The stylesheet is Tailwind v4 (exact-pinned dev dependencies `tailwindcss` and `@tailwindcss/cli`) compiled by `scripts/build-tailwind.mjs` into a single static `style.css`; no inline styles or runtime CSS generation, so the CSP stays `style-src 'self'`. For design review without an owner, `node scripts/build-web-preview.mjs` builds a sample-data preview into the gitignored `web-preview/` (never part of a release).

The visual rules and token table live in `.pi/skills/web-ui-design.md`. The look follows Hermes.app, the Hermes desktop chat app: Cursor-like chrome, 13 px text, 28 px rows, near-square corners (2 to 4.8 px), hairline borders, a blue accent used sparingly, system fonts only. Light and dark follow the system setting; the theme button in the sidebar footer cycles system, light and dark and keeps the choice per browser. Color means state only: green connected or done, amber waits for the owner, red blocked, offline or failed.

Layout: a 260 px sidebar (wordmark, the agent's name as a tab, the pages Chat, Mission, Status, Memory, Connections and About with a count on the page that needs the owner, and a footer with the theme button and the version), a 34 px top bar with the page path, and a 20 px status bar across the bottom with the gateway connection, the agent's state (one state by fixed precedence: connection, the reply in progress, what needs the owner, then scheduled work, for example "Replying · read_file · 12 s" or "Blocked · needs you"), and the model, tokens and cost estimate the backend reports. Below 768 px the sidebar opens over the page from the top bar's Menu button. Above every page, strips say what the owner must do (blocked scheduled work with unknown results, a maintenance hold, a missing model, a lost connection) with the terminal command to copy. Chat is home: the owner's messages are bordered boxes that stay pinned while the reply scrolls under them, replies are plain text, tool calls are dimmed one-line rows, and the composer card (one line, grows to 150 px, then scrolls) holds the model and one send button that becomes Stop while a reply runs. Below 1440 px a purpose line sits above the conversation; from 1440 px a read-only Activity pane (300 px) beside it shows the purpose, scheduled work, memory and connections. The other pages use one centered 832 px column with a title, a lead sentence and sections. The Mission page holds the agreed purpose (with the approval receipt), the current work run with its limits, recorded checks, history and the terminal commands that show the same facts. Status keeps totals, memory and runtime. Browser approval does not start work.

For design review the preview accepts `?section=status|memory|connections` (`channels` still works as an alias), `?theme=light|dark`, `?empty=1`, `?busy=1`, `?blocked=1`, `?held=1`, `?unconfigured=1`, `?norun=1`, `?long=1`, `?details=none`, `?draft=long`, `?unknown=1`, `?connection=connecting|offline`, `?memory=1`, `?forget=1`; `preview.ts` lists them with what each shows.

Assistant messages render a limited Markdown subset without interpreting HTML, loading images, or making model URLs actionable. Owner messages and copied replies keep their original text. Use the explicit Stop control to cancel chat work; Escape never sends a cancel request.

When Chat shows a bounded window, **Load earlier messages** reads the retained transcript a page at a time. A failed read can be retried without removing rows already shown. Older rows stay in the open tab but are not saved in browser storage; after reload, load them again from the owner.

Use **Define mission** or **Amend mission** to open the draft card in Chat. Opening it does not send a message. Discuss or edit the terms, then select **Review for agreement** to see the exact proposed revision. **Agree** appears only if the gateway confirms that the local launcher permits it; otherwise use the terminal command when available. If the receipt has been issued but reconciliation is pending, wait for the status to update. Agreeing does not start work.

The Memory page draws the memories as a map on a canvas (a `d3-force` layout, node size by degree) with the List view as its text equivalent. The first time the map is shown after the page loads, it forms: memories appear one by one, most related first, their relations draw in, the layout settles, and then the memories glide into a side-view brain while a hairline outline of it is traced. That takes about two seconds, and the first click, wheel turn or key press during it jumps to the end. Later changes of the memories (a filter, a new or forgotten memory, leaving the Focus view) re-form the brain quickly instead of replaying the intro. With fewer than 12 memories, and in the Focus view, there is no brain, only the appearing animation. A dragged memory pulls its neighbours along and springs back to its place when let go. With reduced motion the finished brain is shown at once and nothing animates. Positions in the brain carry no meaning; the shape is only a layout target. The preview switches `?graph=small|mid|large` show 8, 30 and 300 memories.

Graph and List apply the same filters and focus scope. On touch, the map allows page scrolling and tap-to-inspect by default; enable Graph gestures to drag or pan.

Static assets use an exact path map, never a filesystem traversal. The production builder bundles `bootstrap.ts` and copies only `index.html`, `bootstrap.js` and `style.css`. `preview.ts` and its fixture controls are excluded from production assets and releases. Text renders through DOM text nodes, including model output; no executable model-generated markup is accepted.

## Requests and recovery

All API paths start with `/api/v1`. Responses and assets have `Cache-Control: no-store`.

| Method/path | Purpose |
| --- | --- |
| GET `/session` | Get the running gateway’s CSRF token for future deliberate requests. |
| GET `/events` | Watch bounded owner snapshots over server-sent events. |
| POST `/requests` | Submit one stable-ID operator operation. |

The closed operation set is status, send, cancel, earlier root conversation messages, mission status, draft, propose and explicitly confirmed agreement, channel status, memory stats, memory graph, recall and explicitly confirmed forget. Earlier messages use a bounded, exclusive cursor and do not resume work. The memory graph is a read-only snapshot of at most 300 live memories (newest by update), content truncated to 280 code points, summary links only between returned memories (at most 1,000), and an opaque per-owner key instead of each conversation ID; forgotten memories never appear. Browser requests cannot select another installation, claim creator authority or change the configured endpoint.

Agreement names the exact proposed revision and digest shown for review. Developer-local owners can issue the agreement on a trusted workstation. Managed installations use terminal approval. A structured refusal means issuance did not occur. An issued receipt may still be pending owner reconciliation.

The mission plan shows the overall purpose, strategy, tactical work and saved review notes. **Review now** records a note from existing evidence. It makes no model request. A plan can bind at most one runnable tactical to an exact approved purpose. Agreement applies to the complete reviewed revision. Execution stays closed until a separate Open for that revision.

On a managed installation, copy the approval command for the exact revision and digest into the authorized terminal. A later edit leaves an earlier reviewed proposal eligible until the agreed head changes. After a new head is recorded, save any remaining draft again before proposing it against the new head.

A POST response returns only the fields defined for that operation. Send returns an acknowledgement or a notice that an admitted message ended without an answer; conversation text comes from the event stream. An unexpected mutation reply after dispatch is unknown. Only rejection before dispatch restores the send draft.

Each explicit action gets one request ID. Within the current write generation, a repeated ID with the same input receives the same gateway result; different input conflicts. The gateway can renew the write credential after pending mutations settle, without restarting or dropping the workspace stream. A request rejected before dispatch during a renewal can be tried again after reconnect. Mutations are never automatically retried: a dropped reply remains unknown, including when it carried the new credential. Inspect the conversation and keep the request ID before acting again. Owner send/forget receipts remain the durable deduplication boundary. Drafts stay in page memory on a verified same-workspace reconnect; reloading discards them.

Limits are two streams, four active requests, thirty-two retained mutation outcomes per write generation, 1 MiB owner frames, 128 KiB projected browser response envelopes (1 MiB for the memory graph and mission plan responses), 64 KiB HTTP input and two-minute request observation. If the receipt limit is temporarily full, wait for active requests; no launcher restart is needed. The browser limit includes the full response envelope. Slow streams disconnect before they accumulate backlog. Shutdown detaches observation. Admitted owner work survives.

## Local verification and release gate

`test/web-gateway.test.ts` and `test/web-review.test.ts` exercise Host, Origin, CSRF, bounds, deduplication and pending cleanup. `test/web-owner.test.ts` uses real SQLite and the owner’s operator socket to verify packaged assets, streaming, replies and explicit forget. The browser fixture exercises startup, streamed updates, malicious text handling, memory confirmation, cancellation and desktop/mobile layout. Release tests verify the asset inventory and checksums.

Native Linux account isolation and complete packaged/systemd acceptance must pass before production release. GitHub Actions remain disabled. No production installation or public exposure is implied by source merge.

Run the transport and real browser checks after building the app:

```sh
npm run build --workspace apps/unit-001
# From apps/unit-001:
node ../../node_modules/vitest/dist/cli.js --run --config web/vitest.config.ts
UNIT_001_BROWSER_EXECUTABLE=/path/to/chromium node --test test/web-browser.test.mjs
```

The Chromium executable is explicitly supplied; tests do not download a browser. `UNIT_001_KEEP_BROWSER_EVIDENCE=1` preserves screenshots while deleting synthetic SQLite state and the browser profile. The actual browser test verifies known versus unknown outcomes, retained forget IDs and search focus during a real owner update. An oversized or lost post-admission response remains unknown. A gateway-cached unknown result may stay unknown on an explicit repeat; close the dialog and inspect memory rather than assuming that a retry proves completion. A new send always creates a new request ID; inspect an earlier unknown send before submitting its text again.

The earlier Linux x64 container results covered the previous paired transport. Native code-free acceptance must verify the real SSH forward, refusal for the service UID and a separate local account at the managed socket, and closure of the gateway and tunnel after the test.
