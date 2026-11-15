# Browser workspace

Run `agent web` as an authorized operator, without sudo. Open `http://127.0.0.1:4317` and enter the one-time code printed in that terminal. The browser shows conversation, mission, memory and channel state; it can send direction, cancel the current run and explicitly forget selected memories. The existing owner keeps all storage and execution authority.

For a remote installation, keep the same loopback port on both ends:

```sh
ssh -L 4317:127.0.0.1:4317 unit-01
# In that remote terminal, use the installation's actual command:
bob web
```

Then open the address locally. `bob` is this installation's chosen name, not the product name. Use `--port 4318` and matching forwarding if the default port is occupied. No public listener, reverse proxy, TLS termination or extra firewall opening is required or supported.

Pairing grants the operator's existing conversation and coding authority. Keep the code private. It is generated in memory, accepted once, never put into a URL, file, environment variable or browser storage. The command requires a terminal so it cannot silently write a code into service logs. A session lasts thirty minutes. After sign-out or expiry, stop the web command and run it again for a fresh code. Ctrl+C detaches the browser gateway; owner work continues. Closing a tab never cancels work. This first version intentionally requires an operator terminal for provisioning; it is not a public, unattended web login service.

## Authority and access

The gateway runs in a separate process as the operator. Managed installations reject owner/root web launches; the launcher resolves only the installation's existing operator socket. It never opens SQLite or private credentials. Creator approval, channel grants, security changes, updates and lifecycle administration have no browser endpoints. Source-checkout launches use the developer's existing owner socket and authority.

Only exact `http://127.0.0.1:PORT` origins and loopback peers are accepted. Every request checks Host and Origin; forwarded headers are rejected. Writes additionally require same-origin JSON and an in-memory CSRF token. The host-only session cookie is HttpOnly and SameSite=Strict. The computer and browser must be trusted: loopback HTTP is not an isolation boundary against a compromised browser, OS administrator, or malicious local program able to acquire the pairing/session credentials. The Linux operator account cannot read private owner state; trusted coding tools still run with the owner's existing authority.

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

The closed operation set is status, send, cancel, mission status, channel status, memory stats, recall and explicitly confirmed forget. Browser requests cannot select another installation, claim creator authority or change the configured endpoint.

Each explicit action gets one request ID. A repeated ID with the same input receives the same gateway result; different input conflicts. Mutations are never automatically retried. If the connection fails after admission, delivery remains unknown; inspect the conversation and keep the displayed ID before deciding to act again. Owner send/forget receipts remain the durable deduplication boundary. SSE reconnects replace the current snapshot without replaying commands. Drafts stay in page memory during reconnect and are cleared on sign-out; reloading the page discards them.

Limits are one session, two streams, four active requests, thirty-two mutation outcomes, 1 MiB frames, 128 KiB stored responses, 64 KiB HTTP input and two-minute request observation. A consumed mutation outcome budget requires restarting and pairing again. Slow streams disconnect rather than accumulate backlog. Authentication expiry, sign-out and shutdown detach observation; admitted owner work survives.

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
