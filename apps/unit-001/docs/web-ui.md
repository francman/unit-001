# Browser workspace and operator gateway

The browser workspace attaches to the existing agent owner. It does not create another agent, open SQLite, read provider credentials, or grant creator authority. A small separate Node HTTP process uses the existing operator socket and serves bundled static assets. This isolates browser parsing and connection failures from the owner; embedding HTTP in the owner would save one process but expose its private account to browser-facing code.

This slice is a prototype library and browser fixture, not an installed service. There is no launch command, public listener, deployment, or production authentication bootstrap yet. Private access is the default design pending the operator's access choice.

## Access boundary

The gateway must run as an authorized operator, ideally a dedicated account with only the installation's operator group. Its configuration selects exactly one installation/session/socket; HTTP requests cannot select another agent. A protected administrator provisioning step must supply that socket and a freshly generated random pairing secret. The eventual launcher must resolve the managed operator endpoint rather than accept a private administrator socket from browser input. Root setup and Linux account proof remain release gates.

The current library accepts only an exact `http://127.0.0.1:PORT` or `http://[::1]:PORT` origin. It checks loopback TCP peers, exact Host, and any supplied Origin on every request. Writes additionally require the exact Origin, JSON content type, and a session CSRF token. Forwarded headers are rejected. Remote access, TLS termination, trusted proxies, cookie Secure policy, and nonloopback binding require a separately reviewed explicit configuration; this library does not support them.

Pairing sends the secret once in a JSON POST, never a URL. The gateway consumes it for the process lifetime, allowing one thirty-minute session. The session cookie is host-only, HttpOnly, SameSite=Strict; browser code holds its CSRF token only in memory. Logout or expiry requires an administrator to restart with a new secret. This deliberately limited prototype is not the final recovery workflow: production provisioning must rotate consumed credentials durably and define simple re-pairing without exposing secrets in logs, model context, browser storage, or command arguments.

An authenticated web user has the existing operator's coding authority: sending text can cause the agent to execute allowed coding tools. Pairing is therefore an authority grant, not anonymous chat access. Creator approval, security administration, installation updates, and channel grants have no browser endpoints. Pending approvals are shown as pending, with no invented approval action. Mission execution remains explicitly `not-implemented` where reported by the owner.

## Version-one HTTP contract

All API paths start with `/api/v1`. Response bodies and assets use `Cache-Control: no-store`. Static assets are an exact path map, never a filesystem traversal. Browser text must render through text nodes; no raw HTML or executable model-generated markup.

| Method/path | Body or result |
| --- | --- |
| GET `/session` | `{authenticated:false}` or `{authenticated:true,csrfToken,expiresAt}` |
| POST `/session` | `{secret}`; creates the protected cookie and returns session metadata |
| POST `/logout` | CSRF header required; expires cookie and detaches streams |
| GET `/events` | SSE `view` containing the existing bounded `ServiceView`; optional `connecting` message |
| POST `/requests` | `{requestId,operation}` with `X-Unit-CSRF`; returns completed owner response or unknown outcome |

`src/web/contract.ts` defines the closed operation set: status, send, cancel, mission status, channel status, memory stats, recall, and explicitly confirmed forget. Forget forwards the displayed record ID and stable request ID. Unknown fields, authority claims, agent selectors, and other operations are rejected before owner dispatch.

The browser generates one request ID per explicit action. A repeated ID with identical input receives the same in-memory outcome; different input conflicts. The gateway never automatically retries a mutation. A disconnect after admission may leave work running; `unknown` tells the user to inspect current state before deciding what to do. Owner send/forget IDs remain the durable deduplication boundary. Cancel is an explicit independent operation; closing a tab only detaches observation.

SSE reconnects obtain a current full owner snapshot; they do not replay commands or pretend to deliver every intermediate event. Frontends replace their projection, using existing entry IDs to avoid duplicates. There are at most two streams, four active requests, thirty-two recorded outcomes, and one session; frames cap at 1 MiB, stored responses at 128 KiB, input at 64 KiB, request observation at two minutes. Slow streams disconnect instead of accumulating backlog. Expiry/logout/shutdown detach watches and request observation while owner-admitted work survives.

## Required before installation or release

Implement protected one-time provisioning and recovery, a launcher that enforces the operator endpoint and loopback bind, and packaged static asset verification. Prove the gateway's Linux UID cannot read private state or use the administrator socket. Complete browser acceptance with synthetic streamed content, reconnect, cancel, unknown outcomes, memory confirmation, and malicious text. Exercise actual owner UDS integration and bounded resource behavior on the small VPS profile. Run the full local check and focused tests; GitHub Actions remain disabled. No production deployment is implied by this prototype.
