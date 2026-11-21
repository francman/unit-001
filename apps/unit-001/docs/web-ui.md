# Browser workspace

Run `agent web` as an authorized operator, without sudo. Open `http://127.0.0.1:4317` and enter the one-time code printed in that terminal. The browser shows conversation, mission, memory and connection state; it can send direction, cancel the current run and explicitly forget selected memories. The existing owner keeps all storage and execution authority.

For a remote installation, keep the same loopback port on both ends:

```sh
ssh -L 4317:127.0.0.1:4317 unit-01
# In that remote terminal, use the installation's actual command:
bob web
```

Then open the address locally. `bob` is this installation's chosen name, not the product name. Use `--port 4318` and matching forwarding if the default port is occupied. No public listener, reverse proxy, TLS termination or extra firewall opening is required or supported.

Use the exact `Browser workspace` URL printed by the command: `http://127.0.0.1:4317`, not `localhost`, the server hostname, or a different local port. If the browser reports `Origin is not permitted`, check that URL and use the same port on both sides of the SSH tunnel. Direct browser navigation does not require an `Origin` header; writes still require the exact origin.

Pairing grants the operator's existing conversation and coding authority. Keep the code private. It is generated in memory, accepted once, never put into a URL, file, environment variable or browser storage. The command requires a terminal so it cannot silently write a code into service logs. A session lasts thirty minutes. After sign-out or expiry, stop the web command and run it again for a fresh code. Ctrl+C detaches the browser gateway; owner work continues. Closing a tab never cancels work. This first version intentionally requires an operator terminal for provisioning; it is not a public, unattended web login service.

## Authority and access

The gateway runs in a separate process as the operator. Managed installations reject owner/root web launches; the launcher resolves only the installation's existing operator socket. It never opens SQLite or private credentials. Creator approval, connection grants, security changes, updates and lifecycle administration have no browser endpoints. Source-checkout launches use the developer's existing owner socket and authority.

Only exact `http://127.0.0.1:PORT` origins and loopback peers are accepted. Every request checks Host and Origin; forwarded headers are rejected. Writes additionally require same-origin JSON and an in-memory CSRF token. The host-only session cookie is HttpOnly and SameSite=Strict. The computer and browser must be trusted: loopback HTTP is not an isolation boundary against a compromised browser, OS administrator, or malicious local program able to acquire the pairing/session credentials. The Linux operator account cannot read private owner state; trusted coding tools still run with the owner's existing authority.

The stylesheet is Tailwind v4 (exact-pinned dev dependencies `tailwindcss` and `@tailwindcss/cli`) compiled by `scripts/build-tailwind.mjs` into a single static `style.css`; no inline styles or runtime CSS generation, so the CSP stays `style-src 'self'`. For design review without an owner, `node scripts/build-web-preview.mjs` builds a sample-data preview into the gitignored `web-preview/` (never part of a release).

The visual rules and token table live in `.pi/skills/web-ui-design.md`. The look follows Hermes.app, the Hermes desktop chat app: Cursor-like chrome, 13 px text, 28 px rows, near-square corners (2 to 4.8 px), hairline borders, a blue accent used sparingly, system fonts only. Light and dark follow the system setting; the theme button in the sidebar footer cycles system, light and dark and keeps the choice per browser. Color means state only: green connected or done, amber waits for the owner, red blocked, offline or failed.

Layout: a 260 px sidebar (wordmark, the agent's name as a tab, the pages Chat, Mission, Status, Memory, Connections and About with a count on the page that needs the owner, and a footer with the theme button, Sign out and the version), a 34 px top bar with the page path, and a 20 px status bar across the bottom with the gateway connection, the agent's state (one state by fixed precedence: connection, the reply in progress, what needs the owner, then scheduled work, for example "Replying · read_file · 12 s" or "Blocked · needs you"), and the model, tokens and cost estimate the backend reports. Below 768 px the sidebar opens over the page from the top bar's Menu button. Above every page, strips say what the owner must do (blocked scheduled work with unknown results, a maintenance hold, a missing model, a lost connection) with the terminal command to copy. Chat is home: the owner's messages are bordered boxes that stay pinned while the reply scrolls under them, replies are plain text, tool calls are dimmed one-line rows, and the composer card (one line, grows to 150 px, then scrolls) holds the model and one send button that becomes Stop while a reply runs. Below 1440 px a purpose line sits above the conversation; from 1440 px a read-only Activity pane (300 px) beside it shows the purpose, scheduled work, memory and connections. The other pages use one centered 832 px column with a title, a lead sentence and sections. The Mission page holds the agreed purpose (with the approval receipt), the current work run with its limits, recorded checks, history and the terminal commands that show the same facts. Status keeps totals, memory and runtime. Nothing in the browser approves, reconciles or starts work.

For design review the preview accepts `?section=status|memory|connections` (`channels` still works as an alias), `?theme=light|dark`, `?empty=1`, `?busy=1`, `?blocked=1`, `?held=1`, `?unconfigured=1`, `?norun=1`, `?long=1`, `?details=none`, `?draft=long`, `?unknown=1`, `?connection=connecting|offline|expired`, `?memory=1`, `?forget=1` and `?pairing=1`; `preview.ts` lists them with what each shows.

Static assets use an exact path map, never a filesystem traversal. The production builder bundles `bootstrap.ts` and copies only `index.html`, `bootstrap.js` and `style.css`. `preview.ts` and its fixture controls are excluded from production assets and releases. Text renders through DOM text nodes, including model output; no executable model-generated markup is accepted.

## Requests and recovery

All API paths start with `/api/v1`. Responses and assets have `Cache-Control: no-store`.

| Method/path | Purpose |
| --- | --- |
| GET `/session` | Inspect the current session and obtain its CSRF token. |
| POST `/session` | Exchange the one-time pairing code for a session cookie. |
| POST `/logout` | Revoke that session, pending observations and streams. |
| GET `/events` | Watch bounded owner snapshots over server-sent events. |
| POST `/requests` | Submit one stable-ID operator operation. |

The closed operation set is status, send, cancel, mission status, channel status, memory stats, memory graph, recall and explicitly confirmed forget. The memory graph is a read-only snapshot of at most 300 live memories (newest by update), content truncated to 280 code points, summary links only between returned memories (at most 1,000), and an opaque per-owner key instead of each conversation ID; forgotten memories never appear. Browser requests cannot select another installation, claim creator authority or change the configured endpoint.

Each explicit action gets one request ID. A repeated ID with the same input receives the same gateway result; different input conflicts. Mutations are never automatically retried. If the connection fails after admission, delivery remains unknown; inspect the conversation and keep the displayed ID before deciding to act again. Owner send/forget receipts remain the durable deduplication boundary. SSE reconnects replace the current snapshot without replaying commands. Drafts stay in page memory during reconnect and are cleared on sign-out; reloading the page discards them.

Limits are one session, two streams, four active requests, thirty-two mutation outcomes, 1 MiB frames, 128 KiB stored responses (1 MiB for the memory graph), 64 KiB HTTP input and two-minute request observation. A consumed mutation outcome budget requires restarting and pairing again. Slow streams disconnect rather than accumulate backlog. Authentication expiry, sign-out and shutdown detach observation; admitted owner work survives.

## Local verification and release gate

`test/web-gateway.test.ts` and `test/web-review.test.ts` exercise actual HTTP authentication, CSRF, bounds, deduplication, session expiry and pending cleanup. `test/web-owner.test.ts` uses real SQLite and an operator Unix socket to verify packaged assets, observation, replies and explicit forget without a second writer. `test/fixtures/web-workspace.ts` supports actual Chromium interaction with synthetic provider data. Browser acceptance covers pairing rejection/success, streaming, malicious text, memory confirmation, cancellation, desktop/mobile layout and sign-out. Release tests verify the exact asset inventory and checksums.

Native Linux account isolation and complete packaged/systemd acceptance must pass before production release. GitHub Actions remain disabled. No production installation or public exposure is implied by source merge.

Run the transport and real browser checks after building the app:

```sh
npm run build --workspace apps/unit-001
# From apps/unit-001:
node ../../node_modules/vitest/dist/cli.js --run --config web/vitest.config.ts
UNIT_001_BROWSER_EXECUTABLE=/path/to/chromium node --test test/web-browser.test.mjs
```

The Chromium executable is explicitly supplied; tests do not download a browser. `UNIT_001_KEEP_BROWSER_EVIDENCE=1` preserves screenshots while deleting synthetic SQLite state and the browser profile. The actual browser test verifies known versus unknown outcomes, retained forget IDs and search focus during a real owner update. An oversized or lost post-admission response remains unknown. A gateway-cached unknown result may stay unknown on an explicit repeat; close the dialog and inspect memory rather than assuming that a retry proves completion. A new send always creates a new request ID; inspect an earlier unknown send before submitting its text again.

Disposable Linux x64 Docker acceptance also exercised a gateway under operator UID 2001 and an owner under UID 2000, using the published Node 24 runtime and release dependencies with the candidate application. Operator access to private credentials, SQLite and the administrator socket was denied; outsider UID 2002 could not connect to the operator socket or make unauthenticated HTTP requests. Pairing reached real owner status with zero provider calls. This is x64 emulation on a macOS host, not native systemd or complete release acceptance.
