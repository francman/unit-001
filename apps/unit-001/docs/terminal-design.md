# A calm terminal for an always-on agent

The terminal is a view and control surface for one named agent. Detaching leaves its work running. Show identity and connection state before decoration so operators can distinguish Bob from another installation after SSH reconnects.

Use a transparent background with restrained cyan accents, blue user labels, normal terminal foreground for conversation text, and dim metadata. Green means succeeded, yellow means working, red means failed; neutral done means outcome unknown. Every state also has a text label; color never carries the only explanation. Keep tool details collapsed to bounded name/status cards initially. Provider arguments, internal documents and secrets do not belong in those cards.

Keep three stable regions: a compact identity/model header, scrollable conversation and activity, and a composer with status/help beneath it. Follow live output until the operator scrolls back; do not pull them away from earlier text. Render Markdown for answers, retain readable plain text for tool names and status, and sanitize untrusted terminal control sequences before rendering.

The status area shows model/provider from the watched agent document and recorded conversation-model token totals from its usage document. Display positive recorded costs as **estimated USD**, never an invoice or subscription charge. Show **cost unknown** when zero ledger values cannot establish pricing. Missing counters stay unavailable. These totals exclude tool and subagent usage. No catalog scan, provider call or extra history read is needed to paint a frame.

Respect monochrome output and terminal capabilities. Narrow layouts hide optional metadata before clipping identity or input; wrap answers and retain cancel/detach hints. Avoid mandatory special fonts, background fills and animation on the critical path. Test light/dark terminals, 40/80-column SSH sessions, resize, paste, reconnect and keyboard-only use. Plain mode supports basic terminals; use `send` for pipes.
